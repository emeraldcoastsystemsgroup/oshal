# Cockpit workspace navigation

Requested 2026-09-11. **The optional navigation overlay is in implementation; the
broader dashboard prototype remains a backlogged design proposal.**
The [clickable HTML prototype](../mockups/cockpit-workspaces.html) is self-contained
and opens locally without a server. It uses only synthetic content. No application,
model, microphone, file, message or account is accessed. Its route references are
display-only; clicks stay within the prototype.

## Selectable visual skin

The **Workspace** visual skin is implemented in core source separately from this
backlogged layout. It applies the prototype's paper background, white surfaces,
restrained indigo accents and softer borders to **today's Cockpit markup**. The
color skin itself does not add navigation or implement the proposed daily dashboard.
Installation and native acceptance are recorded separately from source verification.

Settings → Global Settings → Theme includes Workspace. It becomes the starting
theme only when this browser has no saved theme. Valid existing choices remain;
an invalid saved ID keeps the established Midnight fallback. A focused application
can still apply its own temporary or bundled skin without overwriting the saved
choice. Shared surfaces follow their current parent theme, or the saved/default
theme when opened separately. A late stylesheet from a previous app must not undo
a newer choice.

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
screen or unsaved iframe content. It is available in Global Settings and the
header's Navigation layout button, including inside focused applications.

The optional rail opens existing complete profiles using ordinary same-tab links:
`/cockpit/`, `/cockpit/?app=little-monsters`, `/cockpit/?app=create` and
`/cockpit/?app=intelligent-career`. Learning is a label for Little Monsters, not a
new application. Other eligible complete applications, including custom skinned
profiles, appear in **More**. All applications remains reachable there and existing
sidebar tools remain where their profile puts them. People/HR is not invented.

The server supplies only currently installed, visible and authorized destinations.
The overlay does not infer access from roles, theme names or an installation list.
It refreshes discovery when a page becomes visible or focused, discards stale
responses and removes app links on failure. Opening an app still follows its own
current authorization, enrollment and workspace checks. The current app is selected
only by its existing URL; navigation settings never cache an app profile.

Custom pages, member tools, package skins, chat/assistant/status policies, artifact
handoffs and iframe messages continue through the existing controllers. A workspace
link starts at that app's canonical entry and does not forward another app's record,
artifact or business-workspace parameters. Browser Back/Forward and the app's own
unsaved-work handlers retain their normal behavior. Student/kiosk pages do not add
workspace switching; zen and fullscreen hide the rail. On narrow screens the major
links scroll within the bar while More and the existing mobile drawer remain usable.

Source, isolated test results and native deployment acceptance are recorded
separately. This overlay does not implement the prototype dashboard, replace any
application's landing page, or turn app discovery into permission to use every
member action.

## Broader design direction

Put a small number of major workspaces across the top: **OSHAL Cockpit, Learning,
Create and Intelligent Career**, with **More** for overflow. These are quick entry
points to complete applications or established application groups. They are not
one tab per installed application.

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
keyboard-accessible drawer. **All applications remains reachable from both the
left navigation and More**, with a searchable directory. Pinning and ordering are
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
