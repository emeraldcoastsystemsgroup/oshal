# Reusable components and integration — 2026-09-13

Source checks below have passed. Publication, installation and native acceptance
are recorded below only after completion. The earlier accepted daily dashboard is
documented in its [separate release](daily-dashboard-2026-09-13.md).

## Delivered source

- Profile & Access uses one compact themed panel, consistent existing account and
  Settings actions, bounded session loading, truthful Retry and keyboard/focus
  lifecycle. Opening/closing preserves the current application. Settings continues
  its existing navigation lifecycle.
- Workspace discovery stops calling further registry/authorization/profile ports
  after a disconnected client. Existing in-flight work may finish; this is not SQL
  cancellation or a diagnosis of all origin stalls. Current connected-user policy
  checks remain intact.
- Scan 0.3.1 retains the previously tested multipart identity and output-freshness
  guards while incorporating 0.3.0 contours/CAD integration. Pending CAD handoffs
  retire on input, job or output changes; late responses cannot navigate away.
- Scan and CAD 0.1.1 use one versioned core STL viewer through thin adapters.
  CAD's copied shader and first-frame defects were reproduced independently before
  extraction. Geometry engines, artifacts, ownership and history remain in their
  owning applications. Upgrade core before these packages.
- The [reuse inventory](../apps/reusable-components.md) directs authors to existing
  tools, UI components, artifact exchange and registered integrations. This preview
  component does not implement the separate Embodied physics workstream.

## Evidence and limits

| Lane | Source evidence | Limits |
| --- | --- | --- |
| Profile | 19 new actual-renderer cases and 17 retained appearance cases accepted across scoped runs; types/lint pass | Earlier failed runs are retained; final acceptance includes a targeted two-case rerun, not a claim of one all-green combined run. |
| Discovery | 13 new real HTTP lifecycle cases plus 28 retained authorization cases pass | Controlled policy/registry ports; no live database load benchmark. |
| Scan merge | 95 Node/HTTP checks plus 7 retained Chromium cases pass; all 33 canonical compiled modules match; 14 Lab cases, including 9 dependency-free Node recipes | DOM/HTTP/CAD/printer ports are explicit doubles where stated; installed workflows are separate. |
| Shared preview | 16 real WebGL cases pass for both actual pages; original shader and initial-draw defects reproduced | Finite input and bounded grid checks included; earlier cleanup failure retained, final owned browser exited gracefully. No CAD-kernel or physical printer claim. |
| Core integration | 42 Lab catalog/readiness cases and 53 asset/surface cases pass; both TypeScript projects and scoped lint pass | Readiness is distinct from running linked application suites. |

Profile and workspace suites are linked under their existing AI Test Lab cards.
The shared viewer has its own fixed-asset readiness card with its executable
browser regression linked. Running these core cards checks readiness; it does not
execute the linked browser suites. Scan package cases use the existing installed
test-catalog runner and retain their declared prerequisites.

Ignored receipts retain exact source hashes, commands, failures and owned-process
cleanup: `temp/cockpit-profile-release-receipt-v2.json`,
`temp/workspace-discovery-cancellation-release.json` and
`temp/scan-merge-031-release-receipt.json`. Screenshots and user data stay local.

## Publication and installed acceptance

Pending. Capture a fresh preservation baseline after the separately installed
CAD engine and CAD authorization revision; the earlier daily-dashboard baseline
does not describe this runtime. Preserve other applications, the active Embodied
workstream and existing business records. Compare registry stable fields and its
loader timestamp separately from the outset. No result from an older baseline
may be rewritten into a current pass.
