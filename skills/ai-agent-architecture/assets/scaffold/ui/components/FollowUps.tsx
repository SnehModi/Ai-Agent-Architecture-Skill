// SCAFFOLD TEMPLATE (ai-agent-architecture skill) — adapt placeholders marked TODO to the target app.

/** Suggested next prompts (`followups` event). Clicking sends the text as the next turn. */
export function FollowUps({ items, onPick, disabled }: { items: string[]; onPick: (text: string) => void; disabled: boolean }) {
  if (items.length === 0) return null
  return (
    <div className="flex flex-wrap gap-2">
      {items.map(s => (
        <button key={s} type="button" disabled={disabled} onClick={() => onPick(s)} className="rounded-full border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800">
          {s}
        </button>
      ))}
    </div>
  )
}
