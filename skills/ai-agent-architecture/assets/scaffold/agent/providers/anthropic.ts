// SCAFFOLD TEMPLATE (ai-agent-architecture skill) — adapt placeholders marked TODO to the target app.

import Anthropic from '@anthropic-ai/sdk'
import {
  textOf,
  type ChatInput,
  type ChatMessage,
  type ChatProvider,
  type ChatResult,
  type ContentPart,
  type ProviderStreamEvent,
  type StopReason,
  type ToolCall,
  type ToolDef,
} from './types'

/**
 * Translates our generic ChatProvider shapes to/from the Anthropic SDK's Messages API
 * (streaming). The second adapter next to openai.ts: nothing above `providers/` changed to
 * add it, which is what proves the seam held (references/architecture.md §2, §3).
 *
 * Same division of labour as openai.ts: pure translation here, retries and tool rounds in
 * agent/loop.ts. The per-call timeout is the one cross-cutting concern owned here.
 */

// TODO: pin the model your agent is evaluated against (references/evals.md).
const DEFAULT_MODEL = 'claude-sonnet-5-5'

// Hard cap per provider HTTP call, same reasoning as openai.ts.
const PER_CALL_TIMEOUT_MS = 30_000

// ChatInput.reasoning -> extended-thinking budget. Anthropic requires 1024 <= budget < max_tokens,
// and thinking tokens come out of the same max_tokens as the answer, so the budget is capped
// to leave MIN_ANSWER_TOKENS for the visible answer (and thinking is skipped if it can't).
const THINKING_BUDGET = { low: 1024, medium: 4096, high: 16_000 } as const
const MIN_THINKING_TOKENS = 1024
const MIN_ANSWER_TOKENS = 1024

// Structured output (ChatInput.responseSchema) is a single forced call to this tool.
const RESPOND_TOOL = 'respond'

const EPHEMERAL = { type: 'ephemeral' } as const

export class AnthropicChatProvider implements ChatProvider {
  private readonly client: Anthropic
  readonly model: string

  constructor(opts: { apiKey: string; model?: string }) {
    // maxRetries: 0 — agent/loop.ts owns the single retry, as with the OpenAI adapter.
    this.client = new Anthropic({ apiKey: opts.apiKey, maxRetries: 0 })
    this.model = opts.model || DEFAULT_MODEL
  }

  /** Accumulates `chatStream`, so there is exactly one translation of the wire format. */
  async chat(input: ChatInput): Promise<ChatResult> {
    let reasoning = ''
    let reasoningSignature: string | undefined
    let answer = ''
    let toolCalls: ToolCall[] = []
    let done: Extract<ProviderStreamEvent, { type: 'done' }> | undefined

    for await (const event of this.chatStream(input)) {
      if (event.type === 'reasoning_delta') reasoning += event.delta
      else if (event.type === 'text_delta') answer += event.delta
      else if (event.type === 'tool_calls') toolCalls = event.calls
      else if (event.type === 'done') {
        done = event
        reasoningSignature = event.reasoningSignature
      }
    }

    const content: ContentPart[] = []
    if (reasoning) content.push({ type: 'reasoning', text: reasoning, ...(reasoningSignature && { signature: reasoningSignature }) })
    if (answer) content.push({ type: 'text', text: answer })
    return {
      content,
      toolCalls,
      stopReason: done?.stopReason ?? 'end',
      usage: done?.usage ?? { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
    }
  }

  async *chatStream(input: ChatInput): AsyncGenerator<ProviderStreamEvent> {
    const schemaMode = input.responseSchema !== undefined
    const messages = toAnthropicMessages(input.messages)
    const effort = input.reasoning ?? 'low'
    // Thinking can't be combined with a forced tool call, so structured output runs without it.
    const thinkingBudget =
      effort === 'none' || schemaMode ? 0 : Math.min(THINKING_BUDGET[effort], input.maxOutputTokens - MIN_ANSWER_TOKENS)

    const stream = await this.client.messages.create(
      {
        model: this.model,
        max_tokens: input.maxOutputTokens,
        // Prompt caching: the system prompt and the tool list are the stable prefix of every
        // call, so each gets a cache breakpoint on its last block. `cachedInputTokens` on
        // `done` shows whether it is working.
        system: [{ type: 'text', text: input.systemPrompt, cache_control: EPHEMERAL }],
        messages,
        ...toolParams(input),
        ...(thinkingBudget >= MIN_THINKING_TOKENS
          ? { thinking: { type: 'enabled' as const, budget_tokens: thinkingBudget } }
          : {}),
        stream: true,
      },
      { timeout: PER_CALL_TIMEOUT_MS, signal: input.signal },
    )

    // tool_use blocks arrive as a name up front, then argument JSON in fragments.
    const toolBlocks = new Map<number, { id: string; name: string; json: string }>()
    let reasoningSignature: string | undefined
    let stopReason: StopReason = 'end'
    let inputTokens = 0
    let cachedInputTokens = 0
    let outputTokens = 0
    let sawTerminalEvent = false

    for await (const event of stream) {
      if (event.type === 'message_start') {
        // Anthropic's `input_tokens` excludes cached tokens; fold them back in so
        // `cachedInputTokens` is a share of `inputTokens`, as the seam documents.
        const u = event.message.usage
        cachedInputTokens = u.cache_read_input_tokens ?? 0
        inputTokens = u.input_tokens + cachedInputTokens + (u.cache_creation_input_tokens ?? 0)
      } else if (event.type === 'content_block_start') {
        if (event.content_block.type === 'tool_use' && !schemaMode) {
          const { id, name } = event.content_block
          toolBlocks.set(event.index, { id, name, json: '' })
          yield { type: 'tool_call_start', id, name }
        }
      } else if (event.type === 'content_block_delta') {
        const d = event.delta
        if (d.type === 'text_delta') yield { type: 'text_delta', delta: d.text }
        else if (d.type === 'thinking_delta') yield { type: 'reasoning_delta', delta: d.thinking }
        // The seam carries one signature per call. That is exact with a single thinking block
        // (the default); interleaved thinking (multiple blocks) would need a richer seam.
        else if (d.type === 'signature_delta') reasoningSignature = d.signature
        else if (d.type === 'input_json_delta') {
          // Structured output: the forced `respond` tool's input *is* the answer, so its
          // JSON streams straight out as text.
          if (schemaMode) yield { type: 'text_delta', delta: d.partial_json }
          else {
            const block = toolBlocks.get(event.index)
            if (block) block.json += d.partial_json
          }
        }
      } else if (event.type === 'message_delta') {
        stopReason = mapStopReason(event.delta.stop_reason, schemaMode)
        outputTokens = event.usage.output_tokens
      } else if (event.type === 'message_stop') {
        sawTerminalEvent = true
      }
    }

    // The SDK throws on an in-stream error event; a stream that just ends is ours to flag.
    if (!sawTerminalEvent) {
      throw new Error('Anthropic stream ended unexpectedly')
    }

    const calls = [...toolBlocks.values()].map(b => ({ id: b.id, name: b.name, args: parseArgs(b.json) }))
    if (calls.length > 0) yield { type: 'tool_calls', calls }

    yield {
      type: 'done',
      stopReason,
      usage: { inputTokens, outputTokens, cachedInputTokens },
      ...(reasoningSignature && { reasoningSignature }),
    }
  }
}

function mapStopReason(reason: Anthropic.StopReason | null, schemaMode: boolean): StopReason {
  switch (reason) {
    case 'tool_use':
      return schemaMode ? 'end' : 'tool_calls' // the forced `respond` call is the answer, not a tool round
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'max_tokens'
    default:
      return 'end' // end_turn, stop_sequence, refusal, pause_turn
  }
}

/** `tools` / `tool_choice` request params, with the cache breakpoint on the last tool. */
function toolParams(input: ChatInput): { tools?: Anthropic.Tool[]; tool_choice?: Anthropic.ToolChoice } {
  if (input.responseSchema) {
    return {
      tools: [
        {
          name: RESPOND_TOOL,
          description: 'Return your answer as structured data matching this schema.',
          input_schema: input.responseSchema as Anthropic.Tool.InputSchema,
          cache_control: EPHEMERAL,
        },
      ],
      tool_choice: { type: 'tool', name: RESPOND_TOOL },
    }
  }

  if (input.tools.length > 0) {
    const tools = input.tools.map(toAnthropicTool)
    tools[tools.length - 1]!.cache_control = EPHEMERAL
    return { tools }
  }

  // The loop's forced-final-answer call sends no tools, but Anthropic rejects a transcript
  // containing tool_use/tool_result blocks unless `tools` is defined. Declare stubs for the
  // tools already used in history and forbid calling any: same effect as "no tools".
  // TODO: confirm against the live API; if it ever objects, flatten history tool blocks to text.
  const used = new Set(input.messages.flatMap(m => m.toolCalls?.map(c => c.name) ?? []))
  if (used.size === 0) return {}
  return {
    tools: [...used].map(name => ({ name, input_schema: { type: 'object' as const } })),
    tool_choice: { type: 'none' },
  }
}

function toAnthropicTool(tool: ToolDef): Anthropic.Tool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.jsonSchema as Anthropic.Tool.InputSchema,
  }
}

/**
 * Parts -> content blocks. Anthropic wants strictly alternating user/assistant turns with all
 * of one round's tool_result blocks together in the user turn right after the tool_use, so
 * consecutive same-side messages (our one-`tool`-message-per-call) are merged.
 */
function toAnthropicMessages(messages: ChatMessage[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = []
  for (const message of messages) {
    const role = message.role === 'assistant' ? 'assistant' : 'user'
    const blocks = toBlocks(message)
    if (blocks.length === 0) continue // the API rejects empty content
    const last = out[out.length - 1]
    if (last && last.role === role) (last.content as Anthropic.ContentBlockParam[]).push(...blocks)
    else out.push({ role, content: blocks })
  }
  return out
}

function toBlocks(message: ChatMessage): Anthropic.ContentBlockParam[] {
  if (message.role === 'tool') {
    return [{ type: 'tool_result', tool_use_id: message.toolCallId ?? '', content: textOf(message) }]
  }

  const blocks: Anthropic.ContentBlockParam[] = []
  for (const part of message.content) {
    if (part.type === 'reasoning') {
      // Replayed only with its signature (the API rejects thinking blocks without a valid one),
      // so reasoning that came from another provider is dropped here.
      if (part.signature) blocks.push({ type: 'thinking', thinking: part.text, signature: part.signature })
    } else if (part.type === 'image') {
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: part.mimeType as Anthropic.Base64ImageSource['media_type'], data: part.data },
      })
    } else if (part.text) {
      // text, and documents (already fenced as data upstream, references/inputs.md §2)
      blocks.push({ type: 'text', text: part.text })
    }
  }
  for (const call of message.toolCalls ?? []) {
    blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.args })
  }
  return blocks
}

/** Malformed tool-call JSON becomes `{}` so it hits the normal invalid-arguments path (see openai.ts). */
function parseArgs(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}
