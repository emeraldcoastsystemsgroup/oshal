# ADR-074 — Daily trade recap pipeline: post-close cron → staged workflow → Vids worker

- **Status:** Accepted — 2026-06-26. All code committed on `main`. The pipeline runs end-to-end; specific stage transitions are noted as LIVE or DESIGNED below.
- **Date:** 2026-06-26
- **Related:**
  [ADR-052 (stock-trading swarm)](052-stock-trading-swarm.md) — the trading-analyst bot and Alpaca
  paper/live ledgers that produce the numbers this pipeline consumes.
  [ADR-065 (connector runtime)](065-connector-runtime-and-spec.md) — the ConnectorClient / token broker that
  resolves the owner's Google credentials for `gmail.send`.
  [ADR-073 (Vids Operator scenario library)](073-vids-operator-scenario-library.md) — the
  `@oshal/vids-operator` package and the tool/function registry the Vids worker runs.

## Context

The OSHAL trading swarm (ADR-052) generates daily paper trades but had no automated delivery path. Each
evening someone would manually pull numbers from the Alpaca ledger, write a recap, and post it. The
goals for this build were:

1. Trigger automatically after market close on weekdays, without a human in the loop until approval.
2. Produce a structured artifact chain: numbers → narrative → slide deck → video → social draft.
3. Park at a human approval gate before anything reaches a public channel.
4. Reuse existing OSHAL bots and workflow machinery rather than bespoke scripts.

Two infrastructure gaps had to be closed first: (a) no generic cron → workflow trigger existed, and (b)
`@oshal/vids-operator` was a standalone local tool with no in-swarm dispatch path.

## Decision

### 1. Vids platform integration (new, LIVE)

`src/app/routes/vids-routes.ts` adds `createVidsRoutes(ctx)`, mounted at `/api/vids` in `server.ts`
**without** `requiresAuth` (mirrors `/api/world`; loopback-only, lets the in-container `vids_generate`
CLI tool reach it without a session cookie).

Three endpoints:

| Endpoint | Purpose |
|---|---|
| `POST /api/vids/jobs` | Insert a `vids_jobs` row (migration 059), locate a registered Vids worker by capability `vids.generate` or tag `vids`, enqueue `mcp.call-tool { name:'vids.generate', arguments }` via `remoteClientRegistry.enqueueTask`. |
| `GET /api/vids/jobs` | List jobs and registered worker status. |
| `GET /api/vids/app` | Self-contained cockpit surface (job queue + submit form, theme-bridged). |

A `setInterval` watcher (5 s, 30 min ceiling) polls `remoteClientRegistry.getCompletedResult` and
writes `status`, `final_prompt`, and `outcome` back to the `vids_jobs` row when the worker posts
completion.

**The Vids worker is a remote client, not a container.** `packages/oshal-vids-operator` (`oshal-vids
worker`) runs **outside** the container swarm on a machine with a physical screen and Chrome, because it
drives Google Vids/Veo by clicking the real UI. It registers with the control plane via
`POST /api/remote-clients` using `VIDS_SWARM_URL` + `VIDS_SWARM_SECRET` (= `REMOTE_CLIENT_SHARED_SECRET`),
heartbeats, and polls for tasks. This is the same "make a PC a swarm worker" model used by
`packages/oshal-chat` (oshal-node-desktop). The vision loop inside the worker uses `codex`.

**VALIDATED:** platform dispatch → worker claimed the task → drove the real Chrome screen.
The Veo render itself is gated at runtime by the codex usage quota (the vision loop is codex calls).

### 2. Generic workflow-ticket scheduler (new, LIVE)

`src/app/workflow-ticket-schedule-dispatch.ts` adds two exports:

- `isWorkflowTicketSchedule(taskType)` — returns true when `taskType` starts with `workflow:`.
- `dispatchWorkflowTicketSchedule(ctx, schedule)` — strips the prefix, reads `ticketType`, calls
  `ctx.ticketService.createTicket({ ticketType, status:'backlog', … })`. That is the entire job of the
  cron; everything else is the workflow.

Wired into `src/app/schedule-runtime.ts` as a branch in the dispatch chain, with an
`ensureSchedulingEnabled` bypass so workflow-ticket schedules fire even when `ENABLE_AGENT_SCHEDULER` is
not set for the other schedule types.

The live schedule `workflow_daily-trade-recap` uses cron `15 20 * * 1-5` (20:15 UTC = 4:15 PM ET on
weekdays). It is Redis-backed and survives container restart. A ticket created at status `backlog` is
promoted to `approved` by `QueueManagerService` on the next poll cycle (`autoStart: true` on the
manifest).

**VALIDATED:** an every-minute test schedule fired and created an auto-approved `daily-trade-recap`
ticket. The production weekday cron replaced it after verification.

### 3. The daily-trade-recap workflow (LIVE — stage 0 validated; stages 1-3 DESIGNED)

`swarm-apps/daily-trade-recap.yaml` — authored by the OSHAL workflow compiler
(`compileWorkflowSpec` + `serializeManifest`), `mode:'staged'` which serialises to
`pipeline:'graph'` with a `processDefinition.nodeGraph`.

```
start → trading-analyst → deck-builder → vids-operator → communications-bot → approval-gate → deliver
```

| Node | Bot | Work |
|---|---|---|
| n-start | — | trigger entry point |
| n-stage-0 | `trading-analyst` | Pull Alpaca ledger numbers + write narrative recap |
| n-stage-1 | `deck-builder` | Produce charted slide deck (pptxgenjs) |
| n-stage-2 | `vids-operator` | Render a ~3-minute video via Vids worker |
| n-stage-3 | `communications-bot` | Draft social post + email owner an approval link |
| n-gate-3 | — | `approval_required` — parks the run |
| n-deliver | — | Deliver on owner approval |

Execution path: `chooseDispatchPath → 'graph'` → `ProcessDefinitionExecutionEngine` walks
`topologicalOrder`, dispatches each `execute-agent` node to its bound bot via `engine-services-adapter`
(bot-node endpoint, with `localhost /api/send-message` fallback).

**VALIDATED:** n-stage-0 (`trading-analyst`) executed on the `claude-code` harness (not `codex`, so not
quota-blocked). Stages 1-3 are wired and will execute in sequence once n-stage-0 completes; they have
not yet been validated end-to-end as a continuous run.

**Delivery design:** `communications-bot` owns the Gmail and social connectors. It drafts the social
post and sends an approval-link email to the owner via `gmail.send`, resolved through
`connector-token-broker.ts` (`resolveBotCreds` decrypts the caller's stored Google token into the bot's
workspace). The approval gate parks the run; nothing auto-posts to a public channel.

## Architecture summary

```
[cron: 15 20 * * 1-5]
        |
        | workflow-ticket-schedule-dispatch
        v
  createTicket(ticketType=daily-trade-recap, status=backlog)
        |
        | QueueManagerService (autoStart poll)
        v
  ticket → approved
        |
        | chooseDispatchPath → 'graph'
        v
  ProcessDefinitionExecutionEngine
        |
        |─ n-stage-0: trading-analyst  ←→ claude-code harness
        |─ n-stage-1: deck-builder     ←→ codex / claude harness
        |─ n-stage-2: vids-operator    ←→ POST /api/vids/jobs
        |                                    → remoteClientRegistry.enqueueTask
        |                                    → oshal-vids worker (remote PC, Chrome)
        |─ n-stage-3: communications-bot ←→ gmail.send (connector token broker)
        |─ n-gate-3:  approval-gate    (parks)
        └─ n-deliver: deliver          (on owner approval)
```

## Consequences

- Any authored workflow with `autoStart:true` now has a one-line cron trigger:
  create a schedule with `taskType:'workflow:<ticketType>'`. No workflow-specific scheduler code needed.
- The Vids worker model (remote client on a screen machine) is reusable for any task that requires
  physical-screen control. The same registration/heartbeat/poll pattern scales to additional worker
  machines.
- The approval gate before delivery is structural, not a config flag — it cannot be accidentally
  skipped by changing an env var.
- Stage failures surface as ticket status changes; the run parks rather than silently dropping.

## Known limitations and follow-ups

1. **PPT → video handoff (DESIGNED, not built).** The `vids.generate` tool generates Veo prompt clips
   from a text description. It does not import a `.pptx` and convert it to video. Turning the
   deck-builder output into a video requires a new tool path (the manual flow has been proven in the
   operator but is not wired into `vids.generate`). Cross-stage file-path handoff between deck-builder
   and vids-operator is also not yet implemented — stages currently pass ticket context, not file paths.

2. **deck-builder chart rendering.** pptxgenjs renders charts as text/table representations, not
   embedded chart objects. Native chart embeds are a follow-up.

3. **Google Drive scope absent.** The owner's stored Google connection has `gmail.send` but not
   `drive` scope. Programmatic organisation of Vids drafts into a Drive folder via API is not possible
   with current credentials. Vids drafts do auto-save to Google Drive by the browser session; this only
   affects folder automation.

4. **`docker cp` persistence.** `vids-routes.ts` and `workflow-ticket-schedule-dispatch.ts` were
   deployed into the running container via `docker cp` and survive container restart, but revert on
   container `RECREATE`. Source is committed; the oshal-bot image must be rebuilt to make the deploy
   permanent. Until then, redeploy after any `docker compose up --force-recreate`.

5. **Codex quota blocks Vids render.** The `oshal-vids worker` vision loop calls `codex`. If the codex
   usage quota is exhausted the render hangs at the worker until quota resets (typically top of the
   next hour on the free tier). This does not affect stage 0 (`trading-analyst` runs on `claude-code`).
