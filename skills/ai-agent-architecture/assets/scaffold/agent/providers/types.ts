// SCAFFOLD TEMPLATE (ai-agent-architecture skill) — adapt placeholders marked TODO to the target app.

/**
 * ChatProvider — the ONE thing the agent loop (loop.ts) depends on for talking to a model
 * (see references/architecture.md §2 "Provider seam"). Deliberately not a third-party
 * SDK/agent-framework type: a small interface we own, so swapping vendors later is "one
 * new adapter file", never a change to the loop or tools.
 *
 * v2 of the seam. What changed from v1 and why:
 * - `content` is a list of parts, not a string: images/documents in, visible reasoning
 *   and interleaved text + tool calls out. Modern models say "let me check…" *and* call a
 *   tool in the same round; v1 could not represent that.
 * - `reasoning_delta` / `tool_call_start` stream events exist so the UI can show a live
 *   activity trail ("Thinking…", "Searching orders…") instead of a blank spinner.
 * - `done` carries a `stopReason` and cached-token usage, so the loop can tell "finished"
 *   from "cut off", and you can see whether prompt caching is working.
 */

export type ContentPart =
  | { type: 'text'; text: string }
  /** Visible reasoning summary (Anthropic thinking / OpenAI reasoning summary). Assistant
   *  only. `signature` is an opaque provider token some vendors need to replay the part
   *  on the next call; adapters set and consume it, nothing else reads it. */
  | { type: 'reasoning'; text: string; signature?: string }
  /** Inline image. `data` is base64; see references/inputs.md §2 for re-encoding at upload. */
  | { type: 'image'; mimeType: string; data: string }
  /** Extracted document text, already fenced as data (references/inputs.md §2). */
  | { type: 'document'; name: string; text: string }

export interface ToolCall {
  id: string
  name: string
  args: unknown
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool'
  content: ContentPart[]
  /** role === 'assistant': tool calls made in this message (may coexist with text parts). */
  toolCalls?: ToolCall[]
  /** role === 'tool': which call this is the result for. One tool message per call. */
  toolCallId?: string
}

export interface ToolDef {
  name: string
  description: string
  jsonSchema: Record<string, unknown> // JSON Schema object for the tool's input
}

export type StopReason = 'end' | 'tool_calls' | 'max_tokens'

export interface Usage {
  inputTokens: number
  outputTokens: number
  /** Input tokens served from the provider's prompt cache (0 if unsupported). Watch this:
   *  a stable system-prompt + tools prefix should make it most of `inputTokens` after
   *  the first turn (references/reliability.md). */
  cachedInputTokens: number
}

export interface ChatInput {
  systemPrompt: string
  messages: ChatMessage[]
  tools: ToolDef[]
  maxOutputTokens: number
  /** Reasoning effort for models that support it; adapters map or ignore it.
   *  Default 'low': most agent turns narrate tool data, they don't need deep reasoning. */
  reasoning?: 'none' | 'low' | 'medium' | 'high'
  /** Ask for a JSON object matching this schema instead of prose (structured output).
   *  Used by extraction/classification helpers, never by the main loop. Adapters that
   *  cannot enforce it fall back to instructing the model and validating after. */
  responseSchema?: Record<string, unknown>
  /** Aborts the in-flight provider call when the caller (e.g. a closed SSE
   *  connection) no longer wants the result. */
  signal?: AbortSignal | undefined
}

export interface ChatResult {
  /** Everything the model produced this call, in order: text, reasoning. */
  content: ContentPart[]
  toolCalls: ToolCall[]
  stopReason: StopReason
  usage: Usage
}

/**
 * Streamed provider events (references/architecture.md §3 "Provider adapter").
 * Order within one call: zero or more `reasoning_delta`, then any mix of `text_delta`
 * and `tool_call_start` (a round may contain both text AND tool calls), then exactly one
 * `tool_calls` if any calls were started (complete, parsed args), then exactly one `done`.
 */
export type ProviderStreamEvent =
  | { type: 'reasoning_delta'; delta: string }
  | { type: 'text_delta'; delta: string }
  /** Emitted as soon as the model names a tool, before its arguments finish streaming —
   *  lets the UI show "Searching…" immediately. */
  | { type: 'tool_call_start'; id: string; name: string }
  | { type: 'tool_calls'; calls: ToolCall[] }
  | { type: 'done'; stopReason: StopReason; usage: Usage; reasoningSignature?: string }

export interface ChatProvider {
  /** Which model this provider was resolved for (e.g. for traces and the model picker). */
  readonly model: string

  chat(input: ChatInput): Promise<ChatResult>

  /** Streaming counterpart of `chat` — see `ProviderStreamEvent`. `chat` is implemented
   *  on top of this so there is exactly one translation of the vendor's wire format. */
  chatStream(input: ChatInput): AsyncIterable<ProviderStreamEvent>
}

/** Convenience for the common case. */
export function text(t: string): ContentPart[] {
  return [{ type: 'text', text: t }]
}

/** The plain text of a message (reasoning excluded) — for transcripts, summaries, evals. */
export function textOf(message: Pick<ChatMessage, 'content'>): string {
  return message.content
    .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
    .map(p => p.text)
    .join('')
}
