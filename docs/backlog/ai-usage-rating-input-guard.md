# AI usage rating: declaration input guard

Status: implemented and locally tested, 2026-09-29. This closes a ledger CLI
validation gap, not the measured-usage or model-compatibility backlog.

## Already-decided scope

The answered A2 direction is one product using supported local or hosted inference,
with measured per-feature usage, cadence, compatibility and cost, and pausable
background work. It does not authorize a separate offline edition or silent paid
fallback. This guard does not reopen those decisions, select models, change routing,
or implement pause controls. Existing `degrade` / `reducedEdition` declaration fields
remain compatible; accepting that schema does not create a new product edition.

## As built

[The standalone ledger CLI](../../scripts/ai-usage-ledger.js) now checks the same
declaration boundary as [the manifest loader's validator](../../src/features/swarm-apps/services/swarm-app-rating.ts):

- Unknown fields at rating, memory and feature levels are rejected, including
  hand-authored token, model-verification, cost and cadence fields. `--allow-unrated`
  only permits missing ratings; it cannot waive malformed declarations.
- Memory bounds/basis, feature identifiers/uniqueness, unit text, closed tier /
  generation / degrade sets, context floor and reduced-description requirements
  are validated before rendering.
- Invalid declarations cannot create or replace `--out`. When `--check` and
  `--out` are combined, checking happens before writing: a stale checked file
  cannot be repaired by that same invocation and then reported as having passed.
- Valid generated output is unchanged. Missing ratings retain rollout behavior:
  generation lists them, strict `--check` refuses them, and `--allow-unrated`
  permits them. Unmeasured token/model cells remain explicitly unmeasured/unverified.

The CLI remains plain Node JavaScript; it does not load the TypeScript service
runtime. Tests compare acceptance/refusal against the authoritative validator.
Any future schema extension must update both validators and their parity cases.
An accepted `basis: observed` label is still a declaration, not independently
verified measurement evidence.

## Regression evidence

[The new guard](../../tests/unit/ai-usage-rating-input-guard.spec.ts) executes the
actual CLI, YAML parser and owned temporary filesystem, plus the actual TypeScript
validator with only its logger doubled. The CLI child uses a clean environment,
128 MiB heap and a ten-second deadline; spawn failures/timeouts are not counted
as successful refusals. No model, database, browser or provider is involved.
[Existing rating tests](../../tests/unit/app-rating-validation.spec.ts) additionally
exercise the real manifest reader and current repository manifests.

Recorded locally on 2026-09-29:

- Original script: initial guard baseline **27 failed / 5 passed**.
- Restored final source: **67 passed, zero skipped** across the two files
  (42 new guard cases plus 25 existing rating cases).
- Planted removal of feature unknown-key rejection: **8 failed / 34 passed**.
- Planted removal of pre-render validation: **4 failed / 38 passed**.
- Both mutations restored; source SHA256
  `69644c92380b09da3b1e8bf4780ab28f32fd63f4e9158fb6e93f361b4e792805`.
- Script syntax and the committed core ledger's read-only `--check` passed;
  no generated ledger was rewritten.

Focused command (runner heap 128 MiB, one worker heap 384 MiB):

```powershell
$env:NODE_OPTIONS='--max-old-space-size=128'
node --max-old-space-size=128 node_modules/vitest/vitest.mjs run --config vitest.config.ts --pool=forks --maxWorkers=1 --no-file-parallelism --execArgv=--max-old-space-size=384 --testTimeout=15000 --hookTimeout=15000 tests/unit/ai-usage-rating-input-guard.spec.ts tests/unit/app-rating-validation.spec.ts
node --max-old-space-size=128 --check scripts/ai-usage-ledger.js
node --max-old-space-size=128 scripts/ai-usage-ledger.js --core . --check docs/apps/ai-usage-ledger.md
```

The final main-based supervised run at `2ff4895e` started with 2216 MiB free,
observed a minimum of 1888 MiB and finished in 13.77 seconds. Local execution requires
a fresh 1800 MiB preflight, a 600 MiB reserve and an enforced 180-second deadline. Full compilation,
publication and runtime acceptance are separate, unrun gates for this slice.

## Discovery and evidence registration

This document is indexed in [the backlog topic index](./README.md). The real
CLI/YAML/filesystem/validator scope and logger-only double are recorded in
[the real-boundary audit](../governance/real-boundary-regression-audit.md#ai-usage-rating-declaration-guard-2026-09-29).
The two specs match `tests/unit/**/*.spec.ts` in [vitest.config.ts](../../vitest.config.ts),
with no applicable exclusion. [package.json](../../package.json)'s `test:unit` runs
`vitest run`; both [the local CI unit gate](../../scripts/ci-local.sh) and
[the hosted CI unit job](../../.github/workflows/ci.yml) call that command. This is
source-confirmed discovery, not a claim that the entire CI suite has run. There is
no existing runtime Lab card for this standalone CLI; no new card is introduced.

## Remaining acceptance boundary

[ADR-170](../adr/170-token-rating-and-code-offload.md) and the current
[backlog](../BACKLOG.md) still own feature attribution and generated per-operation
token ranges, background cadence/cost projections, named-model compatibility
evidence and pause/resume behavior. This change neither supplies those measurements
nor claims a feature is affordable or compatible. Broader ADR/backlog reconciliation
belongs to the integration change; no historic ledger or shared decision document
is rewritten here. The guard's topic index and boundary-audit registration are
included in this change, rather than left pending integration.
