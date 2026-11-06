// SCAFFOLD TEMPLATE (ai-agent-architecture skill) — adapt placeholders marked TODO to the target app.

/**
 * In-process admission control for the agent (references/architecture.md §9 "Concurrency
 * admission control"). A tool loop holds a slot for its whole (multi-round, provider-bound)
 * duration; capping the number of concurrent loops stops one runaway client from
 * saturating the server instance or the provider quota. Excess requests are rejected with
 * 429 + Retry-After rather than queued — a fast, honest "busy, retry shortly" beats an
 * unbounded wait behind a slow loop.
 *
 * In-process (not Redis) is deliberate for a single-instance deployment: this cap's job is
 * local resource protection, not cluster-wide fairness. TODO: if you run multiple
 * instances behind a load balancer, either accept that the real cap is
 * MAX_CONCURRENT_AGENT_CALLS × instance count, or move this to a shared store (Redis
 * `INCR`/`DECR`) if a cluster-wide cap actually matters.
 */

export const MAX_CONCURRENT_AGENT_CALLS = 4
export const AGENT_BUSY_RETRY_AFTER_SECONDS = 5

let inFlight = 0

/** Take a slot if one is free. Returns false (caller should 429) when all are in use. */
export function tryAcquireAgentSlot(): boolean {
  if (inFlight >= MAX_CONCURRENT_AGENT_CALLS) return false
  inFlight += 1
  return true
}

/** Release a slot. Call exactly once per successful tryAcquireAgentSlot(), in a finally. */
export function releaseAgentSlot(): void {
  if (inFlight > 0) inFlight -= 1
}
