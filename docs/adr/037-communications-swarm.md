# ADR 037 — The communications swarm: lean, tool-equipped bots

Status: **Accepted — Phases 1–2 built** (2026-06-15). The email/Intelligent
Communication swarm is the **reference implementation** for the swarm catalog
([ADR 038](038-swarms-bundled-by-type.md)); Phases 3–5 (cache, cron, multi-bot,
more providers) tracked in [BACKLOG.md](../BACKLOG.md).
Builds on: [ADR 036 bot-owned application architecture](036-bot-owned-application-architecture.md), [connectors-tenant-isolation](../architecture/connectors-tenant-isolation.md)

## Context

Building the Intelligent Communication app surfaced a mismatch. The email bot
(`email-summarizer`) is a **single heavyweight persona** (211 lines, ~28 tool/CLI
references) designed to run a full agentic Gmail workflow: shell out via Bash to a
CLI, fetch mail, and write a digest deliverable. Two problems:

1. **Harness mismatch.** The persona was authored for **codex-cli + a `bash`
   sandbox** (which can shell out). But it was forced onto **claude-code as root**,
   where claude refuses `--dangerously-skip-permissions` — so native bash/tools
   aren't auto-approved and the model can't run the CLI. (A *separate* red herring
   on the way: `/root/.claude:ro` makes `session-env` read-only — real, but **not**
   the cause; every bot has it and they work, because they produce text the harness
   captures rather than relying on bash.) The bot returned tool-error commentary.
2. **It's the wrong shape.** ADR-036 calls for **light, fast bots with the right,
   working tools + reasoning** — not one do-everything persona. A heavy agentic
   loop is a poor fit for an interactive "summarize this" / "draft that" request.

Owner direction: *"the email fetch becomes a tool and the bot is the reasoning
engine which has the tool … light and quick with reasoning and data access … do
what is right for the long term."*

## Decision

Communications is a **swarm of lean, tool-equipped bots**, not one heavy bot.

1. **Data access is CLI-based, NOT MCP.** (MCP is not used in OSHAL.) The
   email/calendar pull uses the **`scripts/oshal-gmail.js` CLI**, which reads
   Gmail + Calendar via the **per-user connector token**
   (`getValidAccessToken(sub, 'google')`, [connectors-tenant-isolation](../architecture/connectors-tenant-isolation.md)),
   refreshes it, and returns JSON. *Who runs that CLI* is the one real choice —
   see "Who runs the pull" below.
2. **The bot is a lean reasoning engine.** Trimmed persona (reason over the data
   it is given or pulls), not the 28-reference workflow.
3. **The bot owns a per-user store** (`oshal_email_digests`, `user_sub`-keyed,
   AES-256-GCM) — it caches its reasoning so it can pull from it later, isolated.
4. **Three triggers, one owner:** cron delta-pull (every X min) → cache;
   on-demand reasoning (chat/surface) → cost in `chat_tasks`, settings applied;
   a 24h pass → morning dashboard.
5. **Multiple bots as it grows** — split ingest vs reason when warranted; add
   Facebook/Outlook/Yahoo as connectors behind the same CLI + reasoning pattern.

## Who runs the pull — the harness reality

The fetch is a CLI. The choice is whether the **controller/api** runs it or the
**bot** runs it, and the bot running it depends on its harness's shell:

- **claude-code as root cannot run Bash** (the CLI). claude refuses
  `--dangerously-skip-permissions` as root, so the bot produces text and the
  harness writes deliverables — it cannot shell out. So a claude-code bot
  **cannot run the CLI itself**; the **api runs `oshal-gmail.js`** and hands the
  bot the data to reason over. **This is the current, working baseline.**
- **codex has a real sandbox** (`danger-full-access`) and runs the CLI directly,
  so a codex bot **can pull its own mail** via `oshal-gmail.js`. This is what the
  original persona assumed — and codex now works (`CODEX_MODEL=gpt-5.5`; the
  `gpt-5.3-codex` default is invalid for a ChatGPT-account login). See
  [[oshal-harness-override-precedence]].

So **"the bot owns the pull" = a codex bot.** The catch: the bot-node *container*
runtime (`bot-node-server.ts`) only builds **cline + claude-code** providers —
codex runs **inline** (oshal-api) today. For the email bot to be a real codex
**node** that runs the CLI, **add a codex provider to `bot-node-server.ts`**
(the next increment). This is the harness-agnostic platform working as intended:
the same connector + CLI + persona, executed by whichever harness fits the bot.

## Phased plan
1. **DONE** — lean reasoner bot (claude-code) + the surface. The **api runs the
   `oshal-gmail.js` CLI pull** and the bot reasons; on-demand summary/draft works,
   cost lands in `chat_tasks`, per-user encrypted digest store in place.
2. **DONE — Codex provider in the bot-node.** `CodexProvider` + `CodexCLIWrapper`
   (`any-bot/server/...`) added alongside cline + claude-code; `AgenticController`
   gained a `codexProvider` slot; `bot-node-server` selects it on
   `FORCE_LLM_PROVIDER=openai-codex`. The email bot now runs on **codex (gpt-5.5)**
   and **runs `oshal-gmail.js` itself** in its sandbox — verified: it fetched the
   real connected inbox + calendar and summarized (22.8s, `provider=openai-codex`).
   **The bot owns the pull.** Persona restored to the codex CLI-pull reasoner.
3. **Per-user raw-mail cache** + delta-pull semantics in the CLI. *(Next.)*
4. **Cron delta-pull** (every X min) + **24h digest** → morning dashboard.
5. **Split to multi-bot** (ingest vs reason) + add Facebook/Outlook/Yahoo connectors.

## Consequences
**Positive** — works today on claude-code; light/fast bots; cost + settings +
isolation + storage all native (ADR-036); CLI-based (no MCP); a consistent shape
for every comms channel; harness-agnostic (any bot, any harness).

**Negative / notes** — codex bots run on the bot-node now (Phase 2 done); cost on
a ChatGPT-account login is $0/call (subscription), so `chat_tasks` records tokens,
not dollars, for codex. The 211-line persona was trimmed then restored to a lean
codex CLI-pull reasoner.

## Status (2026-06-15)
**Working + tested:** surface→bot dispatch via `BotNodeClient`; **direct mode**
(interactive calls skip ticket scaffolding); per-user encrypted digest store;
on-demand summary + draft with cost in `chat_tasks`; framework fixes banked
(`/api/swarm-execute` response+cost relay, `agenticMode` honored). **Phase 2
DONE:** a **Codex provider in the bot-node** (`CodexProvider` + `CodexCLIWrapper`
+ `AgenticController` slot); the email bot runs on **codex (gpt-5.5)** and **runs
`oshal-gmail.js` itself in its sandbox** — verified fetching the real inbox +
summarizing (22.8s). **Codex was never broken** — `CODEX_MODEL` just defaulted to
a model a ChatGPT-account login can't use (`gpt-5.5` works). **Next:** Phase 3 —
per-user raw-mail cache + cron delta-pull + 24h morning digest.
