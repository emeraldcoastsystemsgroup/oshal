# Deploying the Vids Operator

Two independent things ship here:

1. **The operator** (`@oshal/vids-operator`) — runs on any machine with a screen +
   Chrome. Local panel and/or swarm worker. **Works standalone today.**
2. **The framework app** (`swarm-apps/vids.yaml` + friends) — the cockpit tile +
   `/api/vids` surface. **Off by default; one activation step remains.**

---

## 1. Run the operator locally (hands-off)

```bash
npx @oshal/vids-operator chrome     # debug Chrome on a dedicated profile
# sign into Google + open your Vids project in that window
npx @oshal/vids-operator            # panel at http://localhost:8074
```

Type a prompt → Queue → watch it drive your Chrome. Chat with the Veo specialist.

If your global `~/.codex/config.toml` sets a `service_tier` the current codex CLI
rejects (e.g. `priority`), set `VIDS_CODEX_SERVICE_TIER=fast` (or fix the config).

## 2. Deploy to a REMOTE PC as a swarm worker

On the remote machine (has a screen, Chrome, and `codex` logged in):

```bash
npm i -g @oshal/vids-operator
oshal-vids chrome                   # sign into Google + open Vids once
VIDS_SWARM_URL=https://oshal.agenticfederal.us \
VIDS_SWARM_SECRET=<REMOTE_CLIENT_SHARED_SECRET> \
  oshal-vids worker
```

The worker registers with the control plane, heartbeats, and polls for jobs. It
exposes these tools the swarm can call as `mcp.call-tool`:

- `vids.generate` `{ prompt, orientation?, insertMode?, ingredientPath? }`
- `vids.chat` `{ message }`
- `vids.story` `{ idea | plan, spoke? }`
- `brand.graphic` `{ brief, voiceover?, music?, musicMood?, voice? }` — on-brand
  OSHAL motion graphic (the validated electric-"oshal" look; see BRAND-THEME.md).
- `brand.intro` `{ brief, voiceover?, music? }` — the full OSHAL intro
  (graphic + optional Tyra voiceover + serious evening-news music).

Any swarm dispatcher (or a direct `POST /api/remote-clients/:clientId/tasks`) that
enqueues `mcp.call-tool` with `input:{ name:'vids.generate', arguments:{…} }` will
run on this machine's Chrome and post the result back. **This is the
"generate in the background from the swarm" path — it needs no framework rebuild.**

The auth header defaults to `x-remote-client-key`; the control plane reads
`REMOTE_CLIENT_SHARED_SECRET` (or `REMOTE_CLIENT_CONTROL_PLANE_TOKEN`).

## 3. Activate the cockpit app (optional)

To surface the tile + job queue in the cockpit and wire the `vids_generate` CLI
tool, finish these steps in the open-shal repo:

1. Add `src/app/routes/vids-routes.ts` exporting `createVidsRoutes(ctx)` with:
   - `POST /api/vids/jobs` — insert a `vids_jobs` row, then enqueue an
     `mcp.call-tool { name:'vids.generate', arguments }` task to the registered
     Vids worker via the exported `remoteClientRegistry` (from
     `src/app/routes/remote-client-routes.ts`, `registry.enqueueTask(clientId, …)`).
     A body with `kind:'brand'` (from the brand-graphics store package's
     `tools/oshal-brand.js`, backing its `brand_graphic` tool — carved out of
     core 2026-07-17, ADR-085 Wave 1) instead enqueues
     `name:'brand.intro'` (or `'brand.graphic'` when `brandMode:'graphic'`) with
     `{ brief, subject, voiceover, music, musicMood, voice }` — same worker, same
     registry, no extra plumbing. The worker runs `src/brand/graphics.js`.
   - `GET /api/vids/jobs` — list rows.
   - `GET /api/vids/app` — the job-queue surface (theme via the design-system bridge).
2. Mount it in `src/app/server.ts` next to the other app routes:
   `app.use('/api/vids', createVidsRoutes(ctx))`.
3. Rebuild `oshal-api`, run with `RUN_MIGRATIONS=true` (applies `059-vids-platform.sql`).
4. Flip `swarm-apps/vids.yaml` `status: active` and reload the app
   (`POST /api/swarm/apps/load { "path": "swarm-apps/vids.yaml" }` or restart).
5. Verify: `/cockpit?app=vids` shows the tile; a `vids` ticket routes to
   `vids-operator`; `vids_generate` enqueues to the worker.

Migration `059`, the manifest, persona, and `scripts/oshal-vids.js` are already in
place; only the route module + server mount remain (kept out of the tree so an
unfinished route can't break the `tsc` build).
