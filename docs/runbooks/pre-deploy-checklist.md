# Pre-deploy checklist — what to check before and after `oshal-deploy.sh`

`scripts/oshal-deploy.sh` builds the image from **committed HEAD** and recreates api-then-bots. It
hard-gates on image parity and health and auto-rolls-back to the pre-deploy image on failure, so the
deploy itself is safe. What it does **not** do is the surrounding work: nothing outside the image
moves (bind-mounted files, workspace-volume store packages), and code that shipped with a
"prove it on the running stack" done-when stays unproven until somebody does it.

This runbook is the standing procedure plus a per-cycle log of the deploy-time proofs the current
`main` is waiting on. It exists because those proofs were scattered across a dozen BACKLOG entries
and a COLLABORATE thread, and an operator about to deploy had no single place to read them.

Related: [deploy-parity.md](deploy-parity.md) (split-image drift),
[app-store-drift.md](app-store-drift.md) (stale workspace-volume packages),
[local-ci.md](local-ci.md) (the gate set), [docker-engine-memory-sizing.md](docker-engine-memory-sizing.md)
(the build peak that OOMs a running swarm).

---

## A. Before you deploy

1. **Deploy committed, pushed HEAD.** The script archives HEAD; anything uncommitted or unpushed is
   not in the image. On a shared checkout, confirm nothing is stranded first:

   ```bash
   git fetch origin
   bash scripts/check-unpushed-commits.sh --fetch   # STRANDED = someone's work is not on origin yet
   bash scripts/check-worktree-strays.sh            # linked-worktree half of the same check
   ```

   Both also run as `ci-local.sh` gates (`unpushed-commits`, `worktree-strays`).

2. **Read the plan without touching anything.**

   ```bash
   bash scripts/oshal-deploy.sh --dry-run
   ```

3. **Know what the deploy carries.** Compare the running image's commit label against `origin/main`
   rather than trusting a hand-written list — the delta is the answer:

   ```bash
   git log --oneline <running-image-commit>..origin/main
   ```

4. **Engine headroom.** The build peak and the running swarm share one VM; a build during a full
   swarm is how `Exited (137)` happens. See
   [docker-engine-memory-sizing.md](docker-engine-memory-sizing.md).

5. **Migrations.** New `scripts/migrations/*.sql` apply at api start. Two facts worth knowing before
   a deploy that carries any:
   - The ledger (`app_migrations`) is keyed on **filename**, not version number, so two files that
     share a number both apply, in filename order. `099-bot-db-role.sql` and
     `099-notify-voice-channel.sql` are independent and both run.
   - A migration that catches its own privilege error is still **recorded as applied** and will never
     retry. `099-bot-db-role.sql` is the live example: it needs `CREATEROLE`, which it has only when
     migrations run over `BOOTSTRAP_DATABASE_URL` (`OSHAL_APP_ROLE_BOOTSTRAP` defaults to `true`, so
     the default path is fine). If the operator `.env` sets that to `false`, or points
     `BOOTSTRAP_DATABASE_URL` at a non-superuser, the role is silently not created and every bot's
     DSN then points at a role that does not exist. Recovery:
     `DELETE FROM app_migrations WHERE filename='099-bot-db-role.sql'` and re-run migrations as the
     owner, or create the role by hand.

6. **Custom-DB boxes:** `BOT_DATABASE_URL` must be set beside `DATABASE_URL`. Bot services no longer
   interpolate `DATABASE_URL` at all (compose seq 5 / K5) — a box that sets only `DATABASE_URL` sends
   every bot to the compose default DSN.

## B. Right after the deploy

1. **Parity + health**

   ```bash
   bash scripts/deploy-parity-check.sh     # api and bot-nodes on the SAME image build
   bash scripts/oshal-verify.sh            # postflight trio (also baked into the image)
   bash scripts/app-store-drift-check.sh   # workspace-volume packages vs the store checkout
   ```

2. **Bind-mounted files the image does not carry.** `src/pages` (cockpit JS/CSS) and persona YAML are
   bind-mounted and update on refresh. Individually bind-mounted files do **not** — `src/api/jarvis.html`
   is mounted as a single file, so after the container recreate the new copy has to be pushed over the
   mounted one:

   ```bash
   scp src/api/jarvis.html <box>:<path-to-the-bind-mounted-copy>   # then hard-refresh the tab
   ```

   Check every inline script with `node --check` first if you edited it.

3. **Store packages live in the workspace volume, not the image.** A core deploy never updates them.
   `app-store-drift-check.sh` names the stale ones; re-stage with the volume recipe (docker cp from
   the MERGED store `origin/main`, never the working tree) and then
   `POST /api/swarm/apps/load`. Two behaviours to remember (PR #88): a re-loaded manifest whose status
   flipped to `inactive` now **actually tears down** its bots/workflow/tools/schedules, and the
   `trading` app-bundle row is deliberately left unloaded because a reload re-registers live-money
   schedules.

4. **A human must be able to log in and use it.** The testability gate is part of the deploy, not a
   follow-up.

## C. Behaviour changes to expect on a box coming from an older image

These are already merged and take effect the moment the new image runs. They are not bugs.

| Change | Effect | What to set |
|---|---|---|
| `OSHAL_EXECUTE_ENTITLEMENT` code default is now **`enforce`** (K6) | a non-operator user chatting directly with an internal-machinery bot gets 403 | populate `OSHAL_OPERATOR_SUBS` **before** inviting users; `warn`/`off` are explicit opt-outs, and an unknown value falls back to enforce |
| `TOOL_AUTH_GOOGLE_SEARCH` compose default flipped `auto` → `off` (K8) | `research-bot` no longer reaches Google Search unless opted in | set it back per-deployment in `.env` if that lane is wanted |
| Bot DSNs read `BOT_DATABASE_URL` (K5) | bots connect as least-privilege `oshal_bot`; RLS now enforces on bot paths | custom-DB boxes set `BOT_DATABASE_URL`; rotate the dev password on any shared box |
| `POST /api/swarm/apps/load` honours manifest status (PR #88) | re-loading an `inactive` manifest tears down its live registrations | intended; re-check anything that relied on the old behaviour |
| `/api/voice/synthesize` with no `providerId` resolves the **caller's** saved voice (PR #90) | the swarm default is no longer universal | nothing; per-user prefs are opt-in |

---

## Cycle log — 2026-08-01 — EXECUTED

**This cycle ran.** `main` deployed (772740e, then a8ea1ef), 34/34 healthy, parity clean.
Proven, not assumed: migrations 099x2/100/101/102/103 applied; `oshal_bot` verified
NOSUPERUSER/NOBYPASSRLS; `oshal-verify.sh` PASS on every leg; `/api/readiness` ready:true;
five store packages re-staged from the store's **origin/main** and reloaded (career-hunter
1.6.0, dnd 0.19.0, game-show 0.10.0, hello-oshal 1.1.0, switchboard 0.3.0) with
`app-store-drift-check.sh` clean afterwards; and the ADR-119 P4 container-kill drill PASSED
(see ADR-119 "What the drill found" — it exposed three breaks that had shipped green).

Four things this cycle taught, which apply to every future one:

- **The first attempt failed the BUILD, and the stack was untouched — as designed.** The image
  typechecks `tsconfig.server.json`; every gate ran `tsconfig.json`. `npm run typecheck` now
  runs BOTH (PR #98), so this cannot recur silently. A lane reporting "typecheck clean" from an
  older checkout is telling you only half the truth.
- **A private-index commit never writes to disk.** After a run of agent lanes the working tree
  can be many commits behind what is merged - and the bind-mounted surfaces (`src/api`,
  `src/pages`, personas, `ops/monitoring`, `swarm-apps`) are served FROM THE TREE, so a
  freshly deployed box can still serve stale UI. Re-sync the tree, not just the branch.
- **Env in `.env` that compose does not forward is silently absent in-container.** Third
  occurrence (TELEGRAM_*/TWILIO_*, then `ALERT_WEBHOOK_TOKEN`). Verify inside the container
  (`docker exec ... 'echo ${#VAR}'`), never in `.env` alone.
- **A "healthy" api can be a degraded api.** When memory is tight during the bot-recreate
  storm the api boots with `ENOMEM: scandir '/app/swarm-apps/connectors'` and serves with ZERO
  connector tools registered. Health and readiness both say ok. A bounce fixes it - check the
  boot log for ENOMEM after any deploy.

Monitoring specifics for this box: Prometheus's default 9090 is held by `oshal-headscale`, so
the overlay needs `PROMETHEUS_PORT=9091`; and `docker compose up -d` does **not** reload a
bind-mounted config - use `scripts/monitoring-up.sh`, which SIGHUPs prometheus + alertmanager.

**CYCLE CLOSED 2026-08-01** — every proof below was executed on the running stack and its result is
recorded inline. They are kept rather than deleted because the *procedure* is the reusable part.
Each links to the authoritative done-when text in [../BACKLOG.md](../BACKLOG.md); stamp it there.

**1. K5 — the least-privilege bot role — ✅ PROVEN 2026-08-01.** `099-bot-db-role.sql` applied and
   `oshal_bot` came back `rolsuper=f rolbypassrls=f rolcanlogin=t`. Still owed: the two-user RLS live
   test re-run with bots up, and the dev-password rotation on any shared box. Original procedure:
   1. Confirm migration `099-bot-db-role.sql` applied, then
      `SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname='oshal_bot'` → expect
      `f` / `f`. If the row is missing, see §A.5 — the migration will not retry itself.
   2. With bot containers up, confirm a bot really connects as `oshal_bot` (`SELECT current_user`).
   3. Re-run the RLS two-user live test **with bots up** — that is the leg the code cannot prove.
   4. Rotate the dev password on any shared box (`ALTER ROLE oshal_bot WITH PASSWORD …` +
      `BOT_DATABASE_URL` in `.env`).

**2. K6 — ✅ no denials observed** in the first 10 minutes after the deploy (the one advisory error
   line was the agent-id collision, not an entitlement denial). The
   flip to `enforce` was justified by a 7-day soak that found zero would-be denials; confirm that
   still holds once the new image is running, and that an operator path works.

**3. ADR-119 P4 — the live container-kill drill — ✅ A1 RUN 2026-08-01, ✅ A2 LEGS RUN 2026-08-02.**
   **The A2 legs found two MORE breaks, both of which made unattended apply impossible**, and both
   invisible to all 32 P1–P4 guards for the same reason the first three were: every guard stubs the
   `RemediationExecutor`, and both breaks were in what the executor talks to. `POST /api/self-heal/apply`
   was registered only on the `BOT_RUNTIME=any-bot` legacy server that nothing in compose runs, so the
   real self-healing node answered an HTML 404; and the docker inspect template asked for
   `{{.State.RestartCount}}` (not a field — docker emits nothing) with an unguarded
   `{{.State.Health.Status}}`, so every observation threw and returned `status:'not-found'` **with
   `success:true`** — meaning a *successful* restart would still have escalated `verify-failed`. Both
   fixed in PR #117. Results, with the kill switch on: **auto-apply PASS ×3** (tickets `27e3805e`
   incident-remediation, `703279ce` cloud-ops-bot, `01b2c1ef` home-bot — each `complete` /
   `auto_applied_verified` / `applied-and-verified`, target observed running before close); **hourly cap
   PASS** (the 4th proposal onward: `reason: hourly-cap-reached`, parked at `customer_action`);
   **recurrence PASS** (ticket `0f1e314c`, `recurrenceOf: 01b2c1ef` → `escalated` with
   `auto-apply-blocked:recurrence` + `needs-attention` and NO apply record); **core-infra NOT
   EXERCISED** — the chromadb alert bundled onto the research-bot incident (Stage-D, `hops: 2`) and
   became its `rootCandidate`, but that incident finalized **Mode B**, and Mode B never consults the
   auto-apply hook. Kill switch flipped back to `false` and the api recreated. Full write-up in
   ADR-119 §"What the A2 legs found". **Three things that will cost the next person an hour:** a
   `customer_action` ticket is an OPEN incident, so a refire CONSOLIDATES onto it and never re-enters
   the pipeline — A1's own output blocks A2 on the same key until a human closes the ticket;
   alertmanager will not re-deliver a same-fingerprint refire inside `group_interval`/`repeat_interval`
   (5m/4h) and restarting it does not clear that, so drill deliveries go to the real fail-closed
   receiver directly; and stopping 30 bots at once parked all 30 tickets `analysis-skipped:budget` at
   zero spend, which is the P3 cost bound working. Original 2026-08-01 record follows.
   **The first run found three breaks** (fixed in #99/#100, then re-run green). The first run proved the ladder was not operational even though every
   unit guard passed: the intake could not insert a ticket (owner-RLS refused the identity-less machine
   write), the rules matched nothing (cAdvisor emits no container series on Docker Desktop 29's
   containerd image store), and `ALERT_WEBHOOK_TOKEN` was never forwarded into the api by compose —
   and since the receiver is fail-closed, the ladder was unreachable while merely *looking* quiet.
   Final run: stop `research-bot` → alert in ~95s carrying `container=oshal-local-research-bot
   intake=auto` → ticket `34e1a1c8-…` owned by `alert:prometheus`, RCA ran, action gated at
   `customer_action` → restart → FR-E4 resolved both members. Zero active alerts on a healthy stack,
   where before there were two permanent false alarms. **Keep this lesson: all four phases stubbed the
   ticket gateway in their guards, which is exactly why it shipped green.** A2's legs ran 2026-08-02 — auto-apply and
   the recurrence bound PASS, the core-infra bound still unexercised (see above). Original procedure — five
   steps, in order, and they need the monitoring overlay plus the profile-gated `self-healing-bot`
   container, `ALERT_WEBHOOK_TOKEN` (matching `alertmanager.yml`) and `SWARM_SERVICE_SECRET`:
   A1 leg with the kill switch off → A2 leg with `SELF_HEAL_AUTO_APPLY=true` → the recurrence bound →
   the core-infra bound (chromadb) → flip `SELF_HEAL_AUTO_APPLY` back off. **A1 is already on in
   `ops/monitoring/alert-rules.yml`** for the four container-health rules (`intake: auto`), so once
   the overlay is up their incidents auto-flow into analysis, metered by P3's budget/flap gates.

**4. Store packages — ✅ RE-STAGED AND RELOADED 2026-08-01** from the store's merged `origin/main`
   (never the working tree): career-hunter 1.6.0, switchboard 0.3.0, game-show 0.10.0, dnd 0.19.0 and
   hello-oshal 1.1.0 — which the table below missed and `app-store-drift-check.sh` caught. Trust the
   script over a hand-written list. Drift check clean afterwards. Original note, verified against the
   `oshal-applications` thread, not assumed — re-check with `app-store-drift-check.sh`, which reads
   actual volume state:

   | package | store version | what the store thread says |
   |---|---|---|
   | `career-hunter` | 1.6.0 | core box still registers 1.5.0 (PR #26) |
   | `switchboard` | 0.3.0 | runtime registration happens on the core box (PR #29) |
   | `game-show` | 0.10.0 | NOT deployed — volume still serves 0.9.0 (PR #31) |
   | `dnd` | 0.19.0 | NOT deployed — volume still serves 0.18.x (PR #31) |

   Two more moved the same night and the store thread records them as already handled — verify rather
   than re-stage blindly: `presentations` 2.3.1 (2.3.0 deployed, the 2.3.1 patch deploying on the same
   volume recipe) and `payroll` 1.0.0/1.1 (installed and hot-loaded, live-smoked).

**5. `src/api/jarvis.html`** — bind-mounted per file; do the §B.2 copy after the recreate (PR #90).
   ✅ Handled on the dev box as part of a wider fix worth generalising: the entire bind-mounted set
   (`src/api`, `src/pages`, `ai-lab/bot-personas`, `ops/monitoring`, `swarm-apps` — 271 files) was
   refreshed from `origin/main`. **A checkout that lags `main` serves stale cockpit and persona assets
   from disk however current the image is, so reconcile ALL bind-mounted paths after a recreate, not
   just this one file.**

**6. CORE-05 is source-complete; running-image proof remains a release check** — the canonical
   verifier now supports package-owned `--apps` smokes, no-AI routes return HTTP 503 `ai_disabled`
   and their web surfaces render that state, and explicit `--live` performs one PAT-authorized
   generation with owner-scoped cost attribution. Before release, prove the exact candidate image:

   ```bash
   bash scripts/oshal-verify.sh --env-file .env --apps <comma-separated-installed-apps>
   OSHAL_VERIFY_PAT='oshal_pat_...' bash scripts/oshal-verify.sh --live
   ```

   A source test is not deployment evidence. Preserve the concierge-surface requirement that the
   next deployment must also prove the running UI matches the reviewed source files.
