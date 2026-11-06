// SCAFFOLD TEMPLATE (ai-agent-architecture skill) — adapt placeholders marked TODO to the target app.

/**
 * AgentContext — everything a tool needs about "who is asking, and about what"
 * without ever trusting the model for it (references/architecture.md §4 "AgentContext").
 *
 * `scope.entityId` is set by the controller from server-side state (a URL param, a
 * session, an auth claim) — never from anything the model outputs — so the model can
 * never request another entity's data while one is pinned. Leaving `entityId` optional
 * lets an "unpinned" mode (the model picks the entity itself, e.g. after a search tool)
 * slot in later without changing this interface — see tools/example-tool.ts's
 * requireEntityId for how a tool honours whichever mode is active.
 */

// TODO: replace with the app's real role type (e.g. `import type { Role } from
// '@your-org/types'`). Left as a plain string so this scaffold compiles standalone.
export type Role = string

export interface AgentContext {
  userId: string
  role: Role
  scope: {
    entityId?: string
  }
  // Set by the controller from the URL/session, never by the model.
  conversationId?: string
  /** Sub-agent nesting depth (references/multi-agent.md §4). Unset/0 for a user turn; a
   *  delegate tool sets 1 on the child context and refuses to run when already ≥ 1. */
  depth?: number
}

/**
 * TODO: replace with the app's real application-error type (the common pattern is
 * `AppError(statusCode, message, code)` thrown from services/repositories and turned
 * into a safe HTTP response by a central error-handler middleware — see e.g. Express's
 * error-handling middleware convention). A minimal local class is defined here instead
 * of importing one so the scaffold has no dangling import; swap this for the real
 * import once the app's error-handler exists, and delete this class.
 */
export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code?: string,
  ) {
    super(message)
    this.name = 'AppError'
  }
}
