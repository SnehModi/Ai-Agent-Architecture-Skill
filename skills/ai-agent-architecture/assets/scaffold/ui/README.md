# Chat UI scaffold

React 18 + TypeScript + Tailwind + TanStack Query v5. Headless-ish: plain Tailwind classes, no chat
library. Wire format and behaviour: `references/runs-and-streaming.md` §4-§9, `proposals.md` §6-§7,
`inputs.md` §1-§2. Deps: `react-markdown remark-gfm zustand lucide-react @tanstack/react-query`.

## Mount

Mount `ChatShell` **once in a layout route**, not in a page: the stream and store are module-level,
so a route change must not unmount the shell or the stream is lost.

```tsx
const api = createApi({ baseUrl: '/api/v1/agent', getHeaders: () => ({ Authorization: `Bearer ${token()}` }) }) // module scope

export function ChatLayout() {            // layout route: <Outlet/> is not needed, the shell is the page
  const { id } = useParams(); const nav = useNavigate()
  return <ChatShell api={api} conversationId={id ?? null} pageContext={useMyPageRef()}
    onSelect={cid => nav(cid ? `/chat/${cid}` : '/chat')}
    searchMentions={q => searchMyRecords(q)} slashCommands={MY_COMMANDS}
    componentRenderers={{ kpi: KpiCard, record_table: RecordTable }} />
}
```
Needs a `QueryClientProvider` above it. Keep `api` referentially stable (a new object per render
aborts the stream).

## Endpoints expected

The canonical table is `references/api-surface.md` (prefix `/api/v1/agent`, paths below relative to it).
All responses use `{ success, data }`; lists are cursor-paginated (`pagination.{hasNext,nextCursor}`).

| Call | Endpoint |
|---|---|
| list (pinned first, then newest) | `GET /conversations?cursor&q&limit` |
| create / rename / pin / model / dismiss failed | `POST /conversations`, `PATCH /conversations/:id` `{title?,pinned?,model?,lastFailedTurn:null}` |
| delete | `DELETE /conversations/:id` |
| transcript (cursor, oldest first; `api.ts` follows all pages) | `GET /conversations/:id/messages` -> `{ messages, running, lastFailedTurn, inFlightText?, model? }` |
| send turn (SSE) | `POST /conversations/:id/messages` `{content,pageContext?,mentions?,attachmentIds?,replaceFrom?}` |
| re-attach (SSE) / stop | `GET` / `DELETE /conversations/:id/run` (404 tolerated) |
| proposals | `GET /conversations/:id/proposals`, `PATCH /proposals/:id` `{status}`, `PATCH /proposals/:id/lines/:lineId` `{value}` |
| undo an applied action | `POST /actions/:id/undo` -> 204 / 409 already undone / 410 expired |
| feedback | `POST /messages/:id/feedback` `{score:1\|0\|null,comment?}` |
| upload | `POST /attachments` (multipart `file`) -> attachment |
| starters / models | `GET /starters?pageKind&pageId` -> `{prompts}`, `GET /models` -> `{models:[{id,label,default}]}` |
| artifact | `GET /artifacts/:id?version` -> `{ id, kind, title, version, versions[], body }` (kinds: markdown, code, table, chart, html) |

Conversation list items need `running` (drives the background watcher). Edit/regenerate need the
message ids the transcript and `done` return. `component` events render through the
`componentRenderers` prop on `ChatShell` (name -> component); an unknown name shows `fallbackText`.

## Restyle

Every element is plain Tailwind in the component file (neutral palette, `dark:` variants). Edit the
classes in place, or replace a whole component: they share only `ShellContext` (`useShell()` gives
`api`, `conversationId`, `run`, `openArtifact`) and the `protocol.ts` types.

## Optional pieces

Delete what you do not need; nothing else imports them except where noted.

- `ActionChip`: only with `act`-tier tools (drop `m.actions` from `AssistantMessage`).
- `ArtifactPanel`: only if the server emits `artifact` events (drop `openArtifact` use in `AssistantMessage`).
- `ProposalCard`: only with the proposals layer (drop `<Proposals>` from `AssistantMessage`).
- `QuestionsCard`: only if you register `ask_user`.
- `ModelPicker`: hides itself when `/models` returns fewer than two models.
- `Composer` extras: `@` mentions (`searchMentions`), `/` commands (`slashCommands`), attach button.
- `useBackgroundRuns` + `Toasts`: background "Reply ready" toasts. `EmptyState` starters.

## Behaviour notes

- A failed or stopped turn is not saved server-side; the message shows "not saved" and Retry. `done` without ids is Stopped, unless an `error` event came first (then the error stays, with Retry).
- A failed first-message conversation create shows the inline `ErrorBanner` with the typed text and Retry; nothing is lost.
- Retry from the `lastFailedTurn` banner resends text only (attachments/mentions are not restored).
- Leaving a chat aborts only the client fetch; returning re-attaches, or polls the transcript every 3 s on 404.
- Tool output is never rendered raw: only server step labels/details (as text), markdown with
  raw HTML skipped and images not fetched, and `html` artifacts in a fully sandboxed iframe.
