// SCAFFOLD TEMPLATE (ai-agent-architecture skill) — adapt placeholders marked TODO to the target app.

/**
 * Background watcher (references/runs-and-streaming.md §9): an in-memory set of run ids started in
 * this tab. The conversation list is polled ONLY while the set is non-empty (no timer otherwise);
 * when a tracked run stops and it is not the visible chat, toast "Reply ready" with Open.
 */

import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { create } from 'zustand'
import type { Api } from '../api'

// run id -> when this tab started it (a list snapshot older than that proves nothing)
const useTracked = create<{ runs: Record<string, number> }>(() => ({ runs: {} }))

export const trackRun = (id: string) => useTracked.setState(s => ({ runs: { ...s.runs, [id]: Date.now() } }))
export const untrackRun = (id: string) =>
  useTracked.setState(s => {
    const { [id]: _done, ...runs } = s.runs
    return { runs }
  })

export interface Toast {
  id: string
  text: string
  conversationId: string
}

export const useToasts = create<{ toasts: Toast[] }>(() => ({ toasts: [] }))
export const dismissToast = (id: string) => useToasts.setState(s => ({ toasts: s.toasts.filter(t => t.id !== id) }))

const POLL_MS = 4000

export function useBackgroundRuns(api: Api, visibleId: string | null) {
  const runs = useTracked(s => s.runs)
  const count = Object.keys(runs).length
  const { data, dataUpdatedAt } = useQuery({
    queryKey: ['conversations', 'watch'],
    queryFn: () => api.listConversations({ limit: 50 }),
    enabled: count > 0,
    refetchInterval: count > 0 ? POLL_MS : false,
  })

  useEffect(() => {
    if (!data) return
    for (const [id, startedAt] of Object.entries(runs)) {
      const c = data.items.find(x => x.id === id)
      if (!c || c.running || dataUpdatedAt < startedAt) continue // not listed, still running, or stale snapshot
      untrackRun(id)
      if (id === visibleId) continue
      // The list item carries no failure flag (api-surface.md §2): read it from the transcript's lastFailedTurn.
      void api.transcript(id, false).then(t => t.lastFailedTurn, () => null).then(failed => {
        const text = failed ? 'Could not reply' : 'Reply ready'
        useToasts.setState(s => ({ toasts: [...s.toasts, { id: `${id}:${Date.now()}`, text: `${text}: ${c.title}`, conversationId: id }] }))
      })
    }
  }, [api, data, dataUpdatedAt, runs, visibleId])
}
