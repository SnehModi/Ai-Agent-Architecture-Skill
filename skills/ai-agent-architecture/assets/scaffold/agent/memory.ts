// SCAFFOLD TEMPLATE (ai-agent-architecture skill) — adapt placeholders marked TODO to the target app.

/**
 * Conversation compaction over persisted history (references/architecture.md §8
 * "Conversation memory"). Pure and provider-agnostic, like context-window.ts: `summarize`
 * is injected (wire loop.ts's `summarizeOlder` into it), and persistence is the caller's job —
 * this function returns what to persist (`newSummary`, `newSummarizedUpTo`) and never writes.
 *
 * Call it at turn load: `[summary?] + unsummarized messages + the new message`. If that
 * fits the budget it is returned as-is. Otherwise the most recent units are kept down to
 * HALF the budget (hysteresis: the next several turns fit without another summarizer
 * call) and everything older is summarized together with the prior summary.
 *
 * TODO: the caller owns the Conversation/Message storage from §8; `PersistedMessage.seq`
 * is the message's `seq` column.
 */

import { estimateTokens, summaryMessage, toUnits } from './context-window'
import type { ChatMessage } from './providers/types'

export interface PersistedMessage {
  seq: number
  message: ChatMessage
}

export interface CompactHistoryInput {
  /** Persisted rolling summary; covers every message with `seq < summarizedUpTo`. */
  summary?: string | undefined
  /** Messages NOT yet covered by `summary`, ascending by seq. Seqs may have gaps (§8). */
  history: PersistedMessage[]
  /** The user message for this turn (not yet persisted, so it has no seq). */
  newMessage: ChatMessage
}

export interface CompactHistoryOptions {
  budgetTokens: number
  /** Receives the prior summary (as a leading message, if any) followed by the messages
   *  being folded in; returns the new summary. May throw or return ''. */
  summarize: (messages: ChatMessage[]) => Promise<string>
}

export interface CompactedHistory {
  /** What to send to the loop as `userMessages`. */
  messages: ChatMessage[]
  /** Set only when compaction happened: persist both, in the same update as the turn. */
  newSummary?: string
  newSummarizedUpTo?: number
}

export async function compactHistory(
  input: CompactHistoryInput,
  opts: CompactHistoryOptions,
): Promise<CompactedHistory> {
  const prior = input.summary ? [summaryMessage(input.summary)] : []
  const all = [...input.history.map(h => h.message), input.newMessage]
  const uncompacted: CompactedHistory = { messages: [...prior, ...all] }
  if (estimateTokens(uncompacted.messages) <= opts.budgetTokens) return uncompacted

  // Keep the most recent units that fit in half the budget. The newest unit is always
  // kept, even if it alone is over — better a slight overrun than no usable transcript.
  // toUnits never splits an assistant tool-call message from its tool results.
  const units = toUnits(all)
  let budgetLeft = Math.floor(opts.budgetTokens / 2)
  let keepFrom = units.length
  while (keepFrom > 0) {
    const tokens = estimateTokens(units[keepFrom - 1]!)
    if (keepFrom < units.length && tokens > budgetLeft) break
    budgetLeft -= tokens
    keepFrom -= 1
  }
  const dropped = units.slice(0, keepFrom).flat()
  if (dropped.length === 0) return uncompacted

  let newSummary = ''
  try {
    newSummary = (await opts.summarize([...prior, ...dropped])).trim()
  } catch {
    // fall through: a failed summary means no compaction, never a failed turn
  }
  // No compaction: the loop's fitToBudget (context-window.ts) is the safety net.
  if (!newSummary) return uncompacted

  // `dropped` is a prefix of `all`, and the new message is always kept, so the first kept
  // message is either a persisted one or the new one (whose seq is after the last persisted).
  const first = input.history[dropped.length]
  const newSummarizedUpTo = first ? first.seq : input.history[input.history.length - 1]!.seq + 1
  return {
    messages: [summaryMessage(newSummary), ...units.slice(keepFrom).flat()],
    newSummary,
    newSummarizedUpTo,
  }
}
