// SCAFFOLD TEMPLATE (ai-agent-architecture skill) — adapt placeholders marked TODO to the target app.

import { useState } from 'react'
import type { Question } from '../protocol'

/**
 * ask_user card (runs-and-streaming.md §6): 1..8 questions, 2..4 options each. Answers go back as the
 * user's next ordinary message, `<question>\n-> <answer>` blocks, so history/retry/edit need no special path.
 * Collapses to "Answered" once a later user message exists.
 */
export function QuestionsCard({ questions, answered, onSubmit, disabled }: {
  questions: Question[]
  answered: boolean
  onSubmit: (message: string) => void
  disabled: boolean
}) {
  const [picked, setPicked] = useState<Record<string, number>>({})
  if (answered) return <p className="text-sm text-neutral-500">Answered</p>
  const complete = questions.every(q => picked[q.id] !== undefined)
  const submit = () =>
    onSubmit(questions.map(q => `${q.question}\n-> ${q.options[picked[q.id] ?? 0]?.label ?? ''}`).join('\n\n'))

  return (
    <form className="space-y-4 rounded-lg border border-neutral-300 p-4 dark:border-neutral-700" onSubmit={e => (e.preventDefault(), submit())}>
      {questions.map(q => (
        <fieldset key={q.id} className="space-y-2">
          <legend className="text-sm font-medium">{q.question}</legend>
          {q.options.map((o, i) => (
            <label key={o.label} className={`flex cursor-pointer items-start gap-2 rounded-md border p-2 text-sm ${picked[q.id] === i ? 'border-blue-500 bg-blue-50 dark:bg-blue-950' : 'border-neutral-200 dark:border-neutral-700'}`}>
              <input type="radio" name={q.id} className="mt-1" checked={picked[q.id] === i} onChange={() => setPicked(p => ({ ...p, [q.id]: i }))} />
              <span>
                {o.label}
                {q.recommended === i && <span className="ml-2 rounded bg-green-100 px-1.5 text-xs text-green-800 dark:bg-green-900 dark:text-green-100">Recommended</span>}
                {o.description && <span className="block text-neutral-500">{o.description}</span>}
              </span>
            </label>
          ))}
        </fieldset>
      ))}
      <button type="submit" disabled={!complete || disabled} className="rounded-md bg-blue-600 px-3 py-1.5 text-sm text-white disabled:opacity-50">
        Submit answers
      </button>
    </form>
  )
}
