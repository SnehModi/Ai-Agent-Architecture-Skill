// SCAFFOLD TEMPLATE (ai-agent-architecture skill) — adapt placeholders marked TODO to the target app.

/**
 * One minimal example tool showing the pattern every real tool follows
 * (references/architecture.md §5 "Tool contract + RBAC registry"). Copy this file per
 * tool, or per small group of related tools — don't build one giant tools.ts.
 *
 * `entityId` is optional for the same reason `AgentContext.scope.entityId` is optional
 * (context.ts): when the caller pins a scope (e.g. a single-record view), the model
 * never needs to supply it and can't override it; when scope is unpinned (e.g. a
 * cross-record assistant that searched first), the model supplies it. `requireEntityId`
 * always prefers the pinned scope value over the model's argument — that's the
 * guardrail: a pinned caller's scope can never be overridden by model input.
 *
 * Tools that return lists should project only the fields the model needs, cap the list
 * size, and return a `truncated: boolean` flag so the model knows when it saw a partial set.
 */

import { z } from 'zod'
import type { AgentTool } from '../registry'
import { AppError, type AgentContext } from '../context'

const ENTITY_ID_ARG = z.object({
  entityId: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      'ID of the record to look up. Omit when a record is already pinned by the current view; ' +
        'required otherwise (e.g. after a search tool in an unpinned/cross-record assistant).',
    ),
})

function requireEntityId(ctx: AgentContext, input: { entityId?: string | undefined }): string {
  const id = ctx.scope.entityId ?? input.entityId
  if (!id) {
    throw new AppError(500, 'Agent context is missing a pinned entity scope', 'INTERNAL_ERROR')
  }
  return id
}

// TODO: replace with the app's real repository/service call (e.g. `db.query(...)` or
// `someService.getById(id)`). Returns `null` on not-found, matching the shape below.
async function fetchEntity(id: string): Promise<{ id: string; name: string } | null> {
  return { id, name: `[DOMAIN entity] ${id}` }
}

export const getEntity: AgentTool = {
  name: 'get_entity',
  description:
    // TODO: describe what this tool returns in plain [DOMAIN] business language, and
    // point at sibling tools for data this one deliberately does NOT include — that
    // cross-referencing is what lets the model pick the right tool on the first try.
    'Returns the [DOMAIN] entity’s core identity fields. Does not include [related data] (use [other_tool] for that).',
  inputSchema: ENTITY_ID_ARG,
  // TODO: point at the app's real RBAC permission key.
  requiredPermission: 'entities:view',
  mode: 'read',
  async execute(ctx, input) {
    const id = requireEntityId(ctx, ENTITY_ID_ARG.parse(input))
    const entity = await fetchEntity(id)
    // Expected business failure: return it so the model can recover (see loop.ts runTool).
    if (!entity) return { error: 'Entity not found' }

    return {
      id: entity.id,
      name: entity.name,
    }
  },
}

/** The full toolset for this agent, registered together. TODO: append each new tool here. */
export const exampleTools: AgentTool[] = [getEntity]
