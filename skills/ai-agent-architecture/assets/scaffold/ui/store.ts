// SCAFFOLD TEMPLATE (ai-agent-architecture skill) — adapt placeholders marked TODO to the target app.

/**
 * Per-conversation message store. Module-level on purpose: the stream outlives any component, so
 * a route change never loses it (references/runs-and-streaming.md §9). Streamed text is buffered and
 * written to state once per animation frame, because per-chunk updates re-render markdown dozens
 * of times a second.
 */

import { create } from 'zustand'
import type {
  AssistantMessage, Attachment, FailedTurn, Message, SseEvent, Transcript, TranscriptMessage, TurnRequest,
} from './protocol'

export interface ConvState {
  messages: Message[]
  running: boolean
  loaded: boolean
  loadError: string | null // transcript fetch failed: Thread shows it with Retry instead of a skeleton forever
  failed: FailedTurn | null // from the server's lastFailedTurn; in-session failures show inline
  lastReq: TurnRequest | null // what retry() resends
  model: string | null
}

const EMPTY: ConvState = { messages: [], running: false, loaded: false, loadError: null, failed: null, lastReq: null, model: null }

export const useChatStore = create<{ byId: Record<string, ConvState> }>(() => ({ byId: {} }))

export const selectConv = (id: string | null) => (s: { byId: Record<string, ConvState> }) =>
  (id && s.byId[id]) || EMPTY

let n = 0
const newKey = () => `k${++n}`

function patch(id: string, fn: (c: ConvState) => ConvState) {
  useChatStore.setState(s => ({ byId: { ...s.byId, [id]: fn(s.byId[id] ?? EMPTY) } }))
}

function patchLast(id: string, fn: (m: AssistantMessage) => AssistantMessage) {
  patch(id, c => {
    const last = c.messages[c.messages.length - 1]
    if (!last || last.role !== 'assistant') return c
    return { ...c, messages: [...c.messages.slice(0, -1), fn(last)] }
  })
}

const blankAssistant = (): AssistantMessage => ({
  key: newKey(), role: 'assistant', phase: 'thinking', text: '', reasoning: '', steps: [], questions: [], artifacts: [], components: [], actions: [], followups: [],
})

function fromServer(m: TranscriptMessage): Message {
  if (m.role === 'user') return { key: m.id, id: m.id, role: 'user', text: m.text, attachments: m.attachments ?? [] }
  return {
    ...blankAssistant(), key: m.id, id: m.id, phase: 'done', text: m.text, steps: m.steps ?? [],
    questions: m.questions ?? [], artifacts: m.artifacts ?? [], components: m.components ?? [], actions: m.actions ?? [],
    followups: m.followups ?? [], feedback: m.feedback,
  }
}

/** Replace local state with the server's truth. If a turn is running, show it as thinking so re-attach can replay into it. */
export function setTranscript(id: string, t: Transcript) {
  const messages = t.messages.map(fromServer)
  if (t.running) {
    if (t.inFlightText) messages.push({ key: newKey(), role: 'user', text: t.inFlightText, attachments: [] })
    messages.push(blankAssistant())
  }
  patch(id, c => ({ ...c, messages, running: t.running, loaded: true, loadError: null, failed: t.running ? null : t.lastFailedTurn, model: t.model ?? null }))
}

/** Optimistic user message + thinking placeholder. `retry` first drops the failed pair; `replaceFrom` truncates (§8). */
export function startTurn(id: string, req: TurnRequest, attachments: Attachment[], retry = false) {
  patch(id, c => {
    let messages = c.messages
    if (retry) {
      const last = messages[messages.length - 1]
      if (last?.role === 'assistant') messages = messages.slice(0, -1)
      if (messages[messages.length - 1]?.role === 'user') messages = messages.slice(0, -1)
    }
    let atts = attachments
    const at = req.replaceFrom ? messages.findIndex(m => m.id === req.replaceFrom) : -1
    if (at >= 0) {
      const old = messages[at]
      if (old?.role === 'user' && atts.length === 0) atts = old.attachments // the server reuses them (inputs.md §1)
      messages = messages.slice(0, at)
    }
    return {
      ...c, running: true, loaded: true, failed: null, lastReq: req,
      messages: [...messages, { key: newKey(), role: 'user', text: req.content, attachments: atts }, blankAssistant()],
    }
  })
}

// ---- rAF-batched deltas ----------------------------------------------------------------------

const buf = new Map<string, { text: string; reasoning: string }>()
let raf = 0

export function flushDeltas() {
  if (raf) cancelAnimationFrame(raf)
  raf = 0
  for (const [id, b] of buf) {
    patchLast(id, m => ({
      ...m,
      reasoning: m.reasoning + b.reasoning,
      text: m.text + b.text,
      phase: b.text && m.phase === 'thinking' ? 'streaming' : m.phase,
    }))
  }
  buf.clear()
}

function pushDelta(id: string, kind: 'text' | 'reasoning', chunk: string) {
  const b = buf.get(id) ?? { text: '', reasoning: '' }
  b[kind] += chunk
  buf.set(id, b)
  if (!raf) raf = requestAnimationFrame(flushDeltas)
}

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const i = list.findIndex(x => x.id === item.id)
  return i < 0 ? [...list, item] : list.map((x, j) => (j === i ? item : x))
}

/** Apply one SSE event (§4) to the in-flight assistant message. */
export function applyEvent(id: string, ev: SseEvent) {
  if (ev.event === 'delta') return pushDelta(id, 'text', ev.data.text)
  if (ev.event === 'reasoning') return pushDelta(id, 'reasoning', ev.data.text)
  flushDeltas() // keep order: buffered text lands before whatever this event changes
  switch (ev.event) {
    case 'status':
      return
    case 'step':
      return patchLast(id, m => ({ ...m, steps: upsert(m.steps, ev.data) }))
    case 'questions':
      return patchLast(id, m => ({ ...m, questions: ev.data.questions }))
    case 'artifact':
      return patchLast(id, m => ({ ...m, artifacts: upsert(m.artifacts, ev.data) }))
    case 'component':
      return patchLast(id, m => ({ ...m, components: upsert(m.components, ev.data) }))
    case 'action':
      return patchLast(id, m => ({ ...m, actions: upsert(m.actions, ev.data) }))
    case 'followups':
      return patchLast(id, m => ({ ...m, followups: ev.data.suggestions }))
    case 'error':
      return fail(id, ev.data.error, ev.data.retryable)
    case 'done': {
      const { answer, messageId, userMessageId } = ev.data
      patch(id, c => {
        const messages = c.messages.map((m, i) => {
          if (m.role === 'user' && userMessageId && i === c.messages.length - 2) return { ...m, id: userMessageId }
          if (m.role === 'assistant' && i === c.messages.length - 1) {
            // Done without ids = stopped, not saved (§3, §9), unless an `error` event came first: failed persistence, keep the error + Retry.
            const phase = messageId ? ('done' as const) : m.phase === 'error' ? ('error' as const) : ('stopped' as const)
            return { ...m, id: messageId, text: answer || m.text, phase }
          }
          return m
        })
        return { ...c, messages, running: false }
      })
    }
  }
}

export function fail(id: string, message: string, retryable: boolean) {
  flushDeltas()
  patchLast(id, m => ({ ...m, phase: 'error', error: { message, retryable } }))
  patch(id, c => ({ ...c, running: false }))
}

export function markStopped(id: string) {
  flushDeltas()
  patchLast(id, m => (m.phase === 'thinking' || m.phase === 'streaming' ? { ...m, phase: 'stopped' } : m))
  patch(id, c => ({ ...c, running: false }))
}

export function setFeedback(id: string, key: string, feedback: 1 | 0 | undefined) {
  patch(id, c => ({ ...c, messages: c.messages.map(m => (m.key === key && m.role === 'assistant' ? { ...m, feedback } : m)) }))
}

export function setLoadError(id: string, loadError: string | null) {
  patch(id, c => ({ ...c, loadError }))
}

export function setModel(id: string, model: string | undefined) {
  patch(id, c => ({ ...c, model: model ?? null }))
}

export function clearFailed(id: string) {
  patch(id, c => ({ ...c, failed: null }))
}

export function dropConversation(id: string) {
  useChatStore.setState(s => {
    const { [id]: _gone, ...byId } = s.byId
    return { byId }
  })
}
