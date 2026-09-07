# Strategy Studio conversational parity — live proof run

**Run date:** 2026-09-06 (20:02–20:06 CT; timestamps below are UTC, 2026-09-07T01:02Z–01:05Z)
**Box:** the local stack at `http://127.0.0.1:35457` — api image revision `f221b54c`, core checkout
at `1c44f3c4`, store package `intelligent-trades` **1.9.2** installed at
`/app/workspace-shared/deployed-apps/trading/` (the deployed `routes/trading-strategy-lab-routes.js`
hashes identically, CR-stripped, to the store checkout at `d10557c` (an ancestor of `origin/main`; the route file is byte-identical at both):
`3e67511a…1126`).
**Book:** PAPER only (`?book=paper`, ref `paper`, kind `paper`). The live books were read as a
witness and never written.
**Status:** complete — **every step passed.** No source was changed; this document is the deliverable.

The BACKLOG done-when this run proves: *two refinements update one strategy row through a live LLM
session and the applied strategy reverts cleanly.*

---

## 1. What was run

A stdlib-Python driver (kept in the session scratchpad, not in the repo) issued the HTTP calls below
against the box. Auth was a personal access token minted through the operator bootstrap path and
revoked at the end; the service secret and the token plaintext were read from `.env` / the mint
response and are not reproduced anywhere in this document or in the driver's log.

| # | Step | Request | Result |
|---|---|---|---|
| 0 | Mint PAT (operator bootstrap, time-boxed) | `POST /api/cli-tokens` with `x-service-secret` + `x-oshal-user-sub` | 201, id `d2ff0ec0-…`, `expiresAt` 2026-10-07 |
| 0 | Identity check | `GET /api/cli-tokens/whoami` (Bearer) | 200, `operator: true` |
| 1 | Book roster | `GET /api/trading/accounts` | 200 — 4 books; `paper` is kind `paper` |
| 2 | Baseline | `GET /api/trading/lab/strategies`, `GET /api/trading/lab/apply?book=paper`, `…?book=live` | 84 rows; paper `active: null`; live `active: null` |
| 3 | **Design turn** | `POST /api/trading/lab/studio?book=paper` `{message}` | 200 after one retry (see §3), `refined:false`, new id `ae154336-…` |
| 3b | Row count | `GET /api/trading/lab/strategies` | 85; the only new id is `ae154336-…` |
| 4 | **Refine 1** | `POST …/studio?book=paper` `{message, strategyId}` | 200, `refined:true`, same id, `topN 8→5`, `cadenceDays 21→10` |
| 4b | Row count | `GET …/strategies` | 85 (unchanged) |
| 5 | **Refine 2** | `POST …/studio?book=paper` `{message, strategyId}` | 200, `refined:true`, same id, `corePct 20→30`, `takeProfitPct null→8`; refine-1 knobs kept |
| 5b | Row count | `GET …/strategies` | 85 (unchanged); only new id is still `ae154336-…` |
| 5c | Stored row | `GET …/strategies/ae154336-…` | config = refine-2 knobs; 3 backtest runs on the one row |
| 6a | Apply gate | `POST …/strategies/ae154336-…/apply?book=paper` without `confirm` | 400 `confirm_required` |
| 6b | **Apply to paper** | same with `confirm:true, applyPct:100` | 201, override `337b137a-…`, `bookRef: paper` |
| 6c | Apply truth | `GET …/apply?book=paper` | `active.strategyId = ae154336-…` |
| 6d | Library truth | `GET …/strategies` | `appliedOn: ["paper"]` |
| 7a | **Revert paper** | `POST /api/trading/lab/apply/revert` `{book:"paper"}` | 200, `reverted:true`, `was.strategyId = ae154336-…`, `was.active:false` |
| 7b | Revert truth | `GET …/apply?book=paper` | `active: null` — identical to the step-2 baseline |
| 8 | Restore prior state | n/a | paper had no override before the run, so env defaults **is** the prior state |
| 9 | Live witness | `GET …/apply?book=live` | `active: null` — identical to step 2 |
| 10 | Delete test row | `DELETE /api/trading/lab/strategies/ae154336-…` | 200 `deleted:true`; roster back to 84 rows, same id set as step 2 |
| 11 | Revoke PAT | `DELETE /api/cli-tokens/d2ff0ec0-…` then `GET /whoami` | `revoked:true`; whoami → 401 |

## 2. The three conversational turns (trimmed responses)

**Design brief (turn 1):** *"Design a momentum rotation: hold the top 8 names in the default universe
ranked by momentum, rebalance every 21 trading days, equal weight, a 20% SPY core, balanced posture,
no take-profit. Test it over about two years."*

```json
{ "strategyId": "ae154336-dfcf-4c91-b9e7-46658885fd13", "name": "XS Momentum Rotation with Core · gybl",
  "refined": false, "citations": ["xs-momentum"], "runStatus": "ok",
  "config": { "kind": "rotation", "posture": "balanced", "rank": "momentum", "universe": [], "corePct": 20,
    "coreSymbol": "SPY", "takeProfitPct": null, "cadenceDays": 21, "topN": 8, "weighting": "equal",
    "warmupDays": 80, "windowDays": 780, "earningsGateDays": 0 },
  "knobSummary": "rotation momentum/21d/top8/equal · posture balanced · core 20% SPY · tp posture-default · universe default (159, tracks expansions)",
  "metrics": { "bars": 455, "startCash": 96247, "totalReturnPct": 18.07, "cagrPct": 9.63, "sharpe": 0.97,
    "maxDrawdownPct": 14.08, "trades": 172, "spyReturnPct": 31.28, "alphaVsSpyPct": -13.21 } }
```

`startCash: 96247` — the Studio sized the backtest to the paper book's equity, as the route does.

**Refine 1 (turn 2):** *"Change topN to 5 and the rebalance cadence to 10 trading days. Keep everything
else exactly as it is."* — sent with `strategyId: ae154336-…`.

```json
{ "strategyId": "ae154336-dfcf-4c91-b9e7-46658885fd13", "refined": true,
  "config": { "…": "unchanged", "cadenceDays": 10, "topN": 5, "corePct": 20, "takeProfitPct": null },
  "knobSummary": "rotation momentum/10d/top5/equal · posture balanced · core 20% SPY · tp posture-default · universe default (159, tracks expansions)",
  "metrics": { "totalReturnPct": 15.39, "cagrPct": 8.25, "sharpe": 0.87, "maxDrawdownPct": 9.85, "trades": 203 } }
```

**Refine 2 (turn 3):** *"Raise the SPY core to 30% and set a take-profit of 8%. Keep everything else
exactly as it is."* — sent with the same `strategyId`.

```json
{ "strategyId": "ae154336-dfcf-4c91-b9e7-46658885fd13", "refined": true,
  "config": { "…": "unchanged", "cadenceDays": 10, "topN": 5, "corePct": 30, "takeProfitPct": 8 },
  "knobSummary": "rotation momentum/10d/top5/equal · posture balanced · core 30% SPY · tp 8% · universe default (159, tracks expansions)",
  "metrics": { "totalReturnPct": 17.05, "cagrPct": 9.11, "sharpe": 1.04, "maxDrawdownPct": 9.69, "trades": 218 } }
```

Both refinements changed exactly the knobs asked for and carried the earlier ones forward — the
"change only what was asked" contract held across two live turns, and the stored row read back
(step 5c) matches the turn-3 config with `createdAt 01:05:22Z` / `updatedAt 01:05:43Z` and three
`backtest ok` runs attached to the single id.

**Apply (step 6b) effective knobs, from the response:**

```json
{ "override": { "id": "337b137a-b625-46a7-a667-134285fdeaab", "strategyId": "ae154336-…", "applyPct": 100, "active": true },
  "effective": { "posture": "balanced", "takeProfitPct": 8, "corePct": 30,
    "rotation": { "enabled": true, "everyDays": 10, "topN": 5, "rank": "momentum", "weighting": "equal", "extHours": false },
    "universeCount": 159 } }
```

api log at the same instant: `"strategy APPLIED to book" … "bookRef":"paper"`.

**Revert (step 7a) response:**

```json
{ "reverted": true,
  "was": { "id": "337b137a-…", "strategyId": "ae154336-…", "applyPct": 100, "active": false },
  "envDefaults": { "posture": "active", "takeProfitPct": 8,
    "rotation": { "enabled": true, "everyDays": 1, "topN": 0, "rank": "gravity", "weighting": "conviction" },
    "core": { "targetPct": 0 }, "universeCount": 159 } }
```

## 3. The model rail, and the one failure

Each studio turn dispatched the trading analyst (`a0000000-…-0046`) to the dedicated trading bot node
(`http://trading-bot:5000/api/swarm-execute`); the bot node executed on the caller's **BYO LLM
connection — `gemini-2.5-flash` via the OpenAI-compatible endpoint at
`generativelanguage.googleapis.com`** (`[TaskController] BYO-LLM provider active: gemini-2.5-flash`
on every attempt). Cost events were recorded per turn against the accountable bot (`cost: 0`,
per-call tokens 4501 / 9018 / 13578 for the three successful turns, read from the bot's `OpenAI-compatible call` lines; the three `Cost event recorded` lines carry the cumulative totals 4501 / 13519 / 27097).

**Design attempt 1 failed.** The upstream endpoint answered `503 status code (no body)` after
158 s (bot log 01:05:07Z, `OpenAIProvider` → `APIError.generate`); the route surfaced it as
`502 { error: "lab_error", message: "Bot node execution failed: 503 status code (no body)" }`. **No
strategy row was created by the failed attempt** — the row count stayed at 84 until the retry, and
the "only new id" check in step 3b passed. The driver's backoff (5 s) then retried the same brief and
attempt 2 succeeded in 8.5 s; refines 1 and 2 succeeded first time (8.1 s and 5.7 s model time).
There was no 429 during the run.

Note for the reader of the api log: the api-side `bot-node-client` completion line labels the
attempt with the agent row's *configured* provider (`openai-codex` / `gpt-5.5`), while the bot
node's own log names the rail that actually answered (`byo-llm` / `gemini-2.5-flash`). The bot log
is the truth for which model ran.

## 4. Cleanliness

- Paper book: `active: null` before → applied → `active: null` after. Same operative state as it started.
- Audit residue, by design: the override row `337b137a-…` persists deactivated (`deactivated_at` set, its `strategy_id` nulled by the cascade delete) and strategy-journal rows 78 (`applyOverride`) and 79 (`revertOverride`) remain. The operative state matches the baseline; the audit history does not, and must not.
- Live books: `GET /api/trading/lab/apply?book=live` read `active: null` before and after; the
  Schwab-bound books (`b-6690e236`, `b-77146871`) were only listed by the roster call and never
  addressed. No order path was reached — the lab routes write `trading_config_overrides` only.
- Strategy library: 84 rows before, 85 during, 84 after `DELETE` (a delete route exists; the
  test row and its three runs cascaded). The final id set equals the baseline id set.
- The PAT was revoked by id and confirmed dead (`whoami` → 401).

## 5. Reproduction

Prerequisites: the stack up and healthy (`bash scripts/oshal-up.sh`), a caller whose sub is in
`OSHAL_OPERATOR_SUBS`, and a BYO LLM connection (or a hosted rail) resolvable for that caller.

1. Mint a PAT: `POST /api/cli-tokens` with headers `x-service-secret` (the box's
   `SWARM_SERVICE_SECRET`) and `x-oshal-user-sub` (the operator sub); use `Authorization: Bearer …`
   for everything below.
2. `GET /api/trading/lab/strategies` and `GET /api/trading/lab/apply?book=paper` — record the count
   and the active override (restore it at the end if non-null by re-applying that strategy id with
   its `applyPct`).
3. `POST /api/trading/lab/studio?book=paper {"message": <brief>}` → keep `strategyId`.
4. Twice: `POST /api/trading/lab/studio?book=paper {"message": <change>, "strategyId": <id>}`;
   assert `refined:true`, the same id, and an unchanged row count.
5. `POST /api/trading/lab/strategies/<id>/apply?book=paper {"confirm": true, "applyPct": 100}`;
   `GET /api/trading/lab/apply?book=paper` shows it active.
6. `POST /api/trading/lab/apply/revert {"book": "paper"}`; `GET …/apply?book=paper` → `active: null`.
7. `DELETE /api/trading/lab/strategies/<id>`; `DELETE /api/cli-tokens/<token id>`.

On a 429 or a 5xx from the studio turn, retry with backoff (this run used 5 s / 15 s / 45 s, three
retries max) and record what happened.

## 6. Provenance of the evidence

- The driver's trimmed JSON log (every request, status, latency, and the fields above) and its
  step-by-step stdout were captured in the session scratchpad at run time.
- api container log (`docker logs oshal-local-api`): `Dispatching work to bot node` ×4,
  `lab route failed` ×1 (the 503), `studio strategy designed + backtested` ×3 (`refined:false`,
  `true`, `true`, all `cites:["xs-momentum"]`), `lab backtest persisted` ×3 (`feed: sip`,
  455 bars), `strategy APPLIED to book … bookRef: paper` ×1.
- bot container log (`docker logs oshal-local-trading-bot`): `BYO-LLM provider active:
  gemini-2.5-flash` ×4, one `503 status code (no body)` at 01:05:07Z, three `OpenAI-compatible call
  (gemini-2.5-flash @ generativelanguage.googleapis.com)` completions, three `Cost event recorded`.
- One environmental note that is not part of the proof: the first launch of the driver at
  01:01:29Z failed at step 0 with `500` because Postgres was in crash recovery
  (`the database system is in recovery mode`, recovered 01:01:38Z) while the api container was
  being recreated by another session. The run above started after the api reported healthy.
