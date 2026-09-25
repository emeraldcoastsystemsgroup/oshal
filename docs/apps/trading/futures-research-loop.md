# Futures research schedule — implementation checkpoint

The ADR-116 Phase 2 ES/CL out-of-sample result was negative. That is a block on live promotion, not an instruction to stop studying Futures. This checkpoint adds an operator-configurable, paper-only permutation schedule; it does **not** close the Futures backlog outcome.

## Current path

The Trading console's Strategies → Tuning panel stores one owner-scoped `trading-futures-research:<sub>` schedule. The operator chooses roots, supported chart/higher timeframes, Kibot file or API source, a container-visible data directory, roll adjustment, volume floor, start date, end policy, walk-forward split, stage grids and a UTC cron. The default `latest` policy resolves the end to the previous completed UTC day on **each** run; `fixed` preserves an explicit historical end. The resolved end is recorded with the run for reproducibility. The route is operator-gated for create, run, pause, resume and delete. Stopping the stock advisor does not stop Futures.

A trigger admits one `running` row before returning its run ID. Owner migration `159-futures-research-runs.sql` provisions the table for validate-only production bootstrap, including FORCE RLS and app-role grants. A unique PostgreSQL index allows one active study across the box. The study loads continuous archives and runs the six locked-winner stages in a worker thread with a 1 GiB old-generation heap cap and a 30-minute wall-clock limit. The API event loop remains available. A completed row holds the exact normalized configuration, archive bar counts, chart/higher-timeframe source as-of timestamps, minute-resample flag, latest complete OOS end, each window's locked stage winners and out-of-sample results. The worker hashes the study definition, input bars inside the completed OOS horizon and report into a per-market evidence fingerprint. If the latest completed run for the same owner/schedule has the same root/end/fingerprint set, the new run is marked `unchanged` and no duplicate review ticket is created. Runs after a changed study definition or revised completed-window bars remain new evidence. This comparison happens after the bounded study, so it prevents false new-evidence claims but does not save optimizer compute. Failure writes a failed row and reason; an interrupted row older than 45 minutes is marked failed on the next admission. The console displays running/completed/unchanged/failed states and expandable evidence. A review ticket is attempted after durable new completion; ticket failure is logged without inventing a second failed study.

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
new completed or insufficient-sample evidence, then publishes a ticket of type `futures-research`.
Unchanged and failed studies do not trigger reasoning. Changing the opt-in alone does not count as
new market evidence. With opt-in off, the existing completed evidence ticket remains non-executing.

Admission stages the review ticket paused, binds its exact owner/run/attempt/ticket in PostgreSQL,
then moves it to backlog. The queue uses the companion's tool-less dedicated worker through the
existing bot client and task/cost rail. Before inference it rechecks operator status, the exact
owner's active Futures schedule, current opt-in and dedicated workflow registration. Mutable ticket
descriptions, forged identifiers, provider intents and redirected workers cannot supply evidence
or authority. A missing endpoint or provider fails visibly without unsigned localhost fallback.
The equities decision workflow and detached study worker perform no new inference.

Only a strictly validated response for the currently claimed attempt becomes a completed review.
Replay reuses a completed result without another provider call; invalid, failed or superseded
attempts cannot overwrite one. The console shows queued/reviewing/completed/failed state and the
workflow ticket ID. **Review this study** can retry a failed attempt interactively; a queued or
reviewing attempt can be reclaimed after one hour. Such a retry has a new attempt ID and fences
the old ticket. Pausing/deleting the schedule or clearing opt-in prevents queued admission at its
next execution check, but does not cancel provider work already dispatched. No proposal is
automatically adopted: loading it changes only the form, and explicit Save selects future grids.

## Verification

- `npx vitest run --no-file-parallelism futures-research- tests/unit/futures-optimizer.spec.ts`
- The private PostgreSQL cases apply migrations 159/160 and prove validate-only readiness, one-run admission, owner/RLS isolation, full report persistence, failed-source honesty, review concurrency, retry fencing and unchanged study evidence. An actual stale Kibot file crosses the worker/database boundary and creates a failed row without a completion ticket. `futures-research-quality.spec.ts` verifies refusal before the optimizer and per-window sample floors. Inference is explicitly doubled in these tests; they are not live provider proof. The success-path worker case runs synthetic bars; a separate compiled-JavaScript smoke checks the image-style worker entry.
- In the applications checkout, `trading/tests/trading-surface-expansion.spec.ts` proves operator-only schedule creation and that the stock-advisor stop leaves Futures intact. The route source and compiled twin are generated together by the canonical store-route builder.
- `trading/tests/futures-research-review.spec.ts` drives the real router and browser-script handlers with fixture inference: exact principal, refusal states, escaping, proposal staging without writes, and slow-response navigation guards. Run the package suite with its framework alias configured. The Test Lab's **Futures research studies and review** scenario lists the framework guards and honestly reports that the browser step did not execute host tests.

The `futures-research-queue-postgres.spec.ts` suite crosses actual study-worker, PostgreSQL
ticket/ledger and manifest-dispatch boundaries. It proves explicit opt-in, unchanged-study
suppression, exact binding, revoked access, retry/replay fencing and no unsigned fallback.
Schedule lookup and inference transport are explicit fixtures; the existing
`queued-protected-dispatch.spec.ts` separately exercises signed protected execution. The
companion's package test drives its compiled readiness route over loopback HTTP; readiness is
not a running-worker or provider receipt.

Installed acceptance still requires applying both migrations as owner, installing the matching
Trading and Futures Research packages, enabling the dedicated worker, opening Strategies → Tuning
as the operator, opting in, running a real-source study, reviewing its dedicated workflow ticket
through a configured hosted provider and checking its cost/task record. Verify the proposal
loads without changing the schedule until saved, then observe a real nightly run. These are
acceptance instructions, not a record that those steps have occurred.

## Still required before Futures can close

There is no forward prediction/outcome grading ledger, archive-to-`market_bars` ingestion, installed-console receipt, or nightly observation on the deployed box. Forward grading must bind an issuance timestamp and an actual Futures contract/source; cash-equity prices or retrospectively adjusted continuous-series levels cannot substitute for that contract. The configurable bar-date gate refuses stale input before each market's optimizer, but exchange-session freshness guarantees and proactive stale-source notifications remain open. Unchanged-evidence detection still happens after optimization; a pre-optimizer duplicate skip is not implemented. Paper-book/cockpit acceptance and any eventual live decision remain separate phases; live requires a named operator approval backed by positive research evidence. Keep [Futures extension layer](../../BACKLOG.md) open until its own Done when is met.
