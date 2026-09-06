# ADR-141 — Application groups: one YAML binds installed apps into a themed front door with a setup dashboard

**Status:** Accepted — stage 1 built 2026-09-05 (operator: *"let's take this to completion tonight"*).
Operator direction 2026-09-05 (*"we are taking like 6 applications and binding them together and setting
a toolbar … we need a way to define that outside the swarm directory … I guess it's a yaml"*). Core
ships the kind, the borrowed-surface resolver, `readiness:`, the shared dashboard and the verifier
pass-through; the store ships the Intelligent Career group and its members' readiness probes. See
"What is built" at the end. D7 (a story per role) stays a career-hunter BACKLOG item.

**Date:** 2026-09-05

**Related:** [ADR-085](085-remote-app-packages-and-registries.md) (one app, one package; D11 global surface names),
[ADR-097](097-app-suites-primary-categorization.md) (suites are a shelf, never a re-bundle — "meta-manifest
listing app packages"), the ribbon-groups addendum in the career-hunter package (`group:` on `ui.static[]`),
[ADR-139](139-artifact-exchange-send-to-registry.md) (Send to…, the rail that moves a document between
member apps), [ADR-135](135-print-to-swarm-and-print-to-rag.md) (print intake), [ADR-113](113-switchboard-aggregation-surface-and-workspaces.md)
(Social/Switchboard), [ADR-036](036-bot-owned-application-architecture.md) (the bot owns the domain; the
surface is a view), [ADR-137](137-deploy-modes.md) (posture).

---

## Context

The operator described what a real **Intelligent Career** front door has to do for a new user: upload a
resume, take a profile picture, connect Facebook, choose the articles to comment on, hold a back-and-forth
review of the resume where every bullet — or at least every job title — gets a story, upload performance
reports or any other document, subscribe to the print service and accept printed documents, and see all of
that as one connection-status tab. That is six installed applications (career-hunter, portrait-studio,
social, print-ingest, the connections hub, and the artifact exchange between them) presented as **one
application with one toolbar**, defined outside the kernel's `swarm-apps/` directory.

Almost every piece exists as a package feature already. What does not exist is the binding:

| Need | As built today | Gap |
|---|---|---|
| Compose several apps into one front door | **Launcher packages** (`system`, `games`, `concierge`): a manifest with no code whose `ui.static[]` tiles point at other apps' `iframeUrl`s by hand; the **themed subdomain map** (`HOST_APP_MAP`, `career.oshal.ai=career-hunter`) lands a hostname on one primary app | tiles are copied URLs, not references — nothing checks that the member app is installed, and a renamed surface breaks silently |
| Say which apps belong together | `dependencies.apps` (career-hunter → portrait-studio), resolved npm-style by the installer | only used for install ordering and the reverse-dependency uninstall guard |
| Per-app readiness | package `smoke:` probes (service-authenticated, install-time, "is the package operational"); per-app **per-user** state routes (`/resume/state`, `/settings/state`, `/automation/state`, `/title-profile/state`, the connections hub) | no schema for *per-user* readiness, so nothing can render "what this person still has to set up" |
| A setup / connection-status page | none | every launcher would hand-write its own |
| Move a document from one member app to another | ADR-139 Send to… (stage 3 shipped: Ingest to RAG, Summarize; Email; Save) | career-hunter declares no `artifacts:` block yet, so "print → career materials" is one registration away |
| Define groups outside the kernel | the store repo already installs any `git-subdir` source | a group has no manifest kind, so today it can only be smuggled in as a launcher app |

ADR-097 settled the principle: **a suite is metadata, a physical mega-package is rejected, and if
suite-install is ever wanted it is "a meta-manifest listing app packages — not a re-bundle."** This ADR is
that meta-manifest, made first-class and given the one thing every group needs and no launcher has: a
setup dashboard.

## Decision

### D1 — A group is a manifest kind, and it carries no code

A group is an `oshal-app.yaml` with `kind: group`. It ships in the applications store like any package,
with `name`, `displayName`, `suite`, `theme`, `source`, and `dependencies.apps` (its **members**, all of
which must be installed and active before the group activates — the installer already resolves that list).
It has no `bots`, `tools`, `routes`, `migrations`, or `engine`. A group that declares any of those fails
the load: composition is its whole job. It may carry one thing of its own — a `ui/<theme>.css` skin, as
packages already can.

```yaml
name: intelligent-career
kind: group
suite: ai-knowledge
displayName: Intelligent Career
theme: daylight
dependencies:
  apps: [career-hunter, portrait-studio, social, print-ingest]
toolbar:                                   # D2 — borrowed by app + surface name
  - { app: career-hunter, surface: career-board }
  - { app: career-hunter, surface: career-search, group: Job Search }
  - { app: career-hunter, surface: career-resume-studio, group: Resume }
  - { app: career-hunter, surface: career-strengthen, group: Resume }
  - { app: portrait-studio, surface: portrait-studio, group: Presence }
  - { app: social, surface: social-linkedin-assistant, group: Presence }
  - { app: print-ingest, surface: print-inbox, group: Documents }
  - { app: career-hunter, surface: career-settings, section: bottom }
setup:                                     # D3/D4 — the dashboard is rendered from this
  - { label: Upload your resume, app: career-hunter, readiness: resume, fix: career-resume-studio }
  - { label: Profile picture, app: portrait-studio, readiness: portrait, fix: portrait-studio }
  - { label: Connect Facebook, app: social, readiness: facebook, fix: social-accounts }
  - { label: Articles you want to comment on, app: social, readiness: signals, fix: social-signals }
  - { label: Review your resume story by story, app: career-hunter, readiness: stories, fix: career-strengthen }
  - { label: Add performance reports and other documents, app: career-hunter, readiness: materials, fix: career-settings }
  - { label: Subscribe to the print service, app: print-ingest, readiness: subscription, fix: print-inbox }
```

### D2 — Toolbar tiles are borrowed by reference, and the loader resolves them fail-closed

A `toolbar[]` entry names a member **app** and one of its **surfaces** (`ui.static[].toolName`, which
ADR-085 D11 already makes globally unique). At activation the loader looks the surface up in the member's
loaded manifest and copies its label, icon and `iframeUrl` into the group's synthesised ribbon profile —
the same `synthesiseProfile` output the cockpit renders today, so **the cockpit needs no change to show a
group**. A tile whose member is not installed, or whose surface no longer exists, fails the group's
activation with the member and surface named; it never renders a dead tile. `group:` and `section:` on a
toolbar entry mean what the ribbon-groups addendum says they mean.

Borrowing is a reference, not a copy: when the member app upgrades and its surface's URL moves, the group
follows on its next profile synthesis. That is the defect launcher packages have today and this removes.

### D3 — Member apps declare per-user readiness the way they declare smoke probes

A package may declare `readiness:` entries — the per-user sibling of `smoke:`:

```yaml
readiness:
  - name: resume            # referenced by a group's setup[].readiness
    path: /api/career-hunter/resume/state      # GET, session-authenticated, below this package's own mount
    readyPointer: /indexed                     # RFC 6901 into the JSON: true = done
    detailPointer: /summary                    # optional one-line status for the dashboard
```

The probe runs **as the signed-in user** (never with the service secret, never a PAT), because readiness
is a fact about a person — "your resume is indexed", "your Facebook is connected" — and it must live below
a route the same manifest declares, exactly like smoke. career-hunter's existing state routes satisfy the
shape as they are; portrait-studio, social and print-ingest add one small route each. A group's `setup[]`
step that names a readiness the member does not declare fails activation.

### D4 — One shared setup dashboard, rendered by the kernel from `setup:`

The kernel serves one surface (the way `send-to.js` is one script for every app): given a group name it
reads the group's `setup[]`, calls each member readiness probe with the caller's session, and renders the
checklist — done / not done / probe unavailable, the detail line, and a button that opens the `fix`
surface inside the same ribbon. It is the group's first tile by default and the landing view until every
step is done. No group writes its own dashboard; a group that wants a different look changes its `setup:`
order and labels, not code. "Probe unavailable" is rendered as such, never as "done".

### D5 — Where the YAML lives, and how a hostname reaches it

- **In the applications store repo**, as its own package directory (`intelligent-career/oshal-app.yaml`),
  published, installed, catalogued and gated exactly like a package. The kernel's `swarm-apps/` stays at
  its ten manifests (Rule 0c); a group is never one of them.
- **Per-domain repositories later, not now.** The installer already accepts any `git-subdir` source, so a
  `financeoshal.ai` repository holding that domain's group YAMLs needs no loader change when it is wanted.
  Splitting now buys nothing and costs a second branch discipline, CI and catalog; split when a domain has
  its own owner or release cadence.
- **The subdomain map points the host at the group** (`career.oshal.ai=intelligent-career`) instead of at
  the primary app. The all-in platform login is untouched.

### D6 — Intelligent Career is the first group and the acceptance test

Members: career-hunter (board, search, Resume Studio, Strengthen, Profile Studio, Settings),
portrait-studio (profile picture), social (LinkedIn Assistant, Signals, Accounts — Facebook and LinkedIn
connections), print-ingest (Print Inbox: subscribe, accept a printed document). The setup checklist is
the seven steps in D1. Two small member changes ride with it: career-hunter registers an ADR-139
`artifacts:` destination so a printed or uploaded document can be sent to "Add career materials", and
each member declares its `readiness:` entries. This ADR is accepted when a new user lands on
`career.oshal.ai`, sees the seven steps with live status, completes them from the dashboard alone, and the
toolbar is the union of the four members' surfaces with nothing hand-copied.

### D7 — The story loop belongs inside career-hunter, not in the group

"A story on my bullet, or at least a good story per job title — that's how we collect real job history"
is the piece with the most product value and the least existing coverage, and it is a career-hunter
feature: the engine's interview loop (`interview.py`, `interview_bank.py`) is built and orphaned, the
profile already holds `roles[].deliverables`, and Strengthen already renders bullets. The design: revive
the multi-turn interview as the **resume review conversation** in Strengthen; every answer that carries
evidence becomes a `story` attached to a role (`roles[].stories[]`, with the bullet it supports), the
review walks role by role until each title has at least one story, the resume and cover generators cite
stories as evidence, and the group's "Review your resume story by story" readiness reads "N of M roles
have a story". Tracked as its own BACKLOG item; it does not gate the group.

## Consequences

**Good**

- Six applications become one application for the person using them, defined in one file with no code,
  outside the kernel directory, and the same file is what a hostname lands on.
- Every group gets a setup / connection-status page for free, and it can never claim a step is done that
  the member app does not confirm.
- Launcher packages stop carrying copied URLs; a member app can move its surfaces without breaking the
  front doors that borrow them.
- Nothing in ADR-085's one-app-one-package unit or ADR-097's shelf changes; a group is the meta-manifest
  ADR-097 named.

**Costs / risks**

- A loader change in core: a new manifest kind, a surface resolver, a readiness schema, one shared
  dashboard surface, and the activation rules above. Medium, not small; it waits for acceptance.
- A group is only as honest as its members' readiness probes. A probe that answers "ready" from cached
  state lies to the dashboard — probes must read the same store the fix surface writes.
- Groups nest nothing: a group cannot list another group as a member. Keep it that way until a real case
  appears; the alternative is a resolver that has to detect cycles.

## What is built with this ADR

**Stage 1, core (2026-09-05).** `src/features/swarm-apps/services/swarm-app-group.ts` holds the whole
group concern (the service was over its size budget): `kind: group` validation (D1 — every code key
refused, members required, the toolbar borrows only from members, every setup step names a member and
a toolbar surface), the `readiness:` validation (D3 — own mount, canonical path, session-admitting
route, RFC 6901 pointers), and the resolvers. `activate()` fail-closes a group whose references do not
resolve against its ACTIVE members (D2, member + surface named; the record lands inactive);
`synthesiseProfile` renders a group as the kernel Setup tile followed by the borrowed member surfaces,
resolved at synthesis so a moved surface is followed (D2). `GET /api/swarm/apps/:name/setup` hands the
dashboard the plan; `GET /api/swarm/apps/:name/setup-dashboard` serves the ONE kernel page
(`src/pages/cockpit/tools/app-group-setup.html`), which asks each member probe in the viewer's own
session and opens the fix surface through the ribbon's `app-navigate` message (D4). The smoke verifier
verifies a group through its members' own smokes and fails it by name otherwise. Guards:
`tests/unit/swarm-app-groups.spec.ts` (loader, resolvers, the real service over a doubled repository,
the verifier) and `tests/swarm-app-groups.spec.ts` (the permanent fixture group against the
Playwright-managed server — real loader, real routes). Reference: the "Application groups" and
"Per-user readiness" sections of `docs/apps/authoring-app-packages.md`.

**Stage 1, store (2026-09-05).** `intelligent-career/oshal-app.yaml` is the first group (D5/D6):
members career-hunter, portrait-studio, social, print-ingest; the seven setup steps of D1 backed by
`readiness:` entries each member now declares over its own store — career-hunter (`resume` on the
existing resume-state route; `stories` and `materials` on a new readiness route), portrait-studio
(`portrait`), social (`facebook`, `signals`), print-ingest (`subscription`). career-hunter's ADR-139
destination ("Add to Career profile", 1.14.0) is the Send-to leg. `HOST_APP_MAP` on the demo box
points `career.oshal.ai` at the group.

**Not built, by design.** D7 — the story-per-role review — remains a career-hunter BACKLOG item; its
readiness step reads `roles[].stories[]` honestly today ("0 of N roles have a story") until that
conversation ships. The interim path that needed no core change — a launcher package with hand-listed
tiles and a bespoke dashboard — was not taken: it would have shipped the copied-URL defect this ADR
exists to remove. Per-domain YAML repositories wait for a domain with its own owner (D5).
