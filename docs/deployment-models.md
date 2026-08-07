<!--
CHANGE LOG
-----------------------------------------------------------------------------
SEQ                 | AUTHOR                      | DESCRIPTION
-----------------------------------------------------------------------------
1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — operator-facing map of the supported deployment models, the platform-vs-experiment promise: pick a model, run one command, get a working OSHAL.
-->

# Deployment Models

OSHAL is one Docker image (`oshal-bot:latest` in the local installer/primary compose stack, built from [Dockerfile.oshal](../Dockerfile.oshal)) whose
process is chosen at container start by `BOT_RUNTIME` (`swarm` controller vs `bot-node`
worker — see [CLAUDE.md](../CLAUDE.md)). Every model below runs that same image; what
changes is **auth, exposure, LLM provider, and orchestrator** — not the code.

**Dockerfile source of truth:** use [Dockerfile.oshal](../Dockerfile.oshal) for the
hosted cockpit, `docker-compose.oshal-local.yml`, and registry/Kubernetes releases.
The root `Dockerfile` remains only for legacy/dev-compatible compose and installer paths;
`Dockerfile.bot` is a worker/special-purpose image, not the
main OSHAL runtime.

This is the operator's "which one do I run" map. For the architecture view (what talks to
what), see [deployment-runtime-topology.md](architecture/deployment-runtime-topology.md).

| Model | Who it's for | Auth | LLM | Exposure | Command |
|---|---|---|---|---|---|
| **1. Zero-keys demo** | try it / CI / contributors | mock | `noop` | localhost | one line, no secrets |
| **2. Local self-host** | run *your* OSHAL on a home PC | mock (local) | your Claude/Codex login or local Ollama | localhost | + your connector keys |
| **3. Tunneled prod** | the live, internet-reachable deploy | Google/Entra OIDC | real providers | cloudflared → real domain | + OIDC + `SESSION_SECRET` |
| **4. Kubernetes** | scaled / team | OIDC | real providers | Ingress | `ops/deployment/kubernetes` |
| **5. Home appliance** *(roadmap)* | non-technical home user | one-click | bring-your-own | LAN/local | one-click installer (not built) |

All models persist data in named volumes (Postgres, the `api-output` volume holding
per-user career/resume/connector data, ChromaDB) — a container recreate never loses data.

---

## 1. Zero-keys demo — the "does it even run" path

The fastest way to prove the platform is real, not an experiment: clone, one command, a
working cockpit. No API keys, no OAuth app, no secrets. The `noop` harness stands in for an
LLM and `MOCK_OIDC` fakes login.

```bash
bash scripts/install.sh          # preflight → build → up → SELF-VERIFY → prints URLs
# open http://localhost:35457/cockpit/   (try /cockpit/?app=little-monsters)
```

`install.sh` defaults to this zero-keys path and self-verifies the boot — see
[INSTALL.md](../INSTALL.md). The raw equivalent (what the installer runs):
`FORCE_LLM_PROVIDER=noop MOCK_OIDC=true docker compose -f docker-compose.oshal-local.yml up -d`.

Nothing in `config-seed/secrets.json` or `.env` is required — the entrypoint copies seed
files only if present (`cp -f … 2>/dev/null`), and the compose defaults are
`MOCK_OIDC=true`, `FORCE_LLM_PROVIDER=claude-code` (override to `noop`), `SESSION_SECRET=`
(empty). This is the human-testability gate: a clean machine reaches a usable cockpit.

## 2. Local self-host — the home/local-first product

Same compose, still `MOCK_OIDC=true` (you're the only user on your own box), but now wired to
*your* accounts so the bots do real work. **This is the "your own private AI on your own
machine" door.**

1. Copy `.env.example` → `.env`, set what you want (most are optional).
2. LLM: either log in to Claude Code / Codex (the harness uses your OAuth — no API key), or
   point at a local runtime (Ollama / LM Studio) for fully-offline.
3. Connectors (Gmail, Dropbox, GitHub, …): register each app under your business email
   (see [partner-app-registration.md](partner-app-registration.md)) and paste creds into `.env`.
4. `bash scripts/install.sh --with-keys` (uses real providers from `.env` instead of `noop`)
   → `http://localhost:35457`.

Your data stays on your box (named volumes); nothing pools in a vendor cloud.

## 3. Tunneled prod — internet-reachable, real login

The live deployment (e.g. `oshal.example.com`). Add a cloudflared tunnel + real OIDC.

```env
MOCK_OIDC=false
OIDC_ISSUER_URL=https://accounts.google.com   # or your Entra issuer
OIDC_CLIENT_ID=...      OIDC_CLIENT_SECRET=...
APP_URL=https://oshal.example.com
SESSION_SECRET=<32+ random bytes>             # master connector-token AES key
```

**More than one login method (ADR-126):** the block above stays the *primary* provider
(it keeps `/callback` and the default session cookie); per-provider flags add more. E.g.
Google primary + a "Continue with Microsoft" button:

```env
MICROSOFT_LOGIN=true
MICROSOFT_TENANT_ID=<directory (tenant) id>   # tenant-SPECIFIC; 'common' fails issuer validation
MICROSOFT_OIDC_CLIENT_ID=...    MICROSOFT_OIDC_CLIENT_SECRET=...
```

Register `https://<each login host>/callback/microsoft` as a **Web** redirect URI on the
Azure app (probe with `scripts/check-oidc-redirect-uris.sh -p microsoft <host>`). With
several providers enabled, `/login` renders a chooser; `GOOGLE_LOGIN=false` removes the
Google button. Each provider issues its own identity — a person signing in with Google and
with Microsoft is two different `sub`s (operator status via `OSHAL_OPERATOR_EMAILS` follows
the email, which covers both).

**Security note:** with the tunnel up, the site is public — never set `MOCK_OIDC=true` while
tunneled (it would let anyone in as a mock user). `SESSION_SECRET` lives only on the
controller, never on a bot-node (token-broker model). See the route-auth audit in
[BACKLOG.md](BACKLOG.md) (public controller is fully `requiresAuth`-gated).

## 4. Kubernetes — scaled / team

The compose topology mirrors the K8s layout. Manifests live in
[ops/deployment/kubernetes](../ops/deployment/kubernetes) and `kubernetes/`. Same image,
same `BOT_RUNTIME` split; secrets via K8s Secrets, exposure via Ingress. See
[deployment-runtime-topology.md](architecture/deployment-runtime-topology.md) for the
K8s topology diagram.

## 5. Home appliance *(roadmap — not built)*

The non-technical-user packaging: a one-click installer that bundles the stack for a home
PC + an always-on listener (e.g. an old Alexa as a voice front-end via a custom skill). The
*bones* are real today (BYO-account auth, per-user encryption, local LLM runtimes,
click-connectors); what's unbuilt is the one-click packaging. Tracked in [ROADMAP.md](../ROADMAP.md).

---

## Picking a model

- **Just looking?** → 1 (zero-keys).
- **Want it working for yourself on your machine?** → 2 (local self-host).
- **Putting it on the internet for real login?** → 3 (tunneled prod).
- **Team / scale?** → 4 (Kubernetes).

Every model is the same image and the same `docker-compose.oshal-local.yml` (or its K8s
equivalent); you are only ever changing env + exposure. That sameness — one build, four
ways to run it, data safe across recreates — is what makes OSHAL a platform you deploy, not
an experiment you babysit.

---

## Which compose file? (there are several — use the first one)

| File | Use it for |
|---|---|
| **`docker-compose.oshal-local.yml`** | **The canonical stack** (controller + Postgres/Redis/Chroma + all bot containers; mirrors the Kubernetes layout). This is what `install.sh` runs and what every model above assumes. |
| `docker-compose.yml` | Minimal base containerized stack (infra + api only), no bot fleet. |
| `docker-compose.core.yml` | Core infra only (Postgres/Redis/Chroma + api), for poking at the control plane. |
| `docker-compose.incident-lab.yml` | A minimal 3-bot stack for incident-flow testing. |
| `docker-compose.swarm-local.yml` | Older per-bot-swarm layout — superseded by `oshal-local`. |
| `docker-compose.dev.yml` / `docker-compose.override.yml` | Dev-only hot-reload / config-sync smoke overrides (`override` is gitignored). |
| `docker-compose.platform.yml` | Platform-profile variant. |

When in doubt: `docker-compose.oshal-local.yml`.
