// SCAFFOLD TEMPLATE (ai-agent-architecture skill) — adapt placeholders marked TODO to the target app.

/**
 * Wire + view types for the chat UI. The SSE vocabulary mirrors references/runs-and-streaming.md §4
 * exactly: the client sees a small sanitized set of events, never raw tool results.
 */

// ---- SSE events (runs-and-streaming.md §4) -------------------------------------------------

export type StepState = 'running' | 'done' | 'error'

export interface StepData {
  id: string // the tool call id; running -> done|error share it, so steps upsert by id
  label: string
  state: StepState
  detail?: string
}

/** ask_user payload (runs-and-streaming.md §6): 1..8 questions, 2..4 options each. */
export interface Question {
  id: string
  question: string
  options: { label: string; description?: string }[]
  recommended?: number // index into options
}

/** Artifact kinds (rich-output.md §2); `html` is off by default server-side. */
export type ArtifactKind = 'markdown' | 'code' | 'table' | 'chart' | 'html'

export interface ArtifactRef {
  id: string
  kind: ArtifactKind
  title: string
  version: number
}

/** Generative UI spec (rich-output.md §3); props are validated server-side, the client renders by `component` name. */
export interface ComponentSpec {
  id: string
  component: string
  props: Record<string, unknown>
  sourceRefs?: { id: string; label: string; url?: string }[]
  fallbackText: string // shown when `component` is not in the client's registry
}

/** An `act`-tier change that can be undone until `expiresAt` (trust.md §4). */
export interface ActionRef {
  id: string
  label: string
  detail?: string
  expiresAt: string // ISO
}

export interface DoneData {
  answer: string
  messageId?: string // absent = stopped (not saved), unless an `error` event preceded it: failed persistence (§3)
  userMessageId?: string
  usage?: { inputTokens: number; outputTokens: number }
}

export type SseEvent =
  | { event: 'status'; data: { round: number } }
  | { event: 'reasoning'; data: { text: string } }
  | { event: 'delta'; data: { text: string } }
  | { event: 'step'; data: StepData }
  | { event: 'questions'; data: { questions: Question[] } }
  | { event: 'artifact'; data: ArtifactRef }
  | { event: 'component'; data: ComponentSpec }
  | { event: 'action'; data: ActionRef }
  | { event: 'followups'; data: { suggestions: string[] } }
  | { event: 'done'; data: DoneData }
  | { event: 'error'; data: { error: string; code?: string; retryable: boolean } }

export const SSE_EVENT_NAMES: ReadonlySet<string> = new Set([
  'status', 'reasoning', 'delta', 'step', 'questions', 'artifact', 'component', 'action', 'followups', 'done', 'error',
])

// ---- Domain ---------------------------------------------------------------------------------

export interface Attachment {
  id: string
  name: string
  mimeType: string
  size: number
  truncated?: boolean
}

export interface FailedTurn {
  text: string // text only: attachments/mentions/page context are not restored (inputs.md §2)
  error: string
  at: string
}

export interface Conversation {
  id: string
  title: string
  pinned: boolean
  running: boolean // derived server-side from activeRun.startedAt (§2)
  updatedAt: string
  model?: string | null
}

export type Phase = 'thinking' | 'streaming' | 'stopped' | 'error' | 'done'

interface MessageBase {
  key: string // stable client key; survives id back-fill
  id?: string // server id; needed for edit/regenerate, absent until `done`
}

export interface UserMessage extends MessageBase {
  role: 'user'
  text: string
  attachments: Attachment[]
}

export interface AssistantMessage extends MessageBase {
  role: 'assistant'
  phase: Phase
  text: string
  reasoning: string
  steps: StepData[] // upserted by id
  questions: Question[]
  artifacts: ArtifactRef[] // upserted by id (a new version replaces the ref)
  components: ComponentSpec[] // upserted by id
  actions: ActionRef[] // upserted by id
  followups: string[]
  error?: { message: string; retryable: boolean }
  feedback?: 1 | 0
}

export type Message = UserMessage | AssistantMessage

/** Persisted message as the transcript endpoint returns it (api-surface.md §2). */
export type TranscriptMessage =
  | { role: 'user'; id: string; text: string; attachments?: Attachment[] }
  | {
      role: 'assistant'
      id: string
      text: string
      steps?: StepData[]
      questions?: Question[]
      artifacts?: ArtifactRef[]
      components?: ComponentSpec[]
      actions?: ActionRef[]
      followups?: string[]
      feedback?: 1 | 0
    }

export interface Transcript {
  messages: TranscriptMessage[]
  running: boolean
  lastFailedTurn: FailedTurn | null
  inFlightText?: string // the running turn's user text (persisted only when the turn is saved)
  model?: string | null
}

// ---- Requests -------------------------------------------------------------------------------

export interface Ref {
  kind: string
  id: string
}

export interface TurnRequest {
  content: string
  pageContext?: Ref // what the user is looking at; server resolves the label (inputs.md §1)
  mentions?: Ref[] // capped server-side (~5)
  attachmentIds?: string[]
  replaceFrom?: string // a USER message id: it and everything after are replaced (§8)
}

export interface MentionHit extends Ref {
  label: string
}

// ---- Proposals (proposals.md §3-§7) -----------------------------------------------------------

export type ProposalStatus = 'pending' | 'accepted' | 'rejected' | 'superseded'

/** The preview is server-computed (proposals.md §4); this is the canonical generic shape (api-surface.md §4). */
export interface PreviewLine {
  id: string
  label: string
  value: string
  change: 'added' | 'changed' | 'unchanged' | 'removed'
  editable: boolean
}

export interface Proposal {
  id: string
  messageId?: string
  kind: string
  status: ProposalStatus
  editCount: number
  preview: { title: string; lines: PreviewLine[]; totals?: { label: string; value: string }[]; before?: unknown } // `before` is the server's stale-check snapshot; ignored here
  resultId?: string
}

// ---- Misc -------------------------------------------------------------------------------------

export interface Artifact extends ArtifactRef {
  body: string // text, or JSON for table/chart (api-surface.md §7)
  language?: string
  versions: number[]
}

export interface ModelOption {
  id: string
  label: string
  default: boolean
}

export interface SlashCommand {
  name: string
  description: string
  template: string // replaces the composer text when picked
}
