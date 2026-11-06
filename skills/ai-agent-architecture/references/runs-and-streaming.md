# Runs, Streaming and Failure UX

The turn lifecycle around the loop: who owns a running turn, how it streams, how it stops, and what
the user sees when it fails. Each section states a principle and the reasoning. The loop itself is
in `architecture.md` §6; the write path is in `proposals.md`.

## Contents

1. [Run registry](#1-run-registry)
2. [Re-attach and the stale lock](#2-re-attach-and-the-stale-lock)
3. [Stop](#3-stop)
4. [SSE event contract](#4-sse-event-contract)
5. [Step labels](#5-step-labels)
6. [ask_user](#6-ask_user)
7. [Failure UX](#7-failure-ux)
8. [Edit and regenerate](#8-edit-and-regenerate)
9. [Frontend contract](#9-frontend-contract)

## 1. Run registry

**Principle:** the turn is not the HTTP connection.

If the loop runs inside the request handler, closing the tab (or a flaky network, or a route change)
kills a paid, half-finished turn. Instead, the route starts the turn as a `Run` held in an in-memory
`Map<conversationId, Run>`. The Run buffers **every** event it emits; an SSE response is just a
*subscriber*: it replays the buffer, then receives live events. Closing the connection only
unsubscribes.

```ts
class Run {
  events: Event[] = [];
  abort = new AbortController();
  private subs = new Set<(e: Event) => void>();
  emit(e) { this.events.push(e); this.subs.forEach(s => s(e)); }
  subscribe(fn) { this.events.forEach(fn); this.subs.add(fn); return () => this.subs.delete(fn); }
}
// route: runs.set(conversationId, run) ... finally { runs.delete(conversationId); releaseLock(); releaseSlot(); }
```

Register a Run for the non-streaming (JSON) path too, so Stop works there.

**Per-process caveat.** The map and the admission-control slot counter live in one process's
memory. With several instances, re-attach and Stop only work on the instance that owns the turn
(others return 404; the client falls back to the transcript, section 2). The DB turn lock still
prevents two concurrent turns per conversation cluster-wide, and `running` is derived from the DB,
so it works everywhere. Effective concurrency cap = per-process cap x instance count. If you need
live re-attach across instances, that is a shared pub/sub layer; do not add it speculatively.

## 2. Re-attach and the stale lock

**Principle:** a reload must find the turn that is still running, and a crash must not wedge the chat.

`GET /conversations/:id/run` attaches a new SSE stream to the Run (replay + live). No Run in this
process: **404**, and the client polls the transcript until `running` is false (section 9).

`running` is not a flag; it is **derived**: the conversation's `activeRun.startedAt` (set atomically
with the turn lock, cleared on release) is younger than a stale TTL. A crashed process therefore
self-expires with no sweeper. The transcript endpoint returns `running` (and the in-flight user
text) so a reloaded client can restore state.

**Invariant: lock TTL > worst-case turn time**, not just the nominal timeout. The timeout
(60 s) is checked at round boundaries only, so a turn can overrun it by one per-call timeout
(30 s) plus the single retry (another 30 s + jitter): worst case ~121 s. A 90 s TTL therefore
does *not* hold; use ≥ 150 s. Treat the constants as a set (`OVERALL_TIMEOUT_MS`,
`PER_CALL_TIMEOUT_MS`, retry, lock TTL): change one and re-check the others. The table in
[reliability.md](reliability.md) §5 lists them with the invariants between them.

## 3. Stop

**Principle:** abort is a user decision, not a failure.

`DELETE /conversations/:id/run` calls `run.abort.abort()` (204; 404 if no Run in this process). The
`AbortSignal` reaches provider calls, and tools that accept it (`execute(ctx, input, { signal })`).
On abort:

- no retry (the loop's single retry must skip aborted signals);
- no `error` event, no `lastFailedTurn`;
- nothing is persisted, including the user message (section 7);
- the Run ends and subscribers' streams close.

Edge to handle: Stop can land after the loop yielded its final `done`. Persistence must check
`signal.aborted` and skip; the client must treat "done without ids" as stopped, not saved, **unless an `error` event preceded it**: that is a failed persistence, and the UI shows the error with Retry, not "Stopped".

## 4. SSE event contract

**Principle:** the client sees a small, stable, sanitized vocabulary, never raw internals.

Frames: `event: <name>\ndata: <json>\n\n`. Headers: `Content-Type: text/event-stream`,
`Cache-Control: no-cache, no-transform`, `Connection: keep-alive`. If your framework "hijacks" the
reply to stream, the CORS headers already set on it are bypassed: copy them onto the raw response
yourself.

| Event | Data | When |
|---|---|---|
| `status` | `{ round }` | A tool round started |
| `reasoning` | `{ text }` | Visible reasoning chunk (collapsible "Thinking…" block) |
| `delta` | `{ text }` | Answer text chunk (may arrive before and after `step`s in one round) |
| `step` | `{ id, label, state: 'running' }` then `{ id, label, state: 'done'\|'error', detail? }` | Tool start / end; same stable `id` (the tool call id) |
| `questions` | `{ questions }` | `ask_user` succeeded (section 6) |
| `artifact` | `{ id, kind, title, version }` | A rich output was created/updated (`rich-output.md`); body fetched by id |
| `component` | `{ id, component, props, sourceRefs?, fallbackText }` | Generative UI spec, zod-validated server-side (`rich-output.md`); unknown component renders `fallbackText` |
| `action` | `{ id, label, detail?, expiresAt }` | An `act`-tier tool applied a reversible change; UI shows Undo until `expiresAt` (`trust.md` §4–§5) |
| `followups` | `{ suggestions: string[] }` | Suggested next prompts, after the answer (`ux-doctrine.md`) |
| `done` | `{ answer, messageId?, userMessageId?, usage? }` | Turn saved; ids absent if persistence was skipped |
| `error` | `{ error, code?, retryable }` | Sanitized message; run not aborted |

The loop's own events (`LoopEvent` in `loop.ts`: `reasoning`, `delta`, `tool_start`, `tool_end`,
`status`, `done`) are **not** the wire format. The controller maps them: `tool_start`/`tool_end`
become `step` via `describeStep` (section 5); raw results are dropped.

**Raw tool results never reach the client.** The client gets step labels and short details only:
results can carry fields the user must not see, and the wire format would become a second API you
must keep stable. Failures before the stream starts are plain JSON statuses (400/404/409/422/429);
a failure after headers can only be an `error` event, since the status can no longer change.

## 5. Step labels

**Principle:** progress text is for the human, derived separately from what the model sees.

`describeStep(name, input, result, ok) -> { label, detail? } | null` maps a tool call to plain
English ("Looking up records", "Found 12, total 4,300").

- Label from a `LABELS` map; **generic fallback** ("Looking something up") so a new tool works
  before you label it.
- `detail` is derived from the result (counts, totals, a record number), not echoed.
- On failure show the tool's `error` text only if short (e.g. <= 120 chars); otherwise "Something
  went wrong". Never put internal ids or free text in tool error strings you would not show.
- Return `null` for tools rendered as cards instead (`ask_user`).
- Nothing from `describeStep` is ever sent to the model.

## 6. ask_user

**Principle:** when a choice is needed, ask with structure, not prose.

A read-only tool the model calls for multiple-choice clarifying questions. Bound it:
1..8 questions, each `{ id, question, options: { label, description? }[2..4], recommended?: index }`;
`recommended` must be a valid option index (zod `superRefine`).

`execute` only validates and returns `{ shown: true }`; it renders nothing. The **route**, on that
tool's end, re-parses the input with the same schema, emits a `questions` event, and persists
`questions` on the final assistant message so a reload restores the card. The user's answers come
back as their **next ordinary user message** (e.g. `<question>\n-> <answer>` blocks): no special
resume path, so history, retries and edits all work unchanged. The prompt tells the model to end
with one short sentence and not repeat the options. Collapse the card to "Answered" once a later
user message exists.

## 7. Failure UX

**Principle:** a failed or stopped turn writes nothing, but the user never loses what they typed.

- **Persist nothing** on failure or stop, including the user message. A half-saved turn would
  otherwise need cleanup and could confuse history/summaries.
- Record `lastFailedTurn { text, error, at }` on the conversation for **Retry** (not on Stop).
  Return it from the transcript endpoint so a reload still shows the failed message with Retry.
  Clear it on the next successful turn or `PATCH { lastFailedTurn: null }` (Dismiss). It keeps only
  text: attachments, mentions and page context are not restored (`inputs.md`); say so if it matters.
- Keep a conversation whose only turn failed visible in history (`lastFailedTurn` set) but hide
  empty ones.
- **Map every error to a few fixed safe strings** (`safeMessage`): timeout -> "took too long, try
  again"; anything else -> "unavailable right now". Vendor text stays in server logs.
- Client copy per status: **429** "busy", honoring `Retry-After`; **409** "a reply is already in
  progress"; **504** timeout; **401/403** session/permission; network `TypeError` "connection
  lost".

## 8. Edit and regenerate

**Principle:** replace, then delete; never delete first.

Both are the normal turn endpoint with `replaceFrom` = a **user** message id: that message and
everything after it are replaced. Regenerate resends the original text; edit sends new text.

- Build model history from messages **before** the target; reuse the original's page context,
  decision notes and attachments (`inputs.md`, `proposals.md` §9).
- Delete the old tail only **after the new turn is saved**; a failed attempt leaves the original
  conversation intact.
- **Refuse (422)** if the target is already folded into the rolling summary
  (`seq < summarizedUpTo`): the summary cannot be un-summarized.
- Flip still-`pending` proposals anchored under deleted messages to `superseded`. Decided ones
  remain but are orphaned; decide in the UI whether to show them.
- Do not lower the seq allocator; seqs gain gaps, so never use it as a message count.

## 9. Frontend contract

**Principle:** the stream is a view of the Run, so the UI must survive losing it.

- **POST + `fetch` ReadableStream**, parsed with a small SSE parser. `EventSource` cannot POST or
  set an `Authorization` header.
- **Flush deltas once per animation frame**: buffer text, write to state in
  `requestAnimationFrame`. Per-chunk state updates re-render markdown dozens of times a second.
- **Message phases:** `thinking | streaming | stopped | error | done`. `stopped` shows partial text
  and "not saved" plus Retry.
- **Optimistic user message** plus a `thinking` assistant placeholder; back-fill server ids from
  `done` (needed for edit/regenerate). Upsert `step` events by `id`.
- **Keep the chat UI mounted in a layout**, not in the route pages, so a stream survives route
  changes. Leaving or switching a chat aborts only the client fetch; the Run continues.
- **Re-attach:** on entering a chat load the transcript; if `running`, attach to `GET .../run`.
  On 404, or if the stream ends without `done` ("interrupted"), poll the transcript every few
  seconds until not running, then read the saved reply (or surface `lastFailedTurn`).
- **Background watcher:** keep an in-memory set of run ids started in this tab. Only while it is
  non-empty, poll the conversation list; when one stops running and is not the visible chat, toast
  "Reply ready" / "Could not reply" with an Open action. No timer when the set is empty.
- Stop: abort the client fetch, then `DELETE .../run` (tolerate 404). Esc should also stop.
- After `done`, refetch proposals so cards appear under the new message.
