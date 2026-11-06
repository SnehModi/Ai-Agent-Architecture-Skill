// SCAFFOLD TEMPLATE (ai-agent-architecture skill) — adapt placeholders marked TODO to the target app.

import { useCallback, useEffect, useState } from 'react'
import type { Api } from '../api'
import { useAgentRun } from '../hooks/useAgentRun'
import { useBackgroundRuns } from '../hooks/useBackgroundRuns'
import type { ArtifactRef, Ref } from '../protocol'
import { setModel } from '../store'
import { ArtifactPanel } from './ArtifactPanel'
import { Composer, type ComposerProps } from './Composer'
import { ErrorBanner } from './ErrorBanner'
import { ModelPicker } from './ModelPicker'
import { ShellContext, type ComponentRenderers } from './ShellContext'
import { Sidebar } from './Sidebar'
import { Thread } from './Thread'
import { Toasts } from './Toasts'

export interface ChatShellProps extends ComposerProps {
  /** Create once (module scope or useMemo); a new object per render would abort the stream. */
  api: Api
  /** Current conversation id from the route; null = new chat. The shell never reads the router itself. */
  conversationId: string | null
  onSelect: (id: string | null) => void
  /** What the user is looking at ({kind,id}); sent with every turn, resolved server-side (inputs.md §1). */
  pageContext?: Ref
  /** Renderers for `component` events, by name; an unknown name shows the server's `fallbackText`. */
  componentRenderers?: ComponentRenderers
}

/**
 * Mount ONCE in a layout route, never in a page, so the stream and store survive route changes
 * (runs-and-streaming.md §9). Esc stops the run; Cmd/Ctrl+K starts a new chat.
 */
export function ChatShell({ api, conversationId, onSelect, pageContext, componentRenderers, searchMentions, slashCommands }: ChatShellProps) {
  const [artifact, setArtifact] = useState<ArtifactRef | null>(null)
  const [draftModel, setDraftModel] = useState<string>()
  const run = useAgentRun({ api, conversationId, onCreated: onSelect, draftModel, pageContext })
  useBackgroundRuns(api, conversationId)

  const model = conversationId ? run.model : draftModel

  const { stop, running } = run
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && running) void stop()
      if (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey)) (e.preventDefault(), onSelect(null))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [running, stop, onSelect])

  useEffect(() => setArtifact(null), [conversationId])

  const changeModel = useCallback((id: string) => {
    setDraftModel(id)
    if (!conversationId) return
    const prev = run.model
    setModel(conversationId, id)
    api.updateConversation(conversationId, { model: id }).catch(() => setModel(conversationId, prev ?? undefined)) // revert; the server allowlist said no or the network failed
  }, [api, conversationId, run.model])

  return (
    <ShellContext.Provider value={{ api, conversationId, run, openArtifact: setArtifact, pageContext, componentRenderers }}>
      <div className="flex h-full min-h-0 w-full bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
        <Sidebar selectedId={conversationId} onSelect={onSelect} />
        <main className="flex min-w-0 flex-1 flex-col">
          <header className="flex items-center justify-end p-2"><ModelPicker value={model} onChange={changeModel} disabled={run.running} /></header>
          <Thread />
          {run.failed && <ErrorBanner failed={run.failed} onRetry={() => void run.send(run.failed?.text ?? '')} onDismiss={run.dismissFailed} />}
          <Composer searchMentions={searchMentions} slashCommands={slashCommands} />
        </main>
        {artifact && <ArtifactPanel key={artifact.id} artifact={artifact} onClose={() => setArtifact(null)} />}
        <Toasts onOpen={onSelect} />
      </div>
    </ShellContext.Provider>
  )
}
