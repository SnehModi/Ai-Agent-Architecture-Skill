# Reliability — cost, caching, routing, degradation, limits

What keeps an agent cheap, fast and up once real traffic arrives. The loop already bounds a single turn (`architecture.md` §6, §9); this file covers everything that spans turns, users and vendors: the prompt cache, spend caps, model routing, failing soft, the timeout hierarchy, and admission control. Each section states a principle and the reasoning.

## Contents

1. [Prompt caching](#1-prompt-caching)
2. [Cost and token budgets](#2-cost-and-token-budgets)
3. [Model routing](#3-model-routing)
4. [Graceful degradation](#4-graceful-degradation)
5. [Timeouts and the invariants between them](#5-timeouts-and-the-invariants-between-them)
6. [Rate limits](#6-rate-limits)
7. [Idempotency keys on accept routes](#7-idempotency-keys-on-accept-routes)
8. [Load shedding](#8-load-shedding)
9. [Reliability checklist](#9-reliability-checklist)

## 1. Prompt caching

**Principle:** a provider cache is a prefix match, so order the request from most static to most variable and never let anything per-request leak forward.

Every call sends `system prompt -> tool definitions -> history -> new message`. The provider caches the longest identical prefix; one changed byte invalidates everything after it. The first two segments are identical for every user, so they should be cached for everyone, on every round of every turn (a 5-round turn re-sends them 5 times). This is also why doctrine #8 (no per-request data in the system prompt) is a cost rule, not just a security one.

- **Anthropic:** mark the end of the system block and the end of the tool list with `cache_control: { type: 'ephemeral' }` in the adapter. Explicit breakpoints, so the adapter must place them. Below the model's minimum cacheable length nothing is cached (silently), so check the real hit rate rather than assuming.
- **OpenAI:** prefix caching is automatic above a minimum prompt length; there is nothing to set, only the ordering to protect.
- **The adapter owns this.** Breakpoints are wire-format detail; `ChatInput` stays vendor-neutral and the loop never mentions caching. Map the vendor's cached-token field to `Usage.cachedInputTokens` (0 if unsupported) so the trace shows it.
- **Per-request data goes after the prefix**: page context, the user's name, "today's date", decision notes go in the user message (`inputs.md`), never the system block.

What breaks the cache (each is a silent cost regression, nothing errors):

| Change | Why it breaks |
|---|---|
| Timestamp / date / request id in the system prompt | Prefix differs on every call; 0% hit |
| Per-user text (name, tenant, role) in the system block | One cache entry per user instead of one total |
| Reordering tools, or building the list from a `Set`/`Map` with unstable order | Tool block is part of the prefix |
| Role-filtered tool lists (`availableTools`) | One prefix per distinct role: fine, but sort by name so the same role always yields the same bytes |
| Editing a tool description or schema | Expected on deploy; the cache re-warms in one turn |
| Changing history earlier in the conversation (edit, compaction) | Only that conversation's suffix re-caches; compaction should be rare (`architecture.md` §8 hysteresis) |

- **Watch `usage.cachedInputTokens / usage.inputTokens` on the generation** (`observability.md`). After the first turn it should be most of the input. **Alert if the hit rate falls after a deploy** (compare against the previous `promptVersion`): the usual cause is someone interpolating a value into the prompt.
- Caches expire (minutes of idleness), so a quiet conversation pays full price on its next turn; that is normal, not a bug.
- Test: render the system prompt and tool defs twice with different users and times; assert byte equality.

## 2. Cost and token budgets

**Principle:** per-turn bounds stop a runaway turn; budgets stop a runaway user, a runaway integration, and a runaway month.

The loop caps rounds, output tokens and wall-clock per turn. Nothing yet stops 10,000 legitimate turns. Add stored counters, incremented from the `done` event's `usage`:

```ts
// UsageCounter { scope: 'user'|'org', scopeId, period: '2025-06-14' | '2025-06', inputTokens, outputTokens, cachedInputTokens, turns }
await UsageCounter.updateOne({ scope: 'user', scopeId: userId, period: day }, { $inc: { inputTokens, outputTokens, turns: 1 } }, { upsert: true });
```

- **Per-user daily cap** (tokens and turns) and **per-org monthly cap**. Two scopes because they fail differently: one user looping a script vs. one tenant outgrowing its plan.
- **Check before the turn, charge after.** Read the counters in the controller before taking a concurrency slot; over cap -> **429** `{ code: 'USAGE_LIMIT_REACHED', message: 'You have used today's AI allowance. It resets at 00:00 UTC.' }` plus `Retry-After`. The message must say *which* limit and *when* it resets, or support tickets follow.
- **Charge actual usage once**, from `done.usage`, in the same place the turn is persisted. Aborted and failed turns still cost tokens: charge what was reported, even if nothing was saved. A turn may overshoot the cap by one turn's cost; that is acceptable, do not build a reservation system.
- Sub-calls count too: summarize, title and follow-ups (section 3) increment the same counter under their own purpose key so the admin view can show where tokens go.
- **Use `$inc` with upsert on a period key**, never read-modify-write, or concurrent turns lose counts. Keep counters, not an event log, for enforcement; the trace store is the detailed record.
- **Admin usage view:** per org and per user, today and month to date, tokens split by purpose, top users, cache hit rate. Read-only, behind an admin permission.
- **Alerts:** an org at 80% of its monthly cap (notify the admin before the 429 does), a global daily spend above N x the trailing-7-day mean (a leak or loop), a single user above X% of org usage.
- Caps are config, not constants: a plan change must not need a deploy.

## 3. Model routing

**Principle:** the right model per purpose, chosen in config, never per call site.

Titles, summaries, extraction and follow-up suggestions are short, structured, low-stakes jobs; running them on the main model is the most common avoidable cost. Routing is plain config resolved through the existing `resolveProvider` (`architecture.md` §2):

```ts
const models = {
  turn: 'anthropic:claude-sonnet',   // the user-visible answer
  summarize: 'openai:gpt-5-mini',    // compaction (memory.ts)
  title: 'openai:gpt-5-mini',
  followups: 'openai:gpt-5-mini',
  extract: 'openai:gpt-5-mini',      // attachment/structured extraction, uses responseSchema
  judge: 'openai:gpt-5-mini',        // evals.md
} as const; // names illustrative: use whatever your registry resolves
```

- **Keyed by purpose, not by feature.** A new helper picks an existing purpose or adds one key; no model string appears in feature code.
- Helpers pass `reasoning: 'none'` or `'low'` and, where they need structure, `responseSchema` (`providers/types.ts`). Never route the main turn to a model that has not passed the golden set (`evals.md`); helpers still get a case or two, since a bad summary poisons every later turn.
- **Per-conversation picker, allowlisted.** Store `Conversation.model` only if the product wants it; the value must be in a server-side allowlist (reject anything else with 400), because a free-form model string lets a user select the most expensive model, or one your tools were never evaluated against. The allowlist applies to `turn` only; helpers stay on config.
- Put the resolved model id on the trace and the cost counter. A model change is a gate trigger (`evals.md`).

## 4. Graceful degradation

**Principle:** fail soft in the order the user would prefer: another model, then a partial answer, then an honest "unavailable".

- **Fallback provider on 5xx/timeout, only before output.** The loop already retries once, and only if nothing has streamed (`chatStreamWithRetry`, `architecture.md` §6). Reuse that hook: on the single retry, call the fallback provider (`models.fallback`) instead of the same one. It is a *replacement* for the retry, not an extra attempt, so the worst-case turn time (section 5) does not grow. Once any event has reached the client, no fallback: switching vendors mid-sentence duplicates output. Tools run only after a stream completes, so a fallback never re-runs one.
- **Fallback models are evaluated too**; an untested fallback fails exactly when you need it. Mark the generation `degraded` (below) so you can see how often it fires.
- **A tool whose subsystem is down returns `{ available: false, reason: 'Inventory is unavailable right now' }`**, the same contract as feature-flagged tools (SKILL.md step 4). The model then tells the user what it cannot answer instead of guessing; the turn survives. Do not throw: a thrown error becomes a generic "tool error" the model may retry or paper over. Put a short timeout on the dependency and map its failure to this shape.
- **Partial answers on `max_tokens`.** A `stopReason: 'max_tokens'` answer is delivered, not discarded (`architecture.md` §3). Append a visible "answer was cut short, ask me to continue" marker in the controller (not the model) and set `degraded`. Size `MAX_OUTPUT_TOKENS` so this is rare.
- **`degraded` on the trace:** metadata `degraded: 'fallback_provider' | 'tool_unavailable' | 'truncated'`. Alert on the rate by reason; a rising `tool_unavailable` is an outage in a dependency, found from the agent side.
- **Total outage:** the controller returns the safe 503/`error` event with retry, persists nothing, and keeps `lastFailedTurn` (`runs-and-streaming.md` §7). Never fabricate an answer from history.

## 5. Timeouts and the invariants between them

**Principle:** every wait has an owner and a bound, and each outer bound must exceed the sum of what it contains.

| Bound | Typical value | Owner | Protects against |
|---|---|---|---|
| Per provider call | 30 s | adapter (`PER_CALL_TIMEOUT_MS`) | hung socket |
| Per tool call | 10 s | tool (via `signal`) | slow dependency stalling a round |
| Per turn | 60 s | loop (`OVERALL_TIMEOUT_MS`) | stuck turn, many slow rounds |
| Turn lock / run stale TTL | see below | conversation lock | crashed process wedging a chat |
| Background task max (title, summary, follow-ups) | 20 s | task runner | helper outliving its usefulness |
| SSE idle | proxy timeout, send a comment every 15 s | controller | proxy killing a quiet stream |

Invariants (treat them as a set; changing one means re-checking all):

1. **Per-call < per-turn.** Otherwise one call can consume the turn.
2. **Lock TTL > worst-case turn.** The turn deadline is checked at round boundaries, so a round that starts at 59.9 s can run a full call, fail, wait the retry jitter, and run the retry: worst case is about `turn + 2 x per-call + jitter` = ~121 s with the numbers above. `runs-and-streaming.md` §2 uses 90 s for illustration; with 30 s calls and a retry, size the lock to at least 150 s. Too short lets a second turn start under a live one; too long delays recovery after a crash.
3. **Tool timeout x parallelism fits inside a round.** Tools in a round run in parallel, so a round costs the slowest tool, not the sum.
4. **Stop works within one call.** The abort signal is passed to provider and tools, so Stop is bounded by the slowest non-cancellable step.
5. **Fallback uses the retry slot** (section 4), so it does not add a third call to invariant 2.

## 6. Rate limits

**Principle:** concurrency caps protect the server, rate limits protect fairness, budgets protect money; they are three controls.

- **Per user** (e.g. 20 turns/min): stops one user occupying every slot (`architecture.md` §9). Key on the verified user id, never IP or a body field.
- **Per tenant** (e.g. 120 turns/min across the org): one noisy org must not starve the rest. Without it, per-user limits scale linearly with seat count.
- Check order in the controller: auth, rate limit, usage budget (section 2), concurrency slot, turn lock. Cheapest and most likely to reject first, and nothing is held when an earlier check fails.
- Always **429 + `Retry-After`** with a body code (`RATE_LIMITED` vs `USAGE_LIMIT_REACHED` vs `BUSY`) so the client shows different copy.
- A shared store (Redis token bucket) is needed once there is more than one instance; in-process counters give `limit x instances`.

## 7. Idempotency keys on accept routes

**Principle:** a retried click must not apply a change twice.

Accept (`proposals.md` §7) is already a claim, so a double click yields 409. The gap is the *client* retry after a lost response: the first call applied, the second sees 409 and the UI shows failure for a change that worked.

- The client sends `Idempotency-Key: <uuid>` per decision attempt. Store `(proposalId, key) -> response` with a TTL (24 h). A repeat with the same key returns the stored response with the original status; a different key on a decided proposal still returns 409.
- Same rule for turn creation (`POST /conversations/:id/messages`): a stored `Idempotency-Key` header value (not a body field) makes a retried POST return the saved turn instead of running a paid second one.
- Required on every mutation that sends money, email or an external API call (CLAUDE.md global rule); the apply function's own idempotency (`proposals.md` §8) covers partial failure, this covers the transport.

## 8. Load shedding

**Principle:** when saturated, refuse fast; a queue only converts overload into latency and wasted provider spend.

A queued agent turn is a user staring at a spinner behind someone else's 60-second loop, and a client that has already given up still gets served. So: slots full -> immediate 429 + `Retry-After` (`architecture.md` §9). Extra shedding rules:

- Shed **new** turns before degrading running ones; never kill an in-flight turn to admit a new one.
- Shed cheap-to-refuse work first: helpers (follow-ups, titles) are skipped under load, the answer is not.
- Reject on a dependency's circuit being open (the provider returned 5xx N times in the last minute and the fallback also failed) with 503 instead of letting every request wait out a 30 s timeout.
- Health checks must not count as agent calls, and must not call the provider.

## 9. Reliability checklist

- [ ] System prompt and tool defs are byte-identical across users and requests (tested); tools sorted
- [ ] Cache breakpoints set (Anthropic) and `cachedInputTokens` on the trace; hit-rate alert wired
- [ ] Per-user daily and per-org monthly caps from stored `$inc` counters, charged from `done.usage`
- [ ] Over-cap returns 429 with a code, which limit, and when it resets; admin usage view exists
- [ ] `models` map by purpose; helpers off the main model; per-conversation picker validated against an allowlist
- [ ] Fallback provider rides the single retry slot, before output only, and is in the golden set
- [ ] Unavailable-subsystem tools return `{ available: false, reason }`; `max_tokens` answers delivered and flagged; `degraded` on the trace
- [ ] Timeout table filled in for this app and invariants 1-5 asserted (a test comparing the constants)
- [ ] Rate limits per user and per tenant, in the documented check order
- [ ] `Idempotency-Key` on accept and on turn creation
- [ ] Saturation returns 429/503 immediately; no queue anywhere
