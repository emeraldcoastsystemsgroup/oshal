# Installed package verification — 2026-09-14

Five store packages were upgraded on the live box from store `main` `4e15108` and picked up by a
single api restart at 15:24:31Z. This note records what was **verified** about those five
afterwards, and — equally — what was **not exercised**, so "deployed" is not read as "tested".

Verification window: 15:48Z–15:55Z, same boot as the install. Read-only throughout: no writes to
`deployed-apps`, no restart, no deploy, no ticket, no LLM call, no trading value read or changed.

## Verdict

| package | version served | routes mounted | Test Lab catalog | new errors |
|---|---|---|---|---|
| embodied | 0.15.0 | yes — 4 of 4 declared | parses (24 cases) | none |
| circuit-lab | 0.7.0 | yes — 3 of 3 declared | parses (10 cases) | none |
| drone-relay | 0.3.0 | yes — 3 of 3 declared | parses (9 cases) | none |
| scan-to-print | 0.4.0 | yes — 3 of 3 declared | parses (14 cases) | none |
| animatronics | 0.2.0 | yes — 3 of 3 declared | parses (10 cases) | none |

**All five load and register cleanly. None of them was executed.** See
[What was not exercised](#what-was-not-exercised).

## 1. The new version is the one being served

Each manifest on the box reports the expected new version:

```
docker exec oshal-local-api grep '^version:' \
  /app/workspace-shared/deployed-apps/<pkg>/oshal-app.yaml
```

`embodied 0.15.0 · circuit-lab 0.7.0 · drone-relay 0.3.0 · scan-to-print 0.4.0 · animatronics 0.2.0`

The file content alone would not prove the *runtime* holds those bytes, so the ordering was checked
as well. All five `oshal-app.yaml` files have mtime `15:20:32Z`; the api container started at
`15:24:31Z`; the loader read each path once at `15:24:50Z` and logged `App loaded` with
`status: active`. New bytes were on disk before the load, and the load happened after the restart.

Note for future readers: `docker inspect` reports `RestartCount=0` on this container even though it
was restarted for the install — `RestartCount` counts only restart-policy restarts, not a manual
one. `StartedAt` (15:24:31Z) is the reliable boundary, and the container log carries **two** boots.
Every count below is filtered to lines at or after `15:24:31Z`.

## 2. Routes mounted

83 manifests loaded this boot with **0** load failures and 164 `Mounted package route` lines in
total. Per package, mounted paths against what the manifest declares:

| package | declared route modules | mounted paths |
|---|---|---|
| embodied | 4 | `/api/embodied`, `/api/embodied/_smoke`, `/api/embodied/home-summary`, `/api/embodied/nodes` |
| circuit-lab | 3 | `/api/circuit-lab`, `/api/circuit-lab/_smoke`, `/api/circuit-lab/home-summary` |
| drone-relay | 3 | `/api/drone-relay`, `/api/drone-relay/_smoke`, `/api/drone-relay/home-summary` |
| scan-to-print | 3 | `/api/scan-to-print`, `/api/scan-to-print/_smoke`, `/api/scan-to-print/home-summary` |
| animatronics | 3 | `/api/animatronics`, `/api/animatronics/_smoke`, `/api/animatronics/home-summary` |

Declared count equals mounted count for all five — nothing a manifest asked for is missing.

**The duplicate-load failure mode was checked explicitly and is absent.** Grouping every
`Manifest loaded` line this boot by app name yields exactly one line per app across all 83 — no app
name appears twice, including the five. `deployed-apps/` holds one directory per package with no
version-stamped or backup-shaped siblings; the pre-install trees are under
`/app/output/_pkg-backups/<pkg>-<oldversion>-20260914-152338`, outside the directory the loader
scans.

Mounting is not calling: these paths are registered in the Express router, and no request was sent
to any of them.

## 3. Test Lab catalogs parse

Rather than hand-checking the three known traps, each package was run through the **real** loader —
`loadPackageTestCatalog` from `scripts/oshal-test-catalog.js`, the same module
`InstalledAppTestCatalog` uses — against its real installed directory, via a short Node process
inside the already-running api container. That exercises every rule the catalog loader enforces,
not just three of them, and it also confirms each referenced suite file and fixture exists and is
path-confined (`confinedFile` throws otherwise) and that every case fingerprints.

All five returned a validated catalog. Margins against the three traps the loader refuses a whole
manifest for:

| package | cases | longest `expected` (cap 500) | highest `timeoutMs` (cap 300000) | non-string `expected` |
|---|---|---|---|---|
| embodied | 24 | 495 | 300000 | 0 |
| circuit-lab | 10 | 345 | 300000 | 0 |
| drone-relay | 9 | 295 | 120000 | 0 |
| scan-to-print | 14 | 154 | 120000 | 0 |
| animatronics | 10 | 231 | 180000 | 0 |

Two margins are narrow and are recorded here as measurements, not as findings: embodied's longest
`expected` line is 495 of the 500 permitted characters, and embodied and circuit-lab both declare a
case at exactly the 300000 ms ceiling (the validator refuses `> 300000`, so 300000 is legal today).

All five declare `uses: [test-catalog]`, which the loader requires so an older core refuses a
catalog rather than ignoring it silently. Registered runner kinds across the five: `smoke`,
`node-test`, `playwright`, `external`.

## 4. Nothing new in the error log

This boot produced 3904 info, 116 warn and **4** error lines. All four errors are the
already-queued ADR-149 class:

```
module: manifest-service-route-schedule
err:    ApplicationExecutionDeniedError: authorization_execution_identity_required (403)
apps:   daily-trade-recap (x2), intelligent-sales (x2)
```

That class is on the operator's decision list already and is not new. **There is no other
error-level line this boot**, and none of the four names any of the five packages.

At warn level, no line names any of the five either. The warn population is unrelated pre-existing
traffic (world-feed sentiment fallback, feed variant fetches, ADR-097 suite-less manifests,
anonymous package routes that self-guard, an unclaimed swarm root).

## What was not exercised

**No package test suite, smoke, or route call was run, and no package behaviour was observed.**

The container-backed Test Lab cases decline silently above VM load1 ≈ 6 and then report as a pass,
so a run under load produces a false green rather than an error. Load1 inside the api container was
**33.49** when this verification began and the coordinating lane reported **74** shortly after,
with the owner trading and the market open. Running anything container-backed at that load would
have produced a verdict that could not be trusted, so nothing was run.

Concretely, this note proves the five packages **load, register, mount and validate** at their new
versions. It does **not** show that any endpoint returns correct data, that any simulation or
solver produces a correct result, or that any surface renders. Those remain unproven on this box at
these versions until the suites are run on a quiet VM.

Two further boundaries worth stating plainly:

- Version provenance was taken from the install record and the on-box bytes. The sha256 match of
  staged bytes against `git cat-file blob` was performed by the installing lane at install time; it
  was not re-performed here.
- The runtime registry version was inferred from load ordering (file mtime → restart → single
  `App loaded` per app), not read back out of Postgres. No database was queried.

## Reproducing this

Every check is cheap and read-only. Prefix `docker exec` with `MSYS_NO_PATHCONV=1` under Git Bash
so container paths are not mangled.

```bash
# boot boundary — StartedAt, not RestartCount
docker inspect -f '{{.State.StartedAt}}' oshal-local-api

# the container log carries two boots; filter before counting anything
docker logs oshal-local-api > api-boot.log

# version served
MSYS_NO_PATHCONV=1 docker exec oshal-local-api \
  grep '^version:' /app/workspace-shared/deployed-apps/embodied/oshal-app.yaml

# one Manifest loaded per app, and route mounts
grep 'Manifest loaded' boot-current.log | grep -c '"name":"embodied"'
grep 'Mounted package route' boot-current.log | grep '"appName":"embodied"'

# catalogs, through the real loader (writes nothing)
MSYS_NO_PATHCONV=1 docker exec -i oshal-local-api node < probe-catalog.js
```

`probe-catalog.js` loads `/app/scripts/oshal-test-catalog.js`, parses each
`deployed-apps/<pkg>/oshal-app.yaml`, calls `loadPackageTestCatalog(dir, manifest)`, and reports
case count, longest `expected`, highest `timeoutMs` and any non-string `expected` entry.
