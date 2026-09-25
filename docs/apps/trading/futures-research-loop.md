# Futures research schedule — implementation checkpoint

The ADR-116 Phase 2 ES/CL out-of-sample result was negative. That is a block on live promotion, not an instruction to stop studying Futures. This checkpoint adds an operator-configurable, paper-only permutation schedule; it does **not** close the Futures backlog outcome.

## Current path

The Trading console's Strategies → Tuning panel stores one owner-scoped `trading-futures-research:<sub>` schedule. The operator chooses roots, supported chart/higher timeframes, Kibot file or API source, a container-visible data directory, roll adjustment, volume floor, start date, end policy, walk-forward split, stage grids and a UTC cron. The default `latest` policy resolves the end to the previous completed UTC day on **each** run; `fixed` preserves an explicit historical end. The resolved end is recorded with the run for reproducibility. The route is operator-gated for create, run, pause, resume and delete. Stopping the stock advisor does not stop Futures.

A trigger admits one `running` row before returning its run ID. Owner migration `159-futures-research-runs.sql` provisions the table for validate-only production bootstrap, including FORCE RLS and app-role grants. A unique PostgreSQL index allows one active study across the box. The study loads continuous archives and runs the six locked-winner stages in a worker thread with a 1 GiB old-generation heap cap and a 30-minute wall-clock limit. The API event loop remains available. A completed row holds the exact normalized configuration, archive bar counts, minute-resample flag, each window's locked stage winners and out-of-sample results. Failure writes a failed row and reason; an interrupted row older than 45 minutes is marked failed on the next admission. The console displays running/completed/failed states and expandable evidence. A review ticket is attempted after durable completion; ticket failure is logged without inventing a second failed study.

The stage-grid API accepts only the six reviewed configuration axes, with typed/ranged candidate values, at most eight values per axis, at most 64 combinations per stage and at most 512 estimated backtests per study. Overlapping out-of-sample windows, an empty projected window and a mock source outside tests are refused. The run has no order path and cannot arm a paper or live book.

## Verification

- `npx vitest run --no-file-parallelism tests/unit/futures-research-config.spec.ts tests/unit/futures-research-ledger-postgres.spec.ts tests/unit/futures-optimizer.spec.ts`
- The private PostgreSQL case applies migration 159 and proves validate-only readiness, one-run admission, owner/RLS isolation, full report persistence and failed-source honesty. The worker case runs synthetic bars; a separate compiled-JavaScript smoke checks the image-style worker entry.
- In the applications checkout, `trading/tests/trading-surface-expansion.spec.ts` proves operator-only schedule creation and that the stock-advisor stop leaves Futures intact. The route source and compiled twin are generated together by the canonical store-route builder.

## Still required before Futures can close

This is a deterministic study worker, **not yet a research bot** that can inspect results, explain losses or propose the next bounded study. There is no forward prediction/outcome grading ledger, archive-to-`market_bars` ingestion, installed-console receipt, or nightly observation on the deployed box. The rolling calendar end does not itself prove fresh source bars or a newly completed OOS window; freshness detection and duplicate-study suppression still need implementation so repeated nights do not masquerade as new evidence. Paper-book/cockpit acceptance and any eventual live decision remain separate phases; live requires a named operator approval backed by positive research evidence. Keep [Futures extension layer](../../BACKLOG.md) open until its own Done when is met.
