# Parallel backlog release — 2026-09-11

Status: implementation and isolated verification in progress. This record does not yet
establish installation or native acceptance of the changes below.

The first combined platform run passed 296 of 298 tests across 27 files. Two existing
scheduler cases failed: a completed-result watchdog case did not finish within its fixture
deadline, and an assertion-failure run was recorded as cancelled. Deployment remains pending
repair and revalidation; the original evidence is retained. A bounded isolated diagnostic
reproduced a schedule heartbeat failing after 504 ms because the disposable PostgreSQL pool's
500 ms connection allowance elapsed. The scheduler correctly refused to continue. Fixture
connection reuse is being corrected without extending acquisition or authorization deadlines.
The 17 new installation-verification cases passed. Retained fixture connections and a real
idle-session regression then passed all 18 scheduler cases. The subsequent combined run
passed 297 of 299 tests: one fixture failed to establish its initial connections, and one
source-change case could not confirm sandbox cleanup. Both original failure reports remain
retained; deployment is still pending combined verification. The separately coordinated
Git-history rewrite has finished with source trees unchanged. The fixture now retries only
that exact transient connection-startup error, before
its HTTP server or sandbox exists, with at most three attempts and unchanged per-attempt
deadlines. A new recovery regression failed against the preceding fixture, then all 19
scheduler and seven browser cases passed together; strict fixture types and lint passed.
The source-change cleanup case passed an unchanged isolated diagnostic. Its earlier cleanup
failure remains unexplained and is retained for the next combined run. No application package
or live authorization has changed during this investigation.

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
live operations. [Workspace implementation](../backlog/cockpit-workspace-navigation.md)
remains backlogged; the prototype does not change the deployed Cockpit.
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
CSS work does not implement the proposed top navigation or daily dashboard.

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
