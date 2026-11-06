// SCAFFOLD TEMPLATE (ai-agent-architecture skill) — adapt placeholders marked TODO to the target app.

import { useQuery } from '@tanstack/react-query'
import { userCopy } from '../api'
import { useShell } from './ShellContext'

/** Title + 3-5 starter prompts from the server. Skeleton while loading; a failed fetch just hides the chips. */
export function EmptyState({ title = 'How can I help?' }: { title?: string }) { // TODO: app copy
  const { api, run, pageContext } = useShell()
  const { data, isPending, error } = useQuery({ queryKey: ['starters', pageContext], queryFn: () => api.starters(pageContext), staleTime: 5 * 60_000 })

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 p-6">
      <h2 className="text-2xl font-semibold">{title}</h2>
      <div className="grid w-full max-w-xl gap-2">
        {isPending && [0, 1, 2].map(i => <div key={i} role="status" aria-label="Loading suggestions" className="h-10 animate-pulse rounded-lg bg-neutral-200 dark:bg-neutral-800" />)}
        {data?.slice(0, 5).map(s => (
          <button key={s} type="button" onClick={() => void run.send(s)} className="rounded-lg border border-neutral-300 px-4 py-2 text-left text-sm hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800">
            {s}
          </button>
        ))}
        {error && <p className="text-center text-sm text-neutral-500">{userCopy(error)}</p>}
      </div>
    </div>
  )
}
