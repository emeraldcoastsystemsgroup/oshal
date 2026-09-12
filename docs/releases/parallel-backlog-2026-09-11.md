# Parallel backlog release — 2026-09-11

Status: the core and three packages are installed. Native acceptance passed for
the skin, optional navigation and selected application workflows. The final
navigation startup-timeout correction is deployed and preservation checks passed.

The final combined platform run passed 299 of 300 cases across 27 files. Its sole
failure was the test runner's default five-second outer budget on a real disposable
container case. Giving that test the same explicit outer allowance as adjacent cases
passed all 16 affected runner tests, retaining the existing 30-second execution and
five-second authority limits. All 300 distinct cases are covered across those logs;
this is not a claim of one 300/300 run. Earlier scheduler failures, connection reuse
and bounded startup retry regressions, and the original failed reports are retained.

Core 26fe11ea was deployed through the standard preview process with all 35 application
containers healthy and 14 infrastructure containers preserved. A separately coordinated
release then advanced the serving core to 8a88d33e. Portrait 1.14.0, Sales 1.20.0 and
Capture 3.2.0 were installed from immutable stages; all 412 staged files matched.
The native Access workflow refreshed the existing Portrait manager assignment against
its new catalog. The two reviewed changes advanced authorization revision 74 to
76, retained 70 assignments and left the other 69 unchanged. Existing CRM history,
documents and all 37 preservation checks passed. A separately installed Scan to Print
package is accounted for by its exact source and file receipt against the unchanged
original baseline.

The native Lab Run control passed Capture's three deadline-input assertions with
verified sandbox cleanup. Portrait's native page and Lab visibility exposed an obsolete
legacy default-deny declaration blocking its valid named manager role. Portrait 1.14.1
removes that obsolete declaration while retaining the unchanged named catalog. The
real route-mounter regression reproduces the original refusal; all 16 HTTP and 13
browser cases pass after correction. The installed 1.14.1 catalog now exposes all
eleven registered cases. Its genuine Lab Run passed the four sealed model assertions
with verified cleanup, pinned to public source `2e10bbb6`.

Native Federal CRM reads retain the existing pipeline and imported research, and its
Activities and Calendar pages open normally. The deadline review exposed a presentation
defect: its wrapper did not use the mature application's modal class, leaving the form
outside the visible area after opening scrolled research. Capture 3.2.1 now uses the
existing dialog styles. All three actual-CSS desktop/mobile browser cases passed.
Native review from the scrolled history showed the complete dialog, a blank required
date/time chooser and Cancel. Cancel closed it without creating a task. Its current
Lab Run passed all three deadline-input assertions with verified cleanup, pinned to
private source `3b64b33c`; Sales remained 1.20.0.

The current native installer report returned 41 registered cases: one smoke passed,
two require a caller-owned PAT, and 38 suites were not run by installation verification.
Hello has no declared installation smoke and remains pending. All reported IDs,
revisions, versions and canonical Lab links match the captured 242-scenario catalog.
HTTP 200 reports a successfully completed report, not a claim that pending checks ran.

The standard core preview at `dd7bcaa402d7074122db85a322d1cf785ded1776`
completed with all 35 application containers healthy and matching image
`sha256:b568aa193af92e3c1ca1ac1abde10e304acca71878f3c59584a8a72767503353`.
Strict comparison preserved all 14 infrastructure containers, 11 configuration
hashes, 59 installed packages, 412 staged package files, authorization revision
76 with 70 assignments, 107 imported CRM records and 512 documents. All 37 CRM
preservation checks passed; 476 environment values and 39 mounts were unchanged,
with only the expected build commit value changing.

The first attempt was blocked by an independent nightly diagnostic's live database
dump holding a table lock needed by startup permission setup. Both new and rollback
images waited before listening. Cancelling that exact diagnostic query released
the lock; the previous API recovered, and the standard deployment retry passed.
The cancelled diagnostic incorrectly claimed success from a partial restore.
Its original output was preserved and its generated result marked incomplete.
The release backups and comparison baselines were unchanged. The diagnostic's
completion/error handling and coordination with deployment are separate backlog work.

## Scope

Three independent lanes share one reviewed release:

- Installation verification links smoke outcomes to the installed application's Test Lab
  case IDs, revisions, coverage and suite counts. Only eligible declared smokes run during
  verification; other suites remain registered for separate execution. Pending capability
  is reported as pending, and mandatory safe failures prevent verified success.
- The owning private CRM packages add reviewed deadline follow-ups for imported history
  already linked to a canonical CRM record. Existing source dates remain historical;
  a user chooses a due time and reason before applying a deduplicated deadline activity.
  Source ownership, workspace membership and current activity permissions still apply.
- Portrait Studio adds a bundled browser-local fallback for finding frontal faces. It
  retains manual boxes, cancels stale detection work and requires existing view permission
  for each fixed detector asset. Images do not leave the browser for detection.

Create's larger editor request is documentation only in this release. Its
[application roadmap](https://github.com/emeraldcoastsystemsgroup/oshal-applications/blob/15f17f88f09a5a99888def5e21c1172156b9c04e/create/BACKLOG.md)
separates page layout, durable projects, basic image and video editing, region-directed
regeneration, editor handoffs and advanced editing. Implementation and executable cases
will be registered in the phase that supplies them.

The [Jarvis daily dashboard request](../backlog/jarvis-daily-dashboard.md) is also backlogged:
one compact page, grouped application updates, clear assistant controls and supported
context-aware detail/draft actions. Reported visual and delivery defects still require
reproduction; this release does not implement that redesign.

The [workspace navigation prototype](../mockups/cockpit-workspaces.html) explores curated
top-level tabs, direct Learning entry into Little Monsters, persistent supporting navigation,
per-workspace themes and compact Jarvis context. It uses synthetic content and performs no
live operations. The [optional navigation implementation](../backlog/cockpit-workspace-navigation.md)
now uses existing complete profiles and current permissions; the Career-slot
release passed deployment and native entry at `dd7bcaa4`. Final acceptance of
the 30-second discovery correction is recorded separately.
The prototype dashboard remains a separate proposal.
All 40 prototype browser checks passed, including direct local-file opening, workspace
selection, keyboard entry, short mobile-drawer scrolling, themes and preserved edited drafts.

The requested Workspace skin uses the existing Cockpit theme settings and shared surface
tokens to provide paper backgrounds, white cards and indigo accents on the current layout.
It is the default when no theme is saved; existing choices and packaged application themes
remain available. The initial 107 focused checks passed across four files, including ten Chromium
cases over the real page components, theme selection and contrast, saved-choice restoration
before paint, transient application skins and actual service-worker precaching. Regressions
first reproduced an older stylesheet overriding a newer theme and missing offline assets.
Source and fixture types and scoped lint passed. Native acceptance exposed an additional
embedded-chat compatibility defect: chat's old theme list normalized Workspace to
Midnight and wrote that inherited value into the global preference. Chat now supports
Workspace and keeps inherited appearance separate from the saved global preference.
The real-frame regression reproduced the original defect; all 114 focused theme cases
pass, including six new actual chat browser cases and their Lab registration check.
The original Daylight preference was restored through the native Settings control. This
CSS work is separate from the optional top navigation and daily dashboard.

The optional **Top workspaces + sidebar** layout passed 50 profile/authorization
cases (including 28 new navigation HTTP cases), plus 18 real Chromium cases,
four model cases and one Lab registration assertion. Another 29 existing catalog regressions passed.
Tests preserve custom iframe drafts and actions, packaged themes, keyboard/mobile
navigation and current permissions; both new shell assets also work from the installed
service-worker cache. An iframe-focus menu race was reproduced and corrected.
Source and fixture types and scoped lint passed. These use isolated synthetic surfaces;
native application compatibility and release acceptance are recorded separately.

Native navigation at core `9c5985ed` opened Little Monsters, Create and the installed
Career application through canonical profile links. Little Monsters and Create kept
their packaged themes; the saved Daylight preference was unchanged. Switching the
navigation off and back on retained Create's exact iframe and document. Workspace
selection now agrees across the shell, saved preference and embedded chat; selecting
Daylight restores all three. Current discovery returned 33 authorized destinations
with `Cache-Control: private, no-store`.

The installed Career app uses `career-hunter`; the separate `intelligent-career`
group was not admitted in that snapshot. The final curated slot prefers the admitted
group and otherwise uses the admitted app. Both new browser regressions first failed
and then passed with the full 21-case browser/model/catalog command. This does not
install, admit or invent the missing group.

The two selected native package runs are `69bf258d-6e7b-4444-9bea-b5511add0df6`
(Portrait, four passes) and `41ea834c-3dbd-485e-b81a-3b049c540d2e`
(Capture, three passes). Their durable terminal records confirm exact package source,
catalog/execution revisions, zero skips and verified cleanup. They ran on core
`9c5985ed` / image `sha256:20ba2e72fd2647e767b9386f9e1dbb911753be519c874bdf3e676d3e3ae96559`.
The original Capture 3.2.0 run remains historical and correctly stale.

A Windows passkey prompt temporarily interrupted native acceptance after an
accidentally opened bookmark. It timed out and its error screen closed normally;
no credentials were entered. Native acceptance then resumed on `dd7bcaa4`.
Portrait's actual device picker loaded the licensed astronaut test fixture, and
Group → Find faces produced one reviewable face box using the bundled fallback
with no native FaceDetector available. The page and saved preference remained
Daylight; generation was not requested. The temporary photo was discarded when
leaving the page.

At the `dd7bcaa4` checkpoint, the actual top Career link opened
`/cockpit/?app=career-hunter` and its existing Job Board.
An authenticated static-asset read matched the committed navigation
script's complete 13,430 bytes and SHA-256. This final check also reproduced a
five-second discovery timeout: initial server lookups completed in 18.91 and
6.03 seconds, while subsequent reads took under 1.2 seconds. The bounded 30-second
window passed the full 23-case browser/model/catalog command. Both added Chromium
regressions first failed with the old limit: a valid response after 19 seconds now
completes, while a hung request fails at 30 seconds and Retry admits fresh links.
Drafts and iframe identity remain intact. Current permissions, cancellation and
uncached discovery are unchanged.

The native Lab Run controls also passed **Cockpit appearance** and **Cockpit
workspace navigation** on `dd7bcaa4`. Their results respectively confirm the fixed
Workspace stylesheet and 33 current authorized destinations. These read-only
readiness checks expose the linked regression suites; they do not execute those
browser suites or create application records.

Final standard deployment of `ee2bf11cc79d8a7f2272087b633184e811899faf`
completed on image
`sha256:5156fa8735b64c05b30b8b033fbacf0b013f685a38439aee625b313b0a19121c`.
All 35 application containers were healthy with matching images. A new strict
comparison passed against the original baselines: the same infrastructure,
configuration, packages, grants, CRM history/documents, environment values and
mounts described above were preserved. The earlier receipts were not overwritten.
After the rollout settled, fresh native navigation from Cockpit through the top
Career heading opened the existing Job Board with Career selected. Discovery
returned 33 destinations, the shell and chat retained Daylight, and the saved
preference was unchanged. The authenticated navigation asset matched all 13,619
committed bytes and SHA-256
`c2e95e449452610b887ef85af972d798195f5ed38be6d3701fa8b04d8626d7bc`.

## Release requirements

The source checkpoints must pass their focused behavior suites, existing regression
coverage, catalog validation and publication gates. New executable suites must be
registered with the existing Lab and local commands. Package manifests, marketplace
versions, audit metadata and package documentation must agree.

Native acceptance must identify the serving core commit and image, installed package
versions and case identities. A before/after comparison must preserve unrelated packages,
infrastructure, runtime configuration and existing business records. Any necessary
authorization catalog migration must have an explicit reviewed change and evidence of
the user's resulting application access; an obsolete grant cannot silently gain a new
meaning. No GitHub Actions are used.

## Remaining product work

Deadline conversion without a canonical linked CRM record, website-origin intake and a
unified decisions/obligations dashboard remain in the
[CRM backlog](../backlog/government-contracting-crm.md). Test Lab's broader package
adoption and confined fixture support remain in the
[registration backlog](../backlog/app-test-lab-registration.md). Create's advanced editor
work remains deferred.
