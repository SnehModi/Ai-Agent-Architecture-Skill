// SCAFFOLD TEMPLATE (ai-agent-architecture skill) — adapt placeholders marked TODO to the target app.

import { useQuery } from '@tanstack/react-query'
import { useShell } from './ShellContext'

/** Server-allowlisted models only; the client never invents a model id. Per conversation (see ChatShell). */
export function ModelPicker({ value, onChange, disabled }: { value?: string | null; onChange: (id: string) => void; disabled?: boolean }) {
  const { api } = useShell()
  const { data, isPending, isError } = useQuery({ queryKey: ['models'], queryFn: () => api.models(), staleTime: 10 * 60_000 })

  if (isPending) return <div role="status" aria-label="Loading models" className="h-8 w-32 animate-pulse rounded bg-neutral-200 dark:bg-neutral-800" />
  if (isError || data.length < 2) return null // nothing to choose: hide rather than show a broken control
  return (
    <select aria-label="Model" value={value ?? (data.find(m => m.default) ?? data[0])?.id} disabled={disabled} onChange={e => onChange(e.target.value)}
      className="rounded-md border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700">
      {data.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
    </select>
  )
}
