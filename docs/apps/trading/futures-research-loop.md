# Futures research schedule — implementation checkpoint

The ADR-116 Phase 2 ES/CL out-of-sample result was negative. That is a block on live promotion, not an instruction to stop studying Futures. This checkpoint adds an operator-configurable, paper-only permutation schedule; it does **not** close the Futures backlog outcome.

The current source/package path also includes the registered research-review workflow, frozen
owner-scoped forward prediction receipts, source-alert receipts and explicit archive import. A
negative study remains a durable observation and does not suppress later bounded research calls;
installed provider review, a real nightly/matured-outcome receipt and the separate paper/cockpit
phase are still required before this item can be closed.

## Current path

The Trading console's Strategies → Tuning panel stores one owner-scoped `trading-futures-research:<sub>` schedule. The operator chooses roots, supported chart/higher timeframes, Kibot file or API source, a container-visible data directory, roll adjustment, volume floor, start date, end policy, walk-forward split, stage grids and a UTC cron. The default `latest` policy resolves the end to the previous completed UTC day on **each** run; `fixed` preserves an explicit historical end. The resolved end is recorded with the run for reproducibility. The route is operator-gated for create, run, pause, resume and delete. Stopping the stock advisor does not stop Futures.

A trigger admits one `running` row before returning its run ID. Owner migration `159-futures-research-runs.sql` provisions the table for validate-only production bootstrap, including FORCE RLS and app-role grants. A unique PostgreSQL index allows one active study across the box. The study loads continuous archives and runs the six locked-winner stages in a worker thread with a 1 GiB old-generation heap cap and a 30-minute wall-clock limit. The API event loop remains available. A completed row holds the exact normalized configuration, archive bar counts, chart/higher-timeframe source as-of timestamps, minute-resample flag, latest complete OOS end, each window's locked stage winners and out-of-sample results. The worker hashes the study definition, input bars inside the completed OOS horizon and report into a per-market evidence fingerprint. If the latest successful run for the same owner/schedule has the same root/end/fingerprint set, the new run is marked `unchanged`. Review admission separately compares historical and settled forward evidence, so a newly matured outcome can justify review without a new OOS result. Runs after a changed study definition or revised completed-window bars remain new evidence. Failure writes a failed row and reason; an interrupted row older than 45 minutes is marked failed on the next admission. The console displays running/completed/unchanged/failed states and expandable evidence. An opted-in review ticket is attempted after durable completion and forward settlement when its combined evidence is new; ticket failure is logged without inventing a second failed study.

### Pre-optimizer duplicate reuse

Each market rereads/rebuilds its real source and passes the current source-date gate **before**
reuse is considered. The input key covers the normalized non-operational study definition,
resolved base strategy and ordered stage grids, actual completed windows, minute fallback flag,
and ordered chart/higher-timeframe OHLCV inside the completed horizon. Changes to consumed bars,
settings or completed windows compute again. A growing incomplete tail can reuse the historical
report while refreshing the displayed source dates, bar counts and quality assessment. End policy,
cron, review opt-in and forward controls alone do not change the historical experiment.

Only the latest successful ledger row for the exact owner and schedule is a candidate; no console
payload can supply a cached report. A parent API-process generation is included in the input key:
restart, watched source reload and deployment invalidate reuse. This is deliberately not a
cross-process or persistent engine cache; supported code changes must restart the API. Legacy
rows or changed report hashes compute normally. Canonical report hashing survives PostgreSQL JSONB
key reordering and JSON's non-finite-number representation. The historical evidence hash now also
uses canonical report serialization; the first run against older noncanonical evidence can be new
evidence once, without reclassifying its result.

The per-market `computation` receipt records `computed` or `reused`, the input/report fingerprints
and, for reuse, `reusedFromRunId`. Missing receipts mean unassessed, not skipped or computed.
Every trigger still writes a durable run and settles enabled forward predictions. Review admission
still follows settlement, including for unchanged studies with newly matured outcomes. Reuse is
not a source-health, exchange-session, profitability or promotion verdict.

The stage-grid API accepts only the six reviewed configuration axes, with typed/ranged candidate values, at most eight values per axis, at most 64 combinations per stage and at most 512 estimated backtests per study. Overlapping out-of-sample windows, an empty projected window and a mock source outside tests are refused. The run has no order path and cannot arm a paper or live book.

## Console quality gates

The operator configures `quality.maxSourceLagDays` (integer 1–366, default 7) and
`quality.minOosTradesPerWindow` (integer 1–100,000, default 10) alongside the study. Older saved
schedules adopt these defaults on their next admission. Zero does not disable a gate. Before
optimizing **each market**, the worker compares its last chart and higher-timeframe bar-start
calendar dates with the resolved study end. Excess lag fails the durable run with the actual
source dates, lag, limit and refresh instructions; no result or completion ticket is fabricated.
Earlier markets may already have computed when a later market fails, but no partial study is
published as complete.

This is a **bar-date gate**, not a real-time quote-age or exchange-session SLA. Kibot timestamps
encode exchange-local wall time in UTC fields, and bars are stamped at their start. Coarse
timeframes may need a larger explicitly chosen limit. A fixed historical study compares with
its historical end, not today's clock; `latest` advances the reference date on each admission.

Every completed OOS window must meet the configured trade-count floor. One deficient window,
including zero trades, makes the run `insufficient_sample`; aggregate counts cannot hide it.
The console, review context and completion-ticket metadata retain the thresholds and deficient
windows. Such a run can still be reviewed and used to propose follow-up research without changing
its sample status. Repeated deficient evidence is `unchanged`, still carrying its insufficient
quality receipt and creating no duplicate ticket. Meeting the count floor is **not statistical
confidence, profit, an untouched holdout or promotion permission**. Historical runs without a
quality receipt are shown as unassessed, never backfilled as passing.

## Interactive research review

On a completed, insufficient-sample or unchanged run, **Review this study** invokes the package-owned
`futures-research-analyst` through the existing accounted hosted/BYO bot path. The request is
operator-only and bound to the persisted run's owner, not body-supplied evidence. The bot has no
tools or trading authority. Its bounded context includes aggregate results and the latest eight
windows per root; source paths, user identity and provider errors are excluded. Review output must
cite every root/fingerprint exactly once and conform to a strict schema. Invented evidence,
execution/forecast fields, changes to operator-owned quality thresholds, invalid axes and proposals
beyond the study budget are rejected.

Owner migration `160-futures-research-review.sql`, applied after 159, adds review state under the
run table's existing FORCE RLS. Review success or failure never changes the deterministic study
result. Duplicate clicks reuse a completed review; overlapping requests are refused. A failed
attempt may be retried, and an interrupted attempt can be reclaimed after one hour. Attempt IDs
prevent a late response from overwriting a newer attempt. Leaving the page does not cancel an
accepted review; reopen the run to see its durable state.

The console shows the summary, limitations and next-study rationale. **Load proposed study into
form** restores the reviewed study envelope plus validated grids without saving or running it.
The operator edits the controls and uses **Save / enable nightly loop** to choose the next study.
Reviewing OOS results to select another grid is exploratory tuning: the reused history is no
longer an untouched holdout, and none of these reviews are forward predictions.

## Opt-in scheduled research review

Install the matching framework, Trading package and **Futures Research** companion package. In
the Bots console, enable `futures-research-worker`. Its optional Compose service has the same name,
so the console start/stop operation addresses it directly; no environment-file research settings
or CLI credential mounts are needed. Select a usable hosted provider in Settings → AI Providers.
The owner's configured brain is resolved for every dispatch; a disabled CLI selection is refused,
never silently replaced with another provider. Older cores refuse these packages because they
declare the `bound-workflow-results` compatibility floor.

In Strategies → Tuning, check **Queue research-bot review after new evidence** and Save. This
`nightlyReview` control defaults to false and explicitly acknowledges provider cost. Installing
the package does not create a schedule or enroll other users. The deterministic worker persists
completed or insufficient-sample evidence, settles the enabled forward cycle, then admits a ticket
of type `futures-research` when historical or settled forward evidence has changed. An unchanged
historical study can therefore receive a new review after an outcome matures. Identical settled
evidence is recorded as `skipped`, without a ticket or provider call; fresh pending calls alone do
not trigger spending. Failed historical studies do not trigger reasoning. With opt-in off, the
existing completed evidence ticket remains non-executing. Turning opt-in on admits the next
successful study only if that schedule has no queued/reviewing/completed review of the same evidence.

Admission stages the review ticket paused, binds its exact owner/run/attempt/ticket in PostgreSQL,
then moves it to backlog. The queue uses the companion's tool-less dedicated worker through the
existing bot client and task/cost rail. Before inference it rechecks operator status, the exact
owner's active Futures schedule, current opt-in and dedicated workflow registration. Mutable ticket
descriptions, forged identifiers, provider intents and redirected workers cannot supply evidence
or authority. A missing endpoint or provider fails visibly without unsigned localhost fallback.
The equities decision workflow and detached study worker perform no new inference.

Only a strictly validated response for the currently claimed attempt becomes a completed review.
Replay reuses a completed result without another provider call; invalid, failed or superseded
attempts cannot overwrite one. The console shows queued/reviewing/completed/failed/skipped state and the
workflow ticket ID. **Review this study** can retry a failed attempt interactively; a queued or
reviewing attempt can be reclaimed after one hour. Such a retry has a new attempt ID and fences
the old ticket. Pausing/deleting the schedule or clearing opt-in prevents queued admission at its
next execution check, but does not cancel provider work already dispatched. No proposal is
automatically adopted: loading it changes only the form, and explicit Save selects future grids.

## Forward calls and later outcomes

Trading 1.24.0 adds a separate, default-off **Forward research calls** section in Tuning.
The framework `futures-forward-receipts` compatibility floor and owner migration
`161-futures-predictions.sql` are required. The console configures a dated contract for each
root, the explicitly confirmed archive wall-clock zone, horizon (1–168 hours), source age
(1–168 hours), target tolerance (1–168 hours) and chart history (64–4096 bars). Higher-timeframe
and optional daily-regime histories are capped at 512 bars. File-backed 5Min, 1Hour and 1Day
data are supported. Minute files are `minute/CONTRACT.txt`; daily files are
`daily/CONTRACT.txt`. There is no fallback, rollover or equity-quote substitution. Confirm that
the archive stamps bar opens; daily rows mean local calendar-day buckets, **not exchange
settlement**. Unsupported or ambiguous DST wall stamps are refused, not guessed. Contract
liquidity and renewal remain operator responsibilities.

`locked-strategy-bias-v1` replays the most recent completed OOS window's locked strategy on
that explicit contract's **unadjusted** completed bars. The existing backtester supplies a
detached observation before its synthetic end-of-data liquidation; an active held bias or
admissible final signal yields long/short, and no bias yields an abstention. This is a bounded
research model, not an executable order, calibrated probability, positive-expectancy claim or
continuation of an actual account position. Negative OOS does not suppress research calls.
Warmup, insufficient history, stale inputs, malformed/duplicate bars and missing files produce
visible `withheld` receipts instead of fabricated predictions. A trailing aggregate is excluded
unless raw source timestamps establish its completion.

The receipt freezes strategy, source/clock, contract, chart/higher/daily input arrays, reference
close, observation, study fingerprint and target settings. PostgreSQL assigns actual issuance;
there is no backdating input, and a database constraint rejects a reference close after issuance.
Canonical object-key hashing survives JSONB storage and permits fingerprint reproduction from
the fetched frozen inputs. Identical snapshots deduplicate within the owner/schedule/contract.
The horizon starts at issuance, not at a historical bar date. Grading uses the first completed
same-contract raw close at or after that target within the configured tolerance. It records
directional price change and signed ticks from the last known reference close, **not trade P&L**.
Missing/revised reference evidence and missing target bars are unscored. Late-arriving bars
whose event time falls inside the target window can resolve an unavailable outcome. A graded
result cannot be silently rewritten; flat changes are not wins and abstentions do not enter
accuracy scoring. The receipt list is capped at 50 summaries; full frozen arrays are fetched
only when the owner selects **Inspect frozen replay inputs**.

Each opted-in run settles its forward cycle after the historical worker, including unchanged
and failed studies. A failed study can still grade prior calls and records withheld new calls.
At most 25 pending/unavailable receipts from that same owner are checked per cycle,
oldest check first. One cross-process advisory worker slot defers overlapping cycles visibly.
A separate worker has a 512 MiB heap and five-minute timeout; source files
are limited to 128 MiB. Current owner/operator, active schedule and forward settings are checked
before and after work. Pause, stop or disabling forward calls prevents later cycle admission;
already committed evidence remains. A newly enabled loop can grade its owner's older pending
receipts using each receipt's frozen contract, archive and target settings, even after a schedule
was replaced; another owner's receipts never enter the worker. Forward cycle failures are shown
separately and cannot turn a completed historical study into a failure. The forward cycle settles
before scheduled review admission; a failed study may still grade old calls, but those grades
enter a review on a subsequent successful historical run.

## Frozen forward feedback

Trading 1.25.0 and Futures Research 1.1.0 display and interpret forward feedback with the matching
framework implementation. Interactive and scheduled review admission freeze the exact owner's
latest **25 graded and 25 other** receipts for the study's configured roots, across that owner's
schedules. The separate buckets keep pending calls from crowding out graded history. One SQL
snapshot provides the sample and total available counts, so truncation is explicit. Counts and
cohort denominators summarize only supplied receipts, not the owner's entire ledger. Cohorts
separate contract, model, study fingerprint and horizon; no pooled strategy-accuracy claim follows.
Calls can have overlapping horizons and are not independent trials. Flat and unscored outcomes
are not wins. Signed ticks are directional reference-to-future changes, not executable P&L or
calibrated probabilities. Forward observations remain separate from historical OOS.

The context excludes paths, raw source errors, credentials and owner/schedule identifiers. It
contains safe receipt IDs, immutable evidence fingerprints and observed outcomes, with a canonical
context fingerprint. The reviewer must cite that exact fingerprint whenever receipts exist;
missing or wrong citations fail the attempt. Invalid or future-dated graded evidence is refused
before inference. Missing migration 161 is explicitly unassessed; an empty available ledger and
an old review with no forward context are distinguished in the console, never represented as
zero predictive success. Proposals remain limited to bounded stage grids and require explicit Save.
Outcome-informed tuning consumes that holdout and needs new untouched evidence before promotion.

Nightly admission serializes each owner/schedule in PostgreSQL and compares historical fingerprints
plus settled forward evidence. Pending/check-clock changes do not produce a new spending key.
Failed attempts may be retried; a duplicate skip may be reviewed by an explicit console request.
Queued and completed reviews retain their original context even after later outcomes arrive.
Completed reviews are replayed, not refreshed or overwritten: a later run carries later evidence.
The console shows frozen counts, per-cohort details, receipt/context citations, assessment and skip
reason. This implements the feedback path; it is not a deployed provider or performance receipt.

## Explicit archive import

Trading 1.26.0 adds **Import Futures archives into the shared bar store** in Strategies → Tuning.
The matching framework declares `futures-archive-import`; owner migration
`162-futures-archive-imports.sql` requires the existing migration 096 reference store. Apply it
through the normal owner migration procedure before using a validate-only deployment. This is
independent of the nightly study and does not save, run or alter its schedule.

Choose roots, an absolute server-visible directory, minimum volume and UTC start/end days in
the study form, then explicitly confirm the archive clock and select 1Hour and/or 1Day.
Hourly bars come from `minute/CONTRACT.txt`, daily bars from `daily/CONTRACT.txt`; there is no
mock/API fallback. Up to eight known roots, ten years, one million output bars and 128 MiB per
source file are allowed. Parsing uses a separate 1 GiB worker with a ten-minute limit and one
active preview/import across the database. Interrupted work is recoverable on the next admission
after twenty minutes; an active transaction retains its row lock. Refresh shows the exact
owner's latest twenty receipts.

**Preview archive import** writes only an owned preview receipt, never shared bars. It uses the
existing instrument/front-month model and completeness engine, preserving raw unadjusted OHLCV.
The selected wall clock is decoded to true UTC bar opens, unlike the encoded wall timestamps in
the historical study reader. The UTC end day is inclusive; front-month boundaries remain the
instrument model's UTC boundaries. Daily rows mean local calendar days, not settlement prices.
Ambiguous/nonexistent DST stamps, duplicate or malformed rows, incorrect file granularity,
missing whole root/timeframe series and incomplete trailing aggregates are refused or excluded.
Missing contracts and gaps are visible in the manifest. Counts are session-model evidence, not
proof of vendor completeness or every underlying minute inside an aggregate.

Inspect the ready receipt, coverage, clock and fingerprint, then type
`IMPORT SHARED FUTURES BARS` and select **Import this exact preview**. Confirmation is operator-only
and bound to that owned frozen preview, not subsequent form edits. The worker re-reads the files;
changed effective bars/configuration refuse the import before writes. All inserts and the completed
receipt commit in one transaction. Stored OHLCV conflicts or a different source/clock for the
contract/timeframe roll back every new bar; existing facts and their ingestion timestamps are
never refreshed. Identical repeated imports report zero inserted and the exact unchanged count.
The source tag is `kibot-file:utc-v1:<zone>`. Legacy rows with another source tag are deliberately
not replaced: investigate provenance separately, without deleting shared data to clear this gate.
Completed confirmations replay their original receipt even if files later change. No provider
request, paper demo, trading order or automatic nightly archive refresh is part of this operation.

The optional CLI uses the same boundary. For example, a **read-only** preview:

```bash
npx ts-node -r tsconfig-paths/register --transpile-only scripts/oshal-futures-ingest.ts --source kibot-file --root ES --tf 1Hour --data-dir /data/kibot --source-time-zone America/New_York --start 2025-10-01 --end 2025-10-31
```

Only after inspection, adding `--store --owner <operator-sub> --fingerprint <preview-sha>` and
`--confirmation "IMPORT SHARED FUTURES BARS"` requests a durable import into explicitly configured
`DATABASE_URL`. No missing database, owner, fingerprint or confirmation falls back to memory.
The mock demo remains in-memory only; `--source mock --store` is always refused. Prefer the console
for operator work; local examples are not evidence that the installed archives have been imported.

## Source-failure notifications

Trading 1.28.0 and owner migration `163-futures-source-alerts.sql` add a default-off `sourceAlerts`
checkbox to Tuning. An explicit save opts into one notification attempt per failed stale, empty
or unconfigured source run, including **Run once**. Older schedules stay opted out; only a boolean
is accepted. The operational setting does not change the study or reuse fingerprints. Unexpected
worker/optimizer errors and insufficient or negative samples are not classified as source alerts.

The worker passes typed source evidence to the parent, which persists it with the failed study.
An atomic exact-owner/run claim, additionally guarded by the persisted opt-in and forced RLS,
precedes any outward request. Delivery uses the existing per-user NotificationRouter topic
`futures-source`, then the user's default routing if no topic preference exists. Configure the
channel, destination and quiet hours in Notifications. No deployment-global operator recipient is
used. Messages contain the root, source dates/lags and run ID, not archive paths or provider errors.

The run shows disabled, ready, claimed, delivered, skipped, failed or unknown, actual channel and
fallback channel when applicable, and timestamps. Mutes, quiet hours and unavailable channels
produce a skipped receipt, not delivery. Build/send wait is bounded to twenty seconds; an already
started transport cannot be cancelled, so a timeout is unknown. A router that finishes building
after the deadline does not start a send. Provider exceptions and interrupted outcome writes remain
uncertain. Claims are never automatically retried, even after restart; ready rows interrupted before
claiming also have no background recovery. Skipped messages are not deferred to the end of quiet
hours. Each new failed run has a new attempt, not cross-run incident suppression. This is bounded
per-run delivery, not a guaranteed-delivery outbox. Forward settlement remains independent and no
notification changes the failed study into success, weakens freshness or authorizes a trade.

For installed acceptance, first choose the owned Notifications routing and enable the checkbox
explicitly, then run a known stale source study and inspect its failed run, delivery receipt and
actual destination. Repeat with muted/quiet routing and confirm a skipped receipt without a
message. Those outward sends require the operator's opt-in; deployment alone does not enable them.

## Verification

- `npx vitest run --no-file-parallelism futures-research- futures-prediction- futures-review-forward- futures-archive- tests/unit/futures-backtester.spec.ts tests/unit/futures-optimizer.spec.ts`
- The archive suites use disposable files, the actual worker/ingest engine, private PostgreSQL with migrations 096/162 and an enforcing non-superuser role. They prove preview isolation, UTC conversion, strict source refusal, frozen settings, revoked access, owner/one-worker admission, canonical readers, exact repeat idempotence and full rollback after a later-series conflict. The CLI is executed as a child process with a loopback connection trap, proving dry/mock/unconfirmed paths never connect. Trading's `futures-archive-import.spec.ts` exercises the actual mounted routes with a fixture service and real browser-script handlers. These are local boundary proofs, not installed source completeness or import receipts.
- The forward guards use disposable CSV files, the real locked replay/isolated worker and a private PostgreSQL server with migration 161. They prove no backdating API, repeated-input deduplication, owner/RLS isolation, immutable input/terminal outcomes, explicit clocks, future-only grading, missing/revised data and failed/unchanged-study independence. The database terminal-grade payload is an explicit transport fixture; actual raw-bar grading is exercised separately. Trading's `futures-predictions.spec.ts` tests the real route with a doubled ledger and actual browser-script handlers. These are local boundary proofs, not a deployed forward accuracy receipt.
- The private PostgreSQL cases apply migrations 159/160 and prove validate-only readiness, one-run admission, owner/RLS isolation, full report persistence, failed-source honesty, review concurrency, retry fencing and unchanged study evidence. An actual stale Kibot file crosses the worker/database boundary and creates a failed row without a completion ticket. `futures-research-quality.spec.ts` verifies refusal before the optimizer and per-window sample floors. Inference is explicitly doubled in these tests; they are not live provider proof. The success-path worker case runs synthetic bars; a separate compiled-JavaScript smoke checks the image-style worker entry.
- In the applications checkout, `trading/tests/trading-surface-expansion.spec.ts` proves operator-only schedule creation and that the stock-advisor stop leaves Futures intact. The route source and compiled twin are generated together by the canonical store-route builder.
- `trading/tests/futures-research-review.spec.ts` drives the real router and browser-script handlers with fixture inference: exact principal, refusal states, escaping, proposal staging without writes, and slow-response navigation guards. Run the package suite with its framework alias configured. The Test Lab's **Futures research studies and review** scenario lists the framework guards and honestly reports that the browser step did not execute host tests.

The `futures-research-queue-postgres.spec.ts` suite crosses actual study-worker, PostgreSQL
ticket/ledger and manifest-dispatch boundaries. It proves explicit opt-in, concurrent cross-run
deduplication, newly settled outcome admission despite unchanged history, exact frozen binding,
revoked access, retry/replay fencing and no unsigned fallback.
Schedule lookup and inference transport are explicit fixtures; the existing
`queued-protected-dispatch.spec.ts` separately exercises signed protected execution. The
companion's package test drives its compiled readiness route over loopback HTTP; readiness is
not a running-worker or provider receipt.
An actual file-backed study worker also proves forward settlement precedes unchanged-study
review admission even when the optimizer report is reused; only that case's second forward cycle
supplies a synthetic grade transition. `futures-research-reuse.spec.ts` rereads actual private CSV
files through the real study/optimizer and proves no optimizer call on exact repeat, plus changed
bars/windows/settings/generation and damaged/legacy receipt invalidation. The ledger suite crosses
real worker threads and PostgreSQL JSONB for repeated reuse, exact owner/schedule isolation and
rejection of caller-supplied cache fields. These cases are registered in the Futures Test Lab.

`futures-review-forward-context-postgres.spec.ts` crosses the real projection SQL, JSONB storage,
immutable ledger, review admission and non-superuser RLS boundary. Synthetic dated receipts prove
bounded buckets/cohorts, redaction, canonical hashing, citation rejection, frozen replay and
inconsistent/future-grade refusal. Inference and market outcomes are explicit fixtures; the existing
raw-file prediction suites are the grading companion, not proof of real market performance.

`futures-research-source-alerts-postgres.spec.ts` applies migration 163 and uses real archive workers,
private PostgreSQL claims/RLS and the real preference router with fixture-only senders. It exercises
concurrent claim exclusion, opt-out, stale evidence, quiet/muted/unavailable routing, fallback,
timeout and outcome-write uncertainty. Trading's actual script handlers round-trip the opt-in and
escape every receipt state without writing a schedule or pretending delivery. Neither suite sends
a real notification. Migration 163 is also required by the validate-only research ledger guard.

Installed acceptance still requires applying migrations 159–163 as owner (162 after 096), installing the matching
Trading and Futures Research packages, enabling the dedicated worker, opening Strategies → Tuning
as the operator, opting in, running a real-source study, reviewing its dedicated workflow ticket
through a configured hosted provider and checking its cost/task record. Verify the proposal
loads without changing the schedule until saved, then observe a real nightly run. These are
acceptance instructions, not a record that those steps have occurred.

## Still required before Futures can close

The operator's data-source direction changed on 2026-09-25: Kibot ES/CL archives are not available
and are a roadmap discussion, not a dependency for the active Futures loop. The intended path is a
one-time historical backfill from a source the operator obtains, followed by forward dated-contract
OHLCV collection from the existing Schwab connection. A read-only console probe checks active dated
ES/CL quotes, 30-minute and daily candles independently and returns only statuses/counts/coverage;
quote snapshots never become bars. The connected operator account returned real
volume-bearing `/ESZ26` and `/CLX26` 30-minute candles on 2026-09-25. This establishes entitlement
to a recent dated-contract sample, not multi-year retention or continuous-contract quality.

Migration 167 places Schwab bars in `oshal_trading_futures_schwab_bars` under forced owner RLS,
separate from shared `market_bars`. The capture adapter stores the true UTC timestamp and only
converts to the research engine's New York wall-time convention on an owner-scoped read. It rejects
malformed/duplicate/out-of-order buckets, drops the current bucket, refuses revisions to already
captured closed OHLCV and replays unchanged bars idempotently. Strategies → Tuning has separate
probe, status, manual capture, enable and stop controls. The bounded hourly/half-hour schedule is
read-only and never arms trading or a study. Disposable PostgreSQL tests prove owner denial and
replay. An installed one-shot capture on 2026-09-25 wrote 220 ESZ26 and 219 CLX26 closed bars;
a repeat inserted zero. The one-shot was run with the existing brokered owner token inside the API
container; no token or bar payload was printed. The installed API loaded the new scheduler branch,
and a temporary one-minute canary dispatched twice with `success: true` on 2026-09-25. It was
restored to hourly `7 * * * *` UTC. The normal 03:07 UTC run then dispatched with `success: true`,
execution count 3 and next run at 04:07 UTC; owner-private counts stayed 220/219 during the closed
market. Trading 1.29.3 was installed from committed store HEAD in the persistent package volume
and loaded active after API restart. The deployed unauthenticated route returned 401. A signed-in
console visual check was not performed because
the available browser session redirected to Google sign-in; browser-script and route tests cover
the controls locally, not an authenticated installed click-through.

Remaining: promote the matching core scheduler through a normal committed image deployment; the
live scheduler is a targeted in-container compiled-file activation and would not survive container
recreation. A full-swarm image build is deferred because the box's 6 GB Docker cap is below the
runbook's 8 GB safe build floor. Complete signed-in console acceptance and observe per-contract
gap/freshness behavior over time. The
one-time historical source/backfill and its provenance still require operator selection and proof.
Only then may the Schwab owner-private reader be admitted to the research worker; the current study
config still expects its existing archive source. Session completeness and the DST fold remain
explicit failure gates, not assumed-good timestamps. No silent switch to equity proxies.

Archive-to-`market_bars` ingestion now has a console/CLI implementation and private boundary proofs; actual installed ES/CL import and idempotence receipts remain unproven. Installed-console/provider-cost receipts, a real nightly observation and subsequently matured forward outcomes on the deployed box remain unproven. Exchange-session completeness remains open; the forward clock and freshness guards do not assert exchange-session coverage. Proactive source notifications have local real-worker/owner-routing proofs, not installed channel-delivery acceptance. Pre-optimizer duplicate reuse has real-file and private-worker/JSONB proofs, not an installed nightly receipt. Outcome feedback now has local owner/RLS and frozen-citation proofs; deployed provider review of matured real outcomes still needs acceptance. Paper-book/cockpit acceptance and any eventual live decision remain separate phases; live requires a named operator approval backed by positive research evidence. Keep [Futures extension layer](../../BACKLOG.md) open until its own Done when is met.
