# Capture CRM — swarm-app plugin (OPEN WORK / handover)

**Status:** beta, loaded & integration-verified on the local stack · **paused 2026-06-01** · resume from "Next session" below.

> **Re-baseline 2026-07-19:** the ⚠️ blocker below is RESOLVED — `federal-capture` is a live,
> registered ticket type (mapped in `src/entities/ticket/queue-classification.ts` to the
> `federal-capture` queue/app; the running build long ago superseded the stale-dist enum this file
> describes). Next-session step 1 is therefore done. **Still open:** step 2 (the `capture-triage`
> ticketType + coordinator workflow — never added) and step 3 (a live end-to-end coordinator run on
> the real opportunity pipeline — only integration was ever verified). Steps 4–5 (same-origin board,
> corpus seeding) remain fast-follows.
**Owner intent:** the gov-contracting Capture CRM should run **as an OSHAL framework plugin** (cockpit add-in + agents), not as a bolt-on standalone app.

## What this is
A swarm-app that turns the `federal-capture` pipeline into a *managed* CRM (a portfolio, not a list):
- a **cockpit ribbon board** ("Capture CRM") opened in-pane, and
- a **capture-coordinator** agent that triages/ranks the pipeline, tracks human gates, and dispatches
  deep per-opportunity work to the existing `capture-specialist` (the `federal-capture` worker).

It sits as the **application layer** over `federal-capture` (the worker app, owned by another session).

## Files (this plugin — additive, reversible, NO core edits)
| File | Role |
|---|---|
| `swarm-apps/capture-crm.yaml` | Plugin manifest: `ui.static` ribbon entry → board iframe + `bots[]` (coordinator). Currently **no custom ticketType/workflow** — see blocker. |
| `ai-lab/bot-personas/capture-coordinator.yaml` | New agent `b0000000-0000-0000-0000-000000000041` — portfolio triage / prioritization / gate tracking / capture dispatch. |

Board UI + data engine are in the **gov-contracting** repo (other session owns these — do NOT edit here):
`gov-contracting/crm/server.py` (serves the board on :8787, reads the opportunity folders = source of truth)
and `crm/*.py` (the capture engine; its `Advance` currently posts generic `build` tickets to OSHAL).

## Verified working (2026-06-01)
- `POST /api/swarm/apps/load {path:"swarm-apps/capture-crm.yaml"}` → app **active**, botCount 1, toolCount 1.
- Coordinator agent **active** in `/api/agents` (provider `claude-code`).
- Ribbon tool `capture-crm-board` registered in `/api/tools/dynamic` (iframe `http://localhost:8787/`).
- Board server :8787 serves (HTTP 200) and is frameable (no X-Frame-Options) → renders in the cockpit.
- Cockpit at **http://localhost:35457/cockpit/** → "Capture CRM" appears in the left ribbon.

## ⚠️ Blocker (why the rich path isn't live yet)
`POST /api/tickets` validates `ticketType` against a **STATIC enum baked into the running `dist` build**:
`build | incident | education`. The **source** (`src/entities/ticket/types.ts`) already adds
`federal-capture`, but **the container is stale (not rebuilt)** — so right now neither `federal-capture`
nor a custom `capture-triage` ticket can be created via the API. The plugin was therefore built to NOT
depend on a custom ticketType (coordinator reachable via cockpit chat; board uses generic `build` tickets).

## Next session (pick up here)
1. **Rebuild the dist** so the source enum (incl. `federal-capture`) is live: `npm run build` then restart
   the swarm controller (or rebuild `oshal-local-api`). Confirm `POST /api/tickets {ticketType:"federal-capture"}`
   is accepted. (Coordinate — another session owns "OSHAL local stack bring-up".)
2. **Restore the coordinator's own workflow:** add `capture-triage` to `TicketTypeSchema` in
   `src/entities/ticket/types.ts`, then re-add to `swarm-apps/capture-crm.yaml`:
   ```yaml
   ticketType: capture-triage
   workflow: { name: Capture Pipeline Coordination, pipeline: capture, workerBot: capture-coordinator }
   ```
   Reload the app. Now the board can fire a `capture-triage` ticket → coordinator produces
   `PIPELINE-REVIEW.md` + `ADVANCE-PLAN.md`, and per-opp `federal-capture` tickets → `capture-specialist`.
3. **Run the coordinator live end-to-end** on the real 53-opportunity pipeline and review its output
   (NOT yet done — only integration was verified, not a full agent run).
4. **FAST-FOLLOW UX:** bake the board page into the cockpit `dist` for a same-origin path instead of the
   `:8787` iframe (removes the dependency on `python crm/server.py` being up). Use cockpit theme tokens
   (`var(--bg-*)`, `var(--accent-*)`) — do not hardcode colors.
5. **Seed RAG:** the manifest references `capture-corpus` (shared with `federal-capture`); seed it with past
   proposals + the capability statement so the agents are grounded.

## How to use / reverse it (today)
- **Use:** start the board (`cd gov-contracting/crm && python server.py`), ensure OSHAL is up, open
  `http://localhost:35457/cockpit/`, click **Capture CRM** in the ribbon.
- **Reverse:** delete `swarm-apps/capture-crm.yaml` (and the coordinator persona) or toggle the app inactive —
  the ribbon entry, tool, and bot all unwind. No core files were changed.

## Coordination notes
- Built as **new files only**; did NOT touch `crm/*.py`, `federal-capture.yaml`, or `capture-specialist.yaml`.
- Logged in gov-contracting `.colab` under `Claude/opus-crm-oshal-plugin` (released).
- The cockpit UI mechanism used (`ui.static` iframe panels) is the same one `swarm-apps/oshal-engineering.yaml`
  uses for its 9 panels — see `docs/framework-developer-guide.md` and `docs/swarm-apps-framework.md`.
