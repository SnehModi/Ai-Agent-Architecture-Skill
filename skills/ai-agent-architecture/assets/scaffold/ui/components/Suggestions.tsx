// SCAFFOLD TEMPLATE (ai-agent-architecture skill) — adapt placeholders marked TODO to the target app.

import { useEffect, useState } from 'react'
import type { MentionHit, SlashCommand } from '../protocol'

export type Trigger = { kind: 'mention' | 'slash'; query: string; start: number }

/** `@query` after whitespace, or `/query` at the very start of the input. */
export function findTrigger(text: string, caret: number): Trigger | null {
  const before = text.slice(0, caret)
  const m = /(?:^|\s)@([^\s@]*)$/.exec(before)
  if (m) return { kind: 'mention', query: m[1] ?? '', start: caret - (m[1]?.length ?? 0) - 1 }
  const s = /^\/(\S*)$/.exec(before)
  return s ? { kind: 'slash', query: s[1] ?? '', start: 0 } : null
}

export interface SuggestionItem {
  key: string
  label: string
  hint?: string
  mention?: MentionHit
  command?: SlashCommand
}

/** Items for the current trigger. Mention search always hits the backend, debounced 300 ms (never filter client-side). */
export function useSuggestions(
  trigger: Trigger | null,
  searchMentions?: (query: string) => Promise<MentionHit[]>,
  slashCommands: SlashCommand[] = [],
) {
  const [hits, setHits] = useState<{ q: string; items: MentionHit[] } | null>(null)
  const [failed, setFailed] = useState(false)
  const query = trigger?.kind === 'mention' ? trigger.query : null

  useEffect(() => {
    if (query === null || !searchMentions) return
    let stale = false
    const t = setTimeout(() => {
      searchMentions(query).then(
        items => !stale && (setHits({ q: query, items }), setFailed(false)),
        () => !stale && setFailed(true),
      )
    }, 300)
    return () => (stale = true, clearTimeout(t))
  }, [query, searchMentions])

  let items: SuggestionItem[] = []
  if (trigger?.kind === 'mention' && hits?.q === query) {
    items = hits.items.map(h => ({ key: `${h.kind}:${h.id}`, label: h.label, hint: h.kind, mention: h }))
  } else if (trigger?.kind === 'slash') {
    items = slashCommands
      .filter(c => c.name.startsWith(trigger.query))
      .map(c => ({ key: c.name, label: `/${c.name}`, hint: c.description, command: c }))
  }
  return { items, loading: trigger?.kind === 'mention' && !failed && hits?.q !== query, failed }
}

export function SuggestionList({ items, active, loading, failed, onPick }: {
  items: SuggestionItem[]
  active: number
  loading: boolean
  failed: boolean
  onPick: (i: SuggestionItem) => void
}) {
  return (
    <ul role="listbox" className="absolute bottom-full left-0 z-10 mb-1 max-h-56 w-72 overflow-y-auto rounded-lg border bg-white p-1 shadow-lg dark:border-neutral-700 dark:bg-neutral-900">
      {loading && <li className="h-7 animate-pulse rounded bg-neutral-200 dark:bg-neutral-800" aria-label="Searching" />}
      {failed && <li className="px-2 py-1 text-sm text-neutral-500">Search is unavailable right now.</li>}
      {!loading && !failed && items.length === 0 && <li className="px-2 py-1 text-sm text-neutral-500">No matches</li>}
      {items.map((it, i) => (
        <li key={it.key} role="option" aria-selected={i === active}
          onMouseDown={e => (e.preventDefault(), onPick(it))} // mousedown keeps textarea focus
          className={`flex cursor-pointer justify-between gap-2 rounded px-2 py-1 text-sm ${i === active ? 'bg-neutral-100 dark:bg-neutral-800' : ''}`}>
          <span className="truncate">{it.label}</span>
          {it.hint && <span className="truncate text-neutral-500">{it.hint}</span>}
        </li>
      ))}
    </ul>
  )
}
