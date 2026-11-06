// SCAFFOLD TEMPLATE (ai-agent-architecture skill) — adapt placeholders marked TODO to the target app.

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, userCopy } from '../api'
import type { PreviewLine, Proposal } from '../protocol'
import { useShell } from './ShellContext'

const CHANGE: Record<NonNullable<PreviewLine['change']>, string> = {
  added: 'text-green-700 dark:text-green-400',
  changed: 'text-amber-700 dark:text-amber-400',
  removed: 'text-red-700 line-through dark:text-red-400',
  unchanged: '',
}

function Line({ line, canEdit, onSave }: { line: PreviewLine; canEdit: boolean; onSave: (v: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <tr>
      <td className="py-1 pr-4 text-neutral-500">{line.label}</td>
      <td className={`py-1 ${CHANGE[line.change ?? 'unchanged']}`}>
        {draft !== null ? (
          <input autoFocus value={draft} aria-label={`Edit ${line.label}`} className="w-full rounded border px-1 dark:bg-neutral-900"
            onChange={e => setDraft(e.target.value)} onBlur={() => setDraft(null)}
            onKeyDown={e => {
              if (e.key === 'Escape') setDraft(null)
              if (e.key === 'Enter') (onSave(draft), setDraft(null))
            }} />
        ) : canEdit && line.editable ? (
          <button type="button" className="underline decoration-dotted" onClick={() => setDraft(line.value)}>{line.value}</button>
        ) : line.value}
      </td>
    </tr>
  )
}

/** Card rendered from the STORED preview, never from model prose (proposals.md §6). */
export function ProposalCard({ proposal: p }: { proposal: Proposal }) {
  const { api, conversationId } = useShell()
  const qc = useQueryClient()
  const [note, setNote] = useState<string | null>(null)
  const [stale, setStale] = useState(false)
  const refetch = () => qc.invalidateQueries({ queryKey: ['proposals', conversationId] })

  const onError = (e: unknown) => {
    if (e instanceof ApiError && e.code === 'PROPOSAL_STALE') setStale(true)
    setNote(e instanceof ApiError && e.status === 409 ? 'This card was just changed. Showing the latest.' : userCopy(e)) // 409: lost a race (§3, §6)
    void refetch()
  }
  const decide = useMutation({
    mutationFn: (s: 'accepted' | 'rejected') => api.decideProposal(p.id, s),
    onSuccess: () => (setNote(null), refetch()),
    onError,
  })
  const edit = useMutation({
    mutationFn: (v: { lineId: string; value: string }) => api.editProposalLine(p.id, v.lineId, v.value),
    onSuccess: () => (setNote(null), refetch()),
    onError,
  })

  const pending = p.status === 'pending' && !stale
  const busy = decide.isPending || edit.isPending
  const badge = stale ? 'Stale' : p.status.charAt(0).toUpperCase() + p.status.slice(1)

  return (
    <section aria-label={p.preview.title} className="space-y-3 rounded-lg border border-neutral-300 p-4 dark:border-neutral-700">
      <header className="flex items-center justify-between">
        <h3 className="font-medium">{p.preview.title}</h3>
        <span className="rounded bg-neutral-100 px-2 py-0.5 text-xs dark:bg-neutral-800">{badge}</span>
      </header>
      <table className="w-full text-sm"><tbody>
        {p.preview.lines.map(l => <Line key={l.id} line={l} canEdit={pending && !busy} onSave={value => edit.mutate({ lineId: l.id, value })} />)}
      </tbody></table>
      {p.preview.totals?.map(t => (
        <div key={t.label} className="flex justify-between text-sm font-medium"><span>{t.label}</span><span>{t.value}</span></div>
      ))}
      {stale && <p className="text-sm text-amber-700 dark:text-amber-400">This changed since it was proposed. Ask for a fresh proposal.</p>}
      {p.status === 'superseded' && <p className="text-sm text-neutral-500">Replaced by a newer proposal.</p>}
      {note && <p role="alert" className="text-sm text-red-700 dark:text-red-400">{note}</p>}
      {pending && (
        <div className="flex gap-2">
          <button type="button" disabled={busy} onClick={() => decide.mutate('accepted')} className="rounded-md bg-blue-600 px-3 py-1.5 text-sm text-white disabled:opacity-50">
            {decide.isPending && decide.variables === 'accepted' ? 'Applying…' : 'Accept'}
          </button>
          <button type="button" disabled={busy} onClick={() => decide.mutate('rejected')} className="rounded-md border px-3 py-1.5 text-sm disabled:opacity-50">Reject</button>
        </div>
      )}
    </section>
  )
}

/** All cards anchored under one assistant message. Fetched once per conversation, shared by every message. */
export function Proposals({ messageId }: { messageId?: string }) {
  const { api, conversationId } = useShell()
  const { data } = useQuery({
    queryKey: ['proposals', conversationId],
    queryFn: () => api.listProposals(conversationId as string),
    enabled: !!conversationId && !!messageId,
    select: all => all.filter(p => p.messageId === messageId),
  })
  if (!data?.length) return null
  return <div className="space-y-3">{data.map(p => <ProposalCard key={p.id} proposal={p} />)}</div>
}
