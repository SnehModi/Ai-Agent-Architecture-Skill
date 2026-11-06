// SCAFFOLD TEMPLATE (ai-agent-architecture skill) — adapt placeholders marked TODO to the target app.

import { useEffect, useState } from 'react'
import { Undo2 } from 'lucide-react'
import { ApiError, userCopy } from '../api'
import type { ActionRef } from '../protocol'
import { useShell } from './ShellContext'

/** An applied `act`-tier change (trust.md §4). Undo is offered until `expiresAt`, then hidden. */
export function ActionChip({ action: a }: { action: ActionRef }) {
  const { api } = useShell()
  const [state, setState] = useState<'idle' | 'busy' | 'undone' | 'expired'>('idle')
  const [err, setErr] = useState<string | null>(null)
  const [, tick] = useState(0)
  const left = Date.parse(a.expiresAt) - Date.now()

  useEffect(() => {
    const ms = Date.parse(a.expiresAt) - Date.now()
    if (ms <= 0) return
    const t = setTimeout(() => tick(n => n + 1), ms) // re-render once the window closes so Undo disappears
    return () => clearTimeout(t)
  }, [a.expiresAt])

  const undo = async () => {
    setState('busy')
    setErr(null)
    try {
      await api.undoAction(a.id)
      setState('undone')
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) return setState('undone') // already undone elsewhere
      if (e instanceof ApiError && e.status === 410) return setState('expired')
      setState('idle')
      setErr(e instanceof ApiError && e.status === 422 ? 'This changed since, so it cannot be undone.' : userCopy(e))
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-1.5 text-sm">
      <span className="min-w-0 flex-1">{a.label}{a.detail && <span className="text-neutral-500"> {a.detail}</span>}</span>
      {state === 'undone' && <span className="text-neutral-500">Undone</span>}
      {(state === 'idle' || state === 'busy') && left > 0 && (
        <button type="button" disabled={state === 'busy'} onClick={() => void undo()} className="flex items-center gap-1 rounded px-2 py-0.5 hover:bg-neutral-100 disabled:opacity-50 dark:hover:bg-neutral-800">
          <Undo2 className="h-4 w-4" aria-hidden />Undo
        </button>
      )}
      {err && <span role="alert" className="w-full text-xs text-red-700 dark:text-red-400">{err}</span>}
    </div>
  )
}
