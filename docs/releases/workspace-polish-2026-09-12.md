# Workspace navigation and Create polish — 12 September 2026

The header now has one OSHAL Cockpit Home link, the major application tabs and
Profile. More opens beneath its own button and contains other applications,
Settings, theme switching, navigation layout and the existing secondary actions.
At the viewport edge it aligns to the button's right edge; on phones the menu
flows within the workspace drawer. Sidebar layout retains Workspace options.
The original controls and iframe stay mounted through layout changes. Keyboard
theme activation returns focus to the disclosure that opened it.

Create **1.3.0** separates recent work, quick starts and studios on Home and gives
templates one dedicated, searchable catalog. Default Office templates appear once.
Keyboard activation retains the same format handoff as clicking a card. Stories
in Creative Studio **1.2.1** follows the shared portal palette, including optional
Create colors, while preserving the existing brief and connected-draft behavior.

## Verification

Create passes nineteen actual Chromium cases and twenty Node/HTTP checks. Stories
passes seven Chromium cases and four existing summary checks. Scoped lint,
manifest/catalog validation and strict Stories route types pass. Existing routes,
authority and business handlers are retained. Both package changes received an
independent source review.

The six-file core appearance run passes 231 cases; a later focused header run
passes seventeen cases including the reproduced keyboard-focus regression.
Core type checking and scoped root JavaScript/fixture lint pass. The five-file
navigation run passes 112 cases, including the new keyboard activation check. Tests
cover duplicate removal, anchored placement, menu dismissal, responsive layouts
and retention of the original controls and open document.

Package tests are registered in the versioned catalogs: six Create entries and
two Creative Studio entries. Core appearance/navigation cards link the actual
regressions. Browser registration does not mean that a Lab readiness check runs
Chromium; each catalog reports its fixture and runner prerequisites.

## Publication and local acceptance

Publication, exact package staging and the standard local preview rollout are
recorded separately from the isolated checks above. The pending local acceptance
must verify the signed-in header, Create and Stories, installed Lab catalogs,
service health and preservation of unrelated applications and business data.

## Remaining backlog

The next product work is the [compact Jarvis dashboard](../backlog/jarvis-daily-dashboard.md),
with accurate activity states and grouped updates. Durable alert history and
additional report producers remain in that workstream. Manual image editing and
the longer Canva-style workflow remain owned by Create's package backlog.
