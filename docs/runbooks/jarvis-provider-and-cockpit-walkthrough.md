# Jarvis provider health, failover, and cockpit walkthrough

Status as evaluated **2026-06-27** against the hosted app `oshal.agenticfederal.us`,
driven through the operator's signed-in Chrome over CDP (read-only). This documents
why Jarvis appeared to "go red," the verified state of the cockpit, and the
remaining fixes with exact locations.

## 1. Symptom

Ticket history showed conversations and tasks turning from green (active/complete)
to red (escalated/cancelled) quickly and repeatedly.

## Fix 2026-06-28 — bridge swarm tools into the Claude Code harness

Implements the fix for root cause #2 below (registry tools unreachable under Claude
Code). Additive; fail-open (never breaks a run if the bridge can't initialize).

- `scripts/oshal-tools-mcp.js` — dependency-free stdio MCP server. `tools/list`
  and `tools/call` proxy to the api with the shared `SWARM_SERVICE_SECRET` and the
  acting user (`x-oshal-user-sub`), so tools run through the SAME server-side
  executor (user-scoped, audited).
- `src/app/routes/internal-tool-bridge-routes.ts` — `GET /api/tools/for-agent/:agentId`
  (a bot's enabled `agent_tools`) and `POST /api/tools/execute` (run one via
  `ToolExecutorService`). Mounted under `/api/tools` behind `serviceSecretOr(requiresAuth)`
  in `server.ts`.
- `claude-code-cli-harness-adapter.ts` — `resolveToolBridge()` writes a per-task MCP
  config (base servers + an `oshal-tools` server scoped to this bot+user via env) and
  appends `mcp__oshal-tools` to `--allowedTools`; `wipeToolBridge()` deletes the
  secret-bearing per-task file after the run.

Net effect: a persona bot's registered tools (e.g. `career_database`) become real
MCP tools the Claude Code bot can call. Requires an api image rebuild + redeploy to
take effect (the adapter runs in the api process). Verify after deploy: ask the
career-advisor for "job matches 80%+" and confirm it returns real numbers instead of
"no data," and that `_walkthrough-shots`-style dispatch returns `success:true` with a
populated answer.

## Update 2026-06-28 — the actual "everything fails" root causes (verified)

Reading the escalated tickets' metadata (not counts) revealed the real chain:

1. **Worker dispatch was 401 (now FIXED).** Tasks Jarvis handed to a worker bot
   escalated with `manifest_worker_dispatch_failed: localhost send-message failed
   (401): unauthorized`. The controller dispatches via
   `POST /api/send-message` with `serviceSecretHeaders()`; when
   `SWARM_SERVICE_SECRET` is unset the header is omitted and the route returns 401.
   It is now set (64 chars) in `api` + `jarvis-bot`. Verified live: the exact call
   returns `400` with the secret (past auth) and `401` without it; a real dispatch
   to `cb…0002` returned `200 success:true` and the worker ran. The failed items in
   the Jarvis Work Queue are STALE (06-22 / 06-26, before the secret existed).

2. **Framework/app tools are not bridged into the Claude Code harness (CURRENT
   BUG).** The worker ran but could not complete: the `career-advisor` persona
   (agent `cb…0002`) is authorized for the framework tool `career_database` (per
   `ai-lab/bot-personas/career-advisor.yaml` → `authorizations: career_database: auto`,
   registered in the `career-hunter` manifest, since carved out to the
   oshal-applications store per ADR-085:
   `https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/main/career-hunter`).
   But it executes via
   `claude-code-cli-harness-adapter` with a fixed
   `allowedTools = Bash,Read,Write,Edit,MultiEdit,Glob,Grep,LS,WebFetch,WebSearch`
   and `mcpConfigPath` exposing only `fetch, google-search, unrealMCP`.
   `career_database` is in neither, so the bot's injected tool instructions point at
   a tool it cannot call — it reports "no data" and (correctly) refuses to fabricate.
   FIX: bridge framework/app tools into the Claude Code harness (allowedTools + MCP),
   or route persona bots that depend on app tools through a harness that exposes the
   registry (codex / inline / remote-client MCP, which registered 8 tools).

3. **Account split (viewing).** All work + connectors are under
   `owner@example.com` (sub `…1069`, 174 tickets, newest live). A second
   identity (sub `…1153`, e.g. agenticfederal.us) owns 1 ticket. Viewing the
   cockpit as the second identity shows "newest ticket a day ago." Sign in as gmail
   to see the real queue. Also: the Tickets view's default "Active" filter hides
   `complete` tickets (e.g. the 2-hourly trading ones), so newest-visible looks old.

## 2. Diagnosis (earlier-evaluation root causes, in order of impact)

1. **Intermittent Codex auth failure.** The jarvis-bot runs primary provider
   `openai-codex` (`gpt-5.5`). Its `auth.json` token (`last_refresh 2026-06-22`)
   periodically fails to refresh, throwing `401 Unauthorized` /
   `Failed to refresh token` on `wss://chatgpt.com/backend-api/codex/responses`.
   When it does, the turn falls back to `claude-code` (your Claude subscription),
   adding ~10s latency and silently spending Claude credits. Clusters were seen
   ~19:46-19:48 and ~01:00-01:02; at re-check 2026-06-27 there were 0 errors in
   the prior 90 min, i.e. the token is aging and fails on some refreshes, not all.
2. **Escalated LoRA tickets.** 8+ `oshbrainrot` LoRA train/validate/improve tickets
   are escalated. LoRA Studio renders, but training escalates because there is no
   GPU box wired in. This is the bulk of the visible red.
3. **Blocked queue / routing failures.** Operations shows the queue in a
   `blocked` state with `5 routing fails` and `43 flagged` build-open tickets;
   swarm health ~51% (27 online, 2 degraded, 24 offline).
4. **Read-only filesystem on one trading/task container.** One task at ~01:02
   failed because its exec container had a read-only FS (same class as the world
   deep-dive `:ro`→`:rw` fix, different container).
5. **Cancelled daily-trade-recap test runs** (5x) — manual/scheduled test tickets.

## 3. Verified current state (what actually works)

Jarvis is **not blocked**. A live `POST /api/jarvis/ask` through the authenticated
session returned a real answer end-to-end on `openai-codex` (no fallback), e.g.
"I can answer quick questions and coordinate work across tools like email, jobs,
travel, shopping, finance, research, smart home, and coding."

All ~40 cockpit apps render. Interactions actually exercised and verified:

| App | Action performed | Result |
|---|---|---|
| Jarvis | live chat turn (API, your session) | answered, on Codex |
| Shop | clicked Add to cart | cart total $7.04 -> $9.82 |
| Security Center | clicked Run scan | scan completed, timestamp advanced; 50 findings / 49 open |
| Rides | asked concierge for an estimate | replied, but no hard price ("No route yet") |
| Eats / Smart Home / Test Lab | search / toggle / run | controls not driven by the test harness (custom selectors); apps render fine |

Apps awaiting a connector (correct "connect me" state, not bugs):
**Email/Inbox** (Gmail not connected), **Payments** (Square/PayPal not connected),
**Music/Spotify** ("checking"), **user-level Codex** (Cloud page shows
"Not connected — import your Codex auth.json"; the swarm still runs Codex via the
container-baked token).

Apps that looked blank/stuck on the first fast pass were timing artifacts under
host load; with a longer settle Finance, Operations, World Intelligence, Workflow
Studio, and Bot Forge all render fully.

## 4. Provider failover — the gap

Expectation: "if Codex auth fails, redirect to OpenRouter / Gemini / Claude Code."

Reality (code): the automatic stall-fallback chain is **CLI providers only** —
`openai-codex -> claude-code`, `cline-cli -> claude-code`, `claude-code -> openai-codex`.
See `src/app/bot-node-server.ts` (`maybeWrapBotNodeProviderFailover`, the
`fallbackName` branch ~L726-L737) and `src/app/composition/provider-runtime.ts`
(`resolveProviderStallFallbackProviderName`).

There is **no** runtime auto-failover to OpenRouter or Gemini on a Codex 401.
ADR-064 §5 *designs* genuinely-free public endpoints (OpenRouter `:free`, Groq,
Cerebras, Google AI Studio) to sit in a per-user rotation as a "last resort"
fallback, and ADR-064 is the "connect your own free tier" feature
(`/api/connect/free-tier`). But that rotation is opt-in and per-user; it is **not**
wired into the bot-node provider-stall resolver above, so when Codex's token fails
the only net that actually fires is `claude-code`. Bridging the two — having the
stall resolver consult the ADR-064 free-tier rotation — is remediation #2 below.

## 5. Security findings (from the live scan)

The Security Center scan reported **50 findings, 49 open** (7 critical, 24 high,
3 medium, 15 low). The first critical is a **Private key block in
`src/features/governance/dlp/redactor.test.ts:30`**, git-tracked (`committed: true`).
This is in a DLP redaction *test* file, so it may be an intentional fixture, but it
must be assessed (use the "Assess" action in Security Center). Related context:
the project already tracks committed-secret cleanup history.

## 6. Pending remediations (and why they are not auto-applied)

These were intentionally **not** executed automatically because at evaluation time
the repo had ~145 uncommitted files (an active build session) and `oshal-local-api`
had just been redeployed. Applying code or container changes blindly would risk
that work.

1. **Re-auth Codex (the durable fix for #2.1).** The host's `~/.codex/auth.json`
   is identical to the bot's (both `2026-06-22`), so copying it in is a no-op.
   This requires an interactive `codex login` on the host (or importing a fresh
   `auth.json` via the Cloud page connector). Operator action.
2. **Bridge the stall resolver to the ADR-064 free-tier rotation** (so Codex 401
   can fall to OpenRouter/Gemini, not only `claude-code`). Additive change to
   `bot-node-server.ts` / `provider-runtime.ts`; recommended off by default behind
   a flag and built in an isolated worktree so it does not disturb the active tree.
   Requires the free-tier provider instances to be resolvable from the stall path.
3. **GPU for LoRA training.** Until a GPU worker is connected, LoRA train/validate
   tickets will keep escalating; consider auto-no-bidding or pausing that queue.
4. **Assess the redactor.test.ts key finding** (Security Center -> Assess).
5. **Investigate the read-only-FS exec container** (#2.4).

## 7. Live walkthrough test suite (added)

Foreground, read-only Playwright that attaches to your signed-in Chrome over CDP
(does not prune your tabs):

- `tests/live/_attach-noprune.ts` — CDP-attach fixture that leaves your tabs alone.
- `tests/live/zzz-full-walkthrough.live.spec.ts` — sweep + deep read-only interactions.
- `tests/live/zzz-fullcatalog.live.spec.ts` — clicks every nav app (all ~40).
- `tests/live/zzz-actions.live.spec.ts` — actually operates apps and asserts outcomes.
- `tests/live/zzz-recheck.live.spec.ts` — re-checks slow/blank surfaces with a longer settle.

Run (Chrome already on `--remote-debugging-port=9222`, signed in):

```
OSHAL_E2E_BASE_URL="https://oshal.agenticfederal.us" \
  npx playwright test --config playwright.live.config.ts zzz-full-walkthrough
```

Screenshots land in `_walkthrough-shots/` (gitignored artifact, not committed).

Bug fixed during this work: `tests/live/helpers.ts` `listRibbonTools()` referenced
Node-scope helpers inside a browser `evaluateAll` (threw `cleanRibbonLabel is not
defined`); cleaning/mapping now happens in Node.
