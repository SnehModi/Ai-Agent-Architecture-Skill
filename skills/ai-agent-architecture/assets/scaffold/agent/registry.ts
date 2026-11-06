// SCAFFOLD TEMPLATE (ai-agent-architecture skill) — adapt placeholders marked TODO to the target app.

/**
 * The agent tool contract + the permission-filtering registry
 * (references/architecture.md §5 "Tool contract + RBAC registry").
 *
 * Every tool conforms to `AgentTool`. `availableTools()` is the door: tools whose
 * `requiredPermission` the caller's role lacks are filtered out before the model ever
 * sees a tool definition, so it cannot attempt what it can't see. `execute()` re-checking
 * at dispatch time is the defence-in-depth layer — that re-check belongs to the loop
 * (loop.ts), not here.
 *
 * `toJsonSchema` converts a tool's zod `inputSchema` to the JSON Schema the provider layer
 * sends as `ToolDef.jsonSchema`. Keep tools' model-supplied arguments minimal anyway —
 * scope should come from AgentContext, not tool input.
 */

import { z } from 'zod'
import type { AgentContext, Role } from './context'

// TODO: replace with the app's real permission-key type (e.g. `import type {
// PermissionKey } from '@your-org/types'`). Left as a plain string so this scaffold
// compiles standalone.
export type PermissionKey = string

// TODO: replace with the app's real roles/keys, or wire `roleHasPermission` to the app's
// real RBAC check (e.g. a permission-matrix lookup or a DB query). An allow-all default is
// a silent security hole, so the scaffold denies until wired: an unknown role or an
// unlisted key gets no tools.
const MATRIX: Record<string, readonly PermissionKey[]> = {
  admin: ['entities:view', 'proposals:create'],
  viewer: ['entities:view'],
}

async function roleHasPermission(role: Role, key: PermissionKey): Promise<boolean> {
  const keys = MATRIX[role]
  return keys !== undefined && keys.includes(key)
}

export interface AgentTool {
  name: string
  /** What the model sees. */
  description: string
  /** Validates the model's tool-call arguments at runtime. */
  inputSchema: z.ZodType
  /** RBAC key the caller's role must hold for this tool to be offered at all. */
  requiredPermission: PermissionKey
  /**
   * 'read' = queries only. 'propose' = may only create a pending proposal record that a
   * human accepts or rejects out of band (references/proposals.md); it never touches
   * business data. 'write' = reserved seam for a mutating tool: the loop drops it (never
   * offered, never dispatched), so don't wire a real write tool through this contract.
   */
  mode: 'read' | 'propose' | 'write'
  /**
   * Pass `opts.signal` to any cancellable I/O (fetch, DB query with cancellation, etc.)
   * so that when the caller hits Stop, the tool actually stops instead of running on.
   */
  execute(ctx: AgentContext, input: unknown, opts?: { signal?: AbortSignal }): Promise<unknown>
}

/**
 * Filters `allTools` down to the ones `ctx.role` is permitted to use, per
 * each tool's `requiredPermission`.
 */
export async function availableTools(ctx: AgentContext, allTools: AgentTool[]): Promise<AgentTool[]> {
  const allowed = await Promise.all(allTools.map(tool => roleHasPermission(ctx.role, tool.requiredPermission)))
  return allTools.filter((_tool, i) => allowed[i])
}

/**
 * zod -> JSON Schema for `ToolDef.jsonSchema`. Uses zod v4's built-in `z.toJSONSchema`;
 * on zod v3 swap in `zodToJsonSchema` from the `zod-to-json-schema` package instead.
 * `io: 'input'` describes what the model must send (before defaults/transforms), and the
 * `$schema` URI is dropped because some providers reject unknown top-level keys.
 */
export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _drop, ...rest } = z.toJSONSchema(schema, { io: 'input' })
  return rest
}
