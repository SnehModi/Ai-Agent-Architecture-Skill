// SCAFFOLD TEMPLATE (ai-agent-architecture skill) — adapt placeholders marked TODO to the target app.

import { createContext, useContext, type ComponentType } from 'react'
import type { Api } from '../api'
import type { AgentRun } from '../hooks/useAgentRun'
import type { ArtifactRef, ComponentSpec, Ref } from '../protocol'

/** Client registry for `component` events (rich-output.md §3), keyed by component name. */
export type ComponentRenderers = Record<string, ComponentType<Pick<ComponentSpec, 'props' | 'sourceRefs'>>>

/** What every message-level component needs, provided once by ChatShell instead of drilled. */
export interface Shell {
  api: Api
  conversationId: string | null
  run: AgentRun
  openArtifact: (ref: ArtifactRef) => void
  pageContext?: Ref
  componentRenderers?: ComponentRenderers
}

export const ShellContext = createContext<Shell | null>(null)

export function useShell(): Shell {
  const s = useContext(ShellContext)
  if (!s) throw new Error('Render inside <ChatShell>')
  return s
}
