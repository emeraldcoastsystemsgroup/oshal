# Isolated browser cleanup acceptance

Verified locally on 2026-09-29 against main `9ee8094c` plus the cleanup-budget
inventory correction described below. This is browser-fixture acceptance, not an
installed Jarvis, provider, database or whole-suite acceptance result.

## Contract and correction

The [owned browser fixture](../../tests/fixtures/isolated-browser.ts), implemented
in `f96999df`, already has one 45-second exit budget. Five seconds triggers scoped
termination of its own Playwright server; only the observed exit can confirm cleanup.
A premature crash or missing exit evidence still fails loudly. Suites must give
cleanup at least `BROWSER_HOOK_TIMEOUT_MS`, including any explicit hook override.

The first current-main run found **21 passed / 1 failed**: the inventory guard
rejected `budgets-unit-split-browser.spec.ts` because it has no global `hookTimeout`,
although its actual hooks explicitly use the correct imported timeout. No production
browser lifecycle code or Budgets suite was changed. The guard now uses the effective
cleanup-hook argument first, then the global setting; a short explicit override still
fails. Four direct cases cover explicit-only, inherited, short-override and missing
budgets. Existing real spec discovery also recognizes the `ownedBrowser` variable.

## Five consecutive real runs

Each run used these three unchanged suites after that correction:

- [isolated-browser](../../tests/unit/isolated-browser.spec.ts): lifecycle timing,
  actual repository hook budgets, and actual headless Chromium exit/refusal.
- [jarvis-no-brain-browser](../../tests/unit/jarvis-no-brain-browser.spec.ts): real
  page/router/loopback HTTP and Chromium, with identity, persistence and unavailable
  provider resolution explicitly doubled; no provider dispatch.
- [budgets-unit-split-browser](../../tests/unit/budgets-unit-split-browser.spec.ts):
  shipped page in Chromium with fixture budget endpoints.

| Run | Result | Wall seconds | Starting free MiB | Minimum sampled free MiB |
|---|---|---:|---:|---:|
| 1 | 28 passed, 0 skipped | 14.54 | 4195 | 3464 |
| 2 | 28 passed, 0 skipped | 23.87 | 4017 | 3524 |
| 3 | 28 passed, 0 skipped | 12.60 | 4306 | 3714 |
| 4 | 28 passed, 0 skipped | 12.50 | 4349 | 3651 |
| 5 | 28 passed, 0 skipped | 11.78 | 4298 | 3651 |

The sequence ran from 23:17:48 to 23:19:42 UTC on Windows while the Home
qualified-target, pre-push and usage-evidence build lanes continued. This was real
concurrent development, not a synthetic CPU saturation experiment. No forced slow
shutdown duration is inferred from those wall times. Each run used a fresh 2800 MiB
admission floor, a 600 MiB ongoing reserve, an enforced 180-second process-tree
deadline, runner heap 128 MiB and one 384 MiB fork. All exited normally; no retries,
skips, budget overrides, provider sessions or database connections were needed.

The never-exit fake-clock case still fails at the named budget. The real Chromium
case intentionally withholds exit confirmation and verifies a named 250 ms refusal,
then cleans up its own server. It does not pretend Chromium itself became unkillable.

Reproduce each run in a host with that headroom:

```sh
node --max-old-space-size=128 node_modules/vitest/vitest.mjs run tests/unit/isolated-browser.spec.ts tests/unit/jarvis-no-brain-browser.spec.ts tests/unit/budgets-unit-split-browser.spec.ts --pool=forks --maxWorkers=1 --no-file-parallelism --execArgv=--max-old-space-size=384 --testTimeout=15000 --hookTimeout=15000
```

The command's defaults do not replace explicit fixture cleanup-hook budgets.
Run under an outer 180-second watchdog that monitors free memory and terminates
only its owned process tree if the reserve is crossed.

## Retained evidence identity

The tested inventory spec SHA256 is
`eccb4f9335b22ad66be73dea2018d087ca7243aef5c0f4abef579c53e809dd19`.
Local logs/JSON receipts use `browser-fixture-run1-restored` through
`browser-fixture-run5-restored`; the failing original is separately `run1-baseline`.
Raw logs remain local. Their SHA256 values, in run order, are:

```text
f0f96567d417e8f0a4a42fce4ad62dc30d9cd0ee552ea4ca1d1f053648d81ae7
5dffa0d4b9a36ea661135d898eced83b473890d77d469c21592ad1c850719ff5
16d6e5cb647676db06a4b7cb1901ff589d26f489cd3fe60c3cf346392ad46998
68a7d6ce53044127420164b8b0ed0f13b48cf8ee9f610e6f16f237cef23306a4
a436092f9f768a869d8c4b2ab71ca44078f31cb91faea572a973a9bfe38559ae
```

The fixture and Jarvis suites are already linked from the daily-dashboard Test Lab
card; normal Vitest discovery includes all three. Publication/typechecks and backlog
reconciliation are separate from these retained browser results.
