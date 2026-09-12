# Parallel backlog release — 2026-09-11

Status: the initial core and three packages are installed; native acceptance and
the subsequent optional navigation release are in progress.

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
its new catalog. The two reviewed applications advanced authorization revision 74 to
76, retained 70 assignments and left the other 69 unchanged. Existing CRM history,
documents and all 37 preservation checks passed. A separately installed Scan to Print
package is being accounted for explicitly against the unchanged original baseline.

The native Lab Run control passed Capture's three deadline-input assertions with
verified sandbox cleanup. Portrait's native page and Lab visibility exposed an obsolete
legacy default-deny declaration blocking its valid named manager role. The package
correction is being verified through the real route mounter; final native acceptance
will follow its installation.

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
[application roadmap](https://github.com/emeraldcoastsystemsgroup/oshal-applications/blob/main/create/BACKLOG.md)
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
now uses existing complete profiles and current permissions; its deployment is pending.
The prototype dashboard remains a separate proposal.
All 40 prototype browser checks passed, including direct local-file opening, workspace
selection, keyboard entry, short mobile-drawer scrolling, themes and preserved edited drafts.

The requested Workspace skin uses the existing Cockpit theme settings and shared surface
tokens to provide paper backgrounds, white cards and indigo accents on the current layout.
It is the default when no theme is saved; existing choices and packaged application themes
remain available. All 107 focused checks passed across four files, including ten Chromium
cases over the real page components, theme selection and contrast, saved-choice restoration
before paint, transient application skins and actual service-worker precaching. Regressions
first reproduced an older stylesheet overriding a newer theme and missing offline assets.
Source and fixture types and scoped lint passed. Native acceptance remains pending. This
CSS work is separate from the optional top navigation and daily dashboard.

The optional **Top workspaces + sidebar** layout passed 50 HTTP tests over actual
profile synthesis and authorization, 14 real Chromium cases, four model cases and
one Lab registration assertion. Another 29 existing catalog regressions passed.
Tests preserve custom iframe drafts and actions, packaged themes, keyboard/mobile
navigation and current permissions; both new shell assets also work from the installed
service-worker cache. An iframe-focus menu race was reproduced and corrected.
Source and fixture types and scoped lint passed. These use isolated synthetic surfaces;
native application compatibility and release acceptance are recorded separately.

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
