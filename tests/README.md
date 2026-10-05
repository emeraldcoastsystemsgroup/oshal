# Test organization and registration

## LoRA gallery producer boundary

`npx vitest run tests/unit/lora-cell-thumbnails.spec.ts` executes the shipping Python validator
against a loopback receiver. Only ComfyUI rendering and CLIP scoring are fixture ports; real PNG
files are encoded and posted as bounded JPEG thumbnails after the scorecard, with matching cell
filenames. Every callback is signed with the dispatch's callback grant (`OSHAL_LORA_CALLBACK_GRANT`,
`scripts/comfyui-edge/lora_callback.py`): the spec recomputes each signature independently, requires
a distinct nonce per request, and refuses any request that carries the fleet secret. Python and
Pillow are required, and all output stays in the fixture's temporary directory. This is not a live GPU run. The store's `lora/tests/test-lab.yaml` separately
registers actual package HTTP, forced-RLS disposable PostgreSQL and Chromium pixel/expiry/deletion
acceptance; run its documented `lora/tests/gallery.config.mjs` command from the store checkout.

## Kernel manifest route-auth inventory

Run the focused source/manifest guard with one bounded worker:

```sh
node --max-old-space-size=128 node_modules/vitest/vitest.mjs run tests/unit/manifest-route-auth.spec.ts --pool=forks --execArgv=--max-old-space-size=384 --no-file-parallelism --maxWorkers=1 --testTimeout=90000
```

The spec scans top-level YAML files in `swarm-apps/` and `swarm-apps-build/`, not connector
definitions or installed store packages. It pins the required Security declaration by file,
module, factory, mount path and `operator` auth instead of a historical count floor. Both
Engineering variants intentionally leave framework-owned routes undeclared; adding them to
satisfy a count would incorrectly assign app ownership. A changed inventory requires review of
the named contract, not a relaxed threshold. The existing explicit-auth and server-mount comparison
guards remain in place, and the loader cases use real temporary YAML files through `readManifest`.

This is filesystem/YAML and source-contract verification, not live HTTP authentication or installed
package acceptance. The [boundary audit](../docs/governance/real-boundary-regression-audit.md#kernel-manifest-route-auth-inventory-2026-09-29)
records the reproduced failure, deletion/substitution mutations and restored focused results.

## General requirements

New functionality needs behavior tests in the same change. Bug fixes need a regression test that
fails for the original defect. Test the user outcome and relevant failure, ownership, cancellation
and confirmation paths. Keep test data isolated from deployment data; identify any model/provider
fixtures and the limits of their evidence.

Use the existing runners: Vitest discovers `tests/unit/**/*.spec.ts` and colocated source tests;
Playwright owns the other browser/E2E specs. The historical `tests/unit` directory also contains
isolated HTTP and Chromium integration suites. Classify those accurately in the Test Lab instead
of implying they are pure unit tests or moving them outside runner discovery.

The AI Test Lab's `SCENARIOS` registry in `src/app/routes/test-lab-scenarios.ts` is the product
scenario catalog. Feature modules contribute scenarios to it. Each new scenario declares
`regressionTests: [{level, path}]`, using `unit`, `integration`, or `browser`; classify a mixed suite
by the furthest boundary it exercises. These references appear in `/api/test-lab/catalog` and on
the Lab's cards. They document local suites; the Lab runs its declared HTTP steps, not arbitrary
shell commands from the browser.

For artifact exchange and Jarvis routing, run:

```sh
npm run test:artifacts
```

That command runs all suites registered by `test-lab-artifact-scenarios.ts`, serially with a bounded
browser teardown allowance. Its registration test verifies that the referenced files exist and
are included in the command. The two Lab scenarios are `artifact-discovery` and
`jarvis-artifact-handoff`; [the Test Lab guide](../docs/test-lab.md) describes their live effects.

For brand looks in the deck engine (the `brand-look-render` card), run
`npx vitest run tests/unit/brand-look-render.spec.ts tests/unit/deck-looks-unchanged.spec.ts tests/unit/test-lab-brand-look-registration.spec.ts`.
The first opens a .pptx, .docx and .xlsx drawn in a brand look and reads the colors and faces back,
and proves an invalid kit or forged look is refused. The second compares every OOXML part of the ten
built-in looks, and the picker catalog, with `tests/fixtures/deck-look-digests-2026-10-01.json`,
which was generated from the renderer before brand looks existed. Regenerate that fixture only for a
change meant to alter a built-in look: `OSHAL_WRITE_DECK_LOOK_DIGESTS=1 npx vitest run tests/unit/deck-looks-unchanged.spec.ts`.
No suite touches a database, a route or the network.

Suites that own a fixture browser through `tests/fixtures/isolated-browser.ts` set their hook timeout
from the fixture's own `BROWSER_HOOK_TIMEOUT_MS`, so the runner's hook deadline can never fire before
the fixture reaches a verdict about the browser process. The fixture gives that process one exit
budget - 45 s by default, raised for a slower host with `OSHAL_FIXTURE_BROWSER_EXIT_TIMEOUT_MS` - and
a browser that misses it still fails the suite by name. `tests/unit/isolated-browser.spec.ts` guards
both halves, including against a real headless Chromium.

An explicit cleanup-hook timeout is sufficient without a redundant global setting;
when both exist, the explicit timeout wins and must not shorten the fixture budget.
[The browser-fixture acceptance record](../docs/testing/isolated-browser-acceptance.md)
retains five consecutive Chromium/Jarvis/Budgets runs and the real-boundary limits.

Keep local regression results separate from deployed acceptance. A model fixture proves routing
and enforcement, while a live-model scenario measures semantic selection. Report both honestly.

For package installation, connector callbacks and multi-store controls, run:

```sh
npm run test:platform-readiness
```

These suites use disposable package directories, local HTTP/provider fixtures and browser fixtures.
The package execution/history cases also need Docker and a locally built core image
(`oshal-bot:latest`, or `OSHAL_TEST_RUNNER_IMAGE`). They execute real package assertions in
disposable containers and use separate PostgreSQL fixtures for retained evidence.
They do not install applications into the running deployment or connect real external accounts.
Service-smoke regressions use actual local HTTP routes and application policy to
prove the current browser user retains application authorization, including role
revocation and same-subject identities from different issuers. Session credentials
stay outside catalogs, run evidence and Node execution.
Preview deployment source tests use temporary local Git repositories to check
published-branch admission, source pinning and image labels without invoking Docker.
The core release pipeline suites (ADR-167: cut, promote, the on-box managed release and the drift
check) run the shipped scripts in Git Bash against temporary local Git repositories, with docker,
ssh, curl and the image probe runners as recording stand-ins; they never build an image, reach a
box or touch the running stack.
The compose loader budget suite runs `scripts/gen-dist-compose.js` on the real
`docker-compose.oshal-local.yml` from a scratch copy of the files the image build has at that step,
scans `scripts/`, `src/`, `tests/` and `any-bot/` for js-yaml parses of a compose file that bypass the
shared loader, and fails when the file's measured merge-key total passes 80% of the loader's bound.
It builds no image and starts no container.
They also exercise the actual startup-readiness function with synthetic logs,
including large output and producer failures, without restarting services.
The PostgreSQL pool-budget suite runs actual Docker Compose configuration resolution
against an isolated environment file. It checks the API-only 8/2/2 defaults (18 core
connections within the unchanged 24-connection application-role limit), explicit
operator overrides, and unchanged worker/service configuration. It starts no containers
and reads no deployment credentials. This is a default budget; custom overrides still
require deployment-wide capacity planning.
The matching Lab cards link the suites and run their documented discovery/refusal probes. Installed
package smokes appear separately, with app/version metadata and any missing execution prerequisites.

`npm run test:installation-verification` checks installation reports over actual
fixture HTTP, executes the shipped Bash verifier, and opens report links in Chromium.
It verifies registered case IDs/revisions, member ownership, safe-smoke failure,
explicit pending coverage, caller-bound transport and unload/reload refusal.
Node/browser suites remain unrun during installation. Both new suites are registered
on the Installed application test registration card and in the platform command;
the focused command also retains the existing smoke, live-proof and installer checks.
All identities and HTTP endpoints in this command are disposable fixtures.

Installed packages can carry a [versioned test catalog](../docs/testing/package-test-catalog.md).
Declare every suite with its own runner, prerequisites and isolation; reference shared core suites
by exact commit instead of assuming the installation has a sibling developer checkout.

`npm run test:workspace-navigation` covers the optional top headings using real
Cockpit components, current profile synthesis and application authorization over
fixture HTTP. It checks custom iframe drafts/actions, independent theme preferences,
mobile and immersive layouts, stale discovery and first-install offline assets.
The **Cockpit workspace navigation** Lab card links its unit, integration and browser
suites; its live step only reads current admitted links. `npm run test:workspace-theme`
separately checks the selectable color skin and shared surface inheritance. These
commands use synthetic identities and pages, not live application records.

`npm run test:cockpit-startup` keeps the complete Cockpit head and boot scripts in
real Chromium, blocks external requests, and checks local Markdown, regular icon
glyphs, the Mesh screen, authenticated asset bytes and service-worker install/update.
It includes offline cached-asset proof, not offline application-data support. The
existing **Cockpit appearance** Lab card links the browser recipe; its live
stylesheet readiness check does not run Chromium. The remaining command cases
retain existing static-surface, cache-header and Lab-registration contracts.

`npm run test:data-model` covers the data-model explorer: the catalog fold and its parity with the
schema-docs generator, ownership over a real temporary source tree, the integration map, the
service cache, the page model, the Test Lab registration, a real catalog read from a disposable
PostgreSQL container, the operator gate over actual HTTP, and the page in Chromium. The fixtures
are temporary directories, a disposable database and fixture store ports; no deployment database,
graph, vector or cache store is read. The **Data model explorer** Lab card links these suites; its
live step only reads the current snapshot.

`node scripts/test-schema-alert-producer.cjs` runs the additional producer suites on that same Lab
card: normalized-input refusals and an actual policy removal in disposable PostgreSQL through the
schema classifier to one durable pending event. It also checks concurrency, restart, failed-write
rollback, retention and non-bypass-role RLS. The command also exercises detector cadence, shutdown
and retry, plus the real pending sweep and PostgreSQL ticket service to an approval-held ticket
and the same explorer diff in Chromium. Session identity, accelerated cadence/clock, empty app
inventory and fixed migration count are explicit fixture ports. No production policy, ticket,
provider or notification is touched.

The autonomous backlog suites have matching Lab registrations and local commands:

| Command | Coverage |
|---|---|
| `npm run test:authorization` | Principal identity, Users administration, installer root, authorization policy/API/tool/browser boundaries |
| `npm run test:nightly-isolated` | Fixed alert/topology and runner regressions in disposable PostgreSQL, retained reports |
| `npm run test:bot-initialization` | Fresh manifest runtime state, operator preservation and fixture HTTP dispatch |
| `npm run test:provisioning` | Saved setup, trusted sources, reviewed installs, retry and browser resume |
| `npm run test:specialist-context` | Package-owned facts, exact caller scope, signed dispatch and revocation/timeout refusal |
| `npm run test:briefings` | Registered sources, per-user preferences, frequency and delivery channels |
| `npm run test:vendor-login` | The vendor login seeding rail (Lab card **Vendor login seeding**): Codex / Claude / Google imports under the ADR-127 carve, what may leave the operator's machine, and where a Gemini turn runs once a sign-in has been pushed. No vendor endpoint is contacted and no browser login is attempted - the success path is the operator's own, by design. |
| `npm run test:linkedin-content` | LinkedIn Content Assistant queue workflow (Lab card **LinkedIn content queue — ticket to confirmed publish**): one `linkedin-content-post` ticket through the real registry, manifest-worker dispatcher and queue binding to an owner-scoped draft, approval, the 428 confirm gate and a confirmed publish on the caller's brokered token through the declared connector action. The draft joins its `connector_action_audit` rows by params hash and the outcome is written back to the ticket. Also covers retry idempotency through the real unique index, and the cross-owner, anonymous, missing-connection, provider-rejection, forged-ticket and pipeline-less-workflow denials. Runs against a disposable PostgreSQL with a NOSUPERUSER NOBYPASSRLS role and a local LinkedIn protocol double, never LinkedIn. |
| `npm run test:social-signals` | Social signal subscriptions (Lab card **Social signals — your watches reach only your bot**): bot binding, the cron's SYSTEM identity under deny-by-default, owner RLS on subscriptions and deliveries, the owner-only delivery audit, and one subscription producing exactly one event on its owner's Redis lane - proven against a disposable PostgreSQL with the non-superuser enforcing role and a disposable Redis. |

`npm run test:remote-authorization` (Lab card **Protected remote application execution**) includes
`tests/unit/guest-demo-seed-own-read.spec.ts`, the guard for the guest issuer stamp on demo tickets.
- **What it does.** It runs the real guest demo seeder against a stub pool, then reads the ticket rows the
  seeder wrote through the real signed guest chain.
- **What it checks.** The seeding guest reads those rows by id and in its list. Another guest is refused,
  and so is the same sub from another issuer.
- **What it is not.** The stub captures SQL, so this is not a PostgreSQL commit or RLS check. The in-memory
  store assigns its own ids and timestamps.
- **The gap it does not cover.** Demo tickets seeded before the stamp stay unstamped and refused. Their
  guests see demo tickets again only in a new guest session.

Docker-backed suites create their own temporary databases. Do not substitute a deployment DSN or
run the unrestricted historical unit collection against a live application database.

### Tree-walk default-runner isolation

`npm run test:unit` still discovers both original test trees, with no removed specs or new skips.
The three Tree-walk guards (`alert-incident-cutover`, `alert-incident-reopen`, `topology-traversal`)
run in the `tree-walk-postgres` project: one isolated fork, no file parallelism, in a later scheduling
group than `unit`. They already own disposable PostgreSQL instances; this partition prevents their
files from competing with one another or with the ordinary corpus in the same invocation. Other
database suites are not reclassified by this narrow change. Separate Vitest invocations still need
host resource coordination. Existing global/per-suite budgets and zero default retries are unchanged.

Database-free configuration/discovery proof:

```sh
node --max-old-space-size=128 node_modules/vitest/vitest.mjs run tests/unit/vitest-db-serialization.spec.ts tests/unit/autonomous-test-lab-registration.spec.ts tests/unit/nightly-isolated-runner.spec.ts --pool=forks --maxWorkers=1 --no-file-parallelism --execArgv=--max-old-space-size=384
```

The new guard uses the real Vitest resolver and file discovery, compares against the original full
collection, and checks exact membership, scheduler groups, worker isolation, budgets and retries.
It does not collect or execute the PostgreSQL specs. The existing Isolated nightly regressions Lab
card and fixed runner include this guard. Removing the database exclusion or its serial group must
make it fail. With an authorized disposable-container slot, `npx vitest run --project tree-walk-postgres`
runs the three actual database suites. That execution, a real scheduler-overlap receipt and the
backlog's three consecutive complete unit runs remain required; discovery proof alone closes none
of those runtime claims.

### Host-owned PostgreSQL test transport

[DisposablePostgres](./helpers/disposable-postgres.ts) keeps its existing Docker-owned default.
A separately coordinated Linux runner may opt into the
[owned transport](./helpers/owned-postgres-transport.ts) through the fixed read-only
`/contract/access.json` mount. This is not a deployment DSN option: inherited database configuration,
foreign/expired contracts, wrong server markers, populated databases and repeat claims are refused.
The fixture still creates real non-superuser/non-bypass roles and applies the actual migrations;
only the host that created the server removes it. An invalid opt-in never falls back to Docker.

The database-free guard exercises the actual transport and fixture control flow with explicitly
named filesystem, PostgreSQL-client and Docker collaborators:

```sh
NODE_OPTIONS=--max-old-space-size=384 node --max-old-space-size=128 node_modules/vitest/vitest.mjs run tests/unit/owned-postgres-transport.spec.ts --pool=forks --maxWorkers=1 --no-file-parallelism --execArgv=--max-old-space-size=384
```

It is discovered by the normal unit gate. Its results do not establish real database/RLS proof.
Real fixture receipts must separately identify the exact product/spec source, any test-helper
overlay, dependency and PostgreSQL images, enforcing role, actual assertions and owned cleanup.
Neither a transport guard nor a prepared host contract is a provider or installed-device result.

## Line coverage is measured, and the figure carries its scope

`npm run test:coverage` is the only place a coverage percentage for this repo comes from. It runs
`vitest` with `vitest.coverage.config.ts` and the `@vitest/coverage-v8` provider, prints the measured
statement/branch/function/line percentages, and exits non-zero when any of them falls below the
floors in `tests/coverage-scope.mjs`. Do not write a coverage percentage into prose, a README, a deck
or an ADR: run the command and quote what it printed, together with the scope it printed beside it.

The first scope is deliberately narrow so the gate can be held rather than admired:

| | |
|---|---|
| Source files measured | `src/shared/security/**/*.ts` - the security decision paths, every file in the glob whether or not a spec imports it |
| Specs that produce the figure | the explicit list in `tests/coverage-scope.mjs` |
| Floors that fail the run | the `COVERAGE_THRESHOLDS` block in the same file |

The figure is **not** a whole-tree number and must never be quoted as one. The command prints the
scope above and below the figure for exactly that reason. Widening the scope means adding globs and
specs to `tests/coverage-scope.mjs` and re-running the command to set the new floors from what it
reports - never from an estimate.

`tests/unit/test-coverage-gate.spec.ts` is the guard. It runs the real command - the real vitest
runner, the real `@vitest/coverage-v8` provider, the real config - and injects a breach through the
committed wiring rather than a CLI flag: `OSHAL_COVERAGE_FLOOR_OVERRIDE` raises a floor inside
`tests/coverage-scope.mjs`, so the failure has to travel that module, `vitest.coverage.config.ts`
and the runner to reach a non-zero exit. One run then proves four things - the figure is produced,
the scope is printed beside it, a breached threshold exits non-zero, and the floors this repo
actually commits to are met by that same measurement. Nothing outside the guard sets that variable.

### Seven experience UX

Run `npm run test:experience-ux` for the shared Home, Business and Classroom navigation/draft checks, Studio/Jarvis/Orbit/Commons selected-member context and hosted navigation, and the policy-backed complete composite assignment flow, including native application declarations and refusal of missing transitive component roles. These use isolated loopback fixtures and never grant installed accounts access, send to a live provider, or change member records. Auth-state coverage requires the verified issuer to remain authoritative even when the presentation user omits it. The same cases are registered in the Experience Test Lab scenario.

Source browser proofs are separate from signed-in installed acceptance. Installed checks assign one reviewed application composite role, which includes its required component roles automatically. The seven experience products and native Little Monsters publish complete required bundles; no component checkbox is needed. Existing school/household relationships and independently assigned access remain under their own applications.
