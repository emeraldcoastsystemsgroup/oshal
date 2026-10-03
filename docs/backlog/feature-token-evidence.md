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
passed **10/10, zero skips**, in one owned-fixture run on 2026-09-30, 00:19:42–00:20:02
UTC. The suite exited 0 in 9748 ms. It executed actual migrations 005, 055, 078,
090, 112, 115 and 182 (182 twice), the production writer/reducer, a non-bypass
table-owning role under FORCE RLS, wrong-owner refusal and immutable evidence,
real settlement rollback/replay and actual pre-182 savepoint recovery. SQL,
transactions and RLS were not doubled. Destructive schema controls were confined
to the fresh fixture database; no existing database or installed secret was used.

The executed product snapshot was `7ee4d48fa1ff6335eeae12c6a3cc92ffbf76f496`;
the unchanged PG spec Git blob was `ed5415dfb3ea3f0a7e7f4896f43f999b5a3ad6f2`.
The explicit reviewed TEST transport overlay was:

- `tests/helpers/disposable-postgres.ts`: `9b7fe56d38c6981571ce58f9a9ad9375b3b62f6f`.
- `tests/helpers/owned-postgres-transport.ts`: `8eb48217f57a00d09717c86c6c4b09339c332eec`.
- `tests/unit/owned-postgres-transport.spec.ts`: `4e0063f022d2a3d6aff7aea244108f9771aa0d25`
  (provenance/separate unit guard, not another executed PG suite).

All selected source bytes and the source manifest were checked before execution.
The runtime used cached Linux images with exact IDs:

- Dependencies: `sha256:9e9d0fb26b579f9db9acf723ad7d4208814f465e40b1145a1e819b4a5e2e5c9e`.
- PostgreSQL: `sha256:1d533553fefe4f12e5d80c7b80622ba0c382abb5758856f52983d8789179f0fb`.

The source package SHA256 `7353483c617f1b5ee63b9bec38c50e5389de3eabfde9a454226695435a832529`
differs from builder package `60cb532e5fda1cd123264b9867fe7fd773649b94d01b90da95dff3a355d6cdf0`
only by the exact unused `test:package-anonymous-routes` script; all other parsed
package fields match. Both use lock SHA256
`53e3cefe27d2aa9bcc264cae928b175061246cebf6415eaa1145d022658bd783`.
This checked compatibility is not a claim of byte-identical package files.

Actual receipt SHA256s (retained in the separate local acceptance evidence):

| Receipt | SHA256 |
| --- | --- |
| Source manifest | `e86aa8fd4fbc1391a3649ca92a3a5e7ae97b80e6c792bbb30c63ba3561e45a35` |
| Bound execution plan | `4af937bcb9b6c7361be2094a47ca13b1082a43c4431c498c610f70c319753299` |
| Vitest assertions | `91394551373a130ab76c516942476ab2afbfc1dd271a0d59b1d8a416dcf870fa` |
| Actual result | `37886bea584d1bf21519ad6c1e972efc825e5e3e1d9cb06b1a3cba7bd3d8078d` |
| Fresh owned endpoint | `e8ba66d9e153efa7028d5821bf6f00c62d7aa595c1288a91e2d48bc6a4734957` |

The endpoint attested one fresh claim and release. Exact run-label container and
network inventories were empty after exit, private fixture files were absent,
and all ten pre-existing container identities were unchanged. Independent
source and actual-receipt reviews passed. This clears the slice's real database
evidence requirement; it does not claim the later composed main archive was the
executed snapshot, nor deployed behavior or seven-day measurements.

The bounded focused command is:

```powershell
$priorNodeOptions = $env:NODE_OPTIONS
try {
  $env:NODE_OPTIONS = '--max-old-space-size=384'
  node --max-old-space-size=128 node_modules/vitest/vitest.mjs run --config vitest.config.ts --pool=forks --maxWorkers=1 --no-file-parallelism --testTimeout=15000 --hookTimeout=15000 tests/unit/feature-token-evidence.spec.ts tests/unit/cost-ledger-observability-write.spec.ts tests/unit/cost-ledger-rls-refusal.spec.ts tests/unit/remote-task-cost-once.spec.ts tests/unit/inline-turn-cost-ledger.spec.ts
} finally {
  $env:NODE_OPTIONS = $priorNodeOptions
}
```

Use a supervisor with fresh free memory at least 1800 MiB, minimum reserve 600 MiB
and a 180-second process-tree deadline. Inherited `NODE_OPTIONS` bounds the fork;
the direct Node argument separately bounds the runner. The PG companion requires
a separately scheduled runtime window and is omitted from this offline command.
Its ordinary disposable fixture requests 256 MiB; the actual owned-transport
acceptance instead used a 512 MiB PG container and 1024 MiB runner, heap384,
one CPU each/no extra swap, fresh3584 MiB/reserve2048 MiB, one worker/no retries,
suite600s/whole3300s/cleanup90s. Observed fresh6151.60 MiB and post-exit6148.11 MiB
are samples, not a recorded minimum. All owned resources were cleaned and the
remote slot released before collecting the reports.
Both new specs match the existing `tests/unit/**/*.spec.ts` CI selection.

Source/server types and the normal archived-HEAD/publish gate passed on the earlier
exact `7ee4d48f` candidate. The newly composed publication head still requires its
own finite source/server and intact push gates; the PostgreSQL result above is
already accepted and is not held for the separate seven-day outcome.
## Authorized reader and real PostgreSQL verification

`readOwnFeatureTokenEvidence(database, input)` implements the authorized complete read slice:

- Accepts non-system authenticated owner and half-open UTC window `[from, until)`.
- Synchronous validation snapshots inputs before awaiting. Rejects system and invalid owners.
- Parameterized query enforces owner isolation under FORCE RLS, ordered by ID ascending with a 100,001 row sentinel limit.
- Refuses overflows exceeding 100,000 rows with `FeatureTokenEvidenceOverflowError` without returning partial profiles.
- Catches SQLSTATE 42P01 and 42703 when schema predates migration 182, returning `{ status: 'unavailable', reason: 'schema_unavailable' }` without throwing.
- Passes un-truncated owner rows to `aggregateFeatureTokenEvidence` to ensure complete operation verification.
- Unit suite `tests/unit/feature-token-evidence-reader.spec.ts` passes **12/12**.
- Real PostgreSQL companion `tests/unit/feature-token-evidence-reader-postgres.spec.ts` passes **3/3** on disposable PostgreSQL under active FORCE RLS.

Producer adoption, genuine seven-day sampling, ledger generation, model/workload measurements, cadence/cost projection, and pause/resume controls remain separate P0/A2 work. Synthetic fixtures are not production measurements. See the [boundary audit](../governance/real-boundary-regression-audit.md#feature-token-evidence-p0-2026-09-29).

