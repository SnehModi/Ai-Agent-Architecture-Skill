# Observability — tracing and quality signals

## Why

Model output is nondeterministic, so you cannot reproduce a bad answer by rerunning it. You debug
from the **trace** of the turn that went wrong: what the model saw, which tools it called, what
they returned, how long each step took. And the best quality signal is not a synthetic test; it
is what users do with the output: do they accept the proposal, do they thumbs-down the reply.
Evals ([evals.md](evals.md)) gate changes; traces and scores tell you how it is doing in
production.

## Setup rules

**Principle:** tracing must be invisible when off and safe when on.

- **Instrumentation is the first import** of the server entry and of the eval runner. Auto
  instrumentation patches modules as they load; anything imported earlier goes untraced.
- **No-op when keys are unset.** Local dev and CI run without a tracer account; the tracing calls
  must do nothing, not throw. Score helpers also no-op without keys or a `traceId`.
- **Disable resource detectors.** Default OpenTelemetry detectors attach host name, user, and
  process arguments to every span. Turn them off so that detail never leaves the server.
- **Flush on shutdown.** Call the tracer's shutdown on `SIGTERM` and at eval exit, or the last
  spans and scores are lost.
- Any OpenTelemetry-based tracer works (e.g. Langfuse); only the wiring differs.

## Trace shape

**One trace per turn** (a user message through to the final answer):

- **Stable name** for the root (e.g. `agent-turn`). Dashboards and evaluators target it; renaming
  it silently breaks them.
- **`sessionId = conversationId`**, so all turns of a chat group together. **`userId`** from the
  verified session.
- **Tags and metadata**: tag eval runs (`eval`) so they never pollute production metrics;
  metadata carries role, model, eval case id.
- **Root input/output**: the latest user message and the final answer. Errors set the level and
  status message on the root.
- **A generation per provider call**, named by purpose (e.g. `generate-response`,
  `summarize-context`), with model, input, output, token usage, and time to first token.
- **A tool observation per dispatch**, named after the tool, with its input and the **exact text
  the model saw** as output (including error text). That is what you need to explain a wrong
  answer.

Two gotchas:
- **Streaming generators and active spans.** The loop is a generator (architecture.md §6). A
  generator body cannot live inside an "active span" callback, because it yields control
  between steps. Re-enter the turn's trace context explicitly on each step, or nested
  generations and tool spans will detach from the turn.
- **Summarization may not nest.** Compaction runs before the loop (architecture.md §8), possibly
  outside the turn's context, so its generation can show up as its own trace. Either accept
  that or pass the context in; know which you have before reading a trace.

## Linking

Return the `traceId` from the loop in its final event. Store it:
- on the **final assistant message**, so reply feedback can attach to it;
- on **every proposal** the turn created (read the active trace id inside the propose tool), so
  the user's later accept or reject attaches to the turn that produced it, possibly days later.

Without stored ids, a score has nothing to attach to. See [proposals.md](proposals.md).

## Scores

**Principle:** scores are cheap, idempotent, and never on the request's critical path.

| Score | Type | Value | Id | When |
|---|---|---|---|---|
| `proposal_decision` | categorical | `accepted`, `rejected`, `accept_failed` | `proposal-decision-<proposalId>` | decision route; comment e.g. line count or edit count, or the error code on failure |
| `reply_feedback` | numeric | 1 (up) / 0 (down) | `reply-feedback-<messageId>` | feedback route; optional user comment |

- **Acceptance rate is the real product-quality metric.** A proposal the user accepts unedited
  was right; edited means close; rejected means wrong. Record the edit count in the comment so
  you can tell "accepted" from "accepted after heavy fixing".
- **Deterministic score ids** so a retry or a changed decision updates the same score instead of
  adding a duplicate.
- **Fire-and-forget.** Log scoring errors, never throw them into the request. A tracer outage must
  not fail an accept.
- **Clearing a vote deletes the score.** Flush any pending create first, or the delete races it
  and the vote reappears.

## Debugging a failed turn

On failure, store the `traceId` next to the failure record (`lastFailedTurn`, or the message)
alongside the safe error. Support or you then looks up that one trace: which call threw, what
the tool returned, how long each step took. For a wrong-but-successful answer, open the trace of
the message (its stored `traceId`) and read the tool observations first; most bad answers are bad
tool results or a missing tool, not a bad model.

Tracer APIs change, and some legacy endpoints get retired. Check the current API before
scripting against it rather than copying an old query. Prefer the tracer's own UI or its
current observation-level query API.

## What NOT to send

- **Secrets and tokens**: no API keys, auth headers, or session tokens in span attributes,
  inputs, or metadata. Redact before recording.
- **Host and process details**: covered by disabling resource detectors above.
- **Raw vendor errors belong in traces and server logs only.** Never return them to the client;
  map them to a small set of fixed, safe messages (architecture.md §3).
- Remember traces hold user content and tool results. Apply the same access and retention rules
  you would to the conversation store.

## Metrics that matter

**Principle:** alert on a handful of numbers that each map to a known failure; everything else is for exploring after the alert.

| Metric | Source | Suggested alert (tune from your own baseline) |
|---|---|---|
| First-token latency (p50 / p95) | time to first token on the `generate-response` generation | p95 > 5 s for 10 min |
| Turn latency (p50 / p95) | root span duration | p95 > 75% of `OVERALL_TIMEOUT_MS` |
| Tool error rate, per tool | tool observations with an `error` result | > 5% over 30 min, min sample 20 |
| Cache hit rate | `cachedInputTokens / inputTokens` | drops > 20 points vs the previous `promptVersion` |
| Cost per turn | usage x price table, by purpose | mean > 1.5x trailing 7 days |
| Proposal acceptance rate | `proposal_decision` scores | accepted-unedited below your baseline by > 15 points over 7 days |
| Thumbs ratio | `reply_feedback` scores | down-rate above your baseline by > 10 points over 7 days |
| 429 rate | controller, split by `RATE_LIMITED` / `USAGE_LIMIT_REACHED` / `BUSY` | `BUSY` > 2% (capacity); any org near its cap |
| `degraded` rate | trace metadata ([reliability.md](reliability.md) §4) | any sustained rise, by reason |

- Alert on **rates over a window with a minimum sample size**, not single events; a nondeterministic system has bad turns constantly.
- Split every metric by `model`, `promptVersion` and tool name: an average across a deploy hides the regression the deploy caused.
- Exclude traces tagged `eval` from all of the above.
- Acceptance and thumbs are lagging (users decide hours later); use them for weekly trends, and latency/errors/cache for paging.

## Prompt and tool versioning on the trace

**Principle:** a regression you cannot tie to a change cannot be fixed, only guessed at.

Attach to the root span's metadata on every turn:

- **`promptVersion`**: a short hash of the system prompt text (or a manual version string), computed once at startup. A hash cannot be forgotten on edit.
- **`toolSetHash`**: a hash of the sorted tool names plus each tool's description and JSON schema, for the toolset offered *to this caller*. It changes when a tool is added, removed or re-described.
- **`model`**: the resolved model id for the turn, and the fallback if it was used ([reliability.md](reliability.md) §4).
- Optionally `gitSha` of the deploy.

Then "faithfulness dropped on Tuesday" becomes "faithfulness dropped when `toolSetHash` changed", and the dashboards in [evals.md](evals.md) (eval run record, production-sampling trend) group on the same fields. These hashes are also what to compare when the cache hit rate falls: a changed `promptVersion` or `toolSetHash` means the prefix changed.

## Closing the loop

Traces, scores and metrics only matter if something acts on them. Every thumbs-down and rejected proposal feeds the review queue and, when labelled prompt or tool, becomes a golden case: see "Feedback-to-eval loop" in [evals.md](evals.md). Every mutation the agent caused is recorded in the audit log, separate from traces, with the `traceId` that links it back here: see [trust.md](trust.md) §3.
