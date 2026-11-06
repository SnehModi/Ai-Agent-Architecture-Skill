// SCAFFOLD TEMPLATE (ai-agent-architecture skill) — adapt placeholders marked TODO to the target app.

/**
 * The generic tool-use loop (references/architecture.md §6 "The loop").
 * Zero domain knowledge — talks only to the `ChatProvider` interface and the
 * `AgentTool` contract. One agent (one system prompt + one toolset) is just the first
 * caller; a second agent elsewhere in the app is another caller with a bigger toolset
 * and a different prompt, not a change to this file.
 *
 * `runAgentLoopStream` is the core implementation (a generator emitting
 * status/delta/reasoning/tool_start/tool_end/done events, for streaming/SSE callers).
 * `runAgentLoop` is a thin wrapper that consumes the stream and returns the final result,
 * for callers that just want the final response — there is exactly one loop
 * implementation.
 */

import { AppError, type AgentContext } from './context'
import { availableTools, toJsonSchema, type AgentTool } from './registry'
import { fitToBudget } from './context-window'
import {
  text,
  textOf,
  type ChatInput,
  type ChatMessage,
  type ChatProvider,
  type ContentPart,
  type ProviderStreamEvent,
  type ToolCall,
  type ToolDef,
  type Usage,
} from './providers/types'

const MAX_TOOL_ROUNDS = 8
// TODO: tune this per your agent's typical answer shape. 3000 was raised from a lower
// starting point after live testing truncated a real structured answer mid-sentence —
// size this to your longest legitimate answer, not your average one.
const MAX_OUTPUT_TOKENS = 3000
const OVERALL_TIMEOUT_MS = 60_000
// Most agent turns narrate tool data and don't need deep reasoning (providers/types.ts).
// TODO: raise it for an agent whose questions genuinely need multi-step reasoning.
const REASONING_EFFORT = 'low' as const
const RETRY_JITTER_MIN_MS = 200
const RETRY_JITTER_MAX_MS = 500
// Context-window budget (chars/4 heuristic — see context-window.ts) applied once,
// before the first provider call of a turn. Well under any current model's real
// context window; this only exists to bound cost/latency on long-running
// conversations, not to avoid a hard provider error.
export const AGENT_CONTEXT_BUDGET_TOKENS = 24_000

export interface RunAgentLoopInput {
  ctx: AgentContext
  provider: ChatProvider
  allTools: AgentTool[]
  systemPrompt: string
  userMessages: ChatMessage[]
  /** Aborts any in-flight provider call when the caller (e.g. a closed SSE
   *  connection) no longer wants the result — see providers/types.ts. */
  signal?: AbortSignal
  /** Per-call overrides of the loop's constants. Sub-agents pass tighter values, background
   *  tasks a longer timeout (references/multi-agent.md §3, §7). Omitted = the defaults above. */
  bounds?: Partial<LoopBounds>
}

export interface LoopBounds {
  maxToolRounds: number
  maxOutputTokens: number
  timeoutMs: number
  contextBudgetTokens: number
}

const DEFAULT_BOUNDS: LoopBounds = {
  maxToolRounds: MAX_TOOL_ROUNDS,
  maxOutputTokens: MAX_OUTPUT_TOKENS,
  timeoutMs: OVERALL_TIMEOUT_MS,
  contextBudgetTokens: AGENT_CONTEXT_BUDGET_TOKENS,
}

export interface RunAgentLoopResult {
  /** Text of the final assistant message (reasoning excluded). */
  answer: string
  usage: { inputTokens: number; outputTokens: number; toolRounds: number }
  // Operational trace for your logger: tool names dispatched (in order) and the
  // wall-clock latency of each provider call (one entry per round + any forced
  // final call). Log these; they are not part of the API response.
  trace: { toolsCalled: string[]; providerMs: number[] }
  // Messages this turn added beyond the input `userMessages` — the assistant
  // tool-call message(s), the tool-result message(s), and the final assistant
  // message. Optional so existing callers/mocks that predate this field
  // keep type-checking; real runs always populate it.
  appended?: ChatMessage[]
}

/** Events emitted by `runAgentLoopStream`, one turn's worth. */
export type LoopEvent =
  | { type: 'status'; round: number; tools: string[] }
  | { type: 'delta'; text: string }
  /** Visible reasoning summary, for a live "Thinking…" trail. */
  | { type: 'reasoning'; text: string }
  /** A tool was named; its arguments are still streaming. */
  | { type: 'tool_start'; id: string; name: string }
  /** A tool finished dispatch. `ok` is false when the call never ran to completion (unknown
   *  tool, invalid arguments, or a throw); a returned `{ error }` is still `ok`. `result` is
   *  the tool's return value (or `{ error }` on failure): the controller's `describeStep`
   *  derives a label from it, and it must never be forwarded to the client raw. */
  | { type: 'tool_end'; id: string; name: string; ok: boolean; result: unknown }
  | { type: 'done'; answer: string; usage: RunAgentLoopResult['usage']; trace: RunAgentLoopResult['trace']; appended: ChatMessage[] }

export async function runAgentLoop(input: RunAgentLoopInput): Promise<RunAgentLoopResult> {
  let answer = ''
  let usage: RunAgentLoopResult['usage'] = { inputTokens: 0, outputTokens: 0, toolRounds: 0 }
  let trace: RunAgentLoopResult['trace'] = { toolsCalled: [], providerMs: [] }
  let appended: ChatMessage[] = []

  for await (const event of runAgentLoopStream(input)) {
    if (event.type === 'done') {
      answer = event.answer
      usage = event.usage
      trace = event.trace
      appended = event.appended
    }
  }

  return { answer, usage, trace, appended }
}

export async function* runAgentLoopStream(input: RunAgentLoopInput): AsyncGenerator<LoopEvent> {
  const { ctx, provider, allTools, systemPrompt } = input
  const bounds: LoopBounds = { ...DEFAULT_BOUNDS, ...input.bounds }
  const startedAt = Date.now()

  const permitted = await availableTools(ctx, allTools)
  // Hard rule: a write tool is never sent to the model and never dispatched, even if
  // one is mistakenly registered, because the confirmation-flow UX that would make one
  // safe to dispatch doesn't exist yet. registry.ts explicitly leaves this rejection to
  // the loop — do not remove this filter until that confirmation flow is built. 'propose'
  // tools are allowed: they only create a pending record a human accepts out of band.
  const tools = permitted.filter(tool => tool.mode === 'read' || tool.mode === 'propose')
  const toolsByName = new Map(tools.map(tool => [tool.name, tool]))
  const toolDefs: ToolDef[] = tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    jsonSchema: toJsonSchema(tool.inputSchema),
  }))

  const inputCount = input.userMessages.length
  let messages: ChatMessage[] = input.userMessages.map(m => ({ ...m }))

  // Context-window management: only before the first provider call of the
  // turn — a long-running conversation gets trimmed once up front, not on
  // every tool round within the same turn.
  messages = await fitToBudget(messages, {
    budgetTokens: bounds.contextBudgetTokens,
    summarize: older => summarizeOlder(provider, older, input.signal),
  })

  const usage = { inputTokens: 0, outputTokens: 0, toolRounds: 0 }
  const trace = { toolsCalled: [] as string[], providerMs: [] as number[] }

  // Wall-clock each provider call (into trace.providerMs) around the retry logic —
  // the number your ops log wants is "how long did the model take this round".
  async function* timedChatStream(tools: ToolDef[]): AsyncGenerator<ProviderStreamEvent> {
    const t0 = Date.now()
    try {
      yield* chatStreamWithRetry(provider, {
        systemPrompt,
        messages,
        tools,
        maxOutputTokens: bounds.maxOutputTokens,
        reasoning: REASONING_EFFORT,
        signal: input.signal,
      })
    } finally {
      trace.providerMs.push(Date.now() - t0)
    }
  }

  for (let round = 0; round < bounds.maxToolRounds; round++) {
    checkElapsed(startedAt, bounds.timeoutMs)

    const result = yield* collectRound(timedChatStream(toolDefs))
    usage.inputTokens += result.usage.inputTokens
    usage.outputTokens += result.usage.outputTokens
    const content = assistantContent(result)
    const calls = result.calls

    // Branch on whether the model asked for tools, not on stopReason: a 'max_tokens' round
    // is a normal completion (a partial answer beats throwing it away), and any tool calls
    // it did finish are dispatched as usual.
    if (calls.length === 0) {
      // Reassign rather than mutate — `messages` was passed by reference into
      // this round's chatStream call args; pushing onto it in place would
      // retroactively change what that call's recorded args look like.
      messages = [...messages, { role: 'assistant', content }]
      yield { type: 'done', answer: result.text, usage, trace, appended: messages.slice(inputCount) }
      return
    }

    usage.toolRounds += 1
    trace.toolsCalled.push(...calls.map(call => call.name))
    yield { type: 'status', round: round + 1, tools: calls.map(call => call.name) }
    const outcomes = await Promise.all(calls.map(call => runTool(ctx, toolsByName, call, input.signal)))
    for (const [i, outcome] of outcomes.entries()) {
      yield { type: 'tool_end', id: calls[i]!.id, name: calls[i]!.name, ok: outcome.ok, result: outcome.result }
    }
    // Any text the model said alongside its tool calls stays on the same assistant message.
    messages = [...messages, { role: 'assistant', content, toolCalls: calls }, ...outcomes.map(o => o.message)]
  }

  // Round cap hit and the model still wants tools. By now it holds real tool
  // data, so force a final answer from that (tools omitted so it can't ask for
  // another round) instead of failing the request — a bounded-effort
  // completion, not a hang. This is deliberately a different code path from
  // the wall-clock check below: the timeout is reserved for a request that is
  // actually stuck, not one that simply used its full tool budget.
  checkElapsed(startedAt, bounds.timeoutMs)
  const final = yield* collectRound(timedChatStream([]))
  usage.inputTokens += final.usage.inputTokens
  usage.outputTokens += final.usage.outputTokens
  messages = [...messages, { role: 'assistant', content: assistantContent(final) }]
  yield { type: 'done', answer: final.text, usage, trace, appended: messages.slice(inputCount) }
}

interface Round {
  text: string
  reasoning: string
  /** Opaque provider token needed to replay the reasoning part (providers/types.ts). */
  reasoningSignature?: string | undefined
  calls: ToolCall[]
  usage: Usage
}

/** Drains one provider call, forwarding live events to the caller and accumulating the round. */
async function* collectRound(stream: AsyncIterable<ProviderStreamEvent>): AsyncGenerator<LoopEvent, Round> {
  const round: Round = {
    text: '',
    reasoning: '',
    calls: [],
    usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
  }
  for await (const event of stream) {
    if (event.type === 'text_delta') {
      round.text += event.delta
      yield { type: 'delta', text: event.delta }
    } else if (event.type === 'reasoning_delta') {
      round.reasoning += event.delta
      yield { type: 'reasoning', text: event.delta }
    } else if (event.type === 'tool_call_start') {
      yield { type: 'tool_start', id: event.id, name: event.name }
    } else if (event.type === 'tool_calls') {
      round.calls = event.calls
    } else if (event.type === 'done') {
      round.usage = event.usage
      round.reasoningSignature = event.reasoningSignature
    }
  }
  return round
}

/** The assistant message's parts: reasoning first (with its signature, so an adapter that
 *  needs it can replay it), then the visible text. */
function assistantContent(round: Round): ContentPart[] {
  const parts: ContentPart[] = []
  if (round.reasoning) {
    parts.push(
      round.reasoningSignature
        ? { type: 'reasoning', text: round.reasoning, signature: round.reasoningSignature }
        : { type: 'reasoning', text: round.reasoning },
    )
  }
  if (round.text) parts.push(...text(round.text))
  return parts
}

/** One provider.chat call summarizing dropped-context messages — the real `summarize` wired
 *  into context-window.ts's `fitToBudget` for this loop, and (exported) into memory.ts's
 *  `compactHistory` by the controller. */
export async function summarizeOlder(provider: ChatProvider, older: ChatMessage[], signal?: AbortSignal): Promise<string> {
  const transcript = older.map(m => `${m.role}: ${textOf(m)}`).join('\n')
  const result = await provider.chat({
    systemPrompt:
      'Summarize the following earlier conversation in 3-4 sentences, preserving names, numbers, and open questions:',
    messages: [{ role: 'user', content: text(transcript) }],
    tools: [],
    maxOutputTokens: 300,
    reasoning: 'none',
    signal,
  })
  return textOf(result)
}

function checkElapsed(startedAt: number, timeoutMs: number): void {
  if (Date.now() - startedAt > timeoutMs) {
    throw new AppError(504, 'The agent could not produce an answer in time', 'AGENT_TIMEOUT')
  }
}

/**
 * One retry on a transient provider failure. The retry replays only a provider call,
 * before anything has streamed, and tool execution happens after the provider stream
 * completes — so a retry never re-runs a tool. That makes it safe for read and propose
 * tools; a real `write` tool would need this revisited. Retries on any throw rather than
 * parsing a vendor-specific error shape (e.g. the OpenAI SDK's `APIError.status`):
 * loop.ts talks only to the `ChatProvider` interface, and re-running a provider call
 * is cheap regardless of cause.
 *
 * Streaming version: only retries when the failure happens before the first
 * event of this attempt has been yielded (i.e. nothing has reached the
 * client yet). Once any event has been forwarded, a later failure is NOT
 * retried — replaying mid-stream would duplicate output the caller already
 * has.
 */
async function* chatStreamWithRetry(provider: ChatProvider, args: ChatInput): AsyncGenerator<ProviderStreamEvent> {
  let producedAny = false
  try {
    for await (const event of provider.chatStream(args)) {
      producedAny = true
      yield event
    }
    return
  } catch (err) {
    if (producedAny) throw err
    // An abort is the caller giving up, not a transient failure — retrying
    // would just start a second doomed call instead of propagating the abort.
    if ((err as { name?: string }).name === 'AbortError' || args.signal?.aborted) throw err
  }

  await sleep(RETRY_JITTER_MIN_MS + Math.random() * (RETRY_JITTER_MAX_MS - RETRY_JITTER_MIN_MS))
  yield* provider.chatStream(args)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

interface ToolOutcome {
  message: ChatMessage
  ok: boolean
  result: unknown
}

async function runTool(
  ctx: AgentContext,
  toolsByName: Map<string, AgentTool>,
  call: ToolCall,
  signal?: AbortSignal,
): Promise<ToolOutcome> {
  // The model sees `Error: ...`; the tool_end event carries the same text as `{ error }`.
  const failed = (message: string): ToolOutcome => ({
    message: { role: 'tool', toolCallId: call.id, content: text(`Error: ${message}`) },
    ok: false,
    result: { error: message },
  })

  const tool = toolsByName.get(call.name)
  if (!tool) return failed(`unknown tool "${call.name}"`)

  const parsed = tool.inputSchema.safeParse(call.args)
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? 'Invalid arguments'
    return failed(`invalid arguments for "${call.name}": ${message}`)
  }

  // Tool contract: expected business failures are *returned* as `{ error: 'short plain
  // message' }` (the model sees it and can recover); throws are for bugs. A throw must
  // never fail the whole turn, so it becomes a generic tool message — never the raw error.
  try {
    const result = await tool.execute(ctx, parsed.data, { signal })
    return { message: { role: 'tool', toolCallId: call.id, content: text(JSON.stringify(result)) }, ok: true, result }
  } catch (err) {
    // TODO: log err with your logger
    return failed(`the tool "${call.name}" failed`)
  }
}
