// SCAFFOLD TEMPLATE (ai-agent-architecture skill) — adapt placeholders marked TODO to the target app.

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowDown } from 'lucide-react'
import { AssistantMessage } from './AssistantMessage'
import { EmptyState } from './EmptyState'
import { useShell } from './ShellContext'
import { UserMessage } from './UserMessage'

const NEAR_BOTTOM_PX = 80

/** Message list. Follows the stream only while the user is at the bottom; otherwise offers "Jump to latest". */
export function Thread() {
  const { run, conversationId } = useShell()
  const ref = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const [away, setAway] = useState(false)

  const toBottom = () => {
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
    pinned.current = true
    setAway(false)
  }
  const onScroll = () => {
    const el = ref.current
    if (!el) return
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX
    setAway(!pinned.current)
  }

  useEffect(toBottom, [conversationId]) // a different chat starts at the latest message
  useLayoutEffect(() => {
    if (pinned.current && ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [run.messages])

  const lastUser = run.messages.reduce((acc, m, i) => (m.role === 'user' ? i : acc), -1)

  if (conversationId && !run.loaded) {
    if (run.loadError) {
      return (
        <div role="alert" className="flex-1 p-6 text-sm text-red-700 dark:text-red-400">
          {run.loadError} <button type="button" className="underline" onClick={run.reload}>Retry</button>
        </div>
      )
    }
    return (
      <div className="flex-1 space-y-4 p-6" role="status" aria-label="Loading conversation">
        {[40, 64, 52].map(w => <div key={w} className="h-4 animate-pulse rounded bg-neutral-200 dark:bg-neutral-800" style={{ width: `${w}%` }} />)}
      </div>
    )
  }
  if (run.messages.length === 0) return <EmptyState />

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={ref} onScroll={onScroll} role="log" aria-label="Conversation" className="h-full space-y-6 overflow-y-auto p-4">
        {run.messages.map((m, i) =>
          m.role === 'user'
            ? <UserMessage key={m.key} message={m} />
            : <AssistantMessage key={m.key} message={m} answered={i < lastUser} />)}
      </div>
      {away && (
        <button type="button" onClick={toBottom} className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border bg-white px-3 py-1 text-sm shadow dark:bg-neutral-900">
          <ArrowDown className="h-4 w-4" aria-hidden />Jump to latest
        </button>
      )}
    </div>
  )
}
