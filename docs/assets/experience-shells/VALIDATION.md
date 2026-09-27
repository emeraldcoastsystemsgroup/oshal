# Browser verification — 2026-09-25

## Full-swarm prototypes

`node docs/assets/experience-shells/check-full-swarm.cjs` passed **373 assertions** on the final full-swarm code. No browser runtime errors or external HTTP requests occurred.

Checked behavior:

- Four distinct layouts, with all 62 catalog entries reachable.
- Correct suite totals: 8 Finance, 11 Engineering, 13 Creative, 12 Productivity, 13 Home and 5 Knowledge. Games shortcut contains three Creative entries.
- Search, empty results, both identically named Career packages, pin/unpin and pinned filtering.
- Pinning updates Studio's underlying sidebar when the catalog closes.
- Every application opens with its actual name; descriptions and declared dependency links are retained.
- Finance → World Intelligence, Games → its two game applications, and Circuit Lab → Animatronics navigation.
- Example artifact panels, including a game-room preview.
- Workflow approval → automatic publication → restore, entirely within preview state.
- Fixture conversations resolve actual app names; entered markup stays text.
- Studio app context selection; Orbit suite drill-down and cross-suite inspector consistency.
- Commons suite membership, room-scoped unsent drafts, keyboard tabs and app-to-room navigation.
- Workday/evening selector changes the visible experience in every layout.
- Home, directory and app panels at widths 1440, 1024, 768, 600, 390 and 320 pixels: no horizontal page overflow or tested control/heading bounds outside the viewport.
- Gallery contains four entries and loads their current screenshots.

Desktop, mobile, evening and catalog screenshots are saved in `previews/`. All four desktop designs and representative mobile views were visually inspected; the gallery is available through the local in-app browser preview.

## Retained first pass

`node docs/assets/experience-shells/check.cjs` passed **165 assertions**, targeting the original smaller `?scale=sample` experiences. These screenshots are isolated under `previews/first-pass/` and do not replace current gallery images.

## Limits of this evidence

These are real browser interactions against standalone design prototypes, not production feature tests. They do not verify installed apps, live assistants, account data, privacy enforcement, shared editing, backend integrations, application completeness or real workflow execution. The app catalog and manifest relationships are source facts; all runtime activity is explicitly illustrative. No production Test Lab registration or backlog closure is claimed.
