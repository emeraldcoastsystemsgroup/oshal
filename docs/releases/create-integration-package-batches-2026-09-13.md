# Create integration and package test batches

Create 1.7.0 uses the shared artifact exchange to open PNG, JPEG and WebP images
as editor layers. The existing owned upload, revision and save paths remain the
authority. Repeated handoffs import once; delayed imports cannot alter a different
project or a newer draft. The editor also publishes bounded project and selected
layer context through the shared surface bridge. This slice supplies context;
it does not grant Jarvis editing operations or implement regional regeneration.

The AI Test Lab adds **Run package suites** beside the application selector.
It reuses the current disabled package schedule and existing guarded Run now
service, creating a disabled selector when needed. Enabled or differently scoped
schedules require review and are not changed by the shortcut. Double clicks,
selection changes and uncertain request outcomes cannot silently create retries.
Unavailable browser/framework recipes remain visible in the batch summary.

Local source UX tests can also run in bulk:

```sh
npm run test:package -- --package ../oshal-applications/create --level browser --run --report temp/create-ux-results.json
```

The command reads the registered package catalog and runs supported Node,
TypeScript Node and Node-harness Chromium recipes serially. Without `--run` it
only lists the plan. Repeat `--package` for several packages or `--case` for
specific registered recipes. Unsupported adapters and prerequisites stay pending.
Cancellation and timeouts stop subsequent work, with bounded cleanup of owned
processes. This is source-checkout evidence, separate from installed Lab runs.
See the [execution contract](../testing/package-test-execution.md).

## Source verification

| Scope | Result |
| --- | --- |
| Host batch runner | 20 checks pass, including real Windows child/descendant cancellation and portable TypeScript execution. POSIX branches use injected operating-system ports. |
| Installed batch service/UI | 20 service, 16 actual Chromium and six exact HTTP asset/registration checks pass. |
| Create integration batch | Both registered recipes pass in one invocation: 12 context and 16 artifact checks. |
| Retained Create behavior | One existing composition, save/reopen and export browser case passes. |
| Core types | Both TypeScript projects pass; publication separately checks committed source. |

The Create browser fixtures exercise actual shared dispatch, Cockpit forwarding,
editor state and the bridge with synthetic HTTP data. Owned browser exit is
verified. The original stale-import, missing-context and delayed-script failures
are retained. Earlier fixture dependency and polling failures are retained
separately from the final passing commands. No real provider or business data
was used for these source checks.

The core **Installed application test registration** card links the host and
installed-batch regression suites. Create declares both new browser recipes in
its 18-case catalog. Registration and readiness alone do not execute a browser.
The new Lab HTML and fixed JavaScript route use private, no-store responses;
the existing service worker already passes `/api/` requests through, so this
change does not require a shell cache bump.

Local evidence: `temp/package-test-host-lifecycle-release.json`,
`temp/package-batch-release-receipt.json`, and
`temp/create-integration-batch-results.json` (SHA-256
`d5bebdca490ce0a5ec4d832a2e69119f3f1e4fb147a4ccca4b09c6530f68ff0d`).

## Publication and installation

Core `74f5c9e` and Create 1.7.0 at `21ea2f6` were published and installed.
The standard preview finished at 06:59 UTC with 35 healthy application containers
and clean parity. All 76 Create files matched the staged source; its previous
71 files were backed up before copy. Package activation loaded 79 applications
with no failures. The exact committed store archive passed 35 audit, catalog
and security-contract checks without overlays.

The first native **Run package suites** batch selected five installed Node
recipes. Create-new passed seven checks and Create-routes passed five;
Create-surface passed eight of nine. The surface failure was an outdated boot
order assertion after the artifact handoff was added. Editor-model was then
cancelled during fresh authorization/installed-source verification, and the
remaining recipe was deferred. The batch correctly remains failed/cancelled;
it is not a five-suite pass. Thirteen prerequisite-dependent recipes remained
unavailable. No provider or business records were manufactured.

Create 1.7.1 at `70536e2` corrects the surface assertion and checks that artifact
opening follows access resolution and starter permissions. All five registered
Node recipes now pass together locally: **58 checks**. Its complete 2,432-file
committed archive also passes all 35 store checks unchanged. Installation of this
patch and a new native batch are pending at this checkpoint.

A separate core correction scopes selected-application history and scheduled
batch authorization to that application. A real HTTP regression demonstrates
that a held unrelated application's access lookup previously produced 503;
selected-app history now completes while retaining fresh checks on both sides
of persistence. Wildcard batches still check all visible applications. This
reproduction does not establish the cause of the earlier installed cancellation.
All 14 affected HTTP, scheduled-owner and watchdog checks pass, including absent
and empty application filters and current-access revocation. Both TypeScript
projects and scoped lint pass. Existing Lab registrations already link these
specifications; `temp/test-lab-selected-app-release-receipt.json` records them.

The first rollout's strict preservation comparison remains **FAIL**. All original
15 infrastructure containers matched, but a concurrent local CI run added three
containers. Verified-principal hashes also changed, with `last_seen_at` the only
field difference between the supplemental and final captures; an earlier
cross-capture mismatch remains separately unattributed. Other installed packages,
business/private data, role assignments and audit records matched. These
differences are retained rather than exempted from the comparison.

Local receipts: `temp/create-batch-deploy-retry-exit.json`,
`temp/create-batch-lab-terminal-first.json`,
`temp/create-surface-access-order-release.json`,
`temp/create171-committed-family.json`, and `temp/create-batch-final.json`.
The previous CAD and report release remains documented in the
[prior acceptance record](report-briefings-cad-lifecycle-2026-09-13.md).

Regional AI regeneration, reviewed editing mutations, video timelines and full
Canva-style feature coverage remain open in Create's application backlog.
