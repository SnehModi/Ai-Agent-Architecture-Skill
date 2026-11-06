# Tool Design

The single biggest lever on agent quality. The loop, the provider and the prompt are fixed
machinery; the tools are the model's entire world, and a model can only be as good as the names,
descriptions, schemas and results it is handed. Most "the model is dumb" bugs are tool-design bugs.
Each section states a principle and the reasoning. The contract is in
[architecture.md](architecture.md) §5; this file is how to fill it well.

## Contents

1. [Few broad tools](#1-few-broad-tools)
2. [Naming](#2-naming)
3. [Description anatomy](#3-description-anatomy)
4. [Input schema rules](#4-input-schema-rules)
5. [Result shape](#5-result-shape)
6. [Errors that teach](#6-errors-that-teach)
7. [Batching, caps and pagination](#7-batching-caps-and-pagination)
8. [Propose tools and idempotency](#8-propose-tools-and-idempotency)
9. [The delegate pattern](#9-the-delegate-pattern)
10. [Anti-patterns](#10-anti-patterns)
11. [Review checklist](#11-review-checklist)

## 1. Few broad tools

**Principle:** the toolset is a menu the model reads on every call; make it short and unambiguous.

Every tool definition is sent on every provider call, costs tokens each time, and is one more
choice the model can get wrong. Ten overlapping narrow tools (`get_order_total`, `get_order_status`,
`get_order_lines`) make selection harder and force extra rounds; one `get_order` returning a slim
projection answers all three in one call.

- Aim for **5-15 tools** per role. Past ~20, tool selection accuracy visibly drops; split by role
  (RBAC already filters, [architecture.md](architecture.md) §5) or delegate ([section 9](#9-the-delegate-pattern)).
- Shape tools around **questions the user asks**, not tables or REST routes. Parity
  ([proposals.md](proposals.md) §2) bounds what they may *do*, not how they are carved up.
- Typical split: one **search**, one **get**, one or two **summarize** tools (server-computed numbers),
  then propose tools.
- Adding a tool is a golden-set trigger ([evals.md](evals.md)): it can steal calls from an old one.

## 2. Naming

**Principle:** the name is the first thing the model matches against the user's words.

- **`verb_noun`, snake_case, consistent verbs:** `search_*` finds candidates, `get_*` fetches one
  by id, `summarize_*` aggregates, `propose_*` creates a proposal, `ask_user`. The verb tells the
  model the tool's *cost and effect* before it reads the description.
- Use the **business noun the user uses** and one name per concept (`search_invoices`, not `query_ar_ledger`).
- A name must not lie: a `get_*` never writes; a `propose_*` never applies. Step labels fall back on
  names ([runs-and-streaming.md](runs-and-streaming.md) §5).

## 3. Description anatomy

**Principle:** the description is a prompt for *when to call*, not documentation of the function.

Five parts, in order, 40-120 words total:

1. **What it does** (one sentence, business language).
2. **When to use it** (the user questions it answers; the id it produces for other tools).
3. **When NOT to use it** — name the sibling tool instead. This is the cheapest fix for wrong-tool
   calls and the most-skipped part.
4. **What it returns** (fields, order, cap, `truncated`).
5. **One example input.**

```
search_orders — Finds orders by customer, status or date range. Use for "which orders ..."
questions, or to get an orderNumber for get_order. Do NOT use for totals or trends (use
summarize_sales) or when the user gave an exact order number (use get_order). Returns up to 25
rows {orderNumber, customer, status, total, placedOn}, newest first, plus total and truncated.
Example: {"status":"overdue","placedAfter":"2026-01-01"}
```

- Describe **behaviour the model cannot infer** (sort order, what "recent" means, units, inclusive
  dates); field detail belongs in `.describe()`. State side effects and cost ("slow, scans all history").
- Description text is part of the cached prompt prefix ([reliability.md](reliability.md) §1): edit
  deliberately, in one commit, and treat a description change like a prompt change
  ([prompting.md](prompting.md) §8).
- The same descriptions feed the capabilities paragraph in the system prompt
  ([prompting.md](prompting.md) §3), so write them as complete sentences.

## 4. Input schema rules

**Principle:** every argument is a chance for the model to be wrong; remove arguments, then
constrain the rest.

- **Flat objects.** No nested objects or arrays of objects unless the shape is inherently a list
  (propose line items). Deep nesting is where models drop or mis-key fields.
- **Enums over free text** for anything with a known value set (`status`, `period`, `groupBy`).
  An enum is validated, documented and autocompleted in one line; free text invites "Overdue",
  "overdue invoices", "late".
- **Required minimal.** Only what the tool cannot run without; everything else optional with a
  safe default stated in `.describe()`. Required fields the model must invent get invented.
- **`.describe()` on every field**: meaning, format, example, and the default. The schema is the
  second half of the description.
- **Scope is never a model argument when pinned.** Identity, tenant and the current record come
  from `AgentContext` ([architecture.md](architecture.md) §4); if a field must exist for the
  unpinned mode, the tool prefers the pinned value and the `.describe()` says "omit when a record
  is already pinned".
- **Dates as ISO strings, money as numbers plus a currency code** field in results, not in input.
- **Bound every list and string**: `.max(50)` on arrays, `.max(200)` on text, `limit` with a
  `.max()`. An unbounded argument is an unbounded query.
- Re-parse with the same zod schema at dispatch; the model's args are untrusted input.

```ts
const SearchOrders = z.object({
  status: z.enum(['open', 'overdue', 'paid']).optional().describe('Filter by status. Omit for all.'),
  placedAfter: z.string().date().optional().describe('ISO date, inclusive. Example 2026-01-31.'),
  limit: z.number().int().min(1).max(25).default(10).describe('Rows to return (max 25).'),
  cursor: z.string().optional().describe('nextCursor from a previous call, to get the next page.'),
})
```

## 5. Result shape

**Principle:** the result is what the model will read aloud; shape it so reading it aloud is correct.

- **Slim, labelled projection.** Only the fields the answer needs; cap rows. Raw rows leak columns
  the user must not see and burn context replayed every turn ([architecture.md](architecture.md) §7).
- **Business names, not DB names:** `{ customer, placedOn, total }`, not `{ cust_id, created_at,
  amt_cents }`. The model parrots field names; if it sees `sales_trend_yoy` it will say it.
- **Numbers as numbers**, never formatted strings ("$1,200.00") or DB decimal strings. Coerce at
  the boundary; the model formats for the user and can still do arithmetic. Include the unit or
  currency as a sibling field.
- **Server-computed counts, totals and diffs.** The model never sums rows or counts a list; it
  quotes `total`, `count`, `changePct`. Model arithmetic over rows is the top source of wrong
  numbers ([proposals.md](proposals.md) §4 is the same rule for cards).
- **`truncated: boolean`** whenever a cap cut rows, plus the true `total` when cheap. Without it the
  model presents a page as the whole set.
- **Stable order** (state it in the description) so a second call is comparable.
- **Resolve ids to labels** server-side (batch join, no per-row awaits) so the model never has to
  call a tool just to turn an id into a name.
- Sources, if the UI shows citations, ride along as `sourceRefs` ([rich-output.md](rich-output.md) §4).

## 6. Errors that teach

**Principle:** an error is the next instruction to the model; spend it well.

Expected failures return `{ error }` ([architecture.md](architecture.md) §5) and the message should
say **what happened and what to try next**, in plain words with no ids or internals:

| Bad | Good |
|---|---|
| `{ error: "404" }` | `{ error: "No order with that number. Use search_orders to find the right one." }` |
| `{ error: "invalid input" }` | `{ error: "placedAfter must be an ISO date like 2026-01-31." }` |
| `{ error: "forbidden" }` | `{ error: "That record is outside the current scope; tell the user you cannot access it." }` |
| `{ error: "too many results" }` | `{ error: "More than 500 matches. Add a status or date filter and retry." }` |

- A zod failure is returned the same way: field name and the constraint, not a stack.
- Feature-flagged tools return `{ available: false, reason }` so the model explains instead of retrying.
- Keep error text short (step labels may show it, [runs-and-streaming.md](runs-and-streaming.md) §5); never
  echo user free text.
- Throws are for bugs only; the loop hides them behind a generic error that teaches nothing.

## 7. Batching, caps and pagination

**Principle:** one call should answer the question; when it cannot, make the next call obvious.

- **Accept arrays for lookups** (`orderNumbers: string[]`, `.max(20)`) rather than forcing N calls;
  resolve with one `$in`/join ([architecture.md](architecture.md) §5). Tools in one round already run
  in parallel, but each call is a round-trip of tokens and a possible wrong turn.
- **Hard row caps** on every list (10-25 default, 50 max). The cap is a context-budget decision, not a
  database one.
- **Pagination with an opaque `nextCursor`**, not page numbers: return it only when more exist; the
  model passes it back unchanged. Bind it to the user and query server-side (sign it or store the
  filter in it) and re-apply scope on every page, so a forged or replayed cursor cannot widen access.
- Prefer **aggregation to paging**: if the user's question is "how many / how much", give them a
  `summarize_*` tool; making the model page through 400 rows to count is both slow and wrong.
- Pass `opts.signal` to cancellable I/O so Stop works ([runs-and-streaming.md](runs-and-streaming.md) §3).

## 8. Propose tools and idempotency

**Principle:** the model will call a propose tool twice; the second call must be harmless.

Models retry, rephrase and re-propose after a user tweak. [proposals.md](proposals.md) §5 already
supersedes older pending cards; add a cheap guard on top:

- Derive an **idempotency key** = hash of `(conversationId, tool, normalized args)`. An identical call
  while that proposal is still `pending` returns the **existing** `proposalId` instead of creating a
  new row, so a double-call cannot churn cards or reset the user's edits.
- Return `{ proposalId, summary }` only, a one-line summary and no derived numbers
  ([proposals.md](proposals.md) §11). Text like "Created!" in the result teaches the model to claim it.
- Make required inputs **intent only** (what, which record, which quantity); the server computes
  prices and totals ([proposals.md](proposals.md) §4).
- Validate preconditions up front; return a teaching `{ error }`, not a card that cannot be applied.

## 9. The delegate pattern

**Principle:** when a toolset outgrows one prompt, hand a sub-task to a narrower agent as a tool.

A `delegate_*` tool takes a `{ task }` string, runs a scoped child loop with its own small toolset
and prompt, and returns a slim result. It is how a 30-tool surface becomes 8 tools plus 3 specialists,
without changing the loop. Rules for budgets, scope inheritance (the child never gets wider scope than the parent), result size
and tracing are in [multi-agent.md](multi-agent.md) §2-§3; do not build it before a single agent
measurably fails on breadth ([multi-agent.md](multi-agent.md) §1).

## 10. Anti-patterns

- **God tool:** `query(table, filter, ...)` or `do(action, args)`. The schema is untyped, RBAC and
  step labels cannot see what it does, and the model must know your schema. Replace with typed tools.
- **Raw rows:** returning the ORM object. Leaks fields, wastes context, teaches DB vocabulary.
- **Boolean soup:** `includeX, includeY, withZ, expanded, full` flags. The model guesses combinations;
  give each useful combination its own tool, or return the slim projection always.
- **Tools that return instructions:** `{ note: "now call get_order for each id" }`. Instructions in
  results are the same shape as prompt injection and train the model to obey result text. Return data
  and error hints ([section 6](#6-errors-that-teach)) only; sequencing belongs in the description.
- **Free-text enums, per-row awaits, hidden mutation in a `get_*`, preformatted numbers** in results.
- **Overlapping tools** with no "do NOT use" line, or descriptions that restate the name ("Gets orders."): no selection signal.

## 11. Review checklist

For every new or changed tool, before merge:

- [ ] Name is `verb_noun`, uses the user's noun, no synonym of an existing tool.
- [ ] Description has what / when / when NOT / returns / example, 40-120 words.
- [ ] Schema is flat, enums for closed sets, minimum required, `.describe()` on every field, bounds on every list and string.
- [ ] No scope, tenant or identity argument beyond the pinned-or-supplied pattern.
- [ ] Result is a slim labelled projection, business names, numbers as numbers, server-computed totals, `truncated` where capped.
- [ ] Every expected failure returns a teaching `{ error }`; nothing throws for "not found".
- [ ] Batched queries, capped rows, cursor if paged, signal passed through.
- [ ] `mode` is right; propose tools have the idempotency guard and parity is confirmed.
- [ ] Step label added ([runs-and-streaming.md](runs-and-streaming.md) §5).
- [ ] Golden case added, including one where the sibling tool is the right answer ([evals.md](evals.md)).
