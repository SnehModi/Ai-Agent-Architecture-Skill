---
name: ai-agent-architecture
description: >-
  Build a complete, modern agentic AI (assistant / copilot / chat / "ask-the-data") into an app:
  a proven, layered, provider-agnostic tool-use backend (ChatProvider seam, RBAC-filtered tool
  registry, domain-free streaming loop, server-owned memory, concurrency control, golden-set eval
  gate) PLUS the product layer users judge it by — a React chat UI with live activity trail,
  visible reasoning, proposal cards, artifacts, attachments, follow-ups; cross-conversation
  memory; sub-agents and background tasks; retrieval; prompt caching and cost budgets; trust
  controls (audit, PII, confirmation tiers). Use this WHENEVER you are adding or designing an AI
  agent, chatbot, LLM assistant, tool-calling / function-calling loop, RAG, or copilot feature —
  even if the user just says "add an AI chat" and doesn't name an architecture. Defaults to
  TypeScript/Express/zod + React/Tailwind/TanStack; the doctrine adapts to any stack.
user-invocable: true
argument-hint: [stack] [scope]
---

# AI Agent Architecture

You are adding an LLM agent to an application, and you will build it the way this skill
prescribes: a **layered, provider-agnostic tool-use loop** with hard security and resource
boundaries, and a **product layer** that makes it feel like a modern assistant (Claude, ChatGPT,
Gemini) rather than a chat box over an API. The architecture is proven in production; its value is
the *seams* — each layer knows as little as possible about the others, so a vendor swap, a new
tool, a new surface, or a new caller is a local change, never a rewrite.

**Arguments**: `$ARGUMENTS`
- `$0` = stack hint (e.g. `express`, `nestjs`, `fastify`, `python`). Optional — auto-detect.
- `$1` = scope (`full`, `backend-only`, `ui-only`, `add-tool`, `add-provider`, `add-memory`,
  `add-artifacts`, `add-subagent`, `add-retrieval`). Defaults to `full`.

## The one idea

**The loop has zero domain knowledge and zero vendor knowledge.** It talks only to two interfaces you
own — `ChatProvider` (the LLM) and `AgentTool` (a capability). Everything specific to *this* app —
which model, which tools, which prompt, who's allowed, what the UI shows — is injected. Get this
right and the same loop serves a one-record insights panel today and an org-wide assistant with
memory, artifacts and sub-agents tomorrow without edits.

## Intake — answer these before building anything

Decide (with the user if unclear) and write the answers into the agent's README (§9 below).
Each answer selects which layers and references apply; do not build layers the answers don't need.

| # | Question | Decides |
|---|---|---|
| 1 | Domain: what can it answer/do, from what data? | tools, prompt, golden set |
| 2 | Caller: pinned scope (one record) or app-wide? | `AgentContext.scope`, tool args |
| 3 | Roles and permission keys that already exist? | RBAC matrix wiring |
| 4 | Can it change data? Which changes are reversible? | `propose` cards vs `act` with undo ([trust.md](references/trust.md)) |
| 5 | Unstructured docs to search? | [retrieval.md](references/retrieval.md) |
| 6 | Should it remember the user across chats? | [memory.md](references/memory.md) |
| 7 | Outputs beyond text (documents, tables, charts, generated UI)? | [rich-output.md](references/rich-output.md) |
| 8 | Long tasks (> 1 min) or parallel research? | [multi-agent.md](references/multi-agent.md) |
| 9 | Inputs: files, images, page context, mentions? | [inputs.md](references/inputs.md) |
| 10 | Provider(s), model allowlist, budget per user/org? | registry, [reliability.md](references/reliability.md) |
| 11 | Data sensitivity, retention, audit requirements? | [trust.md](references/trust.md) |
| 12 | Surface: embedded panel, full chat page, both? | `ui/` scaffold composition |

## Maturity ladder — ship in this order

Each level is shippable on its own and the gate for the next. Do not skip levels.

- **L1 — Answers.** Read tools, fixed prompt, streaming loop, server-owned history, activity
  trail UI, golden set. The core layers below.
- **L2 — Acts safely.** Propose tools and cards; `act` tier with undo for reversible changes;
  decision notes; audit log; feedback scores.
- **L3 — Remembers and shows.** Cross-conversation memory; artifacts/generative UI; retrieval;
  attachments; projects with pinned context; suggested starters and follow-ups.
- **L4 — Works on its own.** Sub-agents, background tasks with notifications, proactive
  digests, LLM-judge evals on sampled production traffic, cost routing across models.

## The layers (build in this order)

Dependencies point downward — each layer imports only the ones above it.

```
backend  (assets/scaffold/agent/)
providers/types.ts      ChatProvider seam v2 — content parts, reasoning stream, interleaved
        │               text + tool calls, stopReason, cached-token usage (your types, never the SDK's)
providers/openai.ts     adapters — pure SDK translation + per-call timeout
providers/anthropic.ts  the second adapter is what proves the seam held
providers/registry.ts   "anthropic:claude-sonnet-5-5" string → provider; model allowlist
        │
context.ts              AgentContext: who is asking + scope (never trusted to the model)
registry.ts             AgentTool contract + availableTools() RBAC filter + zod → JSON Schema
tools/*.ts              read / propose tools (scope from context, not the model)
        │
context-window.ts       pure budget-trim over parts (injected summarize)
memory.ts               per-conversation compaction over persisted history
concurrency.ts          in-process admission control → 429
loop.ts                 the domain-free streaming tool-use loop (reasoning, tool_start/end events)
        │
prompts/*.ts            system prompt skeleton — capabilities derived from tools once at startup
evals/                  golden set + judge + feedback queue

frontend (assets/scaffold/ui/)
protocol.ts, sse.ts, api.ts, store.ts     the SSE contract and a rAF-batched store
hooks/useAgentRun.ts                      send / stop / retry / edit / regenerate / re-attach
components/                               ChatShell, Sidebar, Thread, AssistantMessage
                                          (ReasoningBlock, ActivityTrail, StreamingMarkdown),
                                          ProposalCard, QuestionsCard, Composer, EmptyState,
                                          FollowUps, ArtifactPanel, ModelPicker, ErrorBanner
```

Drop-in templates for all of these live in [assets/scaffold/](assets/scaffold/). Copy them in and
adapt the parts marked `// TODO`. They type-check as-is against placeholder RBAC/error types.

**Optional layers**, each with its own reference and a row in the intake table:
[proposals](references/proposals.md), [runs-and-streaming](references/runs-and-streaming.md),
[inputs](references/inputs.md), [memory](references/memory.md), [rich-output](references/rich-output.md),
[retrieval](references/retrieval.md), [multi-agent](references/multi-agent.md),
[observability](references/observability.md). The route table the UI scaffold expects is
[api-surface](references/api-surface.md).

**Cross-cutting doctrine** that applies at every level:
[tool-design](references/tool-design.md), [prompting](references/prompting.md),
[ux-doctrine](references/ux-doctrine.md), [reliability](references/reliability.md),
[trust](references/trust.md), [evals](references/evals.md).

## The doctrine (why each seam exists)

Read [references/architecture.md](references/architecture.md) for the layer-by-layer rationale.
The load-bearing rules you must not compromise:

1. **Own the provider interface — never leak the SDK type upward.** `ChatProvider` is a small
   interface *you* define (`providers/types.ts`). The loop and tools import only it. Swapping or
   adding a vendor is one adapter file. An `openai` or `@anthropic-ai` import anywhere but
   `providers/<vendor>.ts` means the seam has leaked — stop and fix it.

2. **The loop is domain-free.** `loop.ts` contains no customer/order/product knowledge and no vendor
   knowledge. New feature = new tools + new prompt + new caller. Never a change to the loop.

3. **Context is the authority on identity and scope; the model is not.** `AgentContext` carries
   `userId`, `role`, and a **pinned scope** set by the *controller from the session/URL*, never by
   the model or the request body. A tool resolves its target from the pinned scope first. This is
   the guardrail that stops a prompt-injected model from reaching another tenant's data.

4. **RBAC filters tools before the model sees them.** `availableTools()` removes any tool whose
   `requiredPermission` the caller's role lacks — the model cannot attempt what it cannot see.
   `execute()` re-checking at dispatch is defense-in-depth. The check is **deny by default**.
   A sub-agent receives a *subset* of its parent's filtered tools, never more.

5. **The model never writes business data unconfirmed. Tiers, not a switch.** Every tool declares
   `mode`. `read` queries. `propose` creates a pending proposal a human accepts on a card
   ([proposals.md](references/proposals.md)). `act` (optional, [trust.md](references/trust.md))
   applies a *reversible, low-blast-radius* change directly and records an undo receipt the UI
   surfaces for N minutes. `write` stays hard-rejected by the loop. Irreversible, financial,
   external, or other-user-visible changes are never below `propose`.

6. **Bound everything.** Tool rounds, wall-clock per turn, output tokens, per-call timeout,
   concurrent loops, per-user rate, per-user/org token budget, context budget, sub-agent depth and
   count, background task duration. An agent with an unbounded anything is an incident waiting to
   happen. The one retry replays only a provider call, before anything has streamed.

7. **Streaming-first, one implementation, one wire vocabulary.** The loop is a generator; the
   non-streaming path consumes it. The client sees only the SSE events in
   [runs-and-streaming.md](references/runs-and-streaming.md) §4 — never raw tool results.

8. **Prompts are doctrine, not data, and defend against injection.** The system prompt is fixed
   and cache-stable; everything specific (page context, memories, attachments, custom instructions)
   arrives as fenced, labelled **data**. Tool results, retrieved chunks, memories and attachments are
   data, not instructions — the prompt says so, and the golden set tests it.

9. **Evals gate change; feedback feeds evals.** A fixed golden set runs through the *real* loop
   against a *live* model before first ship and after any prompt/tool/model change. An LLM judge
   scores sampled production traces. Every thumbs-down and rejected proposal enters a review queue
   and, when labelled prompt/tool, becomes a golden case ([evals.md](references/evals.md)).

10. **Conversation history is server-owned.** The turn endpoint accepts `{ content }` plus
    references, never a client `messages[]`. Persist tool calls/results, compact into a rolling
    summary, filter every query by owner (404), lock one turn per conversation (409).

11. **Parity rule.** The agent may only do what the normal UI/REST can do, through the same service
    code. An agent-only path is a backdoor.

12. **Tool error contract.** Expected failures return `{ error: 'short plain message, with what to
    try next' }`. Throws are caught and never fail the turn. List results are slim, labelled,
    capped, with a `truncated` flag.

13. **Know what code enforces.** Keep an "enforced in code vs prompt only" table in the agent's
    README; every prompt-only rule gets a golden case.

14. **Tool design is the biggest quality lever.** A clear description with when/when-not, a flat
    enum-heavy schema, and a slim business-named result do more for answer quality than any prompt
    tweak ([tool-design.md](references/tool-design.md)). Fix the tool before touching the prompt.

15. **Never a blank spinner; nothing typed is ever lost.** Within 300 ms the user sees reasoning or
    a step label; Stop is always available; a failed or stopped turn keeps the user's text with
    Retry ([ux-doctrine.md](references/ux-doctrine.md)).

16. **Cache-stable prefix and visible cost.** System prompt → tool defs → history, static before
    variable. Watch `cachedInputTokens`; a cache-hit drop after a deploy is a regression. Per-user
    and per-org budgets return 429 with honest copy ([reliability.md](references/reliability.md)).

17. **Trust is a feature.** Redact before tracing, retain with a TTL and a delete path, write an
    audit row for every mutation and decision, and let users see and delete what the agent
    remembers ([trust.md](references/trust.md)).

## Workflow

Follow the karpathy guidelines throughout (invoke `andrej-karpathy-skills:karpathy-guidelines`):
surgical changes, surface assumptions, verifiable success criteria.

**1. Orient.** Detect the stack (or use `$0`). `grep` for `ChatProvider`, `runAgentLoop`,
`tool_calls`, an `agent/` dir, a chat UI. If one exists you are extending — read it and match its
conventions. If it is a v1 scaffold (string `content`, no `reasoning` events), say so and offer
the v2 migration (parts + new events) as its own step.

**2. Intake.** Fill the intake table above. State the maturity level you are building to now.

**3. Lay down the backend layers** top-to-bottom from `assets/scaffold/agent/`:
repoint `Role` / `PermissionKey` / `AppError`; wire `roleHasPermission` to the real matrix and
**verify it allows and denies**; rename `scope.entityId` to the domain; pick the provider string
and the model allowlist.

**4. Write the tools** per [tool-design.md](references/tool-design.md): one file per group; zod
schema with `.describe()` on every field; `requiredPermission`; `mode`; scope from `AgentContext`;
`{ error }` for expected failures; slim capped results. Add `search_documents` if intake #5,
`create_artifact`/`update_artifact` if #7, a delegate tool if #8, `ask_user` always.

**5. Write the prompt** from the skeleton in [prompting.md](references/prompting.md): identity,
capabilities derived from the registered tools once at startup, boundaries, data-not-instructions,
clarify-vs-assume, formatting rules, proposal rules. Fixed text; variable things arrive as data.

**6. Wire the controller.** Per-user rate limit → budget check → concurrency slot (429 +
`Retry-After`) → `AgentContext` from session/URL → assemble inputs
([inputs.md](references/inputs.md): decision notes, page context, mentions, memories, attachments)
→ start a `Run` ([runs-and-streaming.md](references/runs-and-streaming.md)) → map `LoopEvent`s to
the SSE vocabulary via `describeStep` → persist on success only → store `traceId`, `promptVersion`,
usage. Add the conversation, run, proposal, attachment, starters, follow-ups, artifact, feedback
and memory routes the intake selected, all in the app's standard envelope.

**7. Mount the UI** from `assets/scaffold/ui/`: `ChatShell` in a layout route (not a page) so a
stream survives navigation; point `createApi` at the routes; wire `searchMentions`, slash commands,
the artifact renderers and the model allowlist; restyle the Tailwind tokens. Walk the
[ux-doctrine.md](references/ux-doctrine.md) checklist in a browser.

**8. Test.** Unit-test the pure pieces (RBAC filter denies; `fitToBudget` and `compactHistory`
never split a tool-call/result unit; a tool throw is caught; a `write` tool is never offered; an
`act` tool without `undo` is rejected at registration; accept is atomic). Run new stored fields
against a real DB. Stand up the golden set per [evals.md](references/evals.md), including the
injection, negative-propose, memory-recall and retrieval cases the intake selected; run it live.

**9. Observe and close the loop.** One trace per turn with prompt version, tool-set hash and model
id; `traceId` on messages, proposals and tasks; decision and feedback scores; the feedback review
queue feeding the golden set; the metrics and alerts in
[observability.md](references/observability.md).

**10. Document.** Copy [assets/docs-template/README.md](assets/docs-template/README.md) into the
app's docs: intake answers, maturity level, map, invariants, enforced-in-code table, tool tiers,
add-a-tool checklist.

## Adding things later

- **Provider**: one adapter implementing `ChatProvider`, one `case` in `resolveProvider`, add to
  the allowlist. Nothing else changes. Re-run the golden set.
- **Tool**: one `AgentTool` object, registered in the caller's array, permission added to the
  matrix. Re-run the golden set. Propose tools also need: parity check, supersede rule, accept
  path, decision note, card, negative golden case. `act` tools also need: `undo`, receipt, tier
  justification in the README.
- **Sub-agent**: a delegate tool with its own prompt, a subset of the parent's filtered tools,
  tighter bounds, depth 1 ([multi-agent.md](references/multi-agent.md)).
- **Memory / retrieval / artifacts**: each is additive — a store, a tool or two, a route, a UI
  piece, a golden case. None touches the loop.

## Success criteria

Before treating the agent as done, confirm, with tests where marked:

- The loop and tools import no vendor SDK type; a second adapter resolves from config.
- A role lacking a tool's permission never receives it (tested); deny by default (tested); a
  pinned scope cannot be overridden by model input (tested); a sub-agent's tool set is a subset.
- Every bound is present: rounds, wall-clock, tokens, per-call timeout, concurrency, per-user
  rate, per-user/org budget, context budget, sub-agent depth/count, task duration; lock TTL >
  turn timeout.
- A tool throw does not fail the turn (tested); `write` tools are never dispatched (tested); `act`
  tools have `undo` and a receipt (tested); accept is atomic and a double decide is 409 (tested).
- Another user's conversation returns 404; a concurrent turn returns 409 (tested); a failed or
  stopped turn persists nothing but keeps the user's text.
- The UI shows reasoning or a step within 300 ms, streams at animation-frame cadence, survives a
  route change and a reload mid-turn, and has Stop, Retry, edit and regenerate working.
- The system prompt is static and cache-stable; `cachedInputTokens` is non-zero on the second
  turn of a conversation.
- Every prompt-only rule has a golden case; every propose/act tool has a negative case; the
  injection-through-data case passes; the golden set has been run live with a human reading every
  failure; the feedback queue exists.
- Traces carry prompt version, tool-set hash and model; `traceId` is stored on messages,
  proposals and tasks; an audit row is written for every mutation; memories are listable and
  deletable by the user.
