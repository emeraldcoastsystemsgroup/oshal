# Test organization and registration

## LoRA gallery producer boundary

`npx vitest run tests/unit/lora-cell-thumbnails.spec.ts` executes the shipping Python validator
against a loopback receiver. Only ComfyUI rendering and CLIP scoring are fixture ports; real PNG
files are encoded and posted as bounded JPEG thumbnails after the scorecard, with matching cell
filenames and owner headers. Python and Pillow are required, and all output stays in the fixture's
temporary directory. This is not a live GPU run. The store's `lora/tests/test-lab.yaml` separately
registers actual package HTTP, forced-RLS disposable PostgreSQL and Chromium pixel/expiry/deletion
acceptance; run its documented `lora/tests/gallery.config.mjs` command from the store checkout.

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

Suites that own a fixture browser through `tests/fixtures/isolated-browser.ts` set their hook timeout
from the fixture's own `BROWSER_HOOK_TIMEOUT_MS`, so the runner's hook deadline can never fire before
the fixture reaches a verdict about the browser process. The fixture gives that process one exit
budget - 45 s by default, raised for a slower host with `OSHAL_FIXTURE_BROWSER_EXIT_TIMEOUT_MS` - and
a browser that misses it still fails the suite by name. `tests/unit/isolated-browser.spec.ts` guards
both halves, including against a real headless Chromium.

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
| `npm run test:social-signals` | Social signal subscriptions (Lab card **Social signals — your watches reach only your bot**): bot binding, the cron's SYSTEM identity under deny-by-default, owner RLS on subscriptions and deliveries, the owner-only delivery audit, and one subscription producing exactly one event on its owner's Redis lane - proven against a disposable PostgreSQL with the non-superuser enforcing role and a disposable Redis. |

Docker-backed suites create their own temporary databases. Do not substitute a deployment DSN or
run the unrestricted historical unit collection against a live application database.

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
