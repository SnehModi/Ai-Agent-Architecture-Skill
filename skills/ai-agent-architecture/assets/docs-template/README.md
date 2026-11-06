# <Agent name> - Documentation

> Fill in every `<placeholder>`. Delete rows that do not apply. Keep this file the single entry point; link out for detail.

## 1. What it is

<One paragraph: who uses it, what it can read, what it can propose, what it can never do.>

- **Users / roles:** <roles that can use it>
- **Reads:** <data sources>   **Proposes:** <change types, or "nothing">   **Acts (with undo):** <reversible changes, or "nothing">
- **Model / provider:** `<provider:model>` (config: `<ENV_VAR>`); allowlist: `<models>`
- **Maturity level:** <L1 answers | L2 acts | L3 remembers and shows | L4 works on its own>
- **Memory:** <off | on, kinds>   **Retrieval:** <none | sources>   **Rich output:** <none | artifacts, components>

### Intake answers

| # | Question | Answer |
|---|---|---|
| 1 | Domain | <...> |
| 2 | Caller (pinned / app-wide) | <...> |
| 3 | Roles + permission keys | <...> |
| 4 | Changes: propose / act / none | <...> |
| 5 | Unstructured docs | <...> |
| 6 | Cross-chat memory | <...> |
| 7 | Rich outputs | <...> |
| 8 | Long tasks / sub-agents | <...> |
| 9 | Inputs (files, images, page, mentions) | <...> |
| 10 | Provider, allowlist, budgets | <...> |
| 11 | Sensitivity, retention, audit | <...> |
| 12 | Surface | <...> |

## 2. Architecture

```
<client> -> POST <turn route> -> controller (auth, rate limit, slot)
         -> loop (provider seam, tools, trimming) -> SSE/JSON back
         -> proposals: card -> POST <accept route> -> service layer
```

**One turn, end to end:** <1. client sends `{ content }` + `conversationId`; 2. controller builds `AgentContext` from session/URL; 3. history loaded + compacted; 4. loop runs rounds; 5. persist on success only; 6. trace id stored.>

**One proposal tool-call to accept:** <1. model calls `<propose tool>`; 2. a pending proposal row is created (supersedes `<older pending>`); 3. card rendered; 4. human accepts via `<accept route>`; 5. atomic claim -> permission re-check -> `<service>` applies it; 6. a second accept returns 409.>

## 3. Where things live

| Concern | Path |
|---|---|
| Loop | `<path>/loop.ts` |
| Chat UI (`ChatShell`, hooks) | `<path>/ui/` |
| Memory / retrieval / artifacts | `<path>` (delete rows that do not apply) |
| Provider seam / adapters | `<path>/providers/` |
| Tools | `<path>/tools/` |
| Tool registry + RBAC | `<path>/registry.ts` |
| Prompt | `<path>/prompts/` |
| Controller + routes | `<path>` |
| Proposals (model, accept) | `<path>` |
| Evals | `<path>/evals/` |
| UI | `<path>` |

## 4. Core rules / invariants

1. Provider SDK types never leave `providers/<vendor>.ts`.
2. The loop has no domain knowledge.
3. Identity and scope come from the session/URL, never the model.
4. RBAC filters tools before the model sees them; the check is deny by default.
5. The model never writes business data; `propose` creates a pending row only.
6. Parity: the agent does only what the normal UI/REST can, via the same services.
7. Everything is bounded: rounds, wall-clock, tokens, per-call timeout, concurrency, per-user rate, context.
8. History is server-owned; one turn per conversation; ownership failures return 404.
9. Tool errors are `{ error }`; throws never fail the turn.
10. `act` tools are reversible, declare `undo`, and write a receipt; irreversible changes are never below `propose`.
11. The system prompt is static and cache-stable; memories, page context, attachments and custom instructions arrive as fenced data.
12. Every mutation and decision writes an audit row; traces are redacted; users can list and delete memories.
13. <App-specific invariant>

## 4a. Tool tiers

| Tool | Mode | Permission | Why this tier (reversible? financial? external? visible to others?) |
|---|---|---|---|
| `<tool>` | read / propose / act | `<key>` | <...> |

## 5. Glossary

| Term | Meaning |
|---|---|
| Turn | <one user message and the agent's full reply> |
| Proposal | <pending change created by a propose tool> |
| Card | <UI element where a human accepts or rejects a proposal> |
| Scope | <pinned record the context is about> |
| <term> | <meaning> |

## 6. Local development

```
<install / start commands>
```

| Env var | Purpose | Default |
|---|---|---|
| `<PROVIDER_API_KEY>` | <provider key> | none |
| `<AGENT_MODEL>` | <provider:model string> | `<default>` |
| `<TRACING_KEYS>` | <observability, optional> | off |

## 7. Testing and evals

- Unit tests: `<command>` (RBAC deny, trimming, compaction, tool throw caught, write never offered, accept atomic).
- Run new stored fields against a real DB: `<command>` (mocked models hide schema gaps).
- Golden set (live model, human-judged): `<command>`. Run after any prompt, tool, or model change.
- Judge run on sampled production traces: `<command>` / `<schedule>`. Feedback review queue: `<where>`.
- Prompt version: `<promptVersion>`; last golden run: `<date, pass rate, judge mean>`.

## 8. Common tasks

| Task | Where / how |
|---|---|
| Add a read tool | `<path>`; see the checklist below |
| Add a propose tool | `<path>`; see the checklist below |
| Change the prompt | `<path>`; re-run the golden set |
| Swap the model | `<ENV_VAR>`; re-run the golden set |
| Debug a failed turn | `<trace tool>`; look up the `traceId` / `lastFailedTurn` |

## 9. Decisions and known limits

- <Decision: what was chosen and why.>
- <Known limit: what it cannot do yet.>

## Enforced in code vs prompt only

| Rule | Enforced in code? | Where / golden case |
|---|---|---|
| <rule> | Yes / No | `<file>` / `<golden case id>` |
| <rule> | Yes / No | `<file>` / `<golden case id>` |

Every "No" row needs a golden-set case.

## Add a tool - checklist

- [ ] Parity: the UI/REST can already do this, and the tool calls the same service.
- [ ] `name`, `description`, zod `inputSchema`, `requiredPermission`, `mode` (`read` or `propose`).
- [ ] Scope read from `AgentContext`; pinned value wins over model input.
- [ ] Errors returned as `{ error }`; results slim, capped, `truncated` flag; no per-row queries.
- [ ] Propose only: supersede rule, atomic accept path with permission re-check, decision note, card, 409 on double decide.
- [ ] Registered in the caller's tool array; permission added to the matrix (denied by default until added).
- [ ] Unit tests: allowed and denied roles, not-found returns `{ error }`.
- [ ] Golden-set case added (negative case for propose tools); prompt-only rules listed in the table above.
- [ ] This README updated.
