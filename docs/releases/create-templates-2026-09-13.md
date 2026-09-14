# Create 1.6: editable image templates

Create now offers eight original designs with actual rendered previews,
search/category filters and independently editable text and shapes. Choosing a
template creates a new private draft. Cancelled replacement, dialog keyboard
use and raster paste preserve the underlying project. The existing theme
chooser, application colors and named project permissions remain in effect.

Open **Create → New → Image designs → Image templates**, or **Browse image
templates** inside Image editor. The standalone entry is
`/api/create/editor?templates=1`. The [product brief](https://github.com/emeraldcoastsystemsgroup/oshal-applications/blob/54c1e7890ee8352ba85e23ff9bfacdf2bbb1d2aa/create/PRODUCT.md)
records the requested “Canva but better” direction and bounded next milestones.

## Installed source and scope

- Public package source: `54c1e7890ee8352ba85e23ff9bfacdf2bbb1d2aa`, Create **1.6.0**.
- Deployed core remains `2739e2501f8f8919780c8c723dbfea4dd76eccd2` on image
  `sha256:e3b80133a6de8289f905b4211bd008ca0d9e2d2e262d94f78e8477334e1556fd`.
- The standard compatible installer produced a separate immutable stage.
  Only Create was copied after backup; staged dependencies were not activated.
  All **71 files** (70 source files plus installer stamp) match the published
  Git objects and sealed stage. The same API container restarted at
  2026-09-13T00:28:57.819865602Z and autoload registered Create 1.6.0.
- The authorization catalog is unchanged. No roles, assignments or audits were
  added or translated during this upgrade.

The previous manual-image foundation and its distinct evidence remain in
[Create 1.5](create-editor-2026-09-12.md). Later documentation commits do not
change this accepted installed source. Package security audit status remains
pending; compatible installation is not audit certification or main promotion.

## Validation

The release passes **37 new checks**: 13 template model cases and 24 real
Chromium template cases. All eight designs were rendered and exported, including
text-bound checks, independent copies, saved-original preservation, filtering,
keyboard/focus, mobile palettes, permissions/loading and URL conflict handling.
Two real before-fix regressions reproduced background keyboard/paste changes
through the open gallery; the corrected suite proves isolation and ordinary
editing after closing it. **93 retained checks** cover static/HTTP contracts,
editor workflows, launchers, shared themes and Scan-to-Print entry points.
Repeated checks are not added to these totals.

Scoped lint and independent review pass. Canonical Create route compilation
passes for all nine sources. A whole-store rebuild first compiled successfully
but refused synchronization because unrelated legacy D&D JavaScript has no
canonical source; the standard build tool was then applied to an isolated
Create copy and only its changed compiled route was synchronized.

The installed AI Test Lab registers **16 cases: 15 declared recipes plus
generated readiness**. Five suites launched through the signed-in native UI
passed **58 checks**, with exact source/catalog/execution/image attribution and
verified sandbox cleanup:

| Suite | Run | Checks |
| --- | --- | --- |
| New | `19fc07be-3004-4883-b4cc-499a3a4a4f6e` | 7 |
| Routes | `36b17b1f-7934-4a09-b41e-06c90df5ee30` | 5 |
| Home | `3027b9d0-5eee-4c24-be5e-afe1f828b2fd` | 9 |
| Model/history | `98a45c16-e244-498e-91c1-0b1aa3e9098c` | 24 |
| Templates | `25da9835-4f1c-4c6f-bbb1-d9e200703b84` | 13 |

The first Home attempt, `4885bbd9-19ad-4c84-bd18-50ac2c2af76c`, was automatically
cancelled with the service's generic access/source guard reason. It had no TAP
or image result; cleanup passed. The exact guard trigger is unknown. A new
native run passed; the cancelled checkpoint is retained rather than counted as
success. Browser/PostgreSQL/core-harness recipes remain registered with their
explicit prerequisites; these 58 installed checks do not imply those runners
executed inside the installed Lab.

## Native editing and preservation

Native Home → Browse templates → New showed the two distinct Image designs
entries. The first editor iframe request stalled and received an origin gateway
error. After recovery, the standalone gallery opened all eight previews. One
synthetic square-announcement project was renamed, its headline changed to
“Make something great.”, saved as revision 1, cleared from the canvas and reopened
through My projects. Native export downloaded a **1080 × 1080 PNG, 98,467 bytes**,
and **2,503-byte editable JSON with nine layers and zero assets**. The actual
PNG was visually inspected. The temporary project was deleted through the
normal UI and confirmation.

The loading incident affected internal health checks and the tunnel, with no
API restart or reported OOM. It recovered without intervention. This is
standalone editing acceptance after recovery, not uninterrupted embedded
acceptance or a resolved runtime bottleneck. Details remain in
[Cockpit startup resilience](../backlog/cockpit-startup-resilience.md).

A later native retry successfully opened Home → New → Image designs → Image
templates inside the cockpit, showing the actual eight-design gallery. This
separate recovered-launch check made no project selection or writes. Its receipt
is `temp/create-templates-native-embedded-final.json`; the earlier interruption
and standalone saved-project acceptance remain separately attributed.

Strict preservation at 00:39:50.599 UTC passed: all 71 Create files, 58 other
packages, 83 registry rows, 14 infrastructure containers, CRM/configuration and
all 35 healthy application containers. Authorization remains revision **79**
with **71 assignments and 79 audit events**, all unchanged. All four Create
project/asset tables contain zero rows after cleanup.

## Evidence and next track

Operator-local ignored receipts:

| Receipt | SHA256 |
| --- | --- |
| `temp/create-templates-native-acceptance.json` | `607f08a39bd0ec02fbcd72cc2dc66d9a8e1606164e2e196d088a673d52091610` |
| `temp/create-templates-native-lab-final.json` | `ae1f20b92cf9c339ebf581dee18d4af37c59f1ac74423ef858ce30f1b6b29010` |
| `temp/create-templates-preservation-final.json` | `5c6d22a073e79d80ee160dbc248c743c8b69b93d7f4d2b4ac04588907b2c15f8` |
| `temp/create-templates-native-loading-incident.json` | `f3964679f5eaf87835a2849dda70cfa94516b3e93612a88f2422878e29068887` |

The parallel [Video editor plan](https://github.com/emeraldcoastsystemsgroup/oshal-applications/blob/54c1e7890ee8352ba85e23ff9bfacdf2bbb1d2aa/video/EDITOR-PLAN.md)
passed an isolated existing-FFmpeg proof: real source trim/split/reorder/join,
timed title, mixed audio, decoded-frame validation, cancellation and cleanup.
Video's timeline UI, project storage and production export jobs remain open.
Selected-region AI changes, brand kits and complete generation/editing handoffs
also remain planned. No video editor, AI regeneration or full Canva parity is
claimed by this release. No GitHub Actions were invoked.
