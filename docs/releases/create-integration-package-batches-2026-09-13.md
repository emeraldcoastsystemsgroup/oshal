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

Create source is committed at `21ea2f6`; publication, core rollout and Create
installation are pending at this checkpoint. The previous installed core,
CAD and report release remains documented in the
[prior acceptance record](report-briefings-cad-lifecycle-2026-09-13.md).

Regional AI regeneration, reviewed editing mutations, video timelines and full
Canva-style feature coverage remain open in Create's application backlog.
