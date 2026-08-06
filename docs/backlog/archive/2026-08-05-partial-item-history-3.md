# Final completed sub-items removed from partial backlog entries — 2026-08-05

These snapshots preserve mixed implementation narratives removed from the active queue.
Only `docs/BACKLOG.md` is authoritative for current work.

---

## Inline controller tool filtering and platform-secret scrubbing

### Inline controller bots — finish the remaining token-broker rollout and live proof
- **What:** The per-app chat bots `social-writer`/`storage-assistant`/`deck-builder` — and the
  pre-existing `codex-packer`/`project-manager` — run INLINE in the
  `oshal-api` (controller) container, which holds `SESSION_SECRET` (the master connector-token
  key) + `DATABASE_URL`. Those bots have `Bash` (via `CLAUDE_ALLOWED_TOOLS`), so in principle a
  bot could read the controller's env and reach beyond the chatting user. The acute case
  (`social-writer` purpose-built to handle per-user data inline) was mitigated by moving the
  social-data access to `communications-bot` (its own no-master-key container) and stripping
  `social-writer`'s shell/DB access. The general pattern remains.
- **Why deferred:** removing `Bash` per-bot needs the persona→harness `allowedTools` wiring (not
  just the global `CLAUDE_ALLOWED_TOOLS` env), or moving inline bots out of the controller into
  their own containers — both behavior-bearing changes, not a wrap-up edit.
- **Done when:** controller-resident bots cannot read `SESSION_SECRET`/decrypt another user's
  tokens — either they carry no `Bash` (per-bot `allowedTools` without it) or they run in
  dedicated non-controller containers; verified by attempting an env read from a bot tool call.

**Shipped 2026-08-01 — the `allowedTools` half of the done-when, plus a control the item missed.**
`resolveHarnessForAgent` resolves a per-bot scope from the registry `container`
([controller-inline-scope.ts](../../../src/features/llm-provider/services/controller-inline-scope.ts)) and
threads it into the harness factory, so this is per-bot wiring, not the global env:
1. **No shell for inline bots.** The deployment-wide `CLAUDE_ALLOWED_TOOLS` is filtered
   (`Bash`/`BashOutput`/`KillBash`/`KillShell`/`Shell`, case-insensitively) for any bot whose
   container is the api. Read/Write/Edit/Glob/Grep/WebFetch survive, so `codex-packer` still emits
   its persona + manifest. Bot-node bots keep the full incident "SWAT team" set — the restriction is
   inline-only and additive by construction.
2. **Platform-plane credentials scrubbed from the child env.** `SESSION_SECRET` was ALREADY scrubbed
   from every bot spawn (`BaseCliHarnessAdapter.SECRET_ENV_KEYS`) — the item's premise was partly
   stale. What was NOT scrubbed, and matters more, is `REMOTE_CLIENT_SHARED_SECRET`: it lives only on
   the api service, and it is MACHINE TRUST on the worker plane, meaning it skips per-device
   ownership. An injected inline bot holding it could enqueue a shell-exec task on ANY user's
   desktop. It is now deleted for inline spawns, along with
   `REMOTE_CLIENT_CONTROL_PLANE_TOKEN`/`ALERT_WEBHOOK_TOKEN`/`WORLD_INGEST_TOKEN`/`TV_PAIRING_SECRET`.
   Deliberately NOT scrubbed: `SWARM_SERVICE_SECRET` (personas legitimately call the api with it) and
   provider API keys (the CLI *is* the LLM caller).
- **Still open (why this is 🟨 not ✅):** a codex-harness inline bot has a shell by construction —
  the vendor CLI owns its own permission model and compose sets `CODEX_SANDBOX_MODE:
  danger-full-access` — so for those the env scrub is the load-bearing control and the tool list is
  not. `DATABASE_URL` also still reaches inline spawns (removing it risks breaking bot shell-outs
  that were not audited here; the api role is the non-superuser `oshal_app`, so RLS applies).
  The complete answer is this done-when's OTHER option: move inline bots into dedicated
  non-controller containers. That is a topology change with a compose + registry migration behind
  it, not a wrap-up edit. **Live verification of the done-when's own test** ("attempt an env read
  from a bot tool call") still needs a deployed stack.
- **Guard:** `tests/unit/inline-bot-no-shell.spec.ts` (13 cases; 6 targeted mutations proven red
  2026-08-01, including unwiring the scope in `provider-runtime` and dropping `extraSecretEnvKeys`
  from either `super()` branch of the claude adapter).

---

## Bot endpoint and send-message entitlement implementation

### Bot-endpoint privilege model — authorize the ACTUAL endpoint call, not just DB/UI ⬜ (CARRY-FORWARD SECURITY)
- **Why (operator-flagged):** access control must hold at the **bot endpoint-call layer** (`POST /api/swarm-execute`, `/api/send-message`), not only at the database (RLS) or by hiding UI. The failure case: **Jarvis (or any orchestrator) delegates to a cluster-node bot/tool the caller isn't entitled to** — e.g. a **kid reaching a parent's** privileged bot via Jarvis. Today bot-to-bot calls authenticate with a **service secret (machine trust)**, which proves *a bot is calling*, not *that this caller is entitled to that bot*.
- **Build on existing rails:** `requiresAuth` (route), `serviceSecretHeaders` (machine), `connector-token-broker`/`resolveBotCreds` (per-user tokens), ADR-056 ticketed data-access broker, the public-launch isolation audit (cross-user leaks), `BotNodeClient.execute`.
- **Done when:** every bot endpoint call carries the **authenticated caller's identity** (`userSub`) **and** an enforced **entitlement check** (RBAC / ownership / per-bot ACL) before execution; Jarvis/orchestrator delegation **propagates the caller's privilege and never escalates to the bot's**; a restricted user **provably cannot invoke or reach** a bot/tool outside their entitlement, even through Jarvis; covered by tests in the security-review/isolation suite. Ties to the per-app/per-bot scoping noted in [[oshal-iot-tenancy-design]] and the isolation audit.

**Verified 2026-07-19:** OPEN — `/api/swarm-execute` has the service-secret + fail-closed identity payloads, but no per-caller entitlement check at execute time.

**Status 2026-08-01 — the endpoint layer is now covered; delegation shape and the live proof remain.**
- ✅ `POST /api/swarm-execute` (bot node): `createExecuteEntitlementGate` runs after the machine-auth
  gate. Default mode is **enforce** (K6) — unknown values fail closed, `warn`/`off` are explicit
  opt-outs.
- ✅ `executeBotOrInline` (controller chokepoint): `assertExecuteEntitlement`, which is what covers
  INLINE bots — they resolve to a null endpoint and never reach the bot-node HTTP gate.
- ✅ **`POST /api/send-message` + `POST /api/tasks/:taskId/messages` — the gap this line named and
  nothing had closed.** The route honoured a caller-supplied `body.agentId` VERBATIM and called
  `ctx.orchestrator.processMessage` directly, never through `executeBotOrInline`. Its IDOR guard
  checks the THREAD, not the BOT, so a signed-in non-operator could reach exactly the ADR-087
  operator+swarm machinery K7 scoped (`oshal-developer`, `devops-bot`, `vault-bot`,
  `security-analyst`, `code-developer`, `tester-bot`, …) by naming its agentId on a task they
  legitimately own. The resolved agentId now runs through the SAME pure decision, BEFORE any ticket
  is created or any LLM work starts, and a denial answers 403 `caller_not_entitled_to_agent`.
  `direct` is set only for genuine interactive identity callers, so a valid service-secret call
  remains swarm/queue dispatch — the `dispatch-manifest-worker`/`dispatch-incident-worker` localhost
  fallback and the headless CLI are unaffected.
  Guard: `tests/unit/send-message-entitlement.spec.ts` (7 cases; the denial-path mutation proven red).
- ⬜ **Still open:** the done-when's *delegation* clause — "Jarvis/orchestrator delegation propagates
  the caller's privilege and never escalates to the bot's" — is satisfied in the paths above only
  because every one of them threads the caller's own sub. A bot-to-bot call-out (ADR-083) that
  re-enters on the service secret still presents as swarm dispatch, which is trusted by design; if a
  future call-out lets a USER-initiated turn fan out to a bot the user is not entitled to, that is
  the next hole. ⬜ Also open: the live restricted-user proof ("a restricted user provably cannot
  reach a bot outside their entitlement, even through Jarvis") on a deployed stack with
  `OSHAL_OPERATOR_SUBS` populated — the unit guards prove the decision, not the deployment.

---

## Kalshi implementation/carve and trading-watchdog high-severity fixes

## Prediction markets (event contracts) — Kalshi lane 🟨 PHASE 1 BUILT ([ADR-094](../../adr/094-kalshi-prediction-markets-app.md), [docs/apps/kalshi/](../../apps/kalshi/README.md)); Phase 2 NEEDS OPERATOR (account)

- **Context (2026-07-13 operator ask):** Robinhood's prediction-markets hub is EVENT CONTRACTS
  routed through **Kalshi** (CFTC-regulated exchange). Operator priorities for the build:
  "winning, not easy-to-use", "predictive market indicators", "identify the bets and weigh the
  risk — like a poker hand but with probability". OSHAL offers the lane the same way it offers
  equities: the user's OWN account, per-user brokered creds — never house-money, never custody.
- **Phase 1 BUILT 2026-07-13 (no account needed — Kalshi market data is public):**
  `src/features/prediction-markets/` (public client, quadratic fee math from per-series API
  metadata, settled-tape price→outcome **calibration** with beta shrinkage, two-sided poker-hand
  **bet evaluator**: net-of-fee edge, quarter-Kelly, risk-flag discounts), `swarm-apps/kalshi.yaml`
  (`?app=kalshi` surface at `/api/kalshi/`), calibration + scan scripts with evidence docs, and
  the connector card (two-value `keyId:PEM` paste, validated by RSA-PSS-signing a real
  `/portfolio/balance` call; `OSHAL_CRED_KALSHI` broker key). See ADR-093 for the rationale.
- **Phase 2 BUILT + live-verified 2026-07-13:** portfolio (balance/positions/resting orders),
  confirm-gated limit-order placement + cancel, `kalshi_orders` audit trail (migration 074) with
  the justifying `BetHand` snapshot, and the bet dialog on the surface. Four guards, each proven
  against the real exchange: live-money gate off the key's **detected** exchange (never a client
  flag; needs `KALSHI_LIVE_ENABLED=true`), explicit `confirm === true`, limit-only 1..99¢, and
  size/cost caps. Auth env is auto-detected per key — `KALSHI_API_BASE` is NOT the switch and
  should stay unset (compose never forwards `.env` into containers, and it would also point
  market data at the thin demo book).
- **Calibration re-study (the REAL next step — the 4-skeptic adversarial review judged v1 NOT
  tradeable as measured; see evidence doc + ADR-094 status):** rebuild
  `oshal-kalshi-calibration.ts` with (1) **ask-basis pricing** (candle `yesAskClose` /
  `1−yesBidClose` as entry cost; record per-sample staleness, drop >2 candle periods stale),
  (2) randomized series order, ≤10 markets/series, one observation per event per horizon,
  (3) series-level cluster-bootstrap intervals; gate the live table on the
  multiplicity-adjusted conservative bound clearing ask+fee, (4) 6–12-month date stratification
  via `min_close_ts`/`max_close_ts`, keep only regime-stable cells, (5) isotonic/monotone curve
  instead of 16 step buckets (kills the 0.50 discontinuity). **Pre-registered hypothesis to
  test:** YES at 0.50–0.60 beats ask+fee (the only cell that survived conservatively).
  Done when: the re-run table publishes ask-basis edges with cluster-robust CIs and the
  evaluator consumes only cells that pass the gate.
- **Follow-ups (either phase):** scheduled calibration refresh (table stales toward
  fold-everything — safe but blunt); grade scan snapshots (`docs/evidence/kalshi-scan-*.json`)
  against settlements = forward-test of the edge; paper-trade the scanner logging
  quoted-ask-at-signal vs achieved fill (adverse-selection measurement) before ANY live sizing;
  portfolio layer beyond the shipped per-event dedup (per-category aggregate caps); Polymarket
  cross-venue divergence as a second `trueProb` estimator feeding the SAME evaluator.
- **Remaining on Phase 2 (operator step, not code):** the operator's DEMO connection must be
  saved + made default on `/utilities` to actually paper-trade — the live connection is saved and
  the gate correctly refuses it (403). Once a demo order fills, grade it against settlement.
- **Done when (Phase 2):** ✅ a signed-in user can browse live Kalshi markets, place a DEMO order
  audited with its justifying hand snapshot, and see it in a positions ledger; live trading stays
  gated. (Code complete + live-verified; awaiting the operator's demo connection to fill a first
  paper order.)

**Verified 2026-07-19:** OPEN (operator-gated) — code live-verified; still awaiting the demo connection + first demo order fill (no fill evidence).

**CARVED 2026-07-19 (`d8a4ea3c`, ADR-085 Wave 3):** the Kalshi surface (kalshi.html + kalshi-routes.ts + swarm-apps/kalshi.yaml) is ripped from the kernel and now lives in the store package — `/api/kalshi` is unmounted from `server.ts`, the package re-mounts it (auth: service-or-oidc, the ADR-094 confirm/fail-closed order posture byte-identical). The prediction-markets ENGINE (`src/features/prediction-markets`), the kalshi connector + `OSHAL_CRED_KALSHI` broker key, the calibration/forward-test CLIs, migrations 074/075, and the `tool-kalshi-home` default tile stay core per ADR-093. The Phase-2 operator step (demo connection + first fill) and the calibration re-study are now tracked store-side.

The host-side [scripts/trading-watchdog.ps1](../../../scripts/trading-watchdog.ps1) had its 07-13..15
false-positive storm fixed (commits `f4d2b3a7`, `c1cc5b41`: session-mismatch heartbeat, container-
recreate guard, RTH-gated bleeders, core-hold exclusion, retried health probe, F-check logging). A
6-agent adversarial audit surfaced deeper FALSE-NEGATIVE classes — real problems the watchdog would
NOT catch. **The 3 HIGH items were closed overnight 2026-07-16 in `5f10bdab`** (one reframed after
tracing the engine); the medium/low items below remain. Ranked by real-money exposure:

- **✅ HIGH DONE (`5f10bdab`) — live check fails OPEN on a 503/error body.** `pos=(pj&&pj.positions)||[]`
  treated a Schwab-disconnected `{error}` (HTTP 503) as an EMPTY (=healthy) book, silencing the net
  during the weekly token-expiry window. FIXED: the live JS now asserts `response.ok` AND an array
  payload; a non-200/error body returns an explicit error (fail-closed). Schwab auth/token/config
  errors route to a once-daily "re-login needed" notice; anything else to a real `live-check-error`.
  The StartedAt/recreate guard already covers cold-start transients. (Two-consecutive-error hardening
  was deemed unnecessary given the guard + 60-min suppression; revisit only if transients recur.)
- **✅ HIGH DONE (`5f10bdab`) — heartbeat was book-agnostic and ignored run errors.** New B2 block:
  during RTH the LIVE (`_live`) schedule must show its own dispatch outcome or a distinct
  `live-loop-silent` alert fires (a healthy paper beat no longer masks a dead live loop); and any
  recent "run complete" whose `errors[]` is non-empty raises `autopilot-run-errors` (the 07-07
  zombie-fire signature — the loop "completes" but isn't doing its job).
- **✅ HIGH REFRAMED + DONE (`5f10bdab`) — live "no working sell" was structurally always-true.** The
  audit proposed reading working sells from the venue; an Explore pass corrected the premise: the
  live autopilot rests **NO** protective sells on Schwab — it exits via MARKET orders each 5-min run
  and *cancels* any working sell between runs (`trading-schedule-dispatch.ts` `freeStaleSells` /
  `persistDecision` hard-codes `order_type='market'`). So a venue read would still show zero resting
  sells; the true protection signal is loop-health (B2 above). FIXED as a semantic/text correction —
  the misleading "NO working sell / the autopilot should be exiting these" text on both bleeder
  alerts now states the market-order-exit model and points at the loop-health check. **Deliberately
  NOT changed:** the drawdown threshold (still `WD_ALERT_PCT`=5). A higher live "deep-drawdown"
  threshold (e.g. -8%, giving the ~5% synthetic stop + gap room) would cut normal-drawdown noise but
  is an **operator policy call** — decide before changing when real-money paging happens.
- **MEDIUM — protection is only checked once a position is already ≥5% down** (C/E). A cancelled/
  never-placed stop on a flat/-3% position is invisible until the loss materializes — the exact
  slide the watchdog was built to prevent. **Done when:** a coverage check raises on any uncovered
  *managed* position at a tighter warn threshold, independent of current P/L.
- **MEDIUM — no halt-state / live-opt-in check.** `TRADING_HALT=true` and the live double-opt-in
  silently disable protective selling; nothing reads them. **Done when:** the watchdog raises if
  halt is active (or live opt-in is off) during RTH while the live book holds positions.
- **MEDIUM — no account-level check** (cash/margin/concentration/position-count): a sizing bug that
  over-buys into margin or over-concentrates reads all-clear. **Done when:** an account check alerts
  on negative buying power, position count above a ceiling, or single-name weight beyond a max.
- **MEDIUM — suppression key churns on set-membership changes.** Keys are the sorted symbol SET, so
  when one symbol in a multi-symbol bleed recovers the remaining ones form a new (unsuppressed) key
  and re-alert; and the stable-key case can silence a *worsening* position for a full hour. **Done
  when:** suppression is per-symbol with recovery hysteresis and a shorter live-bleed window.
- **MEDIUM — docker-CLI/container-name drift silently blinds B–F** while port-based check A still
  passes; empty `docker exec` output parses to `$null` with no throw → zero alerts. **Done when:**
  empty/whitespace exec output is treated as a distinct "check-infra" failure.
- **LOW — pre-market gap (F) can fire on one thin IEX odd-lot print** (no volume/recency bound);
  **LOW — live working-status whitelist is a hardcoded case-sensitive copy of `IN_FLIGHT_STATUSES`**
  (a future/upper-case status is missed); **LOW — `WD_ALERT_PCT` is culture-interpolated** (a
  comma-decimal locale would NaN the threshold — latent, US-locale host so not biting).

Not bugs (audited + dismissed): the ET gate's `'Eastern Standard Time'` id carries DST on Windows so
July resolves to EDT correctly; the PSSA null-compare, regex escaping, and Out-String/Substring caps
are safe as written.

**Verified 2026-07-19:** PARTIAL — the halt-during-RTH check shipped (trading-watchdog.ps1:133, closing that MEDIUM). Still open: coverage at a tighter threshold, account-level checks, per-symbol suppression hysteresis, and the empty-exec→check-infra failure.

---
