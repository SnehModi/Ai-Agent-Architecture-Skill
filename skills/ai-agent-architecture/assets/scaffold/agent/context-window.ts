// SCAFFOLD TEMPLATE (ai-agent-architecture skill) — adapt placeholders marked TODO to the target app.

/**
 * Context-window management for the agent loop (references/architecture.md §7
 * "Context-window management"). Pure and provider-agnostic — `summarize` is injected
 * so this stays a small, fully unit-testable function; the loop wires a real provider
 * call into it (loop.ts's `summarizeOlder`).
 *
 * Token estimate is a chars/4 heuristic — good enough to decide "should we
 * trim", not a token-exact count (a real tokenizer would be a new dependency
 * for a budget check that only needs to be roughly right).
 */

import { text, type ChatMessage } from './providers/types'

const CHARS_PER_TOKEN = 4
// Fixed cost per image, regardless of size (references/inputs.md §3).
const TOKENS_PER_IMAGE = 1500

/** chars/4 over text, document and reasoning parts, plus a fixed cost per image. Exported
 *  so memory.ts uses the same estimator (references/inputs.md §3). */
export function estimateTokens(messages: ChatMessage[]): number {
  let chars = 0
  let images = 0
  for (const m of messages) {
    for (const p of m.content) {
      if (p.type === 'image') images += 1
      else chars += p.text.length
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN) + images * TOKENS_PER_IMAGE
}

/** The synthetic message that stands in for dropped history (shared with memory.ts). */
export function summaryMessage(summary: string): ChatMessage {
  return { role: 'user', content: text('[Earlier conversation summary]\n' + summary) }
}

/**
 * Groups an assistant tool-call message together with the tool-result
 * message(s) that immediately follow it, so a budget cut can never separate
 * the two — a kept assistant message referencing a call whose result isn't
 * in context (or vice versa) is a malformed transcript.
 */
export function toUnits(messages: ChatMessage[]): ChatMessage[][] {
  const units: ChatMessage[][] = []
  let i = 0
  while (i < messages.length) {
    const unit = [messages[i]]
    const isToolCall = messages[i].role === 'assistant' && (messages[i].toolCalls?.length ?? 0) > 0
    i += 1
    if (isToolCall) {
      while (i < messages.length && messages[i].role === 'tool') {
        unit.push(messages[i])
        i += 1
      }
    }
    units.push(unit)
  }
  return units
}

export interface FitToBudgetOptions {
  budgetTokens: number
  summarize: (older: ChatMessage[]) => Promise<string>
}

/**
 * Trims `messages` to fit `budgetTokens`: keeps the anchor (assumed to be
 * messages[0] — in practice always the conversation's first user message)
 * plus the most-recent messages that fit, and replaces whatever's dropped in
 * between with one synthetic summary message. Never splits a tool-call /
 * tool-result group; always keeps at least the most recent group even if it
 * alone doesn't fit, so the conversation can still continue.
 */
export async function fitToBudget(messages: ChatMessage[], opts: FitToBudgetOptions): Promise<ChatMessage[]> {
  if (messages.length === 0 || estimateTokens(messages) <= opts.budgetTokens) return messages

  const [anchor, ...rest] = messages
  const units = toUnits(rest)

  let budgetLeft = opts.budgetTokens - estimateTokens([anchor])
  const keptUnits: ChatMessage[][] = []
  for (let i = units.length - 1; i >= 0; i--) {
    const unitTokens = estimateTokens(units[i])
    if (keptUnits.length === 0 || unitTokens <= budgetLeft) {
      keptUnits.unshift(units[i])
      budgetLeft -= unitTokens
    } else {
      break
    }
  }

  const keptCount = keptUnits.reduce((n, u) => n + u.length, 0)
  const droppedCount = rest.length - keptCount
  if (droppedCount <= 0) return messages

  const dropped = rest.slice(0, droppedCount)
  const kept = keptUnits.flat()

  let summary: ChatMessage
  try {
    summary = summaryMessage(await opts.summarize(dropped))
  } catch {
    summary = { role: 'user', content: text('[Earlier conversation truncated]') }
  }

  return [anchor, summary, ...kept]
}
