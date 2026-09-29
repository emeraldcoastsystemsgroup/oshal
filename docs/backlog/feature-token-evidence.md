# Feature token evidence: ADR-170 P0

This additive slice records explicit producer evidence on the existing cost-event row
and reduces authorized rows into observed per-operation token distributions. It does
not activate a producer, read production data, add a public endpoint, generate the
usage ledger, or close [ADR-170](../adr/170-token-rating-and-code-offload.md).
Supported local and hosted inference remain the same product; this is not an
offline edition or a model-compatibility claim.

## Producer and persistence contract

[CostEvent](../../src/features/operational-intelligence/services/cost-tracking-service.ts)
accepts optional `featureEvidence` with the
[version-one contract](../../src/features/operational-intelligence/services/feature-token-evidence.ts):

- Explicit producer, application, feature, unit and workload identifiers; exact core
  and store commit SHAs; an operation UUID and start time. One operation is one
  declared unit, not one ledger row or an inferred task/agent category.
- Each member has its own UUID, one-based index and token provenance:
  `provider-reported`, `estimated` or `unknown`. Only the final member supplies
  `completion: { memberCount, completedAt }`; others explicitly supply `null`.
- The writer snapshots cost fields, producer binding and nested completion before
  any await. It copies the event's exact `requestCount` into the stored evidence;
  absent/invalid counts remain null, zero remains zero, and neither is admitted as
  measured usage. An event can represent multiple requests. Estimated/invalid
  tokens cannot become provider-reported measurements.
- Producer evidence is trusted service input, not a browser grant or a feature
  guess. Invalid declarations are warned about without echoing their contents and
  do not interrupt ordinary accounting.

[Migration 182](../../scripts/migrations/182-feature-token-evidence.sql) adds nullable
`oshal_cost_events.feature_evidence`; there is no legacy backfill, new role, RLS
policy, permission or session bypass. Its update trigger prevents retrospective
attribution, removal or rewriting of attributed identity, tokens, timestamps and
the entire evidence payload. New inserts remain subject to existing ledger RLS.
The reducer also rejects conflicting bindings across rows of the same operation.

The evidence insert is the original cost row, not a second accounting stream.
`recordCost` still owns its existing rollup; `recordLedgerEvent` still does not
write that rollup; `recordCostOnce` retains its advisory lock and atomic
receipt/rollup/ledger settlement. If migration 182 is unavailable, SQLSTATE 42703
produces an explicit warning and one legacy cost row without measured evidence.
A savepoint recovers this optional-column failure inside `recordCostOnce`;
other ledger errors still roll back settlement. Existing accounting defaults are
unchanged and must not be mistaken for evidence of exact request counts.

## Pure read-only reduction

`aggregateFeatureTokenEvidence(rows, { ownerSub, from, until })` is exported by the
operational-intelligence feature barrel. It has no pool, SQL, HTTP route or access
grant. Its caller must already have authorized and explicitly scoped the rows,
including every recorded member of the operations under examination. The owner
check is consistency validation, not authority to read another owner's data.
Null-owner system scope does not include personal rows.

The reducer accepts the real ledger projection: ID as decimal string, timestamp,
owner, provider/model, nullable BIGINT tokens and nullable evidence JSON. It:

- Leaves legacy rows unattributed, never zero-token or feature-inferred.
- Quarantines duplicate row IDs, member UUIDs (including reuse across operations)
  and member indices; rejects a changed producer/feature/workload/source binding.
- Requires exactly one completion and every member index from one through its
  declared total. Completion cannot postdate persistence of the final member.
- Uses a half-open UTC window `[from, until)`: operation start, completion and
  every persisted member must fit. Partial/out-of-window operations are excluded.
- Admits only provider-reported, safe-integer token counts, known provider/model
  labels and explicit positive request counts. Unknown/estimated/marker usage and
  overflow are excluded, not silently approximated.
- Sums members before calculating nearest-rank p50/p95 tokens, output tokens and
  requests per completed operation, plus mean requests. Profiles stay separate by
  producer/application/feature/unit/workload/source SHAs and observed model set.

The report names exclusions and `coverage: recorded-samples-only`; it exposes no
owner or operation identifiers. An evidence window is not seven days of observed
stack uptime. A model appearing in a profile is not a tested compatibility verdict.
Do not add Token Chase frames to the same cost-ledger events: that would count
the same work twice. No cadence, dollar projection or quality rating is inferred.

## Verification and remaining acceptance

[Focused tests](../../tests/unit/feature-token-evidence.spec.ts) exercise the actual
reducer and cost writer with a named recording SQL transport and logger double.
They do not prove PostgreSQL transactions, RLS or migration execution.

Final focused result: **103/103 passed, zero skips** across five files (69 new
cases and 34 existing accounting regressions). Each of four actual-code negative
controls produced one expected failure: infer one request when missing, omit
membership completeness, omit strict savepoint recovery, and omit the
`recordCostOnce` input snapshot. All controls were restored. A separate reproduced
large-count mean-rounding failure was repaired with exact integer accumulation;
the final run includes its order-independence regression. The bounded final run
finished in 9.79 seconds, starting at 2827 MiB free and observing a minimum of
1828 MiB. Five touched TypeScript files also passed syntax-only transpilation;
that is explicitly not a project typecheck.

[The PostgreSQL companion](../../tests/unit/feature-token-evidence-postgres.spec.ts)
is prepared but **not executed**. It uses the existing owned disposable fixture,
minted credentials and a non-bypass table-owning role under FORCE RLS. It applies
actual migrations through 115 plus 182 twice, calls the production writer and
reducer, checks wrong-owner refusal and immutable evidence, and exercises actual
rollback/replay and pre-182 savepoint recovery. Its destructive schema control is
restricted to that fixture database. No deployment DSN or installed secret is read.

The bounded focused command is:

```powershell
node --max-old-space-size=128 node_modules/vitest/vitest.mjs run --config vitest.config.ts --pool=forks --maxWorkers=1 --no-file-parallelism --execArgv=--max-old-space-size=384 --testTimeout=15000 --hookTimeout=15000 tests/unit/feature-token-evidence.spec.ts tests/unit/cost-ledger-observability-write.spec.ts tests/unit/cost-ledger-rls-refusal.spec.ts tests/unit/remote-task-cost-once.spec.ts tests/unit/inline-turn-cost-ledger.spec.ts
```

Use a supervisor with fresh free memory at least 1800 MiB, minimum reserve 600 MiB
and a 180-second process-tree deadline. The PG companion requires a separately
scheduled runtime window, cached `postgres:16-alpine`, one owned 256 MiB fixture,
and its normal cleanup; it is deliberately omitted from this offline command.
Both new specs match the existing `tests/unit/**/*.spec.ts` CI selection.

Full typechecking, normal publication gates and real PG acceptance remain pending.
Producer adoption, completeness-preserving authorized reads, genuine seven-day
sampling, ledger generation, model/workload measurements, cadence/cost projection,
and pause/resume controls remain separate P0/A2 work. Synthetic fixtures are not
production measurements. See the [boundary audit](../governance/real-boundary-regression-audit.md#feature-token-evidence-p0-2026-09-29).
