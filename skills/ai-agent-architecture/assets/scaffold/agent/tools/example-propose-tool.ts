// SCAFFOLD TEMPLATE (ai-agent-architecture skill) — adapt placeholders marked TODO to the target app.

/**
 * One minimal example propose tool (references/proposals.md). A propose tool never
 * touches business data: it only stores a pending proposal that a human accepts or
 * rejects out of band. The accept path (atomic claim, permission re-check, apply via the
 * same services as the normal UI) lives in references/proposals.md, not here.
 *
 * Identity comes from `ctx` only. Anything derived (totals, prices, etc.) is computed
 * server-side in `buildPreview()` — the model never supplies it.
 */

import { z } from 'zod'
import type { AgentTool } from '../registry'

const PROPOSE_ARGS = z.object({
  entityId: z.string().trim().min(1).max(64).describe('ID of the record the proposal is about.'),
  title: z.string().trim().min(1).max(120).describe('Short title for the proposed [DOMAIN] record.'),
  items: z
    .array(z.object({ refId: z.string().trim().min(1).max(64), quantity: z.number().int().min(1).max(1000) }))
    .min(1)
    .max(50)
    .describe('Line items to include. Quantities only — prices are computed server-side.'),
})

type ProposePayload = z.infer<typeof PROPOSE_ARGS>

// TODO: replace with the app's real preconditions check (e.g. the entity exists, the
// caller can act on it, referenced items are valid). Returns a short plain message on failure.
async function validatePreconditions(_userId: string, _payload: ProposePayload): Promise<string | null> {
  return null
}

// TODO: compute everything the human reviewer sees (totals, prices, resolved names) from
// trusted server-side data — never from model input.
async function buildPreview(payload: ProposePayload): Promise<{ summary: string; [key: string]: unknown }> {
  return { summary: `[DOMAIN] proposal "${payload.title}" with ${payload.items.length} item(s)` }
}

// TODO: replace with the app's real repository functions and trace lookup.
async function supersedePendingProposals(_conversationId: string): Promise<void> {}
async function createProposal(_data: {
  userId: string
  conversationId: string
  kind: string
  payload: unknown
  preview: unknown
  status: 'pending'
  traceId: string | undefined
}): Promise<{ id: string }> {
  return { id: 'proposal-id' }
}
function getActiveTraceId(): string | undefined {
  return undefined
}

export const proposeEntityChange: AgentTool = {
  name: 'propose_entity_change',
  description:
    // TODO: describe in plain [DOMAIN] language what this proposes, and say that nothing is
    // applied until the user accepts the proposal card.
    'Proposes a [DOMAIN] change for the user to review. Nothing is applied until the user accepts it.',
  inputSchema: PROPOSE_ARGS,
  // TODO: point at the app's real RBAC permission key.
  requiredPermission: 'proposals:create',
  mode: 'propose',
  async execute(ctx, input) {
    const payload = PROPOSE_ARGS.parse(input)
    if (!ctx.conversationId) return { error: 'No active conversation' }

    const problem = await validatePreconditions(ctx.userId, payload)
    if (problem) return { error: problem }

    const preview = await buildPreview(payload)

    // One pending card per conversation: a new proposal supersedes any earlier one.
    await supersedePendingProposals(ctx.conversationId)
    const proposal = await createProposal({
      userId: ctx.userId,
      conversationId: ctx.conversationId,
      kind: 'entity_change', // TODO: one kind per proposal type, matched by the accept path
      payload,
      preview,
      status: 'pending',
      traceId: getActiveTraceId(),
    })

    return { proposalId: proposal.id, summary: preview.summary }
  },
}

/** TODO: append each new propose tool here, and register this list alongside `exampleTools`. */
export const exampleProposeTools: AgentTool[] = [proposeEntityChange]
