// SCAFFOLD TEMPLATE (ai-agent-architecture skill) — adapt placeholders marked TODO to the target app.

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Copy, Download, X } from 'lucide-react'
import { userCopy } from '../api'
import type { Artifact, ArtifactKind, ArtifactRef } from '../protocol'
import { Chart, parseChart } from './Chart'
import { useShell } from './ShellContext'
import { StreamingMarkdown } from './StreamingMarkdown'

const EXT: Record<ArtifactKind, string> = { markdown: 'md', code: 'txt', table: 'csv', chart: 'json', html: 'html' }

function parseTable(body: string): { columns: string[]; rows: string[][] } | null {
  try {
    // Canonical body (api-surface.md §7): columns [{key,label}], rows [{[key]: cell}]
    const t = JSON.parse(body) as { columns?: { key?: unknown; label?: unknown }[]; rows?: Record<string, unknown>[] }
    if (!Array.isArray(t.columns) || !Array.isArray(t.rows)) return null
    const keys = t.columns.map(c => String(c.key))
    return { columns: t.columns.map(c => String(c.label ?? c.key)), rows: t.rows.map(r => keys.map(k => String(r?.[k] ?? ''))) }
  } catch {
    return null
  }
}

const csv = (t: { columns: string[]; rows: string[][] }) =>
  [t.columns, ...t.rows].map(r => r.map(c => `"${c.replace(/"/g, '""')}"`).join(',')).join('\n')

function Body({ a }: { a: Artifact }) {
  if (a.kind === 'markdown') return <StreamingMarkdown text={a.body} />
  if (a.kind === 'code') return <pre className="overflow-x-auto rounded-md bg-neutral-100 p-3 text-sm dark:bg-neutral-800"><code>{a.body}</code></pre>
  if (a.kind === 'html') {
    // Empty sandbox: no scripts, no same-origin, no forms, no navigation. The body is untrusted model/tool output.
    return <iframe title={a.title} sandbox="" srcDoc={a.body} className="h-full min-h-[24rem] w-full rounded-md border bg-white" />
  }
  if (a.kind === 'chart') {
    const c = parseChart(a.body)
    return c ? <Chart spec={c} /> : <p className="text-sm text-neutral-500">This chart could not be displayed.</p>
  }
  const t = parseTable(a.body)
  if (!t) return <p className="text-sm text-neutral-500">This table could not be displayed.</p>
  return (
    <div className="overflow-x-auto"><table className="min-w-full border-collapse text-sm">
      <thead><tr>{t.columns.map((c, i) => <th key={i} className="border px-2 py-1 text-left dark:border-neutral-700">{c}</th>)}</tr></thead>
      <tbody>{t.rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className="border px-2 py-1 dark:border-neutral-700">{c}</td>)}</tr>)}</tbody>
    </table></div>
  )
}

/** Side panel for rich outputs. Body is fetched by id (the `artifact` event carries only the ref). */
export function ArtifactPanel({ artifact, onClose }: { artifact: ArtifactRef; onClose: () => void }) {
  const { api } = useShell()
  const [picked, setPicked] = useState<number | null>(null)
  const version = picked ?? artifact.version // defaults to the ref's version; ChatShell keys the panel by artifact id so a pick resets
  const { data, isPending, error, refetch } = useQuery({
    queryKey: ['artifact', artifact.id, version],
    queryFn: () => api.artifact(artifact.id, version),
  })

  const copy = () => data && void navigator.clipboard.writeText(data.body).catch(() => undefined)
  const download = () => {
    if (!data) return
    const t = data.kind === 'table' ? parseTable(data.body) : null
    const url = URL.createObjectURL(new Blob([t ? csv(t) : data.body], { type: 'text/plain' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `${data.title.replace(/[^\w.-]+/g, '_') || 'artifact'}.${EXT[data.kind]}`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <aside aria-label={artifact.title} className="flex h-full w-[28rem] max-w-[45vw] shrink-0 flex-col border-l border-neutral-200 dark:border-neutral-800">
      <header className="flex items-center gap-2 border-b p-3 dark:border-neutral-800">
        <h2 className="min-w-0 flex-1 truncate font-medium">{artifact.title}</h2>
        {data && data.versions.length > 1 && (
          <select aria-label="Version" value={version} onChange={e => setPicked(Number(e.target.value))} className="rounded border bg-transparent px-1 text-sm">
            {data.versions.map(v => <option key={v} value={v}>v{v}</option>)}
          </select>
        )}
        <button type="button" aria-label="Copy" disabled={!data} onClick={copy}><Copy className="h-4 w-4" aria-hidden /></button>
        <button type="button" aria-label="Download" disabled={!data} onClick={download}><Download className="h-4 w-4" aria-hidden /></button>
        <button type="button" aria-label="Close" onClick={onClose}><X className="h-4 w-4" aria-hidden /></button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {isPending && <div role="status" aria-label="Loading" className="space-y-2">{[60, 80, 40].map(w => <div key={w} className="h-4 animate-pulse rounded bg-neutral-200 dark:bg-neutral-800" style={{ width: `${w}%` }} />)}</div>}
        {error && <p role="alert" className="text-sm text-red-700 dark:text-red-400">{userCopy(error)} <button type="button" className="underline" onClick={() => void refetch()}>Retry</button></p>}
        {data && <Body a={data} />}
      </div>
    </aside>
  )
}
