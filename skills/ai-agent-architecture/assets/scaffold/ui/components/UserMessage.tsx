// SCAFFOLD TEMPLATE (ai-agent-architecture skill) — adapt placeholders marked TODO to the target app.

import { useState } from 'react'
import { Pencil } from 'lucide-react'
import type { UserMessage as Msg } from '../protocol'
import { AttachmentChips } from './AttachmentChips'
import { useShell } from './ShellContext'

/** Edit replaces this message and everything after it (runs-and-streaming.md §8); needs the server id from `done`. */
export function UserMessage({ message: m }: { message: Msg }) {
  const { run } = useShell()
  const [draft, setDraft] = useState<string | null>(null)
  const canEdit = !!m.id && !run.running

  if (draft !== null && m.id) {
    const id = m.id
    return (
      <div className="ml-auto w-full max-w-[85%] space-y-2">
        <textarea autoFocus value={draft} onChange={e => setDraft(e.target.value)} rows={3} aria-label="Edit message"
          className="w-full resize-y rounded-lg border border-neutral-300 p-2 dark:border-neutral-700 dark:bg-neutral-900" />
        <div className="flex justify-end gap-2 text-sm">
          <button type="button" onClick={() => setDraft(null)} className="rounded-md border px-3 py-1">Cancel</button>
          <button type="button" disabled={!draft.trim() || draft.trim() === m.text} className="rounded-md bg-blue-600 px-3 py-1 text-white disabled:opacity-50"
            onClick={() => (void run.edit(id, draft), setDraft(null))}>Save and resend</button>
        </div>
      </div>
    )
  }
  return (
    <div className="group ml-auto flex max-w-[85%] flex-col items-end gap-1.5">
      <AttachmentChips items={m.attachments} />
      <p className="whitespace-pre-wrap rounded-2xl bg-blue-600 px-4 py-2 text-white">{m.text}</p>
      {canEdit && (
        <button type="button" aria-label="Edit message" onClick={() => setDraft(m.text)} className="opacity-0 transition-opacity focus:opacity-100 group-hover:opacity-100">
          <Pencil className="h-3.5 w-3.5 text-neutral-500" aria-hidden />
        </button>
      )}
    </div>
  )
}
