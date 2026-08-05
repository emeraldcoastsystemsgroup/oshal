# Runbook — Daily trade recap pipeline

The pipeline runs automatically at 4:15 PM ET on weekdays (cron `15 20 * * 1-5`). A schedule fires,
creates a `daily-trade-recap` ticket at status `backlog`, and `QueueManagerService` promotes it to
`approved` (autoStart). The graph engine then dispatches five stages in order:

1. `trading-analyst` — numbers + narrative from the Alpaca ledger
2. `deck-builder` — charted slide deck
3. `vids-operator` — render video via the remote Vids worker
4. `communications-bot` — draft social post + email owner an approval link
5. approval gate — owner approves before anything is delivered

Nothing in this graph workflow posts to a public channel before the approval gate.

The Windows host also has a separate, explicitly operator-authorized nightly delivery rail:
`scripts/run-daily-recap.ps1`. That runner drives the render workstation, emails and archives the
finished recap, then automatically publishes the exact same verified delivery to AgenticFederal
and Emerald Coast Systems Group. These are different entry points: the graph remains approval-gated;
the host task is the unattended production publisher and returns non-zero if either site is stale.

### Host-runner provenance and recovery

The host runner does not trust reusable filenames. A completed render produces an immutable
`build-artifacts-<runId>.json` plus the current `BUILD.manifest.json` pointer. The build manifest
binds the requested market date, all four build inputs, and all four rendered pieces by byte length
and SHA-256. Final assembly produces `recap-artifacts-<runId>-<deliveryId>.json` plus
`RECAP.manifest.json`, binding that build to the deck, dated PDF, and final video.

- `-SkipBuild` is allowed only when the completed build manifest matches the requested date and
  current input hashes.
- `-ResumePull` reuses a local piece only when both its length and SHA-256 match that build.
- One host-wide mutex covers the complete normal run, including shared staging, assembly, and
  publication names. A second scheduled or manual run fails before staging; manifest-only
  verification remains available while a run is active.
- Publishers freeze one verified manifest/build/output snapshot and use it for both sites; a
  concurrent new run cannot mix deliveries.
- Production is complete only after the public index provenance and downloaded artifact hashes
  match the frozen delivery.

The manifests are local integrity and coherence records, not signatures. They close stale-file,
partial-write, substitution-race, and cross-run mixing failures, but they do not authenticate bytes
against an attacker who can rewrite both the artifact and its manifest. Keep the output directory
writable only by the scheduled-task account and administrators; treat unexpected ACL expansion as a
pipeline security incident. Cryptographic signing is required before manifests can cross an
untrusted storage boundary.

Manual recovery and verification:

```powershell
powershell -File scripts/run-daily-recap.ps1 -Date 2026-08-05 -SkipBuild -ResumePull
powershell -File scripts/run-daily-recap.ps1 `
  -VerifyDeliveryManifest C:\path\to\RECAP.manifest.json `
  -DeliveryArtifactRoot C:\path\to\out
```

Verifier exit codes are `0` valid, `1` readable but mismatched, and `2` unreadable or malformed.

---

## The write-once flow: pull data → build report → email

The recap is produced from ONE source-of-truth JSON document, written once per day from the real
trading account and then consumed by every downstream renderer (deck, video). The two halves are
plain-Node CLI scripts registered as manifest tools in `swarm-apps/daily-trade-recap.yaml`:

| step | tool (manifest) | script | what it does |
|---|---|---|---|
| pull data | `trade_recap_data` | `scripts/oshal-trade-data.js` | reads the real Alpaca **paper** day (account, positions, today's filled orders, intraday equity history) and writes the recap-data.json contract |
| build report | `trade_recap_build` | `scripts/oshal-trade-recap.js` | shells out to `packages/oshal-vids-operator/build-daily-report.js` against that JSON to render the write-once report |
| email | `communications-bot` (gmail.send) | — | drafts the post + emails the owner an approval link |

In the graph workflow, stage 0 (`trading-analyst`) runs `trade_recap_data` to produce
`packages/oshal-vids-operator/out/recap-data.json`; stage 2 (`vids-operator`) runs `trade_recap_build`
to render the report from it; stage 3 (`communications-bot`) drafts + emails. The approval gate is
unchanged.

**The data script never fabricates numbers.** If the Alpaca paper creds are missing or the API call
fails, it exits non-zero with a clear message and writes nothing — the pipeline stops rather than
inventing a recap.

### recap-data.json contract

`scripts/oshal-trade-data.js` writes exactly these keys (the report generator reads them):

```json
{
  "date": "June 27, 2026",            // human, ET
  "pl": 800.57,                        // day P/L $  (equity - last_equity)
  "pct": 0.79,                         // day P/L %
  "equity": 102387.84,
  "unrealized": 1400.71,               // sum of positions unrealized_pl
  "fills": 25,                          // count of today's filled orders
  "positions": 32,                      // open positions count
  "leaders": "JNJ · TGT · WMB",        // top-3 open winners by unrealized_pl, joined with ' · '
  "winners": [["JNJ",6.46],["TGT",5.1]],// top-4 open winners [ticker, unrealized_plpc*100]
  "sells": ["LLY","GS"],               // today's SELL fill tickers (up to 6, de-duped)
  "buys": ["PM","PG"],                 // today's BUY fill tickers (up to 6, de-duped)
  "durationMs": 31000,
  "narration": "..."                   // ~2-sentence male-TTS recap built from the numbers
}
```

### Run it manually

From the repo root, with the Alpaca paper creds in the env or repo `.env`
(`ALPACA_PAPER_KEY_ID` / `ALPACA_PAPER_SECRET_KEY`, aliases accepted):

```bash
node scripts/oshal-trade-data.js && node scripts/oshal-trade-recap.js
```

The first command prints the recap JSON on stdout and writes
`packages/oshal-vids-operator/out/recap-data.json`. The second renders the report and prints
`{ "ok": true, "report": "<path-to-mp4>" }`. If the report generator
(`packages/oshal-vids-operator/build-daily-report.js`) is not present yet, the second command exits
non-zero with a clear message — run it once that file exists.

---

## Trigger the pipeline manually

### Option A — direct DB insert (fastest)

```sql
INSERT INTO tickets (ticket_id, title, ticket_type, status, priority, metadata, created_at, updated_at)
VALUES (
  gen_random_uuid(),
  'Daily Trade Recap — manual',
  'daily-trade-recap',
  'backlog',
  'medium',
  '{"source":"manual","workflowTrigger":true,"ticketType":"daily-trade-recap"}'::jsonb,
  now(), now()
);
```

`QueueManagerService` picks up the `backlog` ticket within its next poll and promotes it to `approved`
because the manifest has `autoStart: true`. The graph engine dispatches stage 0 on the following cycle.

### Option B — wait for or fire the cron

The schedule name is `workflow_daily-trade-recap`. To verify it exists and see its next-fire time:

```sql
SELECT id, task_type, cron_expression, enabled, last_fired_at
FROM schedules
WHERE task_type = 'workflow:daily-trade-recap';
```

To fire it immediately without waiting for the cron window, update the next-run timestamp to the past:

```sql
UPDATE schedules
SET next_run_at = now() - interval '1 second'
WHERE task_type = 'workflow:daily-trade-recap';
```

The schedule runtime will fire it on the next tick (typically within 60 seconds).

---

## Create or replace the schedule

The schedule is managed through `ScheduleService` inside the container. If it needs to be recreated
(e.g., after a full DB wipe), exec into the container and call the service directly, or use the
schedule API if the endpoint is exposed.

**Pattern used when the schedule was first created (replicate this):**

A `POST` to `/api/schedules` (if exposed) or a direct DB insert:

```sql
INSERT INTO schedules (id, task_type, cron_expression, enabled, task_data, owner_sub, created_at, updated_at)
VALUES (
  'workflow_daily-trade-recap',
  'workflow:daily-trade-recap',
  '15 20 * * 1-5',
  true,
  '{"title":"Daily Trade Recap"}'::jsonb,
  null,
  now(), now()
)
ON CONFLICT (id) DO UPDATE
  SET cron_expression = EXCLUDED.cron_expression,
      enabled = EXCLUDED.enabled,
      updated_at = now();
```

`task_type` must begin with `workflow:` for the `workflow-ticket-schedule-dispatch` branch to handle it.
The rest of the string (`daily-trade-recap`) is the `ticketType` that gets stamped on the created
ticket. Redis backs the schedule state; it survives container restart.

To use a different cadence (e.g., every 5 minutes for testing):

```sql
UPDATE schedules SET cron_expression = '*/5 * * * *' WHERE id = 'workflow_daily-trade-recap';
```

Restore to production after testing:

```sql
UPDATE schedules SET cron_expression = '15 20 * * 1-5' WHERE id = 'workflow_daily-trade-recap';
```

---

## Deploy and register a Vids worker

The Vids worker (`@oshal/vids-operator`) must run **on a physical machine with a screen and Chrome**,
outside the container swarm. It drives Google Vids by clicking the real browser UI.

### First-time setup on the worker machine

```bash
npm i -g @oshal/vids-operator
oshal-vids chrome        # opens a dedicated Chrome profile; sign into Google + open your Vids project
```

Leave that Chrome window open and in the foreground during worker operation.

### Start the worker (connects to the swarm)

```bash
VIDS_SWARM_URL=https://oshal.agenticfederal.us \
VIDS_SWARM_SECRET=<value of REMOTE_CLIENT_SHARED_SECRET from the swarm env> \
  oshal-vids worker
```

The worker registers at `POST /api/remote-clients`, announces capabilities `['vids.generate']` and tag
`vids`, heartbeats every 30 s, and polls for tasks. When `POST /api/vids/jobs` dispatches a job, the
worker picks it up and drives the Chrome session.

If the global `~/.codex/config.toml` has `service_tier = "priority"`, the codex CLI will error on
every vision call. Override it:

```bash
VIDS_CODEX_SERVICE_TIER=fast oshal-vids worker
```

### Verify the worker is registered

```
GET /api/vids/jobs
```

The response includes a `workers` array. A healthy worker shows `"status":"online"` or `"healthy":true`.
If the array is empty the swarm has no Vids worker and `POST /api/vids/jobs` will return `503`.

---

## Verify each stage

### Stage 0 — trading-analyst

```sql
SELECT ticket_id, status, metadata
FROM tickets
WHERE ticket_type = 'daily-trade-recap'
ORDER BY created_at DESC
LIMIT 5;
```

A ticket at status `in_progress` means the graph engine is running stage 0. A ticket at `done` with a
child ticket or output message means stage 0 completed. Check the bot logs:

```bash
docker logs oshal-api --tail 100 | grep trading-analyst
```

Stage 0 runs on the `claude-code` harness, not `codex`. It is not affected by codex quota.

### Stage 2 — vids-operator (most likely failure point)

```sql
SELECT job_id, status, idea, outcome, updated_at
FROM vids_jobs
ORDER BY created_at DESC
LIMIT 5;
```

| status | meaning |
|---|---|
| `queued` | task dispatched to worker; worker has not started yet |
| `running` | worker is driving Chrome |
| `done` | clip generated |
| `failed` | error in `outcome` column |

If `status` stays `queued` for more than 2 minutes, the worker is not responding. Check worker terminal
output and confirm it is still running.

### Stage 3 — communications-bot (email approval)

The bot calls `gmail.send` via the connector token broker. If the email does not arrive within a few
minutes of stage 3 completing:

1. Confirm the owner's Google token is stored:

```sql
SELECT user_sub, connector_id, scopes, expires_at
FROM connector_tokens
WHERE connector_id = 'google';
```

2. Confirm `gmail.send` is in the `scopes` column. If only `openid email profile` appear, the OAuth
   grant needs to be repeated with the Gmail scope.

3. Check the Drive scope is absent (expected — Vids drafts auto-save to Drive by the browser session,
   but API-level folder organisation is not available with current credentials).

---

## Troubleshooting

### The cron fires but no ticket appears

Check that the dispatch branch recognises the task type:

```bash
docker logs oshal-api --tail 200 | grep "workflow-ticket-schedule"
```

If the log line `workflow schedule missing ticketType` appears, the schedule row has a malformed
`task_type` (must be exactly `workflow:daily-trade-recap`, no extra spaces before the colon).

If the scheduler is not running at all:

```bash
docker logs oshal-api --tail 200 | grep "schedule-runtime"
```

The workflow-ticket dispatch branch bypasses the `ENABLE_AGENT_SCHEDULER` gate, but the runtime itself
must have started. A missing `REDIS_URL` env var will prevent the Redis-backed scheduler from
initialising.

### Worker not registered / POST /api/vids/jobs returns 503

- Confirm the worker process is running on the screen machine.
- Confirm `VIDS_SWARM_URL` points to the live control plane (not `localhost`).
- Confirm `VIDS_SWARM_SECRET` matches `REMOTE_CLIENT_SHARED_SECRET` in the swarm `.env`.
- Check for a firewall blocking outbound HTTPS from the worker machine to the swarm URL.

### Vids render hangs at `queued` or `running` for more than 10 minutes

Most likely the codex usage quota is exhausted on the worker machine. The vision loop is all codex
calls. Check the worker terminal for `429` or quota errors. The quota resets at the top of the next
hour on the free tier. Until it resets, the job will remain stuck; there is no retry loop — cancel it
and resubmit after reset.

### docker cp changes lost after container recreate

`vids-routes.ts` and `workflow-ticket-schedule-dispatch.ts` were deployed via `docker cp` and survive
restart but not `docker compose up --force-recreate`. To make the deploy permanent, rebuild the image:

```bash
docker compose build oshal-api
docker compose up -d oshal-api
```

After the rebuild, `RUN_MIGRATIONS=true` is not required again unless the DB was also wiped — migration
059 (`vids_jobs` table) is idempotent.

### Approval email delivered but gate does not advance

The approval gate (`n-gate-3`) waits for a `/resume` call on the ticket. Confirm the email contains a
valid approval link pointing to the correct environment URL. If the link points to a local or
staging URL from a misfired test, open the cockpit and approve manually:

```
POST /api/tickets/<ticket_id>/resume   { "decision": "approved" }
```
