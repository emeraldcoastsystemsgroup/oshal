<!--
CHANGE LOG
-----------------------------------------------------------------------------
SEQ                 | AUTHOR                      | DESCRIPTION
-----------------------------------------------------------------------------
1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — full plan to migrate the standalone ai-optimize (C:\Projects\ai-optimize, :8799) into native OSHAL surfaces + tools + a bot, retiring the standalone Docker stack.
-->

# ai-optimize — Native Migration Plan

> **Status — 2026-06-17: PLANNED, not started.** Awaiting operator sign-off.
> Legacy app still runs standalone at `C:\Projects\ai-optimize` → `docker compose` → `localhost:8799`
> (container `ai-optimize-ai-optimize-1`). It stays up until each native surface reaches parity, then we retire it.

**Goal:** retire the standalone ai-optimize Node app and rebuild **100% of its functionality** as a native
OSHAL surface + bot, architected for the swarm (per-user data, cost in `chat_tasks`, the OSHAL provider
registry as the single catalog). This is the **Token Chase pitch made visible** — race one prompt across N
provider/model configs, compare **cost / tokens / latency / judged quality**, pick the right model for a job.

## What the legacy app does (parity target)

Type a prompt → every configured `(provider, model, harness)` config runs **concurrently** → each row lands
live with **cost, tokens, latency, the answer, and a judged quality score (1–10)**. Cheapest / fastest /
best-answer flagged. Then a graphical report — five charts incl. a **cost-vs-quality scatter** — with
**PDF / CSV / JSON** export and a reloadable run **history**. Source map (`C:\Projects\ai-optimize\runner\`):

| Legacy module | Responsibility | Native OSHAL home |
|---|---|---|
| `engine.mjs` | per-config CLI/REST adapters, rate-card cost estimate, the judge, `runConfig` | **delete** — reuse OSHAL harness adapters + `chat_tasks` real cost + a judge bot call |
| `providers.mjs` | ESM wrapper vendoring OSHAL's `LLMProviderRegistry` | **delete** — use the real registry directly (`provider-definitions.ts`) |
| `server.mjs` | http server, inline UI, roster/keys/run endpoints | `optimize-routes.ts` + a cockpit surface |
| `sweep.mjs` / `report.mjs` | headless batch + static report | a `optimize` ticketType (scheduled batch) + the report surface |
| `.secrets.json` keys | per-app provider keys | **delete** — per-user connector tokens (ADR-042) |

## Architecture (ADR-036 bot-owned, ADR-038 bundle)

- **The race is LLM work → it runs on bots, never the controller.** Each config row = one `(provider, model,
  harness)`. The controller surface collects the prompt + selected configs, then dispatches each row to be
  executed natively. Cost is captured in `chat_tasks` automatically (`recordCost`), which **replaces the
  legacy rate-card estimator entirely** — OSHAL bills real, not list-price guesses.
- **An `optimizer` bot owns the domain** (ADR-036): it runs the judge (quality score + rationale), owns the
  per-user run **history** in a `user_sub`-keyed store, and reasons over results ("for *this* prompt, the
  sweet spot is Haiku — Opus adds 2 quality points for 14× the cost"). Real node: container + registry +
  persona, heartbeating — not an inline stub.
- **Surface = a view** (ribbon `ui.static`) over the bot's run store + the live race stream.

### The one real design decision — how a row executes

ai-optimize races **arbitrary** `(provider, model)` combos, including ones with no standing bot node. OSHAL
bots are a fixed registry. Two options; **Phase 1 picks (A), Phase 6 may add (B):**

- **(A) Ephemeral harness execution** *(recommended)* — call the existing `BaseCliHarnessAdapter` subclasses
  (`claude-code-cli`, `codex-cli`, `gemini-cli`) directly for a one-off run with the per-user connector token,
  no standing bot. This is the same seam as the BYO-LLM connector (`getUserLlmConnection()`). Each ephemeral
  run still records cost to `chat_tasks` keyed to the caller. Matches the legacy app's adapter model 1:1.
- **(B) Standing-bot dispatch** — fan the prompt to already-registered bots via `BotNodeClient.execute`. Only
  covers providers that have a live bot; richer (full persona/tooling) but can't race ad-hoc combos. Use as an
  optional "race my actual swarm bots" mode later.

## The legacy views → native surfaces

| Legacy UI / endpoint | Native surface / route | Phase |
|---|---|---|
| roster + `⚙ Settings` (keys, rate card, custom configs) | `optimize-configs.html` + `GET/POST /api/optimize/configs` (catalog from the registry; keys = connector tokens) | **1** |
| prompt box → live concurrent race (`POST /run`) | `optimize-race.html` + `POST /api/optimize/race` (SSE/stream of per-row results) | **2** |
| judged quality score + cheapest/fastest/best flags | judge runs on the optimizer bot; flags computed server-side | **3** |
| 5 charts incl. cost-vs-quality scatter + PDF/CSV/JSON export | `optimize-report.html` (reuse the legacy inline chart JS, dependency-free) + export routes | **4** |
| reloadable run **history** | per-user `user_sub`-keyed run store + `GET /api/optimize/runs` | **5** |
| `sweep.mjs` headless batch | `optimize` ticketType + workflow (scheduled batch race) | **6** |

## Phases + testable milestones

- **Phase 1 — Catalog + configs** *(testable: pick provider→model→harness from the real OSHAL registry, save a
  roster; keys resolve from connector tokens, not an app secrets file)*. Build `optimize` app bundle skeleton
  (manifest, persona, container, registry entry), the configs route + surface.
- **Phase 2 — Live race (ephemeral exec)** *(testable: type a prompt, N rows land concurrently with real cost,
  tokens, latency, answer)*. Wire option (A); each row → `chat_tasks`. No judge yet.
- **Phase 3 — Judge + selection** *(testable: each row gets a 1–10 score + rationale; cheapest/fastest/best
  flagged)*. Judge runs on the optimizer bot (cost applies).
- **Phase 4 — Report + export** *(testable: 5 charts incl. cost-vs-quality scatter render natively; PDF/CSV/JSON
  download)*. Port the legacy inline chart JS verbatim where possible.
- **Phase 5 — History** *(testable: prior runs reload from the per-user store; owner-scoped)*.
- **Phase 6 — Batch sweep + retire** *(testable: a scheduled `optimize` ticket races the roster headless; legacy
  :8799 stack stopped)*. Optionally add mode (B) "race my swarm bots".

Each phase: native route(s) + surface, `npx tsc --noEmit` clean, rebuilt + deployed + verified on real data,
committed, operator notified it's testable. Legacy stack stays up until Phase 6.

## Done-when (the whole migration)
`/cockpit/?app=optimize` races a prompt across the OSHAL provider catalog, shows real per-row cost (from
`chat_tasks`) / tokens / latency / judged quality with cheapest-fastest-best flags, renders the cost-vs-quality
report with PDF/CSV/JSON export, reloads per-user history, and runs headless batch sweeps via an `optimize`
ticket. Keys are per-user connector tokens. The standalone :8799 container is stopped and removed from the host.
The optimizer bot owns the judge + history and reasons over results.

## Security / accountability checklist
- All `/api/optimize/*` routes wrapped in `requiresAuth` (running an LLM / spending money → must be auth-gated).
- No app-level provider keys on disk — only per-user connector tokens (ADR-042), brokered to the ephemeral run.
- Every race row records to `chat_tasks` so spend is visible and attributable (the legacy app had no cost capture).
