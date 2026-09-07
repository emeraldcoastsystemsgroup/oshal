# Futures extension layer (ADR-116) — the remaining work, phased, with a stop-line

**Status:** planning document, as-verified 2026-09-06. Nothing in this document enables a live
futures order. No phase below builds a live futures rail, and the document's honest end state
includes *never building one*.

This is the phase plan the BACKLOG "Futures extension layer" entry points at. It exists because
that entry had become a single sentence listing eleven unrelated things ("sweep ensemble exits …
fail-closed live adapter … cockpit coverage") with one compound done-when. The work is split here
into five independently shippable phases, each with scope, files, size, prerequisites, done-when,
and a regression guard that crosses the boundary it claims to protect (CLAUDE.md
"integration-boundary corollary"). Phase 1 is the evidence phase; everything that could cost money
is gated on what Phase 1–2 find.

Read [ADR-116](../../adr/116-futures-extension-layer.md) for the decision and
[futures-backtester.md](./futures-backtester.md) for the machinery and the numbers so far.

## 1. What exists today (verified on disk, 2026-09-06)

Every path below was checked with `ls`, `grep`, or `wc` on this box on the date above; the
commands are in the right-hand column so the check can be re-run instead of trusted.

### 1.1 Code in core (`c:/Projects/oshal`)

| Piece | File | Posture | Verified by |
|---|---|---|---|
| F1 instrument model | `src/features/trading/services/futures-contract.ts` | shipped — roots, month codes, expiry/roll, `contractsForRange`, `activeContractAt(root, asOf)`, `expectedBarCount` | `grep -n "export function"` |
| F2 data sources | `src/features/trading/services/futures-data-source.ts` | shipped — `MockFuturesDataSource`; `KibotFileDataSource` (bulk files, front-month clamp on by default, `configured()` only checks the directory exists); Kibot **HTTP** client is credential-gated on `KIBOT_USER`/`KIBOT_PASSWORD`/`KIBOT_API_BASE`/`KIBOT_FETCH_TIMEOUT_MS` and its own header says the endpoint spelling is unconfirmed | header lines 18–20; `grep -o "KIBOT_[A-Z_]*"` |
| F2 bar store | `src/app/trading-bar-store.ts`, `scripts/migrations/096-market-bars.sql` | shipped — `market_bars(symbol,timeframe,bar_ts,…)`, PK `(symbol,timeframe,bar_ts)`, no `user_sub`, RLS enabled with an open `market_bars_public USING (true)` policy | `ensureBarSchema` (l.47–69) |
| F3 completeness + session calendar | `futures-completeness.ts`, `futures-session-calendar.ts`, `src/app/trading-futures-ingest.ts` | shipped | present |
| Continuous series | `futures-continuous.ts` | shipped — panama back-adjustment, overlap-median seams, `gap` seams never adjusted | present |
| Strategy port | `futures-indicators.ts`, `futures-trail-stops.ts`, `futures-stop-engine.ts` (incl. `stopBufferMode: 'ticks' \| 'atr-percent'`), `futures-entry-indicators.ts`, `futures-wave-tracking.ts`, `futures-entry-evaluator.ts` (`generation: 'dynstops' \| … \| 'ensemble'`, `ensembleEntryThresholdPct`), `futures-entry-ensemble.ts` (`retentionPct`, `drawdownPct`) | shipped | `grep -n ensembleEntryThresholdPct` → evaluator l.214/328/440 |
| Backtester + objectives | `futures-backtester.ts` (573 code lines), `futures-fitness.ts` | shipped — NT8 fill semantics, stage-1 timed harness, overlay; the nine fitness ports. Since PR #114 (`eb8caae3`, 2026-08-02 — SEQ 2 in the backtester header): **margin** (modelled only from a cited `FuturesMarginSpec`, otherwise `marginModeled:false`), **Target-1** partial (`futures-targets.ts`), **daily-ADX regime gate** (`futures-regime-gate.ts`, fail-closed when enabled without a `dailyBars` argument) | header SEQ 2; `futures-margin.ts`, `futures-targets.ts`, `futures-regime-gate.ts` present |
| F4 paper broker | `paper-futures-broker-adapter.ts` (129 code lines) | shipped **in-memory**: market/limit fills, shorting, multiplier P&L; `stop`/`stop_limit`/`trailing_stop` are accepted-working and **never trigger**; state resets on restart | header lines 13–15; l.99 |
| Broker types | `broker-adapter.ts` | `BrokerProviderType` includes `'paper'` and `'tradovate'`; the comment on `'tradovate'` reads "not-yet-wired" and nothing imports a Tradovate client | l.37–38 |
| Backtest runner | `scripts/oshal-futures-backtest.ts` (189 code lines) | shipped — `--source mock\|kibot\|kibot-file`, `--data-dir` (default `process.env.KIBOT_DATA_DIR ?? 'C:\MarketData\kibot'`), `--start/--end`, `--adjust`, `--stage1`, costs. **Limits:** `entry.generation` is hardcoded `'dynstops'` (l.224); `runFuturesBacktest` is called with three arguments so the regime gate's `dailyBars` is never passed; no config-file input; no machine-readable output | l.95, l.222–229 |
| Ingest runner | `scripts/oshal-futures-ingest.ts` | shipped — **mock source only** (`new MockFuturesDataSource` l.100), `--store` writes to `market_bars` when `DATABASE_URL` is set | l.26, l.100–107 |
| Specs | `tests/unit/futures-*.spec.ts` + `paper-futures-broker.spec.ts` | 18 files, 373 `it()` blocks | `grep -c "^\s*it(" tests/unit/futures-*.spec.ts tests/unit/paper-futures-broker.spec.ts` (run 2026-09-06) |

Not present anywhere in `src/` (each grep returned nothing): a Schwab futures data source
(`grep -i futures src/features/trading/services/market-data-source.ts`; `grep -i schwab
src/features/trading/services/futures-data-source.ts`), a Tradovate or any FCM client, a
`futures_backtest` tool on any persona (`grep -rn futures_backtest ai-lab swarm-apps src`), and any
`TRADING_FUTURES_*` env var (`grep TRADING_FUTURES .env.example docker-compose.oshal-local.yml`).
`KIBOT_*` appears in **no** documented env reference — not `.env.example`, not the README table, not
compose — only as `process.env` reads in code.

### 1.2 Data on disk (`C:\MarketData\kibot`)

The bulk Kibot download the source trader supplied in June, extracted 2026-07-27:

| Directory | Contents | Verified by |
|---|---|---|
| `minute/` | **ES** 62 files, contracts `ESH10`…`ESZ25` (`MM/DD/YYYY,HH:MM` rows): earliest row `01/20/2009` (`ESH10`), latest row `12/19/2025,09:29` (`ESZ25`), no 2026 rows in any file. **CL** 242 files, contracts `CLX09`…`CLG36` (`YYYYMMDD HHMMSS;…` rows): earliest row `20070516` (`CLZ09`); the front month `CLZ25` ends at its expiry `20251120 142900`; **14 back-month files** (`CLF27`, `CLG26`, `CLH26`, `CLJ26`, `CLK26`, `CLM26`, `CLM27`, `CLN26`, `CLQ26`, `CLU26`, `CLX26`, `CLZ26`, `CLZ27`, `CLZ28`) carry a handful of `20260101` holiday-session rows as their last bars, six more end `20251231`. **No other root has minute bars.** | `ls minute \| grep -c '^ES'` = 62, `'^CL'` = 242, anything else = 0; bounds from a loop over **every** file — `for f in minute/CL*.txt; do head -1 "$f"; done \| sort \| head -1` and the `tail -1 … \| sort \| tail -1` twin (ES needs the `MM/DD/YYYY` fields re-ordered before sorting); `for f in minute/CL*.txt; do tail -1 "$f" \| awk '{print $1}'; done \| grep -c '^2026'` = 14 |
| `daily/` | **ES** 70 files, contracts `ESZ09`…`ESH27`: earliest row `20080903` (`ESZ09`), latest row `20251231` (five back-month files — `ESU26`, `ESZ26`, `ESH27`, …); the front month `ESZ25` ends `20251219`. **CL** 244 files, contracts `CLX09`…`CLZ36`: earliest row `20030306` (`CLZ09`), latest row `20251231` (47 back-month files); `CLZ25` ends `20251120`. No 2026 daily rows for either root. No other root. | same loop over `daily/ES*.txt` / `daily/CL*.txt`; `… \| grep -c '^20251231'` = 5 (ES) / 47 (CL); `grep -c '^2026'` = 0 for both |
| `raw/` | 8 archives: `CL-DAILY.zip` (3.0 MB), `CL-MINUTE.zip` (184 MB), `ES-DAILY.zip`, `ESMinute.zip` (63 MB), `ESTick.zip` (60 MB), `KibotFuturesLists.zip`, and two ES **tick** archives `ES-20260619T033343Z-3-001.zip` (2.01 GB) / `-002.zip` (1.16 GB) — the tick archives are **unextracted** | `ls -la raw` |
| `lists/` | 84 Kibot symbol **lists** (`ls lists \| wc -l`) (`NQ.txt`, `GC.txt`, `YM.txt`, `MES.txt`, `MNQ.txt`, `RTY.txt`, `C.txt` …). These are contract *rosters*, not bars — `C.txt` is the corn symbol list, not corn data. | `ls lists` |

Consequences that every phase inherits:

- **Two markets have bars: ES and CL.** Any "three-market overlay" needs a third archive (a Kibot
  purchase or another source). Until then the honest phrase is *every market with bars on disk*.
- **No tradable 2026 history exists.** The front months end at their expiries — `ESZ25` on
  2025-12-19 (minute and daily), `CLZ25` on 2025-11-20 — and the archive as a whole runs to
  2025-12-31 (last daily bar for both roots; the only rows dated later are a few `20260101`
  holiday-session minute bars on 14 CL back-month contracts). The most recent measurable full year
  is 2025. Anything that marks a paper position "today" from this data is marking against a 2025
  close and must say so on screen.
- **`market_bars` is empty.** `select count(*) from market_bars` on the live Postgres
  (`127.0.0.1:55433`) returned **0** on 2026-09-06. Every real-bar result so far was produced from
  the files directly, never from the store.

### 1.3 Private material (`c:/Projects/oshal-app-private`, reference only)

The source trader's NT8 source archive, the 2026-07-27 digest and entry-extraction notes, the
port-status note, and the packet sent to him on 2026-07-28 (backtest report, strategy
recommendations, follow-up note, cover email) all live in the private repo. These hold the
trader's constants and our questions to him; nothing in them is a public-repo input, and no phase
below depends on his reply arriving. The private repo is the only place they are named.

### 1.4 Evidence so far — and why it gates everything

All numbers in [futures-backtester.md](./futures-backtester.md#current-honest-numbers-2026-07-27-second-pass)
are **in-sample, un-optimized, paper, no walk-forward**, on panama-adjusted hourly ES and CL
2021→2025 with 1 tick slippage/side and $2.50/contract/side. The reading recorded there: at default
parameters the entries carry no fixed-horizon edge (stage-1 AvgMFE/AvgMAE ≈ 1.0 on both markets);
the stop stack adds value over a raw hold (ES −$36K → +$42K, CL −$93K → −$31K) but CL stays
negative and none of it has been tested out-of-sample. That is the honest starting point: **a
system with no demonstrated edge at defaults, whose author says his optimized per-market constants
are the system, and whose constants we do not have.**

So the order of the phases is not a preference. Evidence first; paper machinery second; a live rail
only if the evidence earns it, and *not building it* is a legitimate finish.

## 2. The phases

Each phase lands as its own branch → PR → merge (Rule 0). Size estimates are code lines (comments
and blanks excluded). "Guard" names the spec and the real boundary it crosses; a pure spec is
allowed only where the claim is branch logic.

### Phase 1 — Evidence rail: reproducible real-bar in-sample / out-of-sample (core, scripts + one pure module, ~450 lines)

**Goal.** Turn "we ran it once and wrote the numbers down" into a re-runnable, machine-readable
IS/OOS report at frozen constants, plus the two parameter sweeps the old BACKLOG line asked for.
This phase produces the first out-of-sample number the project has ever had.

**Scope.**
1. `scripts/oshal-futures-backtest.ts`: `--config <json>` (a partial `BacktestConfig` deep-merged
   over the current literal; explicit `undefined` keys dropped the way `futures-targets.ts` strips
   them, so a missing key can never become `NaN`) and `--out <json>` (per-market
   `{trades, netProfit, maxDrawdown, marginModeled, leverage, regimeBlockedSignals, exits}` so no
   downstream tool re-parses stdout). Pass `ltf.bars` as the fourth `dailyBars` argument to
   `runFuturesBacktest` whenever `args.ltfTf === '1Day'` (the runner's LTF default already is
   `1Day`, so this is a wiring fix, not a third series build — building a separate daily series per
   root would double the ~10 s/series cost ADR-121 measured). The regime gate today silently
   blocks every bar if enabled, because `dailyBars` is never passed.
2. New `src/features/trading/services/futures-walk-forward.ts` (pure): `walkForwardWindows(bars,
   {inSampleMonths, oosMonths, stepMonths})` returning non-overlapping windows with `oosStart ===
   isEnd` strictly, and `walkForward(series, dailyBars, config, runner)` that runs a **frozen**
   config over every window and reports `{windows, isNet, oosNet, oosMaxDD, oosTrades, degradation
   = oosFitness/isFitness}`. No optimizer in this phase — frozen constants only, so the OOS number
   measures the *strategy*, not the search.
3. New `scripts/oshal-futures-sweep.ts`: `--grid <json>` expanded as a cartesian product over
   dotted config keys, scored with a named `FITNESS_FUNCTIONS` entry (unknown name → exit 2, never a
   silent default), series built once per root, `--out <csv>`. The two grids the BACKLOG owed, with
   the **real** key names: `entry.generation: ['ensemble']` (required — the ensemble knobs are
   "ignored by the other generations", evaluator l.206–214) × `entry.ensembleEntryThresholdPct:
   [62,66,70,74,78]` × `entry.ensembleConfirmation.retentionPct: [85,90,95]` ×
   `entry.ensembleConfirmation.drawdownPct: [90,93,96]`; and `stops.stopBufferMode:
   ['ticks','atr-percent']` × `stops.strangleBufferAtrPercent: [5,7,10]`.
4. Documentation of the env vars this rail already reads and nobody wrote down: `KIBOT_DATA_DIR`,
   `KIBOT_USER`, `KIBOT_PASSWORD`, `KIBOT_API_BASE`, `KIBOT_FETCH_TIMEOUT_MS` — added to
   `.env.example` (trading block) and the README env table, not only mentioned in a script.
5. Results tables appended to `futures-backtester.md` under "Sweeps (in-sample, un-optimized)" and
   "Walk-forward at frozen defaults (OOS)", every row labelled in-sample or OOS, paper, with the
   exact command line that produced it (docs anti-drift rule 5).

**Files.** `scripts/oshal-futures-backtest.ts`, new `scripts/oshal-futures-sweep.ts`, new
`src/features/trading/services/futures-walk-forward.ts`, `src/features/trading/index.ts` (barrel
export, next SEQ), `.env.example`, `README.md` (env table), `docs/apps/trading/futures-backtester.md`,
`docs/apps/trading/README.md` (bullets for the two scripts).

**Prerequisites.** `C:\MarketData\kibot` present (it is). Nothing else — no credentials, no DB, no
container deploy; the scripts run on the operator box with `npx tsx`.

**Done when.** `npx tsx scripts/oshal-futures-backtest.ts --roots ES,CL --source kibot-file --start
2021-01-01 --end 2025-12-15 --config <file> --out <json>` reproduces the canonical row-A numbers in
futures-backtester.md bit-for-bit (the harness self-check); the walk-forward report (24-month IS /
6-month OOS / 6-month step, or whatever the doc records) exists for ES and CL at frozen defaults
with IS and OOS labelled; both sweep tables are in the doc with commands; `KIBOT_*` is documented.

**Guard.** `tests/unit/futures-walk-forward.spec.ts` — windows never overlap and every OOS bar
timestamp is strictly after the IS window end (mutation: swapping IS/OOS goes red); config merge
keeps unspecified defaults and never turns an explicit `undefined` into `NaN`; grid cardinality
equals the product of axis lengths; unknown fitness name throws. Plus **one real-bar smoke row**:
`walkForwardWindows` over the ES daily files from `KIBOT_DATA_DIR`, failing loud (not skipping
silently) when the directory is absent, following the `mkdtemp` pattern of
`futures-kibot-file-source.spec.ts`. Boundary crossed: look-ahead in the splitter, on real bars.

**Live risk.** None. Scripts read files and print.

### Phase 2 — Staged optimizer inside the walk-forward (core, ~600 lines) → **the evidence gate**

**Goal.** Run the trader's six-stage locked-winner protocol (Entry → StopLoss → Trail → Targets →
EmergencyExit → Sizing, each stage scored by its own fitness from `futures-fitness.ts`) *inside*
the Phase 1 walk-forward, so the winner of each IS window is judged only on the OOS window that
follows it. This is where "no edge at defaults" either becomes per-market constants worth quoting
or is confirmed.

**Scope.** New `src/features/trading/services/futures-optimizer.ts` (pure, injected runner):
`OptimizerStage`, `STAGE_FITNESS` (stage-1 = `maxAvgMfeMinAvgMae` with `timedBarsToExit > 0`
forced), `runStage`, `lockWinner` (prior stages never re-opened), `MIN_TRADES_GATE_SENTINEL` for
under-count candidates. New `scripts/oshal-futures-optimize.ts` with `--grids <json>` (a stage
absent from the file is skipped with defaults locked), `--is-months`, `--oos-months`,
`--min-trades` (default = the `maxNetProfitMinTrades` default), per-stage `--out` checkpoints, and
the multi-market overlay over the OOS curves of **every root with bars on disk** (two today).

**Prerequisites.** Phase 1 merged (the walk-forward and `--config`/`--out` are its inputs).
Runtime budget: ADR-121 measured roughly 10 s per five-year ES minute series in TypeScript, so a
200-combination stage is ~35 min per market per stage; six stages × two markets × several windows
runs for hours. Coarse grids, series built once, checkpoints. The ADR-121 WASM kernel is an
optional accelerator and is **not** in scope.

**Done when.** `futures-backtester.md` has an "Optimizer + walk-forward (OOS)" section with the
IS-vs-OOS table per market, per-stage winners, degradation ratio, trade counts, and command lines;
and ADR-116 carries an amendment stating the **evidence gate** (§3 below) and which way it fell.

**Guard.** `tests/unit/futures-optimizer.spec.ts` — stage N+1's base equals stage N's locked
winner; under-min-trades windows return the sentinel, never a number; degradation arithmetic;
reuses the Phase 1 real-bar smoke row so the optimizer's windows are proven non-overlapping on
real ES daily bars, not only on the injected runner. Boundary: the locked-winner contract and the
splitter.

**Live risk.** None.

### Phase 3 — Real archives → `market_bars` (core, ~180 lines)

**Goal.** Get the on-disk ES/CL bars into Postgres so later phases (paper marks, coverage cards)
read from the store and not from a laptop path. Independent of Phases 1–2; a prerequisite for 4–5.

**Scope.** `scripts/oshal-futures-ingest.ts` gains `--source mock|kibot-file` and `--data-dir`
(default `process.env.KIBOT_DATA_DIR ?? 'C:\MarketData\kibot'`), `--start/--end`; `sourceFor()`
returns `MockFuturesDataSource` or `new KibotFileDataSource({ dir: join(dataDir, tf === '1Day' ?
'daily' : 'minute') })`; the paper demo stays mock-only (skipped for `kibot-file` — its price box is
a mock convenience). The existing `ingestFutures({pool})` then writes real bars with
`source='kibot-file'`. **State plainly in the runner and the doc:** `KibotFileDataSource`'s
front-month clamp is on, so stored bars per contract are the *front-month window*, and
`barCoverage(symbol)` reports that window — a coverage card that compares it against a contract's
whole listed life will misread a healthy contract as mostly missing.

**Prerequisites.** `DATABASE_URL` to the live Postgres; the files. Run for ES and CL at `1Hour`
and `1Day`. No container change — the store schema already self-heals via `ensureBarSchema`.

**Done when.** `select symbol, timeframe, count(*) from market_bars group by 1,2` shows ES and CL
at both timeframes; `barCoverage` for `ESZ25`/`1Hour` matches the file's front-month window; a
second run changes no counts.

**Guard.** `tests/unit/futures-bar-store-ingest.spec.ts` against the REAL Postgres at
`127.0.0.1:55433`, `--no-file-parallelism`, fail-loud when the stack is down: write a
Kibot-shaped temp file → `ingestFutures({pool})` → `readBars`/`barCoverage`/`latestClose` return the
same bars; second run idempotent. **Isolation is part of the guard** because `market_bars` is a
shared table with an open RLS policy and no `user_sub`: the spec uses a synthetic symbol and a
unique `source` tag, deletes its own rows in `afterAll`, and asserts the row count for real symbols
is unchanged before and after. Boundary: `market_bars` persistence. Add the row to
[the real-boundary audit](../../governance/real-boundary-regression-audit.md).

**Live risk.** None — the table is reference data; no order path reads it today.

### Phase 4 — Durable paper book with stop triggers and roll closure (core, ~550 lines) — **operator approval required before starting**

**Goal.** Make the paper futures simulator survive a restart and actually trigger the stop family,
so "paper stops survive restart" is a testable statement in the running system.

**Why the approval gate.** This is ~550 core lines, a new FORCE-RLS table pair, a new dispatch
hook on a hot leg, and a schedule-tick that touches the DB — squarely what CLAUDE.md Rule 0d calls
"the core is load-bearing … say so and get approval first". It is sequenced **after** the Phase 2
gate: if the evidence is negative, the operator may reasonably decide a durable simulator for a
system without an edge is not worth core churn, and this phase is skipped without loss.

**Scope.**
- New pure module `futures-paper-triggers.ts`: `stopTriggerFill(order, bar)` implementing the
  backtester's intrabar rule (long exit when `bar.l <= stop`, fill `min(stop, bar.o)`; mirrored for
  buy stops; `stop_limit` fills only if the limit is reachable within the bar);
  `ratchetTrailingStop(order, bar)` (high-water advances on the bar extreme; tighten-only).
- New `src/app/trading-futures-paper-store.ts`: `oshal_futures_paper_positions(user_sub, symbol,
  qty, avg_entry_price, realized_pnl, last_bar_ts, updated_at)` and
  `oshal_futures_paper_orders(user_sub, order_id, client_order_id, symbol, side, qty, type,
  limit_price, stop_price, trail_percent, trail_price, high_water, status, filled_qty,
  filled_avg_price, submitted_at, last_bar_ts, updated_at)` via the `runRuntimeSchemaBootstrap` +
  `buildOwnerRlsPolicyStatements(table,'user_sub')` pattern, mirrored in a numbered migration
  **`NNN = next free number at merge time`** (ADR-134 D1 wording; `125-trading-books-cutover.sql` is
  the latest committed and another in-flight item has already claimed 126 — check `ls
  scripts/migrations | tail -1` and COLLABORATE.md before minting).
- `paper-futures-broker-adapter.ts`: an optional `persistence: {load, save}` option, a static
  `create()` that hydrates, `save` after every mutation, `onBar(symbol, bar)` running the trigger
  module over working orders, and `closeAtRoll(symbol, mark)`.
- New `src/app/trading-futures-paper.ts`: `futuresPaperEnabled()` reads `TRADING_FUTURES_PAPER`
  (default `false`); `TRADING_FUTURES_PAPER_TF` (default `1Hour`); `TRADING_FUTURES_PAPER_START_CASH`
  (default `100000`); `tickFuturesPaper(ctx, sub)` wired as a fourth dynamic import in
  `dispatchTradingEventSchedule` (`src/app/trading-event-plans.ts`), same `.catch`/ERROR-log shape
  as the pinned-lots and dated-orders ticks. All four env vars go in `.env.example`, the README env
  table, and compose.

**Three hazards the design must carry, each pinned by the guard:**
1. **Replay cursor.** `market_bars` holds static 2021→2025 history while the wall clock is 2026.
   "Read bars since the last processed bar" with no cursor would replay every stored bar through a
   stop placed at a 2025-12 mark and fill it instantly. The cursor is the explicit `last_bar_ts`
   column above, initialised on order placement to the bar at or after `submitted_at`; only bars
   after the cursor may trigger.
2. **Roll clock.** `activeContractAt(root, asOf)` evaluated at `Date.now()` would declare every
   ESZ25/CLF26 paper position "past roll" on the first tick. Roll is evaluated against the **bar
   clock** — the latest `bar_ts` in `market_bars` for that symbol/timeframe — never wall-clock.
3. **The leg must exist.** The `trading-events:<sub>` schedule is not created by the kernel; the
   store routes create it (`ensureEventSchedule` in
   `oshal-applications/trading/src-routes/trading-manual-order-routes.ts`, and the event-plan arm
   route) when a dated order or plan is armed. A user who only ever placed a paper futures order
   would have no leg and `tickFuturesPaper` would never run. The Phase 5 order route must perform
   the same `createSchedule` upsert (`eventPlanTaskType(sub)`, `EVENT_PLANS_CRON`,
   `EVENT_PLANS_TIMEZONE`, queue `intelligent-trades`), and the Phase 4 spec asserts the schedule row
   exists after an order.

The paper futures book is **deliberately outside `oshal_trading_books`**: that table's `broker`
column is `CHECK (broker IN ('schwab','alpaca'))` (cite by content — the line moves), and the
futures simulator must not enter the equities money ledger, the ADR-134 HWM breaker, or the
`/summary` rollup. Record this in the ADR-116 amendment with a one-line ADR-134 cross-reference.

**Prerequisites.** Phase 3 (bars in the store); the Phase 2 report published; **explicit operator
approval**. Deploy via `bash scripts/oshal-deploy.sh` in a market-closed window; set
`TRADING_FUTURES_PAPER=true` only after the deploy is green; `TRADING_EVENT_PLANS=true` is also
required for the leg to fire.

**Done when.** A paper position and a resting stop placed before an api restart are present after
it; a bar through the stop fills at `min(stop, open)`; a trailing stop ratchets on a higher bar and
fills on the pullback; roll closure happens on the bar clock; flag off → no row touched.

**Guard.** `tests/unit/futures-paper-durable.spec.ts` against the REAL Postgres,
`--no-file-parallelism`: restart survival (new adapter from the same pool shows identical
positions/orders); intrabar stop fill price; trailing ratchet; re-hydrated book flat after the fill;
bars seeded before and after `submitted_at` prove only post-cursor bars trigger (mutation: remove the
cursor → red); roll evaluated with a stale wall-clock and a 2025 bar clock does **not** close
(mutation: swap to `Date.now()` → red); `TRADING_FUTURES_PAPER` unset → `tickFuturesPaper` writes no
row; RLS statements present on both tables; the schedule row exists after the order-route upsert.
Boundary: FORCE-RLS tables and the durable-state claim. Add the row to the real-boundary audit.

**Live risk.** None by construction — the adapter has no venue; `BrokerProviderType 'paper'` is the
simulator. The dispatch hook is one gated dynamic-import line; `trading-schedule-dispatch.ts` is not
touched.

### Phase 5 — Cockpit coverage (store package `trading`, ~630 lines)

**Goal.** Contracts, coverage/gaps, margin/leverage, and the paper book become visible in
`?app=intelligent-trades`.

**IA rule (ADR-136 D1).** Research is *market-wide, not account-scoped*; acting on a position is
account-scoped and lives in account detail. So this phase is **split**: the market-wide cards —
roots, contract roster with roll dates, bar coverage/gaps per contract (front-month-clamped, labelled
as such), margin/leverage from an operator-cited spec — go under a Research sub-tab; the per-user
paper positions, working orders, and the order form get an **account-scoped home**, a "Futures
paper (simulator)" entry in the Accounts view, and ADR-136 gets a short amendment recording the
paper-simulator carve. Either way ADR-136 is in this phase's docs list.

**Scope.** New `src-routes/trading-futures-routes.ts` exporting `registerTradingFuturesRoutes`
(registered after `registerTradingResearchRoutes` in `trading-routes.ts`). Every handler defines its
own `sub(req, res)` around `callerSub` from `@/app/routes/trading-routes-helpers` — the one in
`trading-research-routes.ts` is module-local, not an import. Routes: `GET /futures/roots`,
`GET /futures/contracts?root=&from=&to=`, `GET /futures/coverage?root=&tf=`,
`GET /futures/margin?root=&price=&qty=&equity=` (notional/leverage always; `affordableContracts`
only when `TRADING_FUTURES_MARGIN_SPECS` — a JSON array of `FuturesMarginSpec` with `asOf` +
`source` — contains the root, else `marginModeled:false`; the code refuses a built-in margin table
by design), `GET /futures/paper`, `POST /futures/paper/orders`. The order route **calls
`resolveBook(ctx.pool, sub, (req.query.book) ?? body.book ?? (req.query.mode) ?? body.mode)`
first** — the real signature is `resolveBook(pool, sub, raw)` (`src/app/routes/trading-routes-helpers.ts`
l.65) and this is the query-first call shape every store route already uses
(`trading-manual-order-routes.ts` l.291, `trading-event-plan-routes.ts` l.90) — and refuses
unless the resolved book kind is `paper` — `403 futures_live_not_wired` — before touching the
futures paper store; then performs the schedule upsert from Phase 4 hazard 3. Quantity is capped by
`guardrails().maxQty`; **`TRADING_MAX_NOTIONAL_USD` is not applied** — its default is $1,000 and one
ES contract is several hundred thousand dollars of notional, so applying it would refuse every
order; the route reports `notionalValue` instead and the doc says so. New `tools/ui/view-futures.js`
(classic script, `jbody(method,obj)` convention) plus the sub-tab entry and `<script>` tag; the
Accounts-view entry for the paper book. Bump `oshal-app.yaml`.

**Prerequisites.** Phase 4 **deployed** first — the routes import the new kernel modules and a
package importing a kernel module that is not on the box 404s at boot (store-package deploy
mechanics). Then `oshal-app.js build` + `docker cp` + api restart.

**Done when.** A human at `localhost` can open the futures Research sub-tab, see ES/CL contracts
with roll dates and per-contract coverage from `market_bars` with the bar as-of time shown (not
implied live), see margin either modelled-from-cited-spec or "not modeled — supply
`TRADING_FUTURES_MARGIN_SPECS`", and from the Accounts view place a paper futures order that lands
in the durable book; a request that resolves to a live book gets 403.

**Guard.** `tests/trading-futures-surface.spec.ts` (source pins, acceptable for a UI/route contract
per the governance note): every handler 401-gates via `callerSub`; the file carries
`futures_live_not_wired`; it never imports `getBrokerAdapter`, `placeDecisionOrder`, or
`getBrokerReader`; `resolveBook` is called before any write; the route family registers after the
research routes; `trading.html` references `view-futures.js` (the existing `trading-html-syntax.spec.ts`
then parses the module); and the compiled twin `routes/trading-futures-routes.js` exists after
`oshal-app.js build` (a missing twin is a silent 404).

**Live risk.** The route refuses any non-paper book with 403 before any store access and imports no
equities broker; it cannot reach a venue.

## 3. The evidence gate and the stop-line

Evaluated once, after Phase 2, on every market with bars on disk (ES and CL today), using the
Phase 2 OOS report:

| OOS result | Consequence |
|---|---|
| OOS net **≤ 0 on every market** | The finding is published as a **negative result** in `futures-backtester.md` and an ADR-116 amendment. The "fail-closed live adapter" and "contract risk semantics in the portfolio manager" items are **closed as "do not build live"**. Phases 3–5 remain optional paper/UI work at the operator's discretion. **This is an acceptable end state, not a failure** — the layer will have done exactly what it was built to do: measure someone's system honestly and decline to put money behind it. |
| OOS net **> 0 with degradation ≥ 0.5 on at least one market** | Phase 4 may be proposed (approval gate still applies). A live rail is *still* not built by this plan; it becomes a **new** BACKLOG entry whose done-when begins: "the OOS report above holds; AND the operator has named a futures-approved account and vendor/FCM; AND the adapter is paper-first behind the existing confirmation, guardrail, live-gate, and 428-confirm rails." |

Why "do not build live" is the expected default rather than a disappointment:

- The in-sample record shows no entry edge at defaults; the stop stack's contribution is real but
  CL is still negative and nothing has been tested OOS.
- The live books in this codebase are Schwab accounts bound through the **equities** rail; no
  futures-approved account, no FCM, and no Tradovate client exists anywhere in `src/`
  (`BrokerProviderType 'tradovate'` is a declared-not-wired enum member and nothing imports a
  client for it). Building one is a vendor and account decision the operator has not made.
- The archive's last daily bar is 2025-12-31 and the front months expired before that; a live rail
  would also need a real-time futures feed, which is a separate vendor decision.

**Nothing in Phases 1–5 can place, modify, or cancel a venue order.** Phases 1–3 read files and
write reference data; Phase 4's adapter has no venue; Phase 5's route refuses any non-paper book
before it does anything else.

## 4. Sequencing summary

```
Phase 1 (evidence rail)  ──►  Phase 2 (optimizer + OOS)  ──►  EVIDENCE GATE
                                                                  │
Phase 3 (archives → market_bars)  ── independent ──┐              ├─ negative ⇒ publish, close live items ("do not build live"), stop
                                                   ▼              │
                          [operator approval] ── Phase 4 (durable paper) ── Phase 5 (cockpit)
                                                                  │
                                                                  └─ positive ⇒ Phase 4 proposal; live rail = NEW gated BACKLOG entry
```

## 5. Shared-file hazards for whoever implements a phase

Several other trading lanes touch the same files; expect to rebase rather than assume:
`src/app/trading-event-plans.ts` (`dispatchTradingEventSchedule` dynamic imports),
`src/features/trading/index.ts` (barrel SEQ), `docker-compose.oshal-local.yml` trading env block,
`docs/BACKLOG.md`, `README.md` env table and "finance / trading" row,
`docs/governance/real-boundary-regression-audit.md`, and in the store package `trading-routes.ts`,
`tools/ui/view-research.js`, `tools/trading.html`, `oshal-app.yaml`, `README.md`. Do not cite line
numbers from `src/app/trading-books-store.ts` — it carries another item's uncommitted change at the
time of writing; cite the broker `CHECK` by content.

## 6. Open inputs (decisions, not blockers)

1. **Third market's bars** — buy Kibot HTTP credentials or another bulk archive for NQ/GC/YM.
   Without one, every overlay is ES+CL and says so.
2. **Live posture** — decide only after the Phase 2 report; "do not build live" is the expected
   answer if the OOS result is negative.
3. **Margin citation** — CME performance-bond figures (initial/maintenance, `asOf`, `source`) for ES
   and CL as `TRADING_FUTURES_MARGIN_SPECS`. Until supplied, margin is reported "not modeled"
   everywhere, by design.
4. **The trader's optimized per-market constants** — the standing ask in the private packet. Phase 2
   does not wait for them; if they arrive they become one more config file for Phase 1's runner.
