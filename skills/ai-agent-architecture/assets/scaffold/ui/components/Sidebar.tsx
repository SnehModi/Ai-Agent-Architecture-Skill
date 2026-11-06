// SCAFFOLD TEMPLATE (ai-agent-architecture skill) — adapt placeholders marked TODO to the target app.

import { useEffect, useRef, useState } from 'react'
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Pencil, Pin, Plus, Search, Trash2 } from 'lucide-react'
import { userCopy } from '../api'
import type { Conversation } from '../protocol'
import { dropConversation } from '../store'
import { useShell } from './ShellContext'

function Row({ c, selected, onSelect, onDeleted }: { c: Conversation; selected: boolean; onSelect: () => void; onDeleted: () => void }) {
  const { api } = useShell()
  const qc = useQueryClient()
  const [title, setTitle] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const refresh = () => qc.invalidateQueries({ queryKey: ['conversations'] })
  const settings = { onSuccess: () => (setErr(null), refresh()), onError: (e: unknown) => setErr(userCopy(e)) }
  const patch = useMutation({ mutationFn: (p: { title?: string; pinned?: boolean }) => api.updateConversation(c.id, p), ...settings })
  const del = useMutation({ mutationFn: () => api.deleteConversation(c.id), ...settings, onSuccess: () => (dropConversation(c.id), onDeleted(), refresh()) })
  const icon = 'rounded p-1 text-neutral-500 hover:bg-neutral-200 dark:hover:bg-neutral-700'

  return (
    <li className={`group rounded-md ${selected ? 'bg-neutral-200 dark:bg-neutral-800' : 'hover:bg-neutral-100 dark:hover:bg-neutral-900'}`}>
      <div className="flex items-center gap-1 px-2 py-1.5">
        {title !== null ? (
          <input autoFocus value={title} aria-label="Rename conversation" className="min-w-0 flex-1 rounded border px-1 text-sm dark:bg-neutral-900"
            onChange={e => setTitle(e.target.value)} onBlur={() => setTitle(null)}
            onKeyDown={e => {
              if (e.key === 'Escape') setTitle(null)
              if (e.key === 'Enter' && title.trim()) (patch.mutate({ title: title.trim() }), setTitle(null))
            }} />
        ) : (
          <button type="button" onClick={onSelect} aria-current={selected ? 'page' : undefined} className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm">
            {c.running && <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-blue-500" aria-label="Replying" />}
            <span className="truncate">{c.title || 'New chat'}</span>
          </button>
        )}
        <button type="button" aria-label={c.pinned ? 'Unpin' : 'Pin'} aria-pressed={c.pinned} className={`${icon} ${c.pinned ? '' : 'opacity-0 focus:opacity-100 group-hover:opacity-100'}`} onClick={() => patch.mutate({ pinned: !c.pinned })}>
          <Pin className={`h-3.5 w-3.5 ${c.pinned ? 'fill-current' : ''}`} aria-hidden />
        </button>
        <button type="button" aria-label="Rename" className={`${icon} opacity-0 focus:opacity-100 group-hover:opacity-100`} onClick={() => setTitle(c.title)}><Pencil className="h-3.5 w-3.5" aria-hidden /></button>
        <button type="button" aria-label="Delete" disabled={del.isPending} className={`${icon} opacity-0 focus:opacity-100 group-hover:opacity-100`}
          onClick={() => window.confirm(`Delete "${c.title || 'New chat'}"?`) && del.mutate()}><Trash2 className="h-3.5 w-3.5" aria-hidden /></button>
      </div>
      {err && <p role="alert" className="px-2 pb-1 text-xs text-red-700 dark:text-red-400">{err}</p>}
    </li>
  )
}

/** Server returns pinned first, then newest first. Search is server-side (debounced), never a client filter. */
export function Sidebar({ selectedId, onSelect }: { selectedId: string | null; onSelect: (id: string | null) => void }) {
  const { api } = useShell()
  const [input, setInput] = useState('')
  const [q, setQ] = useState('')
  const sentinel = useRef<HTMLLIElement>(null)

  useEffect(() => {
    const t = setTimeout(() => setQ(input.trim()), 300)
    return () => clearTimeout(t)
  }, [input])

  const list = useInfiniteQuery({
    queryKey: ['conversations', { q }],
    queryFn: ({ pageParam }) => api.listConversations({ q, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: last => last.nextCursor ?? undefined,
  })
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = list

  useEffect(() => {
    const el = sentinel.current
    if (!el || !hasNextPage) return
    const io = new IntersectionObserver(([e]) => e?.isIntersecting && !isFetchingNextPage && void fetchNextPage())
    io.observe(el)
    return () => io.disconnect()
  }, [hasNextPage, isFetchingNextPage, fetchNextPage])

  const rows = list.data?.pages.flatMap(p => p.items) ?? []
  return (
    <nav aria-label="Conversations" className="flex h-full w-64 shrink-0 flex-col gap-2 border-r border-neutral-200 p-2 dark:border-neutral-800">
      <button type="button" onClick={() => onSelect(null)} className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-900">
        <Plus className="h-4 w-4" aria-hidden />New chat
      </button>
      <label className="flex items-center gap-2 rounded-md border px-2 py-1 dark:border-neutral-700">
        <Search className="h-4 w-4 text-neutral-500" aria-hidden />
        <input value={input} onChange={e => setInput(e.target.value)} placeholder="Search chats" aria-label="Search chats" className="min-w-0 flex-1 bg-transparent text-sm outline-none" />
      </label>
      <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
        {list.isPending && [0, 1, 2, 3].map(i => <li key={i} role="status" aria-label="Loading" className="h-8 animate-pulse rounded bg-neutral-200 dark:bg-neutral-800" />)}
        {rows.map(c => <Row key={c.id} c={c} selected={c.id === selectedId} onSelect={() => onSelect(c.id)} onDeleted={() => c.id === selectedId && onSelect(null)} />)}
        {list.isSuccess && rows.length === 0 && <li className="px-2 py-1 text-sm text-neutral-500">{q ? 'No matching chats' : 'No chats yet'}</li>}
        {isFetchingNextPage && <li className="h-8 animate-pulse rounded bg-neutral-200 dark:bg-neutral-800" />}
        <li ref={sentinel} aria-hidden className="h-px" />
      </ul>
      {list.isError && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {userCopy(list.error)} <button type="button" className="underline" onClick={() => void list.refetch()}>Retry</button>
        </p>
      )}
    </nav>
  )
}
