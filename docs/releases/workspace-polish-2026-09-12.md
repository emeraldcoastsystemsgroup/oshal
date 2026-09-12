# Workspace navigation and Create polish — 12 September 2026

The header now has one OSHAL Cockpit Home link, the major application tabs and
Profile. More opens beneath its own button and contains other applications,
Settings, theme switching, navigation layout and the existing secondary actions.
At the viewport edge it aligns to the button's right edge; on phones the menu
flows within the workspace drawer. Sidebar layout retains Workspace options.
The original controls and iframe stay mounted through layout changes. Keyboard
theme activation returns focus to the disclosure that opened it.

Installed Daylight review exposed text bleeding through translucent menu surfaces
and options buried beneath a long application list. The follow-up uses each
palette's solid background for disclosures and gives application links a separate
scroll area, keeping workspace controls visible. Pixel comparisons against light
and dark content verify that the background no longer bleeds through.

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
Core type checking and scoped root JavaScript/fixture lint pass. The final five-file
navigation run passes 123 cases, including eleven later opacity, long-list and
short-window regressions beyond the initial 112. Tests
cover duplicate removal, anchored placement, menu dismissal, responsive layouts
and retention of the original controls and open document.

Package tests are registered in the versioned catalogs: six Create entries and
two Creative Studio entries. Core appearance/navigation cards link the actual
regressions. Browser registration does not mean that a Lab readiness check runs
Chromium; each catalog reports its fixture and runner prerequisites.

## Publication and local acceptance

Create 1.3.0 and Creative Studio 1.2.1 are published at public package source
`f4b5ea7f26d72fa6422e17a031345561eb690bde`. The standard installer produced immutable
stages; all 34 installed files, including provenance stamps, match those stages.
Unchanged dependencies resolved by the installer were not copied.

The standard local preview command completed the final rollout at 18:01:01 UTC
on 12 September 2026. All 35 application containers are healthy on core source
`da3f14045ad7b3d67d2f45036aceec56b030ea72`, image
`sha256:a98aaa03849424d975ce963bac02d388df054d6bbb8fa560e73323f92eee0c69`;
deployment parity is clean. Signed-in browser acceptance confirms one global
Home link, More beneath its trigger, an opaque menu and immediately reachable
workspace controls despite 33 admitted application destinations. Create Home
shows seven existing recent pieces; its dedicated catalog has 35 templates.
Stories retains an unsent title and brief through a Daylight-to-Ocean change.
More > Settings opens the existing chooser, which restored Daylight; top workspace
navigation and the application-colors preference were retained. Served navigation
and layout styles match the published source hashes.

The installed AI Test Lab exposes all eighteen relevant entries: eight Career,
six Create, two Stories and the two core appearance/navigation cards. Three
Create 1.3.0 Node suites were executed from the signed-in Lab: Home surface
contracts passed 9/9, New screen contracts passed 7/7 and packaged local HTTP passed
4/4, each with verified disposable-container cleanup. These runs pin the unchanged
package source above and the first rollout's image
`sha256:5ce38570cf6ff2093ccd1ba9830f4e85b70ebd43a6bab19c7168ad813d5afa59`.
The final rollout only updates the core menu. Browser recipes remain registered
with an unavailable-Playwright prerequisite in this installed Lab; their actual
Chromium results are the local runs reported above.

The first rollout's strict preservation report passes. The final report confirms
all 57 unrelated packages, business-data checks, configuration, runtime mounts and
fourteen infrastructure containers are preserved. Its only reported difference
is authorization revision 76/70 assignments becoming 77/71: a separate concurrent
operator-requested Scan-to-Print management grant, recorded by its owning session.
The original strict report and historical baselines retain that difference;
acceptance of the concurrent change is recorded separately rather than rewriting
the baseline. An independent read-only transaction verified the exact added grant,
its consumed preview, applied receipt and audit event. Excluding that one grant
and audit event reproduces the prior assignment and audit hashes. The separate
review passes with this documented exception. This appearance release makes no
permission or business-data changes.

Both branches were published through their normal local gates. No GitHub Actions
were invoked. Core pull request 431 still requires independent approval before
merge; the authorized local preview deployment is complete.

## Remaining backlog

The next product work is the [compact Jarvis dashboard](../backlog/jarvis-daily-dashboard.md),
with accurate activity states and grouped updates. Durable alert history and
additional report producers remain in that workstream. Manual image editing and
the longer Canva-style workflow remain owned by Create's package backlog.
