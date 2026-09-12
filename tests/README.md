# Test organization and registration

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

The autonomous backlog suites have matching Lab registrations and local commands:

| Command | Coverage |
|---|---|
| `npm run test:authorization` | Principal identity, Users administration, installer root, authorization policy/API/tool/browser boundaries |
| `npm run test:nightly-isolated` | Fixed alert/topology and runner regressions in disposable PostgreSQL, retained reports |
| `npm run test:bot-initialization` | Fresh manifest runtime state, operator preservation and fixture HTTP dispatch |
| `npm run test:provisioning` | Saved setup, trusted sources, reviewed installs, retry and browser resume |
| `npm run test:specialist-context` | Package-owned facts, exact caller scope, signed dispatch and revocation/timeout refusal |
| `npm run test:briefings` | Registered sources, per-user preferences, frequency and delivery channels |

Docker-backed suites create their own temporary databases. Do not substitute a deployment DSN or
run the unrestricted historical unit collection against a live application database.
