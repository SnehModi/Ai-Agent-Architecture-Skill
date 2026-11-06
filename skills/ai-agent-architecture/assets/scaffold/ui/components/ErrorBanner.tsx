// SCAFFOLD TEMPLATE (ai-agent-architecture skill) — adapt placeholders marked TODO to the target app.

import type { FailedTurn } from '../protocol'

/**
 * Shown after a reload for the server's `lastFailedTurn` (runs-and-streaming.md §7). Server error text is
 * already a fixed safe string. Retry resends the text only: attachments, mentions and page context are not
 * restored, so say so.
 */
export function ErrorBanner({ failed, onRetry, onDismiss }: { failed: FailedTurn; onRetry: () => void; onDismiss: () => void }) {
  return (
    <div role="alert" className="mx-4 mb-2 flex items-start gap-3 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-100">
      <div className="min-w-0 flex-1">
        <p className="font-medium">{failed.error}</p>
        <p className="truncate text-red-800 dark:text-red-200">Your message: {failed.text}</p>
        <p className="text-xs text-red-700 dark:text-red-300">Retry resends the text only. Re-attach any files.</p>
      </div>
      <button type="button" onClick={onRetry} className="rounded-md border border-red-400 px-2 py-1">Retry</button>
      <button type="button" onClick={onDismiss} className="rounded-md px-2 py-1 hover:bg-red-100 dark:hover:bg-red-900">Dismiss</button>
    </div>
  )
}
