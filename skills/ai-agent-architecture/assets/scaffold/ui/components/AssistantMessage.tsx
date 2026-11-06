// SCAFFOLD TEMPLATE (ai-agent-architecture skill) — adapt placeholders marked TODO to the target app.

import { useState } from 'react'
import { Check, Copy, FileText, RefreshCw, ThumbsDown, ThumbsUp } from 'lucide-react'
import { userCopy } from '../api'
import type { AssistantMessage as Msg } from '../protocol'
import { setFeedback } from '../store'
import { ActivityTrail } from './ActivityTrail'
import { ActionChip } from './ActionChip'
import { FollowUps } from './FollowUps'
import { Proposals } from './ProposalCard'
import { QuestionsCard } from './QuestionsCard'
import { ReasoningBlock } from './ReasoningBlock'
import { useShell } from './ShellContext'
import { StreamingMarkdown } from './StreamingMarkdown'

const btn = 'rounded p-1 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 disabled:opacity-40 dark:hover:bg-neutral-800 dark:hover:text-white'
const bar = 'animate-pulse rounded bg-neutral-200 dark:bg-neutral-800'

function Footer({ m }: { m: Msg }) {
  const { api, conversationId, run } = useShell()
  const [copied, setCopied] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const vote = async (value: 1 | 0) => {
    if (!m.id || !conversationId) return
    const prev = m.feedback
    const next = prev === value ? undefined : value // clicking again clears it (score: null)
    setFeedback(conversationId, m.key, next)
    try {
      await api.sendFeedback(m.id, next ?? null)
      setErr(null)
    } catch (e) {
      setFeedback(conversationId, m.key, prev)
      setErr(userCopy(e))
    }
  }
  const copy = () =>
    navigator.clipboard.writeText(m.text).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1500)), () => setErr('Could not copy.'))

  return (
    <div className="flex items-center gap-1">
      <button type="button" aria-label="Copy" className={btn} onClick={copy}>{copied ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}</button>
      <button type="button" aria-label="Good response" aria-pressed={m.feedback === 1} disabled={!m.id} className={btn} onClick={() => void vote(1)}><ThumbsUp className="h-4 w-4" aria-hidden /></button>
      <button type="button" aria-label="Bad response" aria-pressed={m.feedback === 0} disabled={!m.id} className={btn} onClick={() => void vote(0)}><ThumbsDown className="h-4 w-4" aria-hidden /></button>
      <button type="button" aria-label="Regenerate" disabled={!m.id || run.running} className={btn} onClick={() => void run.regenerate(m.key)}><RefreshCw className="h-4 w-4" aria-hidden /></button>
      {err && <span role="alert" className="text-xs text-red-700 dark:text-red-400">{err}</span>}
    </div>
  )
}

/** thinking placeholder -> streaming -> done (runs-and-streaming.md §9). `answered`: a later user message exists. */
export function AssistantMessage({ message: m, answered }: { message: Msg; answered: boolean }) {
  const { run, openArtifact, componentRenderers } = useShell()
  const live = m.phase === 'thinking' || m.phase === 'streaming'

  return (
    // aria-busy holds screen-reader announcements until the message settles, instead of re-reading every frame
    <article aria-live="polite" aria-busy={live} className="max-w-[90%] space-y-3">
      <ReasoningBlock text={m.reasoning} answering={!!m.text} />
      <ActivityTrail steps={m.steps} />
      {m.phase === 'thinking' && !m.text && !m.steps.length && !m.reasoning && (
        <div role="status" aria-label="Thinking" className="space-y-2"><div className={`h-3 w-48 ${bar}`} /><div className={`h-3 w-32 ${bar}`} /></div>
      )}
      {m.text && <StreamingMarkdown text={m.text} />}
      {m.phase === 'stopped' && <p className="text-sm text-neutral-500">Stopped. This reply was not saved.</p>}
      {m.phase === 'error' && <p role="alert" className="text-sm text-red-700 dark:text-red-400">{m.error?.message ?? 'Something went wrong.'}</p>}
      {(m.phase === 'stopped' || (m.phase === 'error' && m.error?.retryable)) && (
        <button type="button" disabled={run.running} onClick={() => void run.retry()} className="rounded-md border px-3 py-1 text-sm">Retry</button>
      )}
      {m.artifacts.map(a => (
        <button key={a.id} type="button" onClick={() => openArtifact(a)} className="flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800">
          <FileText className="h-4 w-4" aria-hidden />{a.title}<span className="text-neutral-500">v{a.version}</span>
        </button>
      ))}
      {m.components.map(c => {
        const Render = componentRenderers?.[c.component] // unknown (client older than server): plain-text fallback, never blank (rich-output.md §3)
        return Render ? <Render key={c.id} props={c.props} sourceRefs={c.sourceRefs} /> : <p key={c.id} className="text-sm">{c.fallbackText}</p>
      })}
      {m.actions.map(a => <ActionChip key={a.id} action={a} />)}
      <Proposals messageId={m.id} />
      {m.questions.length > 0 && <QuestionsCard questions={m.questions} answered={answered} disabled={run.running} onSubmit={t => void run.send(t)} />}
      {m.phase === 'done' && (
        <>
          <FollowUps items={answered ? [] : m.followups} disabled={run.running} onPick={t => void run.send(t)} />
          <Footer m={m} />
        </>
      )}
    </article>
  )
}
