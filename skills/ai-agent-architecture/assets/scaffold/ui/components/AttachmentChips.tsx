// SCAFFOLD TEMPLATE (ai-agent-architecture skill) — adapt placeholders marked TODO to the target app.

import { Paperclip, X } from 'lucide-react'
import type { Attachment } from '../protocol'

/** File chips for sent messages (no onRemove) and for the composer (onRemove). */
export function AttachmentChips({ items, onRemove }: { items: Attachment[]; onRemove?: (id: string) => void }) {
  if (items.length === 0) return null
  return (
    <ul className="flex flex-wrap gap-1.5">
      {items.map(a => (
        <li key={a.id} className="inline-flex max-w-[14rem] items-center gap-1 rounded-full border border-neutral-300 bg-neutral-100 px-2 py-0.5 text-xs text-neutral-700 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200">
          <Paperclip className="h-3 w-3 shrink-0" aria-hidden />
          <span className="truncate">{a.name}</span>
          {a.truncated && <span className="text-neutral-500">(truncated)</span>}
          {onRemove && (
            <button type="button" aria-label={`Remove ${a.name}`} onClick={() => onRemove(a.id)} className="rounded hover:bg-neutral-300 dark:hover:bg-neutral-600">
              <X className="h-3 w-3" aria-hidden />
            </button>
          )}
        </li>
      ))}
    </ul>
  )
}
