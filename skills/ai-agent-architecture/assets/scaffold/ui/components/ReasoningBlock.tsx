// SCAFFOLD TEMPLATE (ai-agent-architecture skill) — adapt placeholders marked TODO to the target app.

import { useState } from 'react'
import { ChevronDown } from 'lucide-react'

/** Visible reasoning (runs-and-streaming.md §4). Open while thinking, auto-collapses on the first answer delta; the user's toggle wins. */
export function ReasoningBlock({ text, answering }: { text: string; answering: boolean }) {
  const [manual, setManual] = useState<boolean | null>(null)
  if (!text) return null
  const open = manual ?? !answering
  return (
    <div className="text-sm text-neutral-500">
      <button type="button" aria-expanded={open} onClick={() => setManual(!open)} className="inline-flex items-center gap-1 hover:text-neutral-800 dark:hover:text-neutral-200">
        <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? '' : '-rotate-90'}`} aria-hidden />
        {answering ? 'Thought' : 'Thinking…'}
      </button>
      {open && <p className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap border-l-2 border-neutral-200 pl-3 dark:border-neutral-700">{text}</p>}
    </div>
  )
}
