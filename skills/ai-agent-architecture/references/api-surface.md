# API Surface

The one route table every agent built with this skill exposes. The backend references say *what*
each route does; this file fixes *paths, bodies and status codes* so the UI scaffold
(`assets/scaffold/ui/api.ts`) works against any such agent unchanged. Where a reference shows a
route, this file wins.

## Contents

1. [Conventions](#1-conventions)
2. [Conversations](#2-conversations)
3. [Turn and run](#3-turn-and-run)
4. [Proposals](#4-proposals)
5. [Actions](#5-actions)
6. [Attachments](#6-attachments)
7. [Artifacts](#7-artifacts)
8. [Memories and settings](#8-memories-and-settings)
9. [Tasks](#9-tasks)
10. [Meta](#10-meta)

## 1. Conventions

- **Prefix** `/api/v1/agent`; every path below is relative to it. Nouns only, at most 2 levels
  (`/conversations/:id/messages`); actions are HTTP methods, never verbs (`undo` is the one
  sub-resource verb, because it is a state transition with no noun).
- **Envelope.** Success `{ success: true, data }`; failure `{ success: false, error: { code, message } }`
  with `SNAKE_CASE` codes and a safe message (never vendor text, stack traces or internal ids).
  `204` has no body.
- **Cursor pagination.** Lists take `?cursor=&limit=` and return
  `pagination: { nextCursor: string | null, hasNext: boolean }`. There is **no `total` or `page`**: a
  deliberate deviation from offset envelopes, because the chat list is append-heavy (new rows land at the
  head while you page) and never page-jumped; an offset would skip or repeat rows, and a total costs a
  count nobody displays. `limit` defaults to 30 and is capped at 100.
- **Ownership.** Every query filters `{ id, userId }`; malformed, missing and not-yours ids are all
  `404` (`architecture.md` §8). `401` unauthenticated, `403` authenticated but not allowed.
- **Whitelisted bodies.** Each `PATCH` reads only the listed fields; unknown fields are ignored.
- **Idempotency.** `POST /conversations/:id/messages` and `PATCH /proposals/:id` accept an
  `Idempotency-Key` header (`reliability.md` §7). The scaffold UI does not send it; add it if retried
  transport failures matter.
- **Rate and load.** `429` carries `Retry-After` (seconds). Failures before a stream starts are plain
  JSON statuses; after headers they are an `error` event (`runs-and-streaming.md` §4).

## 2. Conversations

Item: `Conversation = { id, title, updatedAt, pinned, running, model? }`. `running` is derived from
`activeRun` (`runs-and-streaming.md` §2).

| Route | Request | `data` | Status |
|---|---|---|---|
| `GET /conversations` | `?cursor&limit&q` (`q` = server-side search) | `Conversation[]` + `pagination`; pinned first, then `updatedAt` desc | 200 |
| `POST /conversations` | `{ model? }` (must be in the allowlist) | `Conversation` | 201; 400 unknown model |
| `PATCH /conversations/:id` | whitelist `{ title?, pinned?, model?, lastFailedTurn?: null }` | `Conversation` | 200; 400 invalid; 404 |
| `DELETE /conversations/:id` | none; cascades messages, proposals, artifacts, attachments, memories sourced here | none | 204; 404 |
| `GET /conversations/:id/messages` | `?cursor&limit` (oldest first; `nextCursor` continues forward) | `{ messages: TranscriptMessage[], running, lastFailedTurn, inFlightText?, model? }` + `pagination` | 200; 404 |

- `lastFailedTurn` is `{ text, error, at } | null`; `PATCH { lastFailedTurn: null }` is Dismiss.
  Only `null` is accepted for it.
- `running`, `lastFailedTurn`, `inFlightText` and `model` are conversation-level, repeated on every page.
- `TranscriptMessage` is `{ role: 'user', id, text, attachments? }` or
  `{ role: 'assistant', id, text, steps?, questions?, artifacts?, components?, actions?, followups?, feedback? }`.
  Only non-empty user/assistant text is returned, never tool calls or raw results (`architecture.md` §8).
  `actions` lists only receipts that are not undone and not yet expired.

## 3. Turn and run

| Route | Request | `data` / stream | Status |
|---|---|---|---|
| `POST /conversations/:id/messages` | `{ content, pageContext?, mentions?, attachmentIds?, replaceFrom? }` | `Accept: text/event-stream` streams the SSE vocabulary; otherwise JSON `{ answer, messageId, userMessageId, usage? }` | 201 JSON; 200 stream; 400 validation or unknown attachment; 404; 409 turn in progress; 413; 422 `replaceFrom` already summarized; 429; 504 |
| `GET /conversations/:id/run` | none | SSE replay + live of the running turn | 200; 404 no Run in this process (client polls the transcript) |
| `DELETE /conversations/:id/run` | none | none | 204; 404 (tolerated: already finished) |

- `pageContext` is `{ kind, id }`; `mentions` is `{ kind, id }[]` (capped ~5); the server resolves
  labels (`inputs.md` §1). `replaceFrom` is a **user** message id (`runs-and-streaming.md` §8).
- The SSE events (`status`, `reasoning`, `delta`, `step`, `questions`, `artifact`, `component`,
  `action`, `followups`, `done`, `error`) are defined in `runs-and-streaming.md` §4. `done` without ids
  is stopped, unless an `error` event preceded it (`runs-and-streaming.md` §3).
- Sub-shapes: `component = { id, component, props, sourceRefs?, fallbackText }`;
  `action = { id, label, detail?, expiresAt }` (`expiresAt` is an ISO string).

## 4. Proposals

`Proposal = { id, messageId?, kind, status, editCount, preview, resultId? }`. `status` is
`pending | accepted | rejected | superseded`. **"Stale" is not a status**: it is a client-side card
state set when a decision returns `422 PROPOSAL_STALE` (`proposals.md` §7).

`preview = { title, lines: [{ id, label, value, change, editable }], totals?: [{ label, value }], before? }`
with `change` one of `added | changed | unchanged | removed`. `before` is the server's stale-check
snapshot; clients ignore it.

| Route | Request | `data` | Status |
|---|---|---|---|
| `GET /conversations/:id/proposals` | none; only proposals anchored to a message; bounded, newest cap 100, **not paginated** | `Proposal[]` | 200; 404 |
| `PATCH /proposals/:id` | `{ status: 'accepted' \| 'rejected' }` | `{ proposalId, status, resultId? }` | 200; 403 permission; 404; 409 already decided; 422 `PROPOSAL_STALE`, unknown type or apply failure |
| `PATCH /proposals/:id/lines/:lineId` | `{ value }` | `Proposal` (rebuilt preview) | 200; 404; 409 not pending; 422 invalid or would leave it empty |

## 5. Actions

| Route | Request | `data` | Status |
|---|---|---|---|
| `POST /actions/:id/undo` | none | none | 204; 403 permission lost; 404; 409 already undone; 410 window expired; 422 stale or undo failed |

Actions are created only by the loop (the `action` event), never by a client route.

## 6. Attachments

`Attachment = { id, name, mimeType, size, truncated? }`.

| Route | Request | `data` | Status |
|---|---|---|---|
| `POST /attachments` | multipart, field `file` | `Attachment` | 201; 400 type or parse; 413 size; 429 |
| `GET /attachments/:id` | none | stored bytes (owner only, `X-Content-Type-Options: nosniff`) | 200; 404 |

## 7. Artifacts

`ArtifactRef = { id, kind, title, version }`; `kind` is `markdown | code | table | chart | html`
(`html` is off by default and renders only in a fully sandboxed iframe, `rich-output.md` §2).

| Route | Request | `data` | Status |
|---|---|---|---|
| `GET /conversations/:id/artifacts` | `?cursor&limit` | `{ id, kind, title, currentVersion }[]` + `pagination`; no bodies | 200; 404 |
| `GET /artifacts/:id` | `?version=n` (default current) | `ArtifactRef & { body: string, language?, versions: number[] }` | 200; 404 |
| `GET /artifacts/:id/versions` | none | `{ version, author, createdAt }[]`; no bodies (the scaffold uses the `versions` numbers above instead) | 200; 404 |
| `POST /artifacts/:id/versions` | `{ content, baseVersion }` | `ArtifactRef` | 201; 404; 409 stale `baseVersion`; 422 invalid for the kind or over a cap |

`body` is the stored content string. For `markdown`, `code` and `html` it is the text. For
`table` it is JSON `{ columns: [{ key, label }], rows: [{ [key]: string | number | null }] }`; for `chart`
JSON `{ type: 'bar' | 'line' | 'pie', labels: string[], series: [{ name, data: number[] }] }`, drawn
client-side as plain SVG (no chart library). Size caps: `rich-output.md` §7.

## 8. Memories and settings

`Memory = { id, text, kind, createdAt, conversationId? }`.

| Route | Request | `data` | Status |
|---|---|---|---|
| `GET /memories` | `?cursor&limit` | `Memory[]` + `pagination` | 200 |
| `DELETE /memories/:id` | none | none | 204; 404 |
| `DELETE /memories` | none (all of this user's, current scope) | none | 204 |
| `GET /settings` | none | `{ memoryEnabled }` | 200 |
| `PATCH /settings` | whitelist `{ memoryEnabled }` | `{ memoryEnabled }` | 200; 400 |

Off means no extraction and no retrieval; rows stay dormant until deleted (`memory.md` §5).

## 9. Tasks

`Task = { id, kind, status, progress?: { label, step }, resultMessageId?, error?: { code }, createdAt,
startedAt?, finishedAt? }` with `status` `queued | running | done | failed | cancelled` (safe subset of
`multi-agent.md` §6). How a task is started is app-specific (a card accept or a turn flag): no
canonical route.

| Route | Request | `data` | Status |
|---|---|---|---|
| `GET /tasks/:id` | none | `Task` (polled when no live stream) | 200; 404 |
| `GET /tasks/:id/run` | none | SSE, same vocabulary as a turn (`multi-agent.md` §7) | 200; 404 no Run here (poll) |
| `DELETE /tasks/:id` | none (cancel) | none | 204; 404; 409 already terminal |

## 10. Meta

| Route | Request | `data` | Status |
|---|---|---|---|
| `GET /starters` | `?pageKind=&pageId=` | `{ prompts: string[] }` (3-5, shared per role and page kind, `ux-doctrine.md` §5) | 200 |
| `GET /models` | none | `{ models: [{ id, label, default }] }` (the allowlist; exactly one `default`) | 200 |
| `POST /messages/:id/feedback` | `{ score: 1 \| 0 \| null, comment? }` (`null` clears) | none | 204; 400; 404 |
