# Create image editor and local Cockpit startup assets — 2026-09-12

**Deployed and verified on the local preview.** Native editor acceptance, four
selected Lab runs and strict preservation passed. Earlier evidence retains its
actual source checkpoint.

Create 1.5.0 adds private layered image projects: text, shapes, freehand and images;
movement, resizing, crop, rotation, opacity and basic adjustments; layer ordering,
visibility and locking; undo, autosave and immutable saved revisions; and portable
JSON, PNG and JPEG export. Home and New open the real editor and saved projects.
Named project permissions and exact issuer-qualified ownership protect the API,
assets and export routes. This is the manual image-editing slice; selected-region
AI regeneration, masks, video editing and broader editor parity remain open.

Cockpit now loads Markdown and regular icon assets from fixed authenticated local
routes using locked marked 18.0.2 and Phosphor 2.1.2. The unused parent graph-library
CDN preload was removed; the actual Mesh screen remains functional. This closes the
blocking external startup-asset slice, not the separate database/startup-load backlog.

## Published and deployed checkpoints

- Core `2739e2501f8f8919780c8c723dbfea4dd76eccd2` deployed through the standard preview
  tool at 21:12:39 UTC on image
  `sha256:e3b80133a6de8289f905b4211bd008ca0d9e2d2e262d94f78e8477334e1556fd`.
  The bounded read-only check confirmed 35/35 healthy containers on that image,
  health HTTP 200, six exact locked asset hashes and six anonymous HTTP 401 responses.
- Initial Create 1.5.0 source `6a49721ea3b4e60f07d485bd75dd86fdfc2a6f4a` contained
  61 source files plus the install stamp. The portable-file loading correction was
  published at `8df99d58a384dbe0b183a7e70d60fb5381b18507` and installed from an exact
  62-file stage. Resolver dependencies stayed staging-only.
- Final corrective Create source `b92013b48d6f705138617b5816c7d49581a28257` is installed
  from `temp/create-editor-b92013b4-stage`. The 22:46:44 UTC activation receipt and
  22:48:27 detail check prove all 66 files exact, registry 1.5.0 active with NULL owner/
  tenant retained, all four migrated tables empty, authority revision 79 with 71
  assignments, and 35 healthy containers on the unchanged core image. The final
  source includes the import-read, readable-error, opaque-popover and bounded-write
  corrections. This bounded activation check is not final full preservation.

The first catalog activation correctly refused the old assignment with
`authorization_catalog_migration_required`; the registry remained 1.4.0 and project
tables were absent. The reviewed recovery uses the old registered catalog for a
normal Access Administration revoke, then activates the new catalog and grants the
same user's named `admin` role. The sealed final comparison verified exactly those
two audited changes and preserved all other assignments. A smooth reviewed catalog
upgrade workflow remains open under [AUTH-07](../backlog/enterprise-authorization.md).

## Native editor acceptance across the initial checkpoints

On source 6a49721e, the ordinary installed UI created a synthetic two-layer project,
saved revision 1, moved the text to Y=235 and saved revision 2. After the upgrade and
API restart to 8df99d58, Home's saved-project card reopened revision 2. Normal export controls downloaded a
1200 × 800 PNG (35,370 bytes) and a portable JSON file (642 bytes, two layers).
Still on 8df99d58, the project was deleted through My projects and its confirmation; the UI
returned to an empty project list. No image assets were uploaded and no provider
generation was invoked. The final b92013b4 increment follows; final database cleanup
is verified separately below.

The first JSON export attempt and one project-list request failed at the network
boundary; explicit retries succeeded. Those failures motivated the published readable
error correction and are retained rather than described as uninterrupted success.
The native sequence does not claim every editor control, JPEG export, upload,
camera, Safari or complete workflow coverage.

Export receipts: `temp/create-editor-native-png-receipt.json` and
`temp/create-editor-native-json-receipt.json`; the complete sequence was recorded by
the root native-acceptance lane.

## Final native acceptance at b92013b4

The actual native file picker imported the previous 642-byte portable project. The
installed editor saved it as a new two-layer project at 22:52:15.889 UTC. The opaque
My projects dialog reopened saved revision 1. Normal controls exported a 1200 × 800
JPEG (20,581 bytes) with the expected pixels and a 641-byte portable JSON file with
both layers and the text's Y=235 position retained. The project was deleted through
the ordinary button and native confirmation at 22:53:55 UTC; the final list was empty.
No raster assets were uploaded and no provider generation was invoked.

The exact-owner saved revision is recorded in
`temp/create-editor-final-native-project.json`; consolidated native actions and export
hashes are in `temp/create-editor-final-native-acceptance.json`. The empty-list screenshot is
`temp/workspace-polish-native-create-final-cleanup.png`. Final preservation
independently confirms all four project/revision/asset tables are empty. This
increment proves portable import, save, reopen, JPEG/JSON export and normal cleanup;
it does not claim every advanced editor interaction or linked Lab suite execution.

## Validation and limits

- Cockpit startup: 87/87 focused checks, including nine actual full-head
  browser/HTTP cases. The unchanged shell first failed to parse its body while an
  external CDN was held. Local assets, Markdown, icons, Mesh, offline cache bytes
  and the normal service-worker update path then passed.
- Final Create local validation: 163 distinct checks across 21 static/HTTP,
  32 retained browser, 24 model/history, 12 canvas-renderer, 24 editor UI,
  16 launcher, 20 backend and 14 authorization cases. The initial 150-check
  checkpoint and subsequent focused reruns are historical evidence, not additional
  checks to add to this total.
- The portable-read correction reproduced two failures before the fix; its complete
  editor UI suite then passed 17/17. These replace the earlier 15-case UI checkpoint,
  rather than representing an additional independent full-package run.
- The network-error/popover correction reproduced three HTTP/deadline failures and
  four opacity failures before the fix; the complete editor UI suite then passed
  24/24. The unchanged 20-second request deadline now yields readable retry guidance,
  and dialogs/menus use opaque palette surfaces. Real Daylight/Midnight optical
  checks vary the canvas behind them and verify unchanged interior pixels. This is
  local source proof, followed by the installed native increment above. Receipt:
  `temp/create-editor-native-errors-surfaces-release.json`.
- A separate real PostgreSQL fixture reproduced two concurrent owner writes failing
  when current authorization shared a two-client pool. The package now admits one
  write at a time per shared pool, with at most 32 waiting writers and a five-second
  queue deadline. Current authorization remains after queueing and before COMMIT.
  Four new concurrency/queue/revocation checks passed with the ten retained outer
  authorization cases (14/14); the twenty existing backend cases also passed.
  This local correction does not establish the cause of the separate native GET/
  export gateway failures or guarantee capacity for unrelated applications.
  Receipt: `temp/create-project-write-gate-release-receipt.json`.
- Final installed-source discovery records 14 Test Lab cases with no registration
  drift: thirteen declared recipes and readiness. The four Node cases were selected through
  the actual authenticated Test Lab UI and passed all 45 installed checks below.
  Browser, PostgreSQL and core-harness prerequisites remain explicit; these four
  runs do not represent native execution of those linked suites.

## Final native Test Lab runs

All four GUI-started runs passed on Create 1.5.0 source
`b92013b48d6f705138617b5816c7d49581a28257`, core
`2739e2501f8f8919780c8c723dbfea4dd76eccd2` and the pinned `e3b80133a6de` image.
The independent read-only reader verified exact current case/execution revisions,
the expected owner, terminal success and verified sandbox cleanup for every run.
There were zero failures, skips, cancellations or todos across 45 checks.

| Case | Run ID | Passed checks |
| --- | --- | ---: |
| `app:create:test:create-new` | `b2286091-91b6-4cdc-a8a9-5e8a148856a8` | 7/7 |
| `app:create:test:create-routes` | `07b3951d-2918-41d5-b99e-8c92b971f772` | 5/5 |
| `app:create:test:create-surface` | `8e933eb8-8ba8-487b-b69a-5a6eb2cf835c` | 9/9 |
| `app:create:test:editor-model` | `be4e04f3-1f02-499c-95a8-0049033e82a7` | 24/24 |

The receipt is `temp/create-editor-native-lab-final.json`, captured at
22:56:57.567 UTC, SHA256
`ffa3b5d3ec85c0b9158e2614db21e6755940a3599343c83c212d32bb0abc5dff`.
The corresponding UI evidence is `temp/create-editor-native-lab-dom.json` and
the exact selection is retained in `temp/create-editor-native-run-ids.json`.
These 45 installed checks are reported separately from the 163 local checks.

## Startup observations retained

The first full core boot logged three optional PostgreSQL stores falling back to
memory. A subsequent API restart positively logged PostgreSQL enabled for all three
at 22:16:00.613 UTC, with zero corresponding fallback events in that boot. These
unchanged initialization paths and the other classified boot advisories remain
separate from the local-asset fix. The fresh restart receipt is
`temp/create-editor-api-restart-readonly.json`; it intentionally records the earlier
catalog refusal and is not a final all-package acceptance receipt.

The final API start at 22:46:12 UTC again enabled all three PostgreSQL stores
without fallback. One later loopback health request timed out at ten seconds;
the bounded follow-up returned HTTP 200 with 35 healthy containers. Both outcomes
remain in `temp/create-editor-activation-b92013b4-detail.json`. The separate
[startup-delay investigation](../backlog/cockpit-startup-resilience.md) remains open.

## Final preservation — passed

The unchanged sealed helper passed at 22:54:50.439 UTC against
`temp/create-editor-preservation-prepared-b92013b4.json`. The final receipt is
`temp/create-editor-preservation-final.json`, SHA256
`a00afc578c1cd46ed784831384b22a4157797739db1487b1bf0d2e39dd954844`.
The immutable before snapshot is SHA256
`a82987913078695c701739ee176efa65211f79c448b7ee2c4ab73973e07e5738`.
The comparison proves 66 exact final Create files, all other 58 packages and all
83 registry rows under the permitted Create-version change, retained NULL package
ownership, all 14 infrastructure containers, CRM records/decisions, 476 unchanged
environment values and 39 mounts. All 35 application containers are healthy on the
pinned core image. Authorization is revision 79 with 71 assignments: exactly the
reviewed revoke/grant, 70 unrelated assignment hashes unchanged and all 77 prior
audit events retained. All four new Create tables exist and contain zero rows;
no project or asset IDs were admitted as retained acceptance data.

The helper's 28 pure refusal/acceptance checks and independent review passed before
the final live read-only comparison. Package security audit
status remains pending, and local preview deployment is distinct from merging the
branch to main. No GitHub Actions or provider generation are part of this release.
