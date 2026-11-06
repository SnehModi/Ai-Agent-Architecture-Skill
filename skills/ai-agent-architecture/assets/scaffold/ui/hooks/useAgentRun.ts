// SCAFFOLD TEMPLATE (ai-agent-architecture skill) — adapt placeholders marked TODO to the target app.

/**
 * The one hook: send / stop / retry / edit / regenerate / re-attach for one conversation
 * (references/runs-and-streaming.md §1-§3, §7-§9). The streaming driver is module-level, not
 * component state, so a stream survives route changes; leaving a chat aborts only the client
 * fetch, the server Run keeps going (§9) and we re-attach when the user returns.
 */

import { useCallback, useEffect, useState } from 'react'
import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { ApiError, userCopy, type Api } from '../api'
import type { Attachment, FailedTurn, Ref, SseEvent, TurnRequest } from '../protocol'
import { applyEvent, clearFailed, fail, markStopped, selectConv, setLoadError, setModel, setTranscript, startTurn, useChatStore } from '../store'
import { trackRun, untrackRun } from './useBackgroundRuns'

const POLL_MS = 3000
const MAX_POLL_FAILURES = 3

/** One live client fetch (or poll loop) per conversation. */
const active = new Map<string, AbortController>()

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>(res => {
    const t = setTimeout(res, ms)
    signal.addEventListener('abort', () => (clearTimeout(t), res()), { once: true })
  })

/** Stream ended without `done`, or re-attach got 404: poll the transcript until not running (§2, §9). */
async function pollUntilIdle(api: Api, id: string, signal: AbortSignal) {
  for (let failures = 0; ; ) {
    await sleep(POLL_MS, signal)
    if (signal.aborted) return
    try {
      const t = await api.transcript(id)
      failures = 0
      if (!t.running) return setTranscript(id, t) // the saved reply, or lastFailedTurn
    } catch (e) {
      if (++failures >= MAX_POLL_FAILURES) return fail(id, userCopy(e), true)
    }
  }
}

async function drive(
  api: Api, qc: QueryClient, id: string, open: (s: AbortSignal) => Promise<AsyncIterable<SseEvent>>, attaching = false,
) {
  active.get(id)?.abort()
  const ac = new AbortController()
  active.set(id, ac)
  trackRun(id)
  let ended = false
  try {
    try {
      for await (const ev of await open(ac.signal)) {
        applyEvent(id, ev)
        if (ev.event === 'done' || ev.event === 'error') ended = true
      }
    } catch (e) {
      if (ac.signal.aborted) return
      if (!(attaching && e instanceof ApiError && e.status === 404)) {
        fail(id, userCopy(e), true)
        ended = true
      }
    }
    if (!ended && !ac.signal.aborted) await pollUntilIdle(api, id, ac.signal) // interrupted, or 404 on attach
  } finally {
    if (active.get(id) === ac) {
      active.delete(id)
      if (!ac.signal.aborted) {
        untrackRun(id)
        void qc.invalidateQueries({ queryKey: ['proposals', id] }) // cards appear under the new message (§9)
        void qc.invalidateQueries({ queryKey: ['conversations'] })
      }
    }
  }
}

/** On entering a chat: load the transcript; if a turn is running, re-attach (§9). */
async function enter(api: Api, qc: QueryClient, id: string) {
  if (active.has(id)) return // we are already streaming this one (e.g. just created)
  try {
    const t = await api.transcript(id)
    if (active.has(id)) return
    setTranscript(id, t)
    if (t.running) void drive(api, qc, id, s => api.attachRun(id, s), true)
  } catch (e) {
    setLoadError(id, userCopy(e))
  }
}

export interface SendExtras {
  pageContext?: Ref
  mentions?: Ref[]
  attachments?: Attachment[]
}

export function useAgentRun(opts: {
  api: Api
  conversationId: string | null
  /** Called with the new id when the first message creates a conversation: navigate to it. */
  onCreated: (id: string) => void
  /** Model for a conversation that does not exist yet. */
  draftModel?: string
  pageContext?: Ref
}) {
  const { api, conversationId, onCreated, draftModel, pageContext } = opts
  const qc = useQueryClient()
  const conv = useChatStore(selectConv(conversationId))
  const [createFailed, setCreateFailed] = useState<FailedTurn | null>(null) // no conversation exists yet, so it cannot live in the store

  useEffect(() => setCreateFailed(null), [conversationId])
  useEffect(() => {
    if (!conversationId) return
    void enter(api, qc, conversationId)
    return () => active.get(conversationId)?.abort() // client fetch only; the Run continues
  }, [api, qc, conversationId])

  const run = useCallback(async (req: TurnRequest, atts: Attachment[] = [], retry = false) => {
    let id = conversationId
    setCreateFailed(null)
    if (!id) {
      try {
        id = (await api.createConversation(draftModel)).id
      } catch (e) {
        return setCreateFailed({ text: req.content, error: userCopy(e), at: new Date().toISOString() }) // shown by ErrorBanner; the text is kept
      }
      setModel(id, draftModel)
      onCreated(id)
    }
    const cid = id
    startTurn(cid, req, atts, retry)
    await drive(api, qc, cid, s => api.sendTurn(cid, req, s))
  }, [api, qc, conversationId, draftModel, onCreated])

  const send = useCallback((text: string, x: SendExtras = {}) => {
    const content = text.trim()
    if (!content || conv.running) return
    return run({
      content,
      pageContext: x.pageContext ?? pageContext,
      mentions: x.mentions?.length ? x.mentions : undefined,
      attachmentIds: x.attachments?.length ? x.attachments.map(a => a.id) : undefined,
    }, x.attachments)
  }, [run, conv.running, pageContext])

  const stop = useCallback(async () => {
    if (!conversationId) return
    active.get(conversationId)?.abort() // abort the client fetch first, then tell the server (§3, §9)
    markStopped(conversationId)
    untrackRun(conversationId)
    try {
      await api.stopRun(conversationId)
    } catch (e) {
      fail(conversationId, userCopy(e), false)
    }
  }, [api, conversationId])

  const retry = useCallback(() => {
    if (conv.lastReq && !conv.running) return run(conv.lastReq, [], true)
  }, [conv.lastReq, conv.running, run])

  /** Edit a USER message: it and everything after are replaced (§8). */
  const edit = useCallback((userMessageId: string, text: string) => {
    if (!conv.running && text.trim()) return run({ content: text.trim(), replaceFrom: userMessageId })
  }, [conv.running, run])

  /** Regenerate an ASSISTANT message: resend the user message before it with replaceFrom. */
  const regenerate = useCallback((assistantKey: string) => {
    const i = conv.messages.findIndex(m => m.key === assistantKey)
    const user = conv.messages[i - 1]
    if (conv.running || user?.role !== 'user' || !user.id) return
    return run({ content: user.text, replaceFrom: user.id })
  }, [conv.messages, conv.running, run])

  const dismissFailed = useCallback(() => {
    if (!conversationId) return setCreateFailed(null)
    clearFailed(conversationId)
    void api.updateConversation(conversationId, { lastFailedTurn: null }).catch(() => undefined) // cleared on next success anyway
  }, [api, conversationId])

  const reload = useCallback(() => {
    if (!conversationId) return
    setLoadError(conversationId, null)
    void enter(api, qc, conversationId)
  }, [api, qc, conversationId])

  return { ...conv, failed: conv.failed ?? createFailed, send, stop, retry, edit, regenerate, dismissFailed, reload }
}

export type AgentRun = ReturnType<typeof useAgentRun>
