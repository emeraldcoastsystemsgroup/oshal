# Installed sandbox

`scripts/operations/installed-sandbox.js` starts a disposable copy of the installed image for
multi-identity acceptance. It uses its own PostgreSQL, Redis and api, and optionally named bot
nodes. Nothing is written to the live box: no row, no append-only audit record, no ticket.
Every result it produces is labelled `installed-sandbox`. Such a result is neither isolated
fixture evidence nor live evidence, and must be reported as its own kind.

It exists because the acceptance cases for backlog entries #1, #2 and #23 need two signed-in
identities with different rights on the installed image. Creating those accounts, grants and
audit rows on the production swarm is not allowed. An earlier hand-built sandbox shared the stack
network, and its queue manager dispatched two sandbox tickets to live bots by container name. The
bots refused with 401, but the route existed. This script removes that route by construction.

**Run it from the host only.** `docker compose` run inside the api inherits
`COMPOSE_PROJECT_NAME=oshal-local` and joins the core project, where the next deploy's
`--remove-orphans` sweeps it up. The script scrubs every `COMPOSE_*` variable, passes `-p`
explicitly, and runs compose in its own state directory. That keeps it away from any checkout
`.env`.

## Commands

```bash
# Print the plan. Nothing is started, written or removed.
node scripts/operations/installed-sandbox.js up --dry-run --package little-monsters@1.4.5 --bot career-bot

# Start one (the RAM guard decides first)
node scripts/operations/installed-sandbox.js up --name accept1 \
  --store-repo ../oshal-applications --store-ref origin/main --package little-monsters@1.4.5 \
  --private-package ../<private repo>/<package dir>@<version> --private-ref origin/main \
  --bot career-bot --user alpha --user bravo

node scripts/operations/installed-sandbox.js status --name accept1
node scripts/operations/installed-sandbox.js down --name accept1        # prints the teardown receipt
```

| Flag | Meaning |
|---|---|
| `--name <suffix>` | Project `oshal-sandbox-<suffix>`. Without it, `up` mints a random one. `down` and `status` can only address `oshal-sandbox-*` projects, so the live project can never be named. |
| `--port` | Loopback port for the sandbox api. Default 35459. A port the live stack publishes is refused. |
| `--image` | Image tag. The default is `OSHAL_BOT_IMAGE`, then the compose default (`oshal-bot:latest`). |
| `--package name[@version]` | Store package. It is resolved at `--store-ref` (default `origin/main`) of `--store-repo` (default `OSHAL_STORE_DIR`, then a sibling `oshal-applications` clone). Fetch that clone first: the script reads refs and never fetches. |
| `--private-package <dir>[@version]` | A package directory inside the private repo, at `--private-ref` (default `origin/main`). The name comes from its manifest, so core never names a private package. |
| `--bot <service>` | A live bot service from the compose file, for example `career-bot`. |
| `--user <label>` | Invited members. The default is `alpha` and `bravo`. The root is always `admin`. |
| `--llm-provider`, `--llm-model` | Model rail. The default `noop` also sets `OSHAL_NO_AI=true`. |
| `--forward-env NAME` | Forward a provider credential by name from `--operator-env` (default `OSHAL_OPERATOR_ENV_FILE`, then the checkout `.env`). The value is never printed or written to disk. |
| `--set-env KEY=VALUE` | Literal api setting. Isolation still rejects secrets, live hosts and posture changes. |
| `--state-root` | Where `<project>/` state lives. The default is `OSHAL_INSTALLED_SANDBOX_ROOT`, then `<tmp>/oshal-installed-sandbox`. |
| `--host-reserve-mb` | Host memory kept free beyond the sandbox budget. Default 1024. |
| `--keep-on-failure` | Leave a failed `up` in place for diagnosis. By default it is torn down. |
| `--print-compose` | With `--dry-run`, also print the generated compose document. It contains references only, no values. |

Exit codes: 0 ok, 1 failed, 2 usage, 3 RAM guard refused, 4 isolation refused, 5 teardown left
something behind.

## What `up` does, in order

1. **Plan.** Reads `docker-compose.oshal-local.yml` for the live project, every service,
   container and network name, the host ports it publishes, and the api, `oshal-db` and
   `oshal-redis` definitions. The dry run reads the checkout's copy. `up` then rebuilds the plan
   from the image's own `/app/docker-compose.oshal-local.yml`, so the api boot command (migrations,
   core RLS enforce, app-role provisioning) is the one the running image ships.
2. **RAM guard.** The stated floor: host free memory must be at least the sandbox budget plus the
   host reserve, and the Docker engine's headroom (`docker info` MemTotal minus
   `docker stats` usage) must be at least the budget. Budget: db 512 MB, redis 128 MB, api 1400 MB,
   and 640 MB per bot. With one bot that is 2680 MB, so the floor is 3704 MB of free host memory.
   A figure it cannot read counts as a refusal.
3. **Static isolation check.** `up` refuses when any of these holds:
   - a network or volume is external or explicitly named;
   - the backend network is not internal;
   - db or redis sits on anything but the backend network;
   - a service uses a bind mount or the docker socket;
   - `container_name`, `network_mode` or the `oshal.tier` label is set;
   - a port is published beyond `127.0.0.1` or on a live port;
   - `restart` is anything but `no`;
   - `pull_policy` is anything but `never`;
   - `host.docker.internal` or `gateway.docker.internal` is not pinned to the container's own
     loopback;
   - an env value names a live host, carries a compose control variable, embeds a credential in a
     URL, or holds a literal secret;
   - the api is not `LOCAL_AUTH=true`, `MOCK_OIDC=false`, `OSHAL_APPLICATION_AUTHORIZATION_MODE=enforce`.
4. **Secrets by name.** Database passwords and DSNs, session, service, encryption and JWT secrets,
   and a fresh Ed25519 delegation key pair are generated per sandbox. The compose file holds only
   `${OSHAL_SANDBOX_*}` references. Values reach `docker compose` through its process environment
   only, and forwarded operator credentials travel the same way.
5. **Containers.** PostgreSQL and Redis start on the internal `backend` network, which has no
   egress and no host route. The api joins `backend` and `edge`, the edge network being only for
   its published loopback port. Bots join `edge` only when a credential is forwarded, because only
   then do they need provider egress. The api and bots answer the live api's and their own
   service and container names on `backend`, so dispatch and callbacks stay inside the sandbox.
6. **Packages.** Each package is streamed with `git archive` of the exact commit, with
   `core.autocrlf` forced off, into the sandbox workspace volume. A throwaway container from the
   same image does the streaming, with no network. The `.oshal-install.json` beside each package
   records repo, ref, sha, audit posture and `installedBy: installed-sandbox`. A requested version
   that differs from the manifest refuses. A required dependency app must be staged too or ship in
   core, as with the installer.
7. **Boot and probe.** The api starts and `/health` answers. The script then waits for
   `Swarm app auto-load complete`. From inside the api, every live name must fail to resolve,
   sandbox aliases may resolve only to sandbox containers, and no live published port may answer
   through the host aliases. Any failure is refused (exit 4) and the sandbox is torn down.
8. **Identities** (`scripts/lib/installed-sandbox-identities.js`):
   - The installer proof (`scripts/oshal-setup-root.mjs`, issued inside the sandbox api) is
     redeemed at `/api/local-auth/bootstrap` by `admin`, who becomes the swarm root.
   - Each member is invited by the root, reads the invitation and accepts it. The spent link must
     answer 410.
   - Every user signs in at `/api/local-auth/login`, and the session must resolve to their subject
     at `/api/auth/user`.
   - A personal access token is minted at `/api/cli-tokens` and must act as its owner at
     `/api/cli-tokens/whoami`.
   - Subjects are `local-<sha256(email)[0..16]>`.
9. **Package check.** Each staged package must be active at its version, and a member's
   `/api/authorization/me?app=` must come from the enforce policy, never `legacy`. No grants are
   made. Granting, denying and revoking are the acceptance case's own steps.
10. **Bots** start last and must report healthy.

## Credentials, by name

`<state-root>/<project>/credentials.env` is written with mode 600. It holds
`OSHAL_SANDBOX_EVIDENCE_LABEL`, `OSHAL_SANDBOX_PROJECT` and `OSHAL_SANDBOX_BASE_URL`, and for each
user `OSHAL_SANDBOX_<LABEL>_{EMAIL,SUB,PASSWORD,SESSION,PAT}`. Here `SESSION` is the
`oshal_local=...` cookie pair and `PAT` is the `oshal_pat_...` token. Acceptance scripts read the
file with `readCredentialsFile()` from `scripts/lib/installed-sandbox-identities.js`, or load it as
an env file. The script prints only the names. `sandbox.json` beside it records the plan, the image
id and revision, the users, the packages and the probe result, with no values.

## Teardown receipt

`down` runs `docker compose down --volumes --remove-orphans`. It then sweeps anything still carrying
the project label (containers, volumes, networks), removes the state directory holding the
credentials, and inventories again. The receipt lists what was removed and what is left. It is
**red**, with exit 5, if anything is left, including the state directory. A failed `up` runs the
same teardown unless `--keep-on-failure` is given.

## Not a Test Lab card

The Test Lab runs inside the api, and this script must never run there (see above). Its guards are
`tests/unit/installed-sandbox.spec.ts`. The first real `up`/`down` against the installed image is
the deploy lane's run. Record its receipt as `installed-sandbox` evidence.
