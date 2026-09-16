# Installing oshal on a second machine as a self-healing, self-developing swarm

For an operator standing up oshal on a box that is not the dev host, who wants that box to
monitor and repair itself and to develop its own core.

Three things this runbook settles, because all three are routinely got wrong on a fresh box:

1. **The App Loader is not missing.** It ships, it is operator-gated, and it is fail-closed —
   an install that never named an operator has no operator, so the rail entry is never drawn.
2. **`docker compose up` from the README is not the install.** `scripts/oshal-install.sh` is.
   The bare compose path skips the identity wiring that makes you the operator.
3. **Hot-swap is not what makes a swarm self-coding.** It is the contributor inner loop.
   The self-development rails are ADR-081 and ADR-077, and neither depends on it.

---

## 1. Why the box has no App Loader

The surface exists. `src/pages/app-loader/index.html` is registered at `/app-loader` in
[server-ui-assets.ts](../../src/app/server-ui-assets.ts), and the cockpit rail entry is pushed in
[RibbonNav.js](../../src/pages/cockpit/js/components/RibbonNav.js) — but only inside the
`this.isOperator` branch. That flag comes from `/api/governance/whoami` →
`isOperatorIdentity()` in [authz.ts](../../src/shared/middleware/authz.ts), which consults, in
order:

1. the `swarm_roles` snapshot (ADR-148), then
2. the env allowlist `OSHAL_OPERATOR_SUBS` / `OSHAL_OPERATOR_EMAILS` — permanent break-glass.

Both are **fail-closed**: an unloaded roles cache grants nothing and an empty allowlist grants
nothing. A box installed without `--admin-email`, or brought up with a hand-written
`docker compose up`, satisfies neither. Nobody is an operator, so the App Loader entry is never
added to the rail and `/app-loader` itself answers with its explanatory screen. The route is
`requiresOperator` server-side regardless, so revealing the tile without fixing identity would
change nothing.

**The second landmine, which defeats the obvious fix.** With `MOCK_OIDC=true` there is no sign-in
page at all: [oidc.ts](../../src/shared/middleware/oidc.ts) fabricates a fixed identity
(`alex@demo.local` / sub `mock-user-001`) and `requiresAuth` becomes a pass-through. Putting your
real email in `OSHAL_OPERATOR_EMAILS` therefore does nothing on its own — the session is still
`alex@demo.local`. The mock identity has to be moved to you at the same time.

### Fix on a box that is already up

Write all four keys into the box's `.env`, then restart the api:

```bash
# .env — the sub must be stable across reinstalls; this is the same derivation both installers use.
MOCK_OIDC=true
MOCK_OIDC_EMAIL=you@example.com
MOCK_OIDC_NAME=Your Name
MOCK_OIDC_SUB=local-<first 16 hex of sha256 of the lowercased email>
OSHAL_OPERATOR_EMAILS=you@example.com
OSHAL_OPERATOR_SUBS=local-<the same value as MOCK_OIDC_SUB>
```

```bash
# the sub, derived the way local_sub() in oshal-install.sh derives it
printf '%s' "you@example.com" | tr 'A-Z' 'a-z' | sha256sum | cut -c1-16 | sed 's/^/local-/'

docker compose -f docker-compose.oshal-local.yml restart oshal-api
```

Reload `/cockpit/`. **App Loader** and **Users** appear in the bottom platform tray.

Re-running `scripts/oshal-install.sh --admin-email you@example.com` against the same directory
writes the same block for you and is idempotent — `.env` and `config-seed/` are never overwritten
on a re-run, so it will not clobber an existing file; edit by hand in that case.

### Installing apps without operator rights

`/applications` — the **Explore apps** surface — is browsable by everyone and is where the
catalog lives. Its install buttons hand off to `/app-loader/?registry=…&name=…`, which is
operator-only. So a non-operator can see the catalog and nothing more; that is by design, not a
missing UX.

---

## 2. How the install should have been run

```bash
curl -fsSLO https://raw.githubusercontent.com/emeraldcoastsystemsgroup/oshal/main/scripts/oshal-install.sh
bash oshal-install.sh --mode 2 --admin-email you@example.com --bundle full
```

`--mode 2` is the **source** path: `git clone` + `docker build -f Dockerfile.oshal` + the same
health-ordered bring-up, against `docker-compose.oshal-local.yml` with its bind mounts. It is the
contributor path, and it is the one to use here — the self-development rails in §5 need a real
git checkout with a `.git` directory on the box, which mode 1 (registry image, no source) does not
produce.

What the installer does that `git clone` + `docker compose up` does not:

| | installer | bare compose |
|---|---|---|
| generates `POSTGRES_PASSWORD`, `SESSION_SECRET`, `SWARM_SERVICE_SECRET`, … | yes | no — you write them |
| wires `MOCK_OIDC_EMAIL/NAME/SUB` + `OSHAL_OPERATOR_EMAILS` from `--admin-email` | yes | **no — this is §1** |
| health-ordered bring-up (infra healthy → api healthy + apps auto-loaded → bots in batches) | yes | no |
| stages store packages through the audited `oshal-app.js install` rail (`--bundle`, `--apps`) | yes | no |
| opens `/welcome` and prints the superadmin steps | yes | no |

Full flag reference and the four modes: [INSTALL.md](../../INSTALL.md).

A box that already ran bare compose does **not** need reinstalling. Apply §1, then continue at §3.

---

## 3. What comes after core

1. **`/welcome` — connect an AI model.** Mandatory and browser-only; the wizard will not let you
   past it, and `/cockpit` 302s back to the wizard while onboarding is incomplete (dropping any
   query or hash on the way, so deep links into the cockpit do not work yet). Free shared model,
   an API key, or a Claude/Codex login all satisfy it.
2. **Become the operator** — §1, if `--admin-email` was not passed.
3. **Verify the box.** `bash scripts/oshal-verify.sh`, or `GET /api/readiness`. `docker ps` is not
   enough: the api healthcheck is shallow HTTP and reports healthy while DB-less.
4. **Install apps**, any of three ways:
   - cockpit → **Explore apps** (`/applications`) → install (operator),
   - the **App Loader** tray entry for a package from any trusted git source (ADR-147),
   - re-run the installer with `--apps name1,name2`.
5. **Optional bots and overlays** — §4 and §5.

Nothing above is a rebuild. After an engine restart use `bash scripts/oshal-up.sh`, not a bare
`compose up`: containers auto-start out of order and Postgres/Chroma can exit 255 while the api
comes up DB-less and still reports healthy.

---

## 4. Self-healing

Prometheus → Alertmanager → `POST /api/alerts/alertmanager` → incident ticket → the `incident-rca`
pipeline proposes a fix → an approve-or-close gate → `self-healing-bot` restarts the container.
Every consequential action is a ticket you can see and gate.

Full procedure, including the five things that must line up before the bot can actually heal
anything: [self-healing-monitoring.md](./self-healing-monitoring.md).

```bash
docker compose -f docker-compose.oshal-local.yml up -d
docker compose -f docker-compose.monitoring.yml up -d
docker compose -f docker-compose.oshal-local.yml --profile incident up -d self-healing-bot
```

The monitoring overlay discovers scrape targets by the `oshal.tier: worker` label, so a bot that
inherits `x-bot-common` is scraped with no edit to `ops/monitoring/prometheus.yml`.

To keep the loop human-gated at the front, set `ALERT_DEFAULT_INTAKE=backlog` on `oshal-api`.

---

## 5. Self-developing

Two separate rails. They do different jobs and a box can run either, both, or neither.

| | Rail A — in-swarm dev bot | Rail B — dev-node sidecar |
|---|---|---|
| ADR | [081](../adr/081-oshal-developer-bot-and-idle-timeouts.md) | [077](../adr/077-self-developing-platform-and-super-admin-dev-console.md) |
| What it does | ordinary platform **feature work** from a ticket | browser-driven **self-edit** and **recovery**, approve-per-diff |
| Entry point | ticketType `oshal-dev` (Jarvis marks platform work with `platform: true`, ADR-083) | the Jarvis orb → **Dev** panel |
| Where it edits | its own clone, `/app/dev-repo` (named volume `oshal-dev-repo`) — never the live tree | a locked-down container, then a governed `dev-session/*` git worktree |
| Where it runs | the `oshal-developer` bot-node container | a **host** process (`npm run dev:node`) — it needs `.git` and docker |
| Gate | ticket owner must be on `OSHAL_SUPERADMIN_SUBS` | `OSHAL_DEV_CONSOLE_ENABLED` **and** `OSHAL_SUPERADMIN_EMAILS/SUBS` |

The split is deliberate: the thing that fixes a swarm cannot live inside the swarm, so recovery is
Rail B — but ordinary feature work is Rail A.

### Rail A — the `oshal-developer` bot

Already in `docker-compose.oshal-local.yml` and in the `kernel` bundle. Configure in `.env`:

```bash
OSHAL_SUPERADMIN_SUBS=local-<your sub>       # privileged dispatch; without this every oshal-dev ticket escalates
OSHAL_DEV_REPO_URL=https://github.com/<you>/<your fork or the trunk>.git
OSHAL_DEV_REPO_BRANCH=main
OSHAL_DEV_REPO_TOKEN=<fine-grained token, contents:rw>   # private repos; read at use time, never persisted
OSHAL_DEV_OWNER_SUB=local-<your sub>         # owner of the 04:00 nightly docs ticket; unset = no nightly
```

The bot works branch → PR → merge. It does not push to `main`; `main` is branch-protected
(ADR-115).

### Rail B — the dev-node

```bash
# .env on the api
OSHAL_DEV_CONSOLE_ENABLED=true
OSHAL_SUPERADMIN_EMAILS=you@example.com
OSHAL_DEV_NODE_URL=http://host.docker.internal:35460
OSHAL_DEV_NODE_SECRET=<>=32 random chars, same value on both sides>

# on the host, in the checkout
OSHAL_DEV_NODE_PORT=35460
OSHAL_REPO_ROOT=/abs/path/to/the/checkout
npm run dev:node          # must stay running — a terminal that closes takes it with it
```

Then cockpit → Jarvis orb → **Dev** → **Run demo**: a safe no-op edit that proves the whole pipe
with no LLM and no network. Real agent mode additionally needs `OSHAL_DEV_AGENT_NETWORK` (a
narrow egress-allowlist network — it refuses to start on `bridge`, because open egress plus the
seeded repo plus mounted credentials is an exfil path), `OSHAL_DEV_AGENT_IMAGE` and
`OSHAL_DEV_AGENT_CREDS`.

Two further capabilities, both off by default and both acting on the live box:

- `OSHAL_DEV_LIVE_APPLY=true` — approved **asset / manifest / persona / package** changes are
  written straight into the checkout and take that class's restart action. **core and infra
  changes are refused here by construction.** A change *set* takes its highest-severity class, so
  one `.ts` file among fifty assets makes the whole set core.
- `OSHAL_DEV_PROMOTE=true` — runs `scripts/oshal-deploy.sh` for core changes already merged to the
  trunk, preserving its four-outcome exit contract (0 deployed / 1 rolled back, still serving /
  2 preflight refused / 3 nothing serving, needs hands).

Do **not** point `OSHAL_REPO_ROOT` at the repo mount the api container holds. An api container
writing the host `.git` is the Rule-0a shared-index hazard from a tenant-serving process; `/apply`
and `/promote` always proxy to the dev-node and are never served in-process.

### The blocker both rails will hit on a fresh box

`oshal-developer` ships `FORCE_LLM_PROVIDER: openai-codex`, and `openai-codex` is in the refused
set in [bot-node-execution-handler.ts](../../src/app/bot-node-execution-handler.ts):

```ts
const UNBROKERED_AUTONOMOUS_PROVIDERS = new Set([
  'cline', 'cline-cli', 'claude', 'claude-code', 'codex', 'codex-cli', 'openai-codex',
]);
```

Unattended local-CLI execution is disabled platform-wide (SEC-05). The request fails with code
`UNBROKERED_AUTONOMOUS_PROVIDER` before a workspace is allocated or a child process starts. Two
ways past it, and only two:

1. **The ADR-127 carve** — `DEMO_MODE=true` **and** the request's owner on `OSHAL_OPERATOR_SUBS`.
   Both are required, a missing identity is refused on purpose, and every use is logged at WARN.
   This is the single-operator posture: your box, your login, your subscription. Note that
   `DEMO_MODE` is read on its own and never inferred from `MOCK_OIDC` — a mock-auth convenience
   must not be able to unlock a real subscription.
2. **Repoint the bot at a hosted provider** — set `FORCE_LLM_PROVIDER` on the `oshal-developer`
   service to `anthropic`, `openai`, or a BYO OpenAI-compatible endpoint, with the matching key.
   The bot-node runtime gives a hosted provider the same agentic tool loop, so the persona's
   `git` / `tsc` / `vitest` shell-outs still work.

A registry `harnessType` outranks `FORCE_LLM_PROVIDER`, and nearly every bot pins one — see
[provider-profiles.md](./provider-profiles.md) before trying to move the whole fleet with env
alone.

---

## 6. Hot-swap — what it is, and what it is not

**What already hot-swaps in the base compose, with no overlay and no rebuild:** `src/pages` (the
whole cockpit and every surface), `jarvis.html`, `ai-lab/bot-personas`, `swarm-apps/*.yaml`,
`config-seed/`, `ops/monitoring`. Edit, refresh, done. This is the "hot" behaviour most people
mean, and a source install already has it.

**What `docker-compose.hotswap.yml` adds:** the controller boots via `tsx watch` from the
bind-mounted host source instead of `node dist/app/server.js`, so **server TS** changes restart it
in place.

```bash
docker compose -f docker-compose.oshal-local.yml -f docker-compose.hotswap.yml up -d oshal-api
# drop the second -f at any time to return to the proven baked-dist boot
```

**It is not the self-coding mechanism, and the self-coding rails do not need it:**

- Rail A edits `/app/dev-repo`, a **named volume inside the bot container**. Nothing in the host
  checkout changes, so there is nothing for `tsx watch` to see.
- Rail B's `LiveApplier` **refuses core and infra by construction**. The classes it does apply —
  asset, manifest, persona, package — are exactly the ones already bind-mounted.
- Core TS reaches the running stack by **PR → merge → `scripts/oshal-deploy.sh`** (or
  `OSHAL_DEV_PROMOTE`). That path builds from committed HEAD, verifies the image, recreates
  api-then-bots, hard-gates on parity and health, and auto-rolls-back. Hot-swap has none of that.

So: layer it if you want a fast contributor inner loop on that box. Do not layer it expecting it
to make the swarm self-developing, and be aware that while it is layered an uncommitted core edit
is live on a box whose `docker ps` says it is running the deployed image — which is the opposite
of what the deploy gate exists to guarantee.

---

## 7. Verify the box does what you just enabled

```bash
bash scripts/oshal-verify.sh                                  # or GET /api/readiness
curl -s localhost:35457/api/governance/whoami                 # expect isOperator true + source
curl -s localhost:35457/app-loader -o /dev/null -w '%{http_code}\n'
curl -s localhost:35460/health                                # dev-node, if Rail B is enabled
curl -s localhost:35457/api/swarm/bots/registry | grep oshal-developer
bash scripts/deploy-parity-check.sh                           # api and bots on one image build
```

## Related

- [INSTALL.md](../../INSTALL.md) — every flag, the four modes, requirements, troubleshooting.
- [self-healing-monitoring.md](./self-healing-monitoring.md) — the monitoring → RCA loop in full.
- [deploy-parity.md](./deploy-parity.md) — `oshal-deploy.sh`, `--preview`, the split-image bug.
- [provider-profiles.md](./provider-profiles.md) — repointing the deployment's provider default.
- [remote-swarm-node-enrollment.md](./remote-swarm-node-enrollment.md) — joining a box to an
  existing swarm as a leaf node instead of standing up a second swarm.
- [ADR-147](../adr/147-multi-registry-app-loader.md), [ADR-148](../adr/148-swarm-root.md) — the
  App Loader and the roles it is gated on.
