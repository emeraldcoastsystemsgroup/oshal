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

The original deploy-time proofs this cycle was waiting on. Each links to the authoritative done-when text
in [../BACKLOG.md](../BACKLOG.md) — read it there rather than trusting this summary, and stamp it
there when the proof is done.

**1. K5 — the least-privilege bot role (BACKLOG "K5", code shipped, live soak outstanding).**
   1. Confirm migration `099-bot-db-role.sql` applied, then
      `SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname='oshal_bot'` → expect
      `f` / `f`. If the row is missing, see §A.5 — the migration will not retry itself.
   2. With bot containers up, confirm a bot really connects as `oshal_bot` (`SELECT current_user`).
   3. Re-run the RLS two-user live test **with bots up** — that is the leg the code cannot prove.
   4. Rotate the dev password on any shared box (`ALTER ROLE oshal_bot WITH PASSWORD …` +
      `BOT_DATABASE_URL` in `.env`).

**2. K6 — re-check the entitlement denial log** on the dev box after the deploy (BACKLOG "K6"). The
   flip to `enforce` was justified by a 7-day soak that found zero would-be denials; confirm that
   still holds once the new image is running, and that an operator path works.

**3. ADR-119 P4 — the live container-kill drill** (BACKLOG "Alert triage & consolidation", P4). Five
   steps, in order, and they need the monitoring overlay plus the profile-gated `self-healing-bot`
   container, `ALERT_WEBHOOK_TOKEN` (matching `alertmanager.yml`) and `SWARM_SERVICE_SECRET`:
   A1 leg with the kill switch off → A2 leg with `SELF_HEAL_AUTO_APPLY=true` → the recurrence bound →
   the core-infra bound (chromadb) → flip `SELF_HEAL_AUTO_APPLY` back off. **A1 is already on in
   `ops/monitoring/alert-rules.yml`** for the four container-health rules (`intake: auto`), so once
   the overlay is up their incidents auto-flow into analysis, metered by P3's budget/flap gates.

**4. Store packages needing re-registration on the core box.** Verified against the
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

**6. Known still-unproven, not deploy blockers** — recorded so they are not mistaken for regressions:
   the installer-gaps remainders (per-app smoke `--apps`, the `noop`-returns-text no-AI surface state,
   `oshal-verify.sh --live`), and the concierge-surface note that "next deployment must prove the
   running UI matches these source files".
