// SCAFFOLD TEMPLATE (ai-agent-architecture skill) — adapt placeholders marked TODO to the target app.

import OpenAI from 'openai'
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
 * Translates our generic ChatProvider shapes to/from the OpenAI SDK's Responses API
 * (`client.responses.create`) — openai@6.x's primary, recommended API for text +
 * tool-calling. Chat Completions ("supported indefinitely" per the SDK README) is the
 * older path; Responses is what the README leads with, so that's what we build against.
 *
 * Pure translation layer — the tool-loop / one-retry logic lives in agent/loop.ts.
 * The only cross-cutting concern owned here is the per-HTTP-call timeout (see
 * references/architecture.md §3 "Provider adapter"), because it's a property of the
 * individual provider request, not the loop's rounds.
 */

// Hard cap per provider HTTP call — one hung call must never hold a request open
// (the loop's own wall-clock timeout is a separate, coarser bound — see loop.ts).
const PER_CALL_TIMEOUT_MS = 30_000

// GPT-5 / o-series are reasoning models: they accept `reasoning.effort` and
// REJECT `temperature`; every other model is the reverse. OpenAI's own docs:
// "temperature changes are not supported for reasoning models, and
// reasoning_effort is not supported for non-reasoning models." So the request
// shape is chosen per model family — sending the wrong one is a 400.
function isReasoningModel(model: string): boolean {
  return /^(o\d|gpt-5)/.test(model)
}

export class OpenAIChatProvider implements ChatProvider {
  private readonly client: OpenAI
  readonly model: string

  constructor(opts: { apiKey: string; model: string }) {
    // maxRetries: 0 — agent/loop.ts owns the single read-only retry (references/
    // architecture.md §6), so the SDK's own default retries stay off; otherwise
    // PER_CALL_TIMEOUT_MS would silently stack up to 3x per provider.chat() call.
    this.client = new OpenAI({ apiKey: opts.apiKey, maxRetries: 0 })
    this.model = opts.model
  }

  /**
   * Non-streaming shape, kept for callers that just want the final result
   * (e.g. loop.ts's context-summarization call). Implemented on top of
   * chatStream so there is exactly one translation of OpenAI's wire format —
   * this just accumulates the stream instead of forwarding it.
   */
  async chat(input: ChatInput): Promise<ChatResult> {
    let reasoning = ''
    let answer = ''
    let toolCalls: ToolCall[] = []
    let done: Extract<ProviderStreamEvent, { type: 'done' }> | undefined

    for await (const event of this.chatStream(input)) {
      if (event.type === 'reasoning_delta') reasoning += event.delta
      else if (event.type === 'text_delta') answer += event.delta
      else if (event.type === 'tool_calls') toolCalls = event.calls
      else if (event.type === 'done') done = event
    }

    const content: ContentPart[] = []
    if (reasoning) content.push({ type: 'reasoning', text: reasoning })
    if (answer) content.push({ type: 'text', text: answer })
    return {
      content,
      toolCalls,
      stopReason: done?.stopReason ?? 'end',
      usage: done?.usage ?? { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
    }
  }

  async *chatStream(input: ChatInput): AsyncGenerator<ProviderStreamEvent> {
    const stream = await this.client.responses.create(
      {
        model: this.model,
        instructions: input.systemPrompt,
        input: input.messages.flatMap(toInputItems),
        tools: input.tools.map(toOpenAITool),
        max_output_tokens: input.maxOutputTokens,
        stream: true,
        // Structured output (ChatInput.responseSchema). Strict mode needs a schema that
        // follows OpenAI's strict rules (all properties required, additionalProperties:
        // false) — TODO: pass `strict: false` here if your helpers' schemas can't.
        ...(input.responseSchema
          ? { text: { format: { type: 'json_schema' as const, name: 'response', schema: input.responseSchema, strict: true } } }
          : {}),
        // Per model family (see isReasoningModel):
        // - reasoning models: effort from ChatInput.reasoning (default 'low' — most agent
        //   use cases narrate structured tool-result data, they don't need deep reasoning;
        //   lower effort leaves more of max_output_tokens for the visible answer, since
        //   reasoning models spend hidden tokens from the same budget). `summary: 'auto'`
        //   asks for the reasoning summary that becomes `reasoning_delta`.
        //   TODO: 'none' maps to 'minimal' (gpt-5 / o-series); newer families accept 'none'.
        // - non-reasoning models: temperature 0.2 — factual narration, not
        //   creative writing. TODO: raise this if your agent's answers should
        //   read as more conversational/varied than a low-variance factual report.
        ...(isReasoningModel(this.model)
          ? {
              reasoning: {
                effort: input.reasoning === 'none' ? ('minimal' as const) : (input.reasoning ?? 'low'),
                summary: 'auto' as const,
              },
            }
          : { temperature: 0.2 }),
      },
      { timeout: PER_CALL_TIMEOUT_MS, signal: input.signal },
    )

    let sawTerminalEvent = false

    for await (const event of stream) {
      if (event.type === 'response.output_text.delta') {
        yield { type: 'text_delta', delta: event.delta }
      } else if (event.type === 'response.reasoning_summary_text.delta') {
        yield { type: 'reasoning_delta', delta: event.delta }
      } else if (event.type === 'response.output_item.added' && event.item.type === 'function_call') {
        yield { type: 'tool_call_start', id: event.item.call_id, name: event.item.name }
      } else if (event.type === 'response.completed' || event.type === 'response.incomplete') {
        // response.incomplete (e.g. max_output_tokens hit) still carries whatever
        // text/tool-calls the model produced before being cut off — a partial
        // answer is better than throwing away the response, so it's treated the
        // same as a normal completion rather than an error (stopReason says which).
        sawTerminalEvent = true
        const calls = event.response.output
          .filter((item): item is OpenAI.Responses.ResponseFunctionToolCall => item.type === 'function_call')
          .map((item) => ({ id: item.call_id, name: item.name, args: parseArgs(item.arguments) }))

        if (calls.length > 0) yield { type: 'tool_calls', calls }

        const stopReason: StopReason =
          event.response.status === 'incomplete' && event.response.incomplete_details?.reason === 'max_output_tokens'
            ? 'max_tokens'
            : calls.length > 0
              ? 'tool_calls'
              : 'end'

        yield {
          type: 'done',
          stopReason,
          usage: {
            inputTokens: event.response.usage?.input_tokens ?? 0,
            outputTokens: event.response.usage?.output_tokens ?? 0,
            cachedInputTokens: event.response.usage?.input_tokens_details?.cached_tokens ?? 0,
          },
        }
      } else if (event.type === 'response.failed' || event.type === 'error') {
        // Never forward the vendor's raw error text to the caller (it can carry
        // provider-internal detail) — the loop's one-retry and the app's own
        // error handler turn this plain throw into a safe response.
        throw new Error('OpenAI stream failed')
      }
    }

    if (!sawTerminalEvent) {
      throw new Error('OpenAI stream ended unexpectedly')
    }
  }
}

function toOpenAITool(tool: ToolDef): OpenAI.Responses.Tool {
  return {
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.jsonSchema,
    strict: false,
  }
}

function toInputItems(message: ChatMessage): OpenAI.Responses.ResponseInputItem[] {
  if (message.role === 'tool') {
    return [{ type: 'function_call_output', call_id: message.toolCallId ?? '', output: textOf(message) }]
  }
  if (message.role === 'user') {
    // Documents are already fenced as data upstream (references/inputs.md §2), so they go
    // in as plain text blocks.
    const content: OpenAI.Responses.ResponseInputContent[] = []
    for (const part of message.content) {
      if (part.type === 'text' || part.type === 'document') content.push({ type: 'input_text', text: part.text })
      else if (part.type === 'image') {
        content.push({ type: 'input_image', detail: 'auto', image_url: `data:${part.mimeType};base64,${part.data}` })
      }
    }
    return content.length > 0 ? [{ role: 'user', content }] : []
  }
  // Assistant: text, then its tool calls. Reasoning parts are dropped on replay — OpenAI
  // reasoning items need server-side ids/encrypted content we don't store, and the model
  // doesn't need its own old summaries back.
  const items: OpenAI.Responses.ResponseInputItem[] = []
  const answer = textOf(message)
  if (answer) items.push({ role: 'assistant', content: answer })
  for (const call of message.toolCalls ?? []) {
    items.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.args) })
  }
  return items
}

/**
 * Malformed JSON in a tool call's arguments is a model-output quirk, not an exceptional
 * code failure. Tool input is zod-validated at dispatch time regardless (see registry.ts /
 * loop.ts's runTool), so falling back to `{}` here just routes a bad model output into
 * that existing "invalid tool input" path instead of throwing and killing the whole agent
 * turn over one bad call.
 */
function parseArgs(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}
