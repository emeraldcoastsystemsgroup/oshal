# Isolated nightly regression runner

Run `npm run test:nightly-isolated` from a checkout with Node dependencies and Docker available.
`node scripts/ci/run-nightly-isolated.mjs --scheduled` uses the same bounded runner and records the
scheduled invocation in its result. It does not register or change a Windows scheduled task.

The fixed eight-suite selection covers alert cutover/reopen, topology traversal, PostgreSQL isolation,
runner validation, scheduled-ref selection, retained CI logs and gate streaks. Each database suite
creates a disposable PostgreSQL 16 container with an ephemeral loopback port and random password.
Neither an ambient deployment DSN nor deployment notification credentials enter the child process.
The helper removes its container after the suite, including failed setup.

Each run writes `result.json`, `result.md`, raw Vitest results and command output beneath a unique
`temp/nightly-isolated/` directory. Timeout kills the child process tree. Missing suites, skipped
assertions and nonzero exits cannot become green merely because a partial report exists.

The 2026-09-11 scheduled invocation passed **59 tests in eight suites, zero skips**, retained at
`temp/nightly-isolated/2026-09-11T06-00-21-240Z-TfNLPS/`. AI Test Lab registers the same eight paths
under **Isolated nightly regressions** and explicitly requires the local runner.

This is not a passing full-nightly declaration. The preceding real unattended run had store-compatibility,
unit timeout, lint and browser failures. Its active process was left undisturbed. The standalone
`scripts/ci/ci-run-log.sh` retention helper is tested; integrating it into the then-locked full CI launcher
and obtaining a complete unattended green run remain separate work.
