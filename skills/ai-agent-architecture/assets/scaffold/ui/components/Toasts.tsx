// SCAFFOLD TEMPLATE (ai-agent-architecture skill) — adapt placeholders marked TODO to the target app.

import { dismissToast, useToasts } from '../hooks/useBackgroundRuns'

/** "Reply ready" toasts from useBackgroundRuns. TODO: swap for the app's toast system if it has one. */
export function Toasts({ onOpen }: { onOpen: (conversationId: string) => void }) {
  const toasts = useToasts(s => s.toasts)
  return (
    <div role="status" aria-live="polite" className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
      {toasts.map(t => (
        <div key={t.id} className="flex items-center gap-3 rounded-lg border bg-white px-4 py-2 text-sm shadow-lg dark:border-neutral-700 dark:bg-neutral-900">
          <span className="max-w-[16rem] truncate">{t.text}</span>
          <button type="button" className="font-medium text-blue-600 dark:text-blue-400" onClick={() => (onOpen(t.conversationId), dismissToast(t.id))}>Open</button>
          <button type="button" aria-label="Dismiss" onClick={() => dismissToast(t.id)}>×</button>
        </div>
      ))}
    </div>
  )
}
