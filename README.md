# ai-agent-architecture

A Claude Code skill that builds a complete, modern agentic AI into any app — the kind of assistant users already know from Claude, ChatGPT and Gemini — instead of a bare "chat over an API".

**Backend:** provider-agnostic tool-use loop (Anthropic + OpenAI adapters), RBAC-filtered tool registry, server-owned memory with compaction, proposals and reversible actions with undo, concurrency control, SSE streaming, golden-set eval gate.

**Frontend:** React + Tailwind + TanStack Query chat shell — streaming markdown, visible reasoning, activity trail, proposal cards, artifacts panel, attachments, @mentions, follow-ups, model picker. Survives reload and route changes.

**Doctrine:** 16 references covering tool design, prompting, UX, reliability, trust/PII, memory, multi-agent, retrieval, rich output, observability, evals and a canonical API contract.

## Install

Claude Code:

```
/plugin marketplace add SnehModi/ai-agent-architecture
/plugin install ai-agent-architecture@sneh-skills
```

Other agents (Cursor, Codex, etc.):

```
npx skills add SnehModi/ai-agent-architecture
```

## Use

In your app's repo:

```
/ai-agent-architecture            # full build: intake → backend → UI → evals
/ai-agent-architecture add-tool   # add one tool to an existing agent
```

Scopes: `full | backend-only | ui-only | add-tool | add-provider | add-memory | add-artifacts | add-subagent | add-retrieval`.

The skill starts with a 12-question intake (users, data, write policy, provider, UI surface…), picks a maturity level (L1 answers → L4 autonomous with background tasks), then scaffolds backend and UI from `skills/ai-agent-architecture/assets/scaffold/` and wires your domain tools.

## What you get

```
server/agent/
  loop.ts  registry.ts  memory.ts  concurrency.ts  context-window.ts
  providers/{anthropic,openai,registry}.ts
  tools/<your-domain>.ts
  routes/  (POST /api/v1/agent/conversations/:id/messages → SSE)
web/agent/
  ChatShell, Thread, Composer, ProposalCard, ArtifactPanel, useAgentRun …
evals/golden-set.json
docs/agent.md
```

## Layout

```
.claude-plugin/        plugin + marketplace manifests
skills/ai-agent-architecture/
  SKILL.md             entry point, workflow, doctrine rules
  references/          design references the skill reads as needed
  assets/scaffold/     backend + UI code copied into your app
  evals/               eval cases for the skill itself
```

## License

MIT
