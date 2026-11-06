// SCAFFOLD TEMPLATE (ai-agent-architecture skill) — adapt placeholders marked TODO to the target app.

import { AlertCircle, Check } from 'lucide-react'
import type { StepData } from '../protocol'

/**
 * Tool steps (runs-and-streaming.md §4-§5). Only the server-derived label and short detail are shown,
 * as plain text: raw tool results never reach the client.
 */
export function ActivityTrail({ steps }: { steps: StepData[] }) {
  if (steps.length === 0) return null
  return (
    <ul className="space-y-1 text-sm text-neutral-600 dark:text-neutral-400" aria-label="Activity">
      {steps.map(s => (
        <li key={s.id} className="flex items-center gap-2">
          {s.state === 'running' && <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-blue-500" aria-hidden />}
          {s.state === 'done' && <Check className="h-3.5 w-3.5 shrink-0 text-green-600" aria-hidden />}
          {s.state === 'error' && <AlertCircle className="h-3.5 w-3.5 shrink-0 text-red-600" aria-hidden />}
          <span className={s.state === 'running' ? 'animate-pulse' : ''}>{s.label}</span>
          {s.detail && <span className="text-neutral-500">· {s.detail}</span>}
          <span className="sr-only">{s.state}</span>
        </li>
      ))}
    </ul>
  )
}
