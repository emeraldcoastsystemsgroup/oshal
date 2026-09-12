# Parallel backlog release — 2026-09-11

Status: implementation and isolated verification in progress. This record does not yet
establish installation or native acceptance of the changes below.

The first combined platform run passed 296 of 298 tests across 27 files. Two existing
scheduler cases failed: a completed-result watchdog case did not finish within its fixture
deadline, and an assertion-failure run was recorded as cancelled. Deployment remains pending
diagnosis; the original evidence is retained. The 17 new installation-verification cases passed.

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
