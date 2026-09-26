# Jarvis says "Sorry — I couldn't do that just now"

## 2026-09-26 forward status

- The real-Chromium/isolated-Postgres legacy-thread guard has now executed green (2/2), alongside the dashboard browser suite (19/19). The installed Test Lab **Briefing settings client** asset step also reads `pass`; these receipts are in `COLLABORATE.md`.
- Source now registers a signed-in `cockpit-daily-dashboard` lifecycle step. It seeds a uniquely tagged issuer-less task through the task store, requires the real `/api/jarvis/ask` to return `404 session_not_found`, starts a fresh thread with the deterministic weather-location clarification, checks the persisted owner issuer, and removes its exact threads, messages and synthetic chat ticket. It refuses to write without a verified issuer and session cookie; incomplete cleanup is a failure. This is **source/test proof only until deployed and run by the signed-in operator**.
- The two older live scripts and the historic exact-ID token/thread cleanup below remain unproven. Do not treat the source step or asset receipt as closure of the backlog item. In particular, the operator-ask script uses a bootstrap PAT without issuer provenance and the guest script's stock-market prompt now routes to Trading; review those scripts before running either on the live box.

That sentence is the Jarvis page's catch-all for **any** non-OK answer from `POST /api/jarvis/ask`.
It is not a model failure. Read the HTTP status in the browser devtools Network tab first; the two
causes met on 2026-09-13 are below, with what was fixed, what was proven, and what is still owed.

## Triage in one minute

| Devtools shows | Cause | State |
|---|---|---|
| `POST /api/jarvis/ask` → **404** `{"error":"session_not_found"}` | The page keeps a thread id in `localStorage.jarvisSessionId` until "New chat". Under `OSHAL_APPLICATION_AUTHORIZATION_MODE=enforce` the server refuses a thread it cannot attribute to the current sign-in: every thread created before issuer provenance landed (2026-09-11, `c18f057a`) carries no `oshalOwnerPrincipalIssuer`, and so does a thread opened under another sign-in. That refusal is deliberate and guarded in `tests/unit/protected-jarvis-results.spec.ts`. | **Fixed in `7aae3ce5`** (page side, live on reload — `src/api/jarvis.html` is bind-mounted). |
| `GET /api/jarvis/briefings/client.js` → **404** with `application/json` and "Refused to execute script … MIME type" | `jarvis-briefing-routes.ts` resolved its page assets through `__dirname/../../pages`. `src/pages/**` is excluded from `tsconfig.server.json`, so in the baked image that is `dist/pages/…`, which does not exist; the missing file fell through to the app-level error handler as a JSON 404. | **Fixed in `7aae3ce5`** (router side, needs the next core deploy). |
| `POST /api/jarvis/ask` → **404** `{"error":"session_not_found"}` **on a brand-new thread too** | The ownership read behind the gate was raising a SQL type error. See "The 2026-09-14 cause" below. | **Fixed in the tree; NEEDS A CORE DEPLOY.** |
| `POST /api/jarvis/ask` → 401 | No session / expired session. | Sign in again. |
| `POST /api/jarvis/ask` → 503 `ai_disabled` | Deployment declared `OSHAL_NO_AI=true`. | Expected. |

## What the fix does

- **Page** ([src/api/jarvis.html](../../src/api/jarvis.html)): on `404 session_not_found` the page rolls to a
  fresh thread id (`rollToFreshThread`, keeps the screen), tells the user, and resends the same turn
  **once**. A refusal of the fresh thread surfaces as one readable error ("Jarvis could not open a
  conversation for your current sign-in") instead of looping. The old thread's history is not
  deleted; it simply cannot be attributed to the current sign-in, so Jarvis does not carry its
  context forward.
- **Router** ([src/app/routes/jarvis-briefing-routes.ts](../../src/app/routes/jarvis-briefing-routes.ts)):
  page assets resolve from `<cwd>/src/pages/jarvis-briefings` like every other page route, with the
  `__dirname` candidate kept for ts-node layouts; a missing asset is a plain 404 from the router.

## Guards (all in the tree)

| Guard | Boundary it crosses | Status |
|---|---|---|
| `tests/unit/jarvis-dashboard-browser.spec.ts` — two Chromium cases: refused bookmarked thread → roll + resend once; refusal of the fresh thread → one readable error, no third ask | real page ↔ the server's real `session_not_found` contract (fixture answers it at HTTP) | **green 19/19; proven red on the pre-fix page** |
| `tests/unit/jarvis-briefing-assets.spec.ts` — exact bytes/MIME/cache through the real briefing router, auth gate, and a layout rule: no route under `src/app/routes` may reach a page asset only via `__dirname` while the server build excludes `src/pages` | real router ↔ the build layout | **green 4/4; proven red on the pre-fix router** |
| Test Lab `cockpit-daily-dashboard` step "Briefing settings client" (`src/app/routes/test-lab-dashboard-scenarios.ts`) | the **running image** on the box, as the signed-in user | **pass on 2026-09-26** |
| `tests/unit/jarvis-legacy-thread-browser.spec.ts` — the real page in Chromium against the **real Jarvis router and an isolated Postgres** (`createProtectedJarvisFixture`): legacy row planted, first ask 404, page rolls, second ask 202, answer renders, new row carries the caller's issuer; plus the owned-thread control case | page ↔ real router ↔ real database (only the model turn is doubled) | **green 2/2 on 2026-09-26** |
| Test Lab `cockpit-daily-dashboard` step "Refused thread rolls to an owned fresh thread and cleans up" | signed-in installed router ↔ persistent task store ↔ exact synthetic cleanup | **source registered, unit guard green; installed run pending** |

## What was proven on the live box (2026-09-14, image `1694a3ca`, includes `c18f057a`)

- The mounted page inside `oshal-local-api` carries the fix (`grep -c rollToFreshThread /app/src/api/jarvis.html` → 2).
- The image has **no** `dist/pages`; `/app/src/pages/jarvis-briefings/{client.js,index.html}` exist; the compiled
  route still says `resolve(__dirname, '../../pages/jarvis-briefings/client.js')` until the deploy.
- `chat_tasks`: 56 `jarvis-chat` rows, **56 without an issuer, 0 created since 2026-09-11** — every ask since then
  failed on the bookmarked thread. The operator's main thread (72 messages, last update 08-31) is one of them.
- As the operator through a time-boxed PAT on loopback (minted and revoked by id): `POST /api/jarvis/ask` on a
  thread owned by another sub → `404 {"error":"session_not_found"}` (ownership fails before any write);
  `GET /api/jarvis/briefings/client.js` → `404 application/json` naming `/app/dist/pages/jarvis-briefings/client.js`.

## What is NOT proven yet (do these first when continuing)

1. **A signed-in ask on the live box.** Agents cannot obtain the operator's Google session. The two automated
   substitutes both hit engine wedges on 2026-09-14 (Docker Desktop on this host wedges when free memory is
   ~1 GB; two other sessions were building images at the time):
   - `scripts/operations/jarvis-live-operator-ask.js` — the operator's real question through the live brain via a
     PAT (bootstrap PATs carry **no issuer**, so this path does not reproduce the 404; it proves the brain answers).
   - `scripts/operations/jarvis-live-guest-e2e.js` — real Chromium on the live page as a **guest** (a real issuer,
     `urn:oshal:guest`), with a planted issuer-less thread, so it reproduces the refusal and the page's recovery.
2. **`tests/unit/jarvis-legacy-thread-browser.spec.ts` has not run.** Same cause: `DisposableAlertPostgres`
   could not start its `postgres:16-alpine` container. It is registered in the Test Lab dashboard scenario as a
   browser-level regression reference.
3. ~~**The core deploy** that makes the briefings asset fix live~~ — **done 2026-09-14.** PR 431 merged to `main` as
   `b8de2099`, and `scripts/oshal-deploy.sh` deployed that commit (image `1fe73566ae87`); the briefing-asset fix
   `7aae3ce5` is an ancestor of it. What is left: the Test Lab "Briefing settings client" step must read `pass`.

## How to continue (exact steps)

```bash
# 0. Box sanity: engine answering, api healthy, >2 GB free host memory, no image build running
docker ps --format '{{.Names}} {{.Status}}' | grep -E 'oshal-local-(api|db)'
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:35457/api/health

# 1. Prove the real-boundary spec (one disposable Postgres; ~2 min)
npx vitest run tests/unit/jarvis-legacy-thread-browser.spec.ts tests/unit/protected-jarvis-results.spec.ts

# 2. Live: the operator's question through the real brain (runs INSIDE the api container; prints the answer;
#    closes the test thread's ticket; revokes the PAT by id). Never run it against the operator's own legacy
#    thread — a bootstrap PAT has no issuer and WOULD run a turn on it.
SUB=$(docker exec oshal-local-db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "select owner_sub from chat_tasks where task_id like '"'"'jarvis-1069251%'"'"' order by updated_at desc limit 1"')
MSYS_NO_PATHCONV=1 docker cp "C:/Projects/oshal/scripts/operations/jarvis-live-operator-ask.js" oshal-local-api:/tmp/ask.js
docker exec -e PROBE_SUB="$SUB" -e PROBE_SESSION=jarvis-validate-$(date +%s) oshal-local-api node /tmp/ask.js
# Use a Windows drive-letter path for docker cp under Git Bash, and `docker exec` WITHOUT `-i` (an stdin pipe hangs).

# 3. Live: the real page in Chromium as a guest, with a planted legacy thread (runs on the host)
NODE_PATH=C:/Projects/oshal/node_modules BASE=http://127.0.0.1:35457 OUT_DIR=/tmp node scripts/operations/jarvis-live-guest-e2e.js
# Expect: asks[0] 404 session_not_found on the planted id, asks[1] 202 on a fresh jarvis-<uuid>, an answer bubble,
# newThreadRow with issuer=urn:oshal:guest, the planted row deleted, the guest session ended.

# 4. Read what the live ask persisted (the result endpoint refuses machine principals — read the DB)
docker exec oshal-local-db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "select role, left(text,300) from chat_messages where task_id like '"'"'jarvis-validate-%'"'"' order by created_at"'
```

## Cleanup owed on the box (verify, do not assume)

- PATs labelled `jarvis-operator-ask-56e3d403` and `jarvis-ask-probe-56e3d403`: the probe token is confirmed
  revoked; the operator-ask token's revoke statements timed out on the wedged engine twice — check
  `oshal_cli_tokens` and revoke **by id** if `revoked_at` is null (it expires in 30 days regardless).
- Threads `jarvis-validate-56e3d403*` (test threads created by the operator-ask runs, if any reached the server)
  and rows `jarvis-legacy-e2e-*` (planted by the guest run, if any reached the database): delete by exact id.

## Why the router refusal must not be "fixed" in core

The refusal protects a thread from being appended to by a same-`sub` principal from a different issuer.
The 2026-09-11 change made it fail closed on purpose and tests it. The page-side roll is the correct
recovery: the thread id was only ever a browser bookmark.

## The 2026-09-14 cause: every ask 404'd, including fresh threads (root-caused; fix deployed 2026-09-14)

**Symptom.** Every `POST /api/jarvis/ask` answered `404 session_not_found` — not just bookmarked
threads. The page rolled to a fresh thread, the fresh thread was refused too, and the operator heard
only the generic "Sorry — I couldn't do that just now."

**Fingerprint in the database.** The refused threads sit at `chat_tasks.status = 'created'`.
`ensureSessionTask` creates the row, and `markJarvisSessionTaskStatus(…, 'processing')` runs *after*
the ownership gate — so `created` means the gate refused. Every thread that ever worked went to
`active` or `processing`; on 2026-09-14 the only four `created` rows in the whole table were the
three the operator produced at 06:10Z and one probe.

**Chain.** `POST /ask` → `canReadJarvisSession` → `canReadProtectedResult` →
`isProtectedAgent(JARVIS_AGENT_ID)` → `readApplicationExecutionOwnership(pool, {kind:'bots', …})`.
That last call ran `$1=ANY(agent_ids)` with `$1` bound as **text**, while
`swarm_applications.agent_ids` is **`UUID[]`** (migration 022). PostgreSQL has no `text = uuid`
operator, so the query raised, the reader converted it to `ApplicationOwnershipUnavailableError`,
and `canReadProtectedResult`'s bare `catch { return false; }` turned that into a plain refusal —
**with nothing logged at any level**. `kind:'tools'` was unaffected because `tool_names` is `TEXT[]`
in both tables, which is exactly the asymmetry the guard reproduces.

Measured in the running container as the real `oshal_app` role:

```
readApplicationExecutionOwnership(pool,{kind:'bots',id:'a0000000-…-050',mode:'enforce'})
  → ApplicationOwnershipUnavailableError  (11 ms)
raw query as oshal_app → error: operator does not exist: text = uuid
```

**Since when.** `canReadJarvisSession` entered the ask path in `c18f057a` (2026-09-11). That matches
the already-recorded fact that **zero** `jarvis-chat` rows had been created since 2026-09-11. It has
nothing to do with any package installed on 2026-09-14 — that correlation is a red herring.

**Fix.** `src/app/application-execution-ownership.ts` compares as text on both sides
(`$1=ANY(<column>::text[])`), which is a no-op on the `TEXT[]` column and correct on the `UUID[]`
one, and logs the previously silent failure at ERROR. Guard:
`tests/unit/application-execution-ownership-postgres.spec.ts` — the real reader against a real
PostgreSQL carrying migration 022's real `UUID[]` column; 5/5 green, and proven red on the pre-fix
query (the three `bots` cases fail with `ApplicationOwnershipUnavailableError`, `tools` still passes).

**This is `src/app/**`, which is baked into the image — Jarvis stays broken until
`bash scripts/oshal-deploy.sh` runs.** That deploy has happened: `086832cf` is on `main` and an ancestor
of `b8de2099`, which `scripts/oshal-deploy.sh` deployed on 2026-09-14 (checked against git and the
deploy log). There is no live workaround: the failure is a query/plan type
mismatch, independent of data, so no row edit or restart changes it. Do **not** "fix" it by altering
`swarm_applications.agent_ids` to `TEXT[]` — migration 022 declares `UUID[]` and
`jarvis-orchestrator.ts` joins `agents.agent_id` (uuid) to `sa.agent_ids[1]`.

## Related

- [deploy-parity.md](./deploy-parity.md) — the one deploy command.
- [localhost-wedge-wslrelay.md](./localhost-wedge-wslrelay.md) and
  [docker-engine-memory-sizing.md](./docker-engine-memory-sizing.md) — the engine wedge shapes that blocked
  the live runs.
- `docs/BACKLOG.md` — "Jarvis refused-thread recovery: finish the live proof and make it a Test Lab step".
