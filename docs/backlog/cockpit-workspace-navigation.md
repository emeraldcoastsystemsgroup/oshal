# Cockpit workspace navigation

Requested 2026-09-11. **The optional navigation overlay and independent Workspace
skin are implemented and deployed; focused native acceptance and preservation
checks passed. The September 13 compact Home/Jarvis and Finance/OSHAL-menu
presentation is delivered and its native acceptance passed.** Additional briefing
producers and editable-field context actions remain backlogged. The prototype
below remains an illustrative design artifact, separate from the implementation.
The [clickable HTML prototype](../mockups/cockpit-workspaces.html) is self-contained
and opens locally without a server. It uses only synthetic content. No application,
model, microphone, file, message or account is accessed. Its route references are
display-only; clicks stay within the prototype.

## Selectable visual skin

The **Workspace** visual skin is implemented separately from the optional navigation
layout. It applies the prototype's paper background, white surfaces,
restrained indigo accents and softer borders to **today's Cockpit markup**. The
color skin itself does not add navigation or implement the proposed daily dashboard.
Installation and native acceptance are recorded separately from source verification.

Settings → Global Settings → Theme includes Workspace. It becomes the starting
theme only when this browser has no saved theme. Valid existing choices remain;
an invalid saved ID keeps the established Midnight fallback. The portal palette
now takes precedence across applications and open tabs. **Application colors**
explicitly enables each application's declared or bundled skin while preserving
the saved portal palette. Choosing any portal theme turns that option off again.
Shared surfaces follow their current parent theme, or the saved/default theme
when opened separately. A late stylesheet from a previous app must not undo a
newer choice. Blocked browser storage retains this tab's selection for its lifetime.

Embedded chat follows the parent theme without writing that inherited appearance
into the saved global preference. Standalone chat follows a saved portal choice
live, retains its Midnight default when no choice exists, and honors explicit
theme URLs. Inherited bot profile colors never overwrite a saved portal choice.

The styling is configurable in
[workspace.css](../../src/pages/cockpit/css/themes/workspace.css) through the existing
CSS custom properties for background, cards, text, accent, border, radius, font and
shadow. These tokens also reach participating embedded surfaces. For example:

```css
[data-theme="workspace"] {
  --bg-primary: #f5f6f9;
  --bg-card: #ffffff;
  --accent-primary: #535bc8;
}
```

This is maintained CSS configuration, not a new arbitrary-CSS upload or runtime
editor. Preserve readable contrast when changing colors. The existing Test Lab
**Cockpit appearance** card checks the fixed stylesheet and links the actual
Chromium component/surface regression; it does not run that suite during its
read-only asset check. `npm run test:workspace-theme` runs the isolated browser and
existing theme/catalog regressions without accounts, providers or database writes.

## Optional navigation overlay

The separate **Navigation** setting offers **Sidebar (existing layout)** and
**Top workspaces + sidebar**. Sidebar remains the default. The preference is local
to this browser and does not change the saved color theme, current URL, active
screen or unsaved iframe content. It is available in Global Settings and under
**OSHAL menu → Navigation layout**, including inside focused applications. The
same brand-adjacent menu holds these controls in Sidebar layout.

The September 12 refinement places the workspace navigation **inside the top
header**, between the application brand and existing controls. It no longer
consumes a separate desktop row. On phones, an accessible Workspaces disclosure
opens the same destinations below the header; keyboard focus, the OSHAL menu and Retry
remain available. Navigation remains independent of the color palette.

The subsequent header cleanup keeps one global **OSHAL Cockpit** home link and
the major workspace tabs. The chevron beside the brand opens the **OSHAL menu**
beneath its trigger, clamped to the viewport. It contains Home, All applications,
searchable remaining workspaces and secondary controls. The selected extra
application is marked once inside the menu. Profile remains in the header.
Menu and layout changes retain the original action nodes and open application.

The [appearance contract](../apps/appearance.md) documents shared page adoption,
application defaults and custom document canvases. Career now applies consistent
palette-derived branding to its thirteen existing screens. Core administration,
AI Test Lab and operations pages use the same live theme bootstrap, with semantic
colors for cards, controls and previews. Deployment and exact verification are
recorded in the [September 12 release](../releases/workspace-facelift-2026-09-12.md).

The optional rail opens existing complete profiles using ordinary same-tab links:
`/cockpit/`, `/cockpit/?app=little-monsters`, `/cockpit/?app=create` and
`/cockpit/?app=intelligent-career`, `/cockpit/?app=capture-crm` and
`/cockpit/?app=finance`. The Career slot prefers that admitted group,
or uses the admitted `/cockpit/?app=career-hunter` application when the group is
unavailable. Only the selected entry is removed from the OSHAL menu. Learning is a label
for Little Monsters, not a new application. Other eligible complete applications, including custom skinned
profiles, appear in the **OSHAL menu**. All applications remains reachable there and existing
sidebar tools remain reachable through their owning workspaces. People/HR is not invented.

The contextual sidebar refinement removes the default Home sidebar's repeated
Learning, Career and Create pages only when the corresponding admitted workspace
is on top. Explicit `workspace` metadata delegates those entries; labels and URL
prefixes never infer ownership. Focused applications retain their internal pages.
An already open delegated page remains reachable until the user leaves it, and
Sidebar layout or failed discovery restores the full default rail. Federal CRM
opens the existing integrated `capture-crm` application. Its source Capture Board
and Formation Plan remain available under **Federal source tools**; Camera Ops,
Forge, Workflow Studio and Pumpkin remain under **Tools** because Create does not
include them. These changes affect presentation, not permissions or data ownership.

The server supplies only currently installed, visible and authorized destinations.
The overlay does not infer access from roles, theme names or an installation list.
It refreshes discovery when a page becomes visible or focused, discards stale
responses and removes app links on failure. Opening an app still follows its own
current authorization, enrollment and workspace checks. The current app is selected
only by its existing URL; navigation settings never cache an app profile.
An initial lookup can take longer while installed profiles load. The overlay waits
up to 30 seconds, keeps the current screen usable and offers Retry if that window
expires; it does not retain old application links while waiting.

Custom pages, member tools, package skins, chat/assistant/status policies, artifact
handoffs and iframe messages continue through the existing controllers. A workspace
link starts at that app's canonical entry and does not forward another app's record,
artifact or business-workspace parameters. Browser Back/Forward and the app's own
unsaved-work handlers retain their normal behavior. Student/kiosk pages do not add
workspace switching; zen and fullscreen hide the rail. On narrow screens the major
links scroll within the bar while the OSHAL menu and existing mobile drawer remain usable.

Source, isolated test results and native deployment acceptance are recorded
separately. The compact daily Home checkpoint uses existing summary and Jarvis
contracts; prototype-only editable drafts and producer adoption remain proposed.
Workspace navigation does not replace application landing pages or grant member actions.

The [September 13 release](../releases/daily-dashboard-2026-09-13.md) records actual
native Finance visibility, compact Home without an `Other` shelf, and an unfinished
Jarvis message retained through Refresh, area changes and the OSHAL directory.
The centered searchable directory found installed Embodied 0.4. The two native
core Lab Run controls passed four readiness steps, including 33 admitted workspace
links; these are in-page readiness results, not executions of their linked suites.
Backend core `0c287223` / image `e92d3468` serves the published modal CSS `d8080f56`
through the existing read-only pages mount, without a second fleet recreation.
The [startup delay investigation](cockpit-startup-resilience.md) remains open.

`npm run test:workspace-navigation` runs the isolated profile, authorization,
preference, browser and catalog regressions. The **Cockpit workspace navigation**
Lab card reads the current caller's discovery endpoint and links those suites;
its Run control does not execute the linked browser tests or open application records.

## Requested follow-up: Finance and the OSHAL menu

Reconfirmed 2026-09-13 alongside the
[Jarvis daily dashboard](jarvis-daily-dashboard.md): Finance is a named area,
and miscellaneous applications belong in the OSHAL menu. The personal dashboard
must not use a large `Other` shelf as a substitute for useful daily information.

Delivered presentation, with source and native checks recorded above: admitted
Finance is a curated top workspace at
`/cockpit/?app=finance`; Home labels its daily area Finance; unknown/missing suites
remain in the searchable authorized directory without an Other daily shelf.
The brand remains a Home link with an adjacent OSHAL menu disclosure. Only the
existing Finance home sidebar entry gains explicit `workspace: finance`; unrelated
Money tools remain reachable. Package permissions and business-data boundaries
continue through the existing discovery and application endpoints.

Done when:

1. **Finance is a named workspace.** The top row includes admitted Finance
   alongside Learning, Create, Intelligent Career and Federal CRM. Resolve the
   existing `finance` profile (`/cockpit/?app=finance`, default `finance-home`)
   through current discovery. It retains its owning pages and member permissions.
   At narrow widths, named workspaces remain reachable through accessible overflow.
2. **OSHAL owns the general menu.** A menu beside the OSHAL brand provides Home,
   searchable All applications, remaining admitted applications and secondary
   navigation controls. Preserve a clear Home action. Keep the menu anchored to
   its trigger with keyboard, Escape, focus-return and mobile behavior; avoid a
   second duplicate miscellaneous-app list in the top bar.
3. **The daily dashboard has no `Other` catalog shelf.** Use compact named areas
   and grouped updates, including Finance, beside Jarvis. Applications without
   suite metadata remain discoverable in the OSHAL menu/directory. Retain saved
   application/suite preferences and distinguish unavailable data from no activity.
4. **Grouping does not hide tools or grant access.** The `ai-finance` category
   includes applications beyond Finance's own toolbar. Category membership alone
   cannot remove those sidebar entries or assert Finance contains their pages.
   Only explicit workspace delegation removes a duplicate destination; every
   remaining authorized tool stays reachable. Open pages, drafts and current
   application context survive menu/theme changes and permission refreshes.
5. **Keep implementation coverage registered.** The existing workspace-navigation,
   Home-grouping and actual browser/authorization suites cover Finance
   present/absent/revoked, retained unique tools, directory access, 390 px width,
   200% zoom and theme changes. Internal catalog grouping may retain `Other` for
   saved choices; the daily view has no such shelf and the complete directory
   remains reachable. AI Test Lab links these source suites separately from its
   native readiness checks; installed presentation acceptance is recorded above.

This is presentation and navigation work. It does not complete Finance provider
setup, initiate transactions, create an umbrella application or implement the
compact Jarvis dashboard by itself.

## Follow-up: Profile and Access consistency

**Implemented in source; installed acceptance pending.** The September 13
[profile renderer](../../src/pages/cockpit/js/cockpit-modals.js) now uses a compact,
opaque palette-driven panel with consistent Settings and account controls. It
removes stale ribbon instructions and the nested standalone modal class. Loading
is bounded; unavailable or malformed session responses show Retry rather than
incorrectly claiming the person is signed out. Closing/reopening retires the old
request and restores focus. Settings uses the existing Global Settings handler.

The actual renderer passed nineteen new browser cases; seventeen retained
appearance cases were also accepted across scoped runs. **Cockpit appearance**
registers the new suite and checks the fixed Profile stylesheet independently.
Opening/closing Profile and changing palette retain the open application and
draft. Navigating to Settings still follows the existing view lifecycle; universal
custom-application draft persistence on leaving a page remains a separate
requirement. See the [integration record](../releases/component-integration-2026-09-13.md).

Done when:

1. The dialog uses the selected portal palette, shared button styles and a compact
   account layout, with consistent spacing and readable focus/hover states across
   desktop, phone widths and zoom.
2. Its wording and action labels describe the current destinations. Cockpit
   settings are easy to find after the header cleanup, and the OSHAL menu remains
   the documented location for global controls. Reuse existing settings routes.
3. Account identity, personal preferences and administration have clear meanings.
   Any administration shortcuts respect current permissions. Opening Profile does
   not change roles, sign the user out or discard an active draft. Settings reuses
   the existing view lifecycle; broader draft retention must be tested per surface.
4. Extend the existing profile/header browser coverage using the real renderer and
   shell styles. Verify signed-in/out states, keyboard close/focus return, settings
   navigation and palette consistency, and register the executable coverage with
   AI Test Lab. Capture installed acceptance when the user has finished testing.

Coverage to reconcile: `content-studio-quality.spec.ts` copies profile HTML and
checks geometry with only component styles; older header/modal tests retain
local-token and removed-control assumptions. The current Workspace theme fixture
checks Profile visibility without binding the real profile renderer. Exercise
the actual hydrated dialog and register that regression under **Cockpit appearance**;
the Lab's live stylesheet readiness check does not execute browser regressions.

## Earlier broader design direction

Put a small number of major workspaces across the top: **OSHAL Cockpit, Learning,
Create and Intelligent Career**, with **More** for overflow. These are quick entry
points to complete applications or established application groups. They are not
one tab per installed application.
This paragraph and the prototype describe the earlier proposal; the September 13
follow-up adds Finance and places general application discovery in the OSHAL menu.

**Learning opens Little Monsters itself.** It does not lead to an extra generic
education directory before the application. Selecting Little Monsters from All
applications does the same thing. The app name, learning tools and restrained
green theme make that destination explicit.

The user asked to leave the rest of navigation where it is. Retain the existing
left navigation, its lower-level tools, sections and permissions. The prototype
separates the active application's tools at the top of the sidebar from shared
links below, including Inbox, Calendar, Tasks, Files, All applications and Settings.
“More existing tools” illustrates continued access to Contacts, Operations and Test
Lab; this sample is not an exhaustive replacement specification for today's rail.
Implementation must inventory and retain all existing authorized destinations,
not silently drop anything omitted from this illustrative sidebar.

The top rail is curated. At narrower widths, workspaces move into **More**; the
current workspace remains identified. On a phone the left navigation becomes a
keyboard-accessible drawer. **All applications remains reachable through the global
Home brand and existing left navigation**, with a searchable directory. Pinning and ordering are
future durable preferences, not settings implemented by this mockup.

## Verified destination mapping

The following package IDs, declared surfaces and themes were read from the current
public package manifests. A route existing does not establish that the current
viewer is authorized, that a member is installed, or that a source has connected.
Production navigation must resolve the current installed profile and application
authorization rather than hard-code these iframe paths into a new shell.

| Top-level choice or application | Focused entry | Declared surface / owner | Current theme and design treatment |
|---|---|---|---|
| OSHAL Cockpit | `/` | Core landing; proposed daily dashboard | Neutral core chrome. The compact layout shown here is new design work. |
| Learning → Little Monsters | `/?app=little-monsters` | `lm-dashboard` → `/api/education/dashboard`; `ribbon.defaultView: lm-dashboard` | Manifest `little-monsters`; restrained green learning accents in the prototype. |
| Create | `/?app=create` | `create-home` → `/api/create/home`; `ribbon.defaultView: create-home` | Manifest `create`; lavender accents, with studios owned by their applications. |
| Intelligent Career | `/?app=intelligent-career` | Existing `kind: group`; borrows `career-hunter` surface `career-board` → `/api/career-hunter/board-native`, plus resume, presence and document surfaces | Manifest `daylight`; quiet blue accents illustrate the proposed workspace treatment. Existing group setup/readiness remains authoritative; the illustrated overview is not a claimed shipped landing. |
| AI Office within Create | `/?app=presentations` | Create declares `/api/presentations/sections/ui` | Member-owned studio. |
| Portrait Studio within Create / Career | `/?app=portrait-studio` | `/api/portrait-studio/app` | Member-owned studio and current permissions. |
| Video Studio within Create | `/?app=video` | Create declares `/api/video/ui` | Member-owned studio. |
| Payroll | `/?app=payroll` | `payroll-home` → `/api/payroll/`; `ribbon.defaultView: payroll-home` | Manifest `ocean`; remains a standalone application. |
| People / HR umbrella | **No established group route** | Proposed grouping only | Optional concept under More, clearly marked Proposed. |

Manifest sources: [Little Monsters](https://github.com/emeraldcoastsystemsgroup/oshal-applications/blob/main/little-monsters/oshal-app.yaml),
[Create](https://github.com/emeraldcoastsystemsgroup/oshal-applications/blob/main/create/oshal-app.yaml),
[Intelligent Career](https://github.com/emeraldcoastsystemsgroup/oshal-applications/blob/main/intelligent-career/oshal-app.yaml),
[Career Hunter](https://github.com/emeraldcoastsystemsgroup/oshal-applications/blob/main/career-hunter/oshal-app.yaml),
[Payroll](https://github.com/emeraldcoastsystemsgroup/oshal-applications/blob/main/payroll/oshal-app.yaml).
The canonical group name is currently singular **Intelligent Career**; changing its
public label to “Intelligent Careers” is a separate naming decision.

## Daily dashboard and Jarvis

Follow the [Jarvis daily dashboard brief](jarvis-daily-dashboard.md). The prototype
shows a bounded daily summary, related updates grouped by source/topic, expandable
history and a short agenda. A small Jarvis panel has a clear composer, attachment
and voice affordances, and a selected detail beside an editable draft. There is no
dominant eye or invented busy indicator.

Click the project update, choose **Draft a sample reply**, then edit the draft.
Switch workspaces and return: the draft is retained for this page session and a
second suggestion does not overwrite it. **Keep draft** never sends anything.
Composer submissions produce an explicitly labeled, preset illustrative response;
they do not invoke a model. Voice and attachment controls explain their intended
placement without requesting access. Real producer delivery, grouping, persistence,
read/dismiss semantics and supported field updates remain the owning backlog's work.

## People / HR is a proposal

Payroll is an existing application; a unified People / HR workspace was not
established by the inspected manifests. Do not invent a group ID, shared employee
directory or permission model to make the mockup look complete. Decide the intended
audience and grouping first: personal career development and employer-side employee
administration are different contexts. If a group is adopted, reuse member-owned
surfaces and require each application's current roles and business workspace.
Payroll confirmations and data boundaries remain in its owning application.

## Ownership and acceptance

Core owns workspace selection, responsive top navigation, global sidebar access,
focus/history behavior and the dashboard/Jarvis composition. Existing packages own
their pages, records, themes, setup probes and actions. Create's deferred visual
editing roadmap is not implemented by this navigation proposal.

1. **Direct, complete destinations:** selecting Learning or Little Monsters opens
   the current `little-monsters` profile at its declared default. Create and
   Intelligent Career resolve their current profiles and member surfaces. Browser
   back, reload, deep links and missing-member states are truthful and tested.
2. **Keep the rest of navigation:** every previously authorized sidebar tool and
   section remains reachable. The top rail stays curated; All applications remains
   searchable. At 1440, 1024, 768 and 390 pixels, and at 200% zoom, no labels overlap
   and no required action falls outside the viewport. Keyboard focus, overflow,
   Escape and the mobile drawer work without pointer input.
3. **Application identity without a second shell:** workspace themes are restrained
   and transient. Shared controls retain their meanings, contrast and position;
   returning to Cockpit restores the core theme. Use current registry/profile
   contracts instead of copying application business code into core.
4. **Current authority and context:** visibility is not a grant. App/role/tenant
   changes invalidate stale navigation and pending actions; deep links receive the
   same current authorization as ordinary entry. Account and business-workspace
   selection remain distinct from these product-workspace tabs.
5. **Useful daily work:** grouped updates retain their individual provenance and
   history; opening an item supplies its authorized detail/draft context. Returning
   preserves the defined filter, scroll and draft state. Delayed responses do not
   overwrite manual edits, and outbound actions require the owning application's
   normal review and submission flow.
6. **Honest prototype-to-product handoff:** retain explicit proposed/unsupported
   states. Add executable tests and appropriate Test Lab registration only alongside
   real implementation. This mockup is design documentation, not a runnable product
   suite and not evidence of live source, connector or payroll functionality.

## Prototype verification

Forty checks passed in real Chromium, including opening directly from `file:///`,
switching workspaces and reloading without a server. The HTTP review served only
the mockup document and blocked other origins. Checks cover direct Little Monsters
selection, grouped history, editable drafts, More, visible keyboard tab stops,
theme switching, 1440/1024/768/390-pixel layouts and a short scrollable drawer.
A 720-pixel CSS viewport also checks the reflow equivalent of 200% desktop zoom;
this does not claim testing browser zoom itself or other browser engines.
Screenshots are review artifacts kept outside tracked source. These checks validate
the mockup's interaction and layout, not deployed application behavior.
