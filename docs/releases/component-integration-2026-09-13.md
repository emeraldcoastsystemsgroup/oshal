# Reusable components and integration — 2026-09-13

Source checks, core deployment and the two package installations are complete.
Native acceptance is partial: Profile and a synthetic CAD preview were observed,
but Scan returned HTTP 502 and installed Lab checks remain pending. The strict
core-only preservation comparison failed on two control-table hashes whose
changes are not attributable from the saved baseline. Final verification is
pending. The earlier accepted daily dashboard is documented in its
[separate release](daily-dashboard-2026-09-13.md).

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

Published core `59f9c52eabbc240ac3227468e69d3a76d8451612` completed the standard
preview rollout with exit 0 at **05:35:06 UTC**. The final deployment census was
35/35 healthy app containers on image
`37b657896ce1cf7c8ac3dfa9d5c1d1d9148b487ab3db8f5fb4a6215a7862eabd`.
Infrastructure and the separate CAD engine were outside that app-fleet rollout.

At **05:36:34 UTC**, the package copy completed from published store commit
`c8010b419d1c4f291a2a525040c918d75be76d2c`: Scan 0.3.1 contains 97 exact files
and CAD 0.1.1 contains 45, **142 files total**. The prior package backup was
verified before copying. A subsequent API restart reported 79 applications
loaded and zero failed. The copy receipt itself does not perform the restart.

### Preservation result

The strict core-only comparison at 05:35:53 UTC is **FAIL**, retained in
`temp/profile-stl-core-only-preservation.json`. It reports changed full-row hashes
for `oshal_authorization_applications` and `oshal_verified_principals`.
Authorization revision **81**, **73 assignments** and **81 audit rows** remain
exact. The comparison also preserves the existing packages, private records and
infrastructure within that core-only checkpoint, before the later two-package
copy and native fixture work.

Both control tables retain their row counts and policy/security hashes, but the
baseline contains no per-field or row-identity hashes for these tables. The
source audit cannot establish whether the differences are timestamps, array
ordering, membership or another field. Do not attribute them to ordinary startup
or login activity, normalize the old receipt into a pass, or infer full
preservation from the unchanged authorization counts. The separate source audit
is `temp/profile-stl-control-table-source-audit.json`; attribution remains
unresolved.

The later final comparison, `temp/profile-stl-preservation-final.json` (SHA-256
`a3df65594c217a43e723149836a4f19c855fa35f8fee35c5266ac16de9bef4de`), also
remains **FAIL**. It records the other engine's concurrent Embodied 0.5 package
and registry update, a changed verified-principal hash, and creation of an empty
CAD data directory. The latter is only `present: false` becoming `true`: CAD
file count remains zero. Existing Scan files (12) and federal source files (797)
retain their hashes, and CAD model/revision tables are empty after cleanup.
The authorization-applications hash matches the original baseline in this later
snapshot; that does not explain or erase its earlier difference. Exact Scan/CAD
target files match their published source. No exception was added to turn these
raw comparisons into passes.

### Native observations and remaining checks

Native Chrome acceptance observed the compact Profile panel in Workspace and
Midnight, with the existing Settings link opening successfully. A synthetic CAD
box created through the ordinary UI showed revision 1, a blue solid and grid,
**12 facets and 60 × 40 × 30 mm** in the shared preview. Unsaved hole diameter
`6` and a draft label survived opening and closing Profile with the same part,
revision and geometry. No feature was submitted in that draft-preservation check.

The synthetic CAD part was deleted through the ordinary confirmation, and the
portal palette was restored to Workspace at **05:48 UTC**. These observations concern installed
CAD 0.1.1; the separately tested
[CAD 0.1.2 lifecycle and report-briefing work](report-briefings-cad-lifecycle-2026-09-13.md)
belongs to the next source checkpoint.

At **05:49 UTC**, the live Scan page returned HTTP 502 and recovered by 05:52.
Another API restart overlapped the first reconstruction/detail-refresh attempt.
The precise interrupted operation was not established. After reloading and
retrying, the three synthetic front/top/right photos produced a 60 × 40 × 30 mm
model, 55,296 facets, an engineering drawing and the shared WebGL preview.
**Open in CAD Studio** created a contour-derived revision 1 with the same
dimensions and a 12-facet CAD preview. The normal Delete confirmations removed
only these synthetic Scan/CAD records; the original two Scan jobs and six images
remained. Cleanup was confirmed through the UI and the final read-only snapshot.

The subsequent core `f4941d2b` checkpoint passed installed appearance,
workspace-navigation, shared-STL and catalog readiness, plus the CAD 0.1.2
engine-client recipe. Those later results are recorded in the
[follow-up release](report-briefings-cad-lifecycle-2026-09-13.md); they do not
retroactively execute the linked browser or Scan package suites here.
Intermittent origin/startup behavior remains tracked in the
[startup investigation](../backlog/cockpit-startup-resilience.md).

The deployment console, `temp/profile-stl-copy-receipt.json` and
`temp/component-native-acceptance.md` retain the local checkpoint evidence;
later native observations include the Workspace restoration and completed
Scan-to-CAD handoff above. The two native geometry screenshots remain in the
ignored `temp/workspace-polish-native-component-*` artifacts. Remaining linked
Lab suites retain their declared prerequisites. Preserve all earlier failed and
partial records.
