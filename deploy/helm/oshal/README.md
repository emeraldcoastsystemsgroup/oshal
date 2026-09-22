# oshal Helm chart

The single source of k8s workload truth for oshal (ADR-129). One chart, two roles:
`main` (swarm controller + infra + bot fleet) and `bot-pod` (federated contributor
bots joining a main swarm over a headscale tailnet).

## Codeless install (recommended)

You don't need this repo checked out — the installer drives everything and pulls
only from the registry:

```bash
curl -fsSLO https://raw.githubusercontent.com/emeraldcoastsystemsgroup/oshal/main/scripts/oshal-install.sh
bash oshal-install.sh --mode 4 --admin-email you@example.com
```

(Windows: `.\scripts\oshal-install.ps1 -Kubernetes -AdminEmail you@example.com`.)

That **installs kubectl and helm if they are missing**, finds a cluster or stands
one up (k3s on Linux, kind where Docker is running), installs the chart (published
OCI package first, repo fallback), exposes the cockpit on a NodePort, waits for
health, and opens `/welcome` in your browser. Every system-touching step asks
first; `--yes` / `-Yes` accepts them for an unattended install.

Direct helm, once the OCI chart is published:

```bash
helm install oshal oci://ghcr.io/emeraldcoastsystemsgroup/charts/oshal \
  -n oshal --create-namespace --wait \
  --set api.service.type=NodePort
```

Defaults are pull-ready: `ghcr.io/emeraldcoastsystemsgroup/oshal-bot:latest`,
in-cluster Postgres/Redis/Chroma, mock single-user auth, the kernel bot fleet.

## Fleet presets

`fleet: kernel` (default — the Tier-0 kernel bots), `full` (every compose bot-node
eligible on k8s), or `custom` (exactly your `bots:` list). `kernel`/`full` render
the preset plus `bots:` extras, deduped by name (preset wins).

The preset lists are **generated** from
[docker-compose.oshal-local.yml](../../../docker-compose.oshal-local.yml) — never
hand-edit them. After changing a bot in compose:

```bash
node scripts/generate-chart-fleet.mjs --write
```

`tests/unit/chart-fleet-parity.spec.ts` goes red when they drift. Excluded on
purpose (logged by the generator): docker-socket bots (no docker daemon in a pod)
and compose-profile services (`build`/`incident`/`extras`/… — a default compose
`up` never started those either; add them via `bots:` if your cluster wants them).

## How bots get a brain on k8s

There are **no vendor-CLI OAuth mounts** here (compose bind-mounts `~/.codex` etc.;
a cluster has no such host state). Reasoning comes from:

1. **The /welcome wizard** (default, zero secrets in values): connect a hosted/BYO
   model in the browser after install — stored per-user in the DB.
2. **Vendor API keys** in the optional `oshal-bot-env` Secret
   (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY`), created out-of-band:
   `kubectl -n oshal create secret generic oshal-bot-env --from-literal=OPENAI_API_KEY=…`
3. `--no-ai` posture: `swarm.forceLlmProvider=noop` — an explicit no-model box.

The shared-env default follows the codex fleet floor (`openai-codex` / `gpt-5.5`);
per-bot registry overrides still win.

## Postures

- **Local/dev (default):** `MOCK_OIDC=true` — no sign-in page; pair with
  `MOCK_OIDC_EMAIL/NAME/SUB` in `api.extraEnv` (the installer does) or every
  visitor is the shared demo identity.
- **Multi-user public tenant:** use the [Terraform layer](../../terraform/README.md) —
  it refuses to deploy without real OIDC + minted secrets, and owns
  Ingress/NodePort exposure, namespace, and posture guards. The chart stays the
  workload truth either way.
- **Kyma:** `cockpit.apiRule.enabled=true` (the APIRule CRD exists only there).
- **Federation:** `relay.enabled=true` on main + a `role: bot-pod` release per
  contributor cluster — see [values-bot-pod.example.yaml](values-bot-pod.example.yaml).
  Bot-pod clusters never receive a DATABASE_URL (trust rule).

## Credentials

No credential is rendered into a ConfigMap. The chart keeps most of its own in two Secrets
(the rest are listed below the next paragraph):

| Secret | Keys | Read by |
|---|---|---|
| `oshal-shared-secret` | `JWT_SECRET`; on a main cluster with in-cluster ArangoDB also `ARANGO_ROOT_USER`, `ARANGO_ROOT_PASSWORD` | the api and every chart bot (`envFrom`), and the ArangoDB container (`secretKeyRef`) |
| `oshal-db-credentials` (main role) | `BOOTSTRAP_DATABASE_URL`, `DATABASE_URL`, `BOT_DATABASE_URL` | only by `secretKeyRef`: the api reads all three, a bot reads `BOT_DATABASE_URL` as its `DATABASE_URL` and nothing else |

Their values come from `swarm.jwtSecret`, `infra.arangodb.rootUser` / `rootPassword`,
`infra.postgres.password` (superuser), `infra.postgres.appPassword` (`oshal_app`),
`infra.postgres.botPassword` (`oshal_bot`) and `swarm.botDatabaseUrl`. The defaults are the
committed dev values. `appPassword` and `botPassword` must otherwise be 48-128 hex characters
(`openssl rand -hex 24`) and differ from each other. The render refuses anything else, because
the api's app-role bootstrap would refuse it at boot.

These credentials are not in either Secret yet. They are literal `env` entries in their
workload's spec, so anyone who can read that Deployment or StatefulSet can read them:

| Workload | Literal credential env |
|---|---|
| `oshal-api` | `TSDB_URL` (its URL carries `infra.tsdb.password`), `SPEAKER_SERVICE_KEY` |
| `speaker-diarization` | `SPEAKER_SERVICE_KEY` |
| `oshal-db` | `POSTGRES_PASSWORD` |
| `oshal-tsdb` | `POSTGRES_PASSWORD` |

Precedence is unchanged. `envFrom` lists the ConfigMap, then `oshal-shared-secret`, then your
`api.envSecret` / `botDefaults.envSecret`, so a key in your Secret wins. The database URLs are
explicit env entries, so they win over every `envFrom`. With managed Postgres set
`infra.postgres.inCluster: false` and supply them through `api.envSecret` (see the durability
boundary below).

`swarm.extraEnv` renders into the `oshal-shared-env` ConfigMap, so it refuses credentials. A key
the chart keeps in either the ConfigMap or `oshal-shared-secret`, and any credential-shaped name
(`SECRET`, `PASSWORD`, `PASSWD`, `TOKEN`, `CREDENTIAL`, a name ending in `KEY`,
`DATABASE_URL`, `*_DSN`), fails the render.

A bot the controller launches at runtime (see [Dynamic bots](#dynamic-bots--apps-bring-their-own))
is built by `src/features/agent-management/services/kubernetes-bot-launcher.ts`, not by this
chart. Its `envFrom` names `oshal-shared-env` and `oshal-bot-env` only, so it does not get
`oshal-shared-secret`: no `JWT_SECRET`, `ARANGO_ROOT_USER` or `ARANGO_ROOT_PASSWORD`. Without
`JWT_SECRET` such a bot fails to boot, because the ConfigMap sets `NODE_ENV=production` and the
bot's config (`any-bot/server/utils/config.js`) then throws `JWT_SECRET must be set in production`.
Chart-declared bots are not affected. Until the launcher reads `oshal-shared-secret` itself, which
is a core change tracked in [the backlog](../../../docs/BACKLOG.md), copy the chart Secret's keys
into `oshal-bot-env`. With `rbac.botLauncher` on, `helm install` prints the same commands:

```bash
kubectl -n oshal create secret generic oshal-bot-env   # only if it does not exist yet
kubectl -n oshal patch secret oshal-bot-env --type merge \
  -p "{\"data\":$(kubectl -n oshal get secret oshal-shared-secret -o jsonpath='{.data}')}"
```

The copy is a snapshot. Run the patch again after you change `swarm.jwtSecret`,
`infra.arangodb.rootUser` or `infra.arangodb.rootPassword`. With the default
`botDefaults.envSecret: oshal-bot-env`, chart-declared bots list `oshal-bot-env` after
`oshal-shared-secret`, so a stale copy would override the new value for them too.

## Shared services

The chart runs the same service tier a default `docker compose up` does, each
behind `infra.<name>.inCluster`:

| values key | Service | Powers | Default |
|---|---|---|---|
| `infra.postgres` | `oshal-db` | tickets, agents, cost ledger | on |
| `infra.redis` | `oshal-redis` | the swarm mesh | on |
| `infra.chromadb` | `oshal-chromadb` | RAG + swarm memory | on |
| `infra.tsdb` | `oshal-tsdb` | trading + world series (`TSDB_URL`) | on |
| `infra.arangodb` | `oshal-arangodb` | graph tier, `/api/graph` (`ARANGO_URL`) | on |
| `infra.vault` | `oshal-vault` | devops vault — **server mode**, sealed until you unseal it | on |
| `infra.codeServer` | `code-server` | workspace IDE behind the cockpit's `/code` | on |
| `infra.diarization` | `speaker-diarization` | local transcription (audio stays in-cluster) | on |
| `infra.ollama` | `oshal-ollama` | local models (`OLLAMA_HOST`) | **off** (compose gates it behind `local-llm`) |

Turning one off also withholds its URL env — that is the degradation switch, not
an oversight: an unset `ARANGO_URL` makes the graph connector return `null` and
`/api/graph` answer 503, which is the designed behavior. Point a feature at a
managed service by setting `inCluster: false` and supplying the URL through
`api.envSecret`.

⚠ **code-server is ClusterIP-only.** It runs `--auth none` over a read-write
shared workspace, so anyone who reaches it owns the workspace. Compose contains
that by binding `127.0.0.1`; here, use
`kubectl -n <ns> port-forward svc/code-server 8444:8080`. Do not expose it
without putting authentication in front of it.

⚠ **Vault comes up sealed.** It runs in server mode on its own claim, with no root
token anywhere in the chart and no Vault token on the api. See the
[Vault runbook](#vault-runbook) before you rely on it.

## Vault runbook

The in-cluster Vault (`infra.vault.inCluster: true`, the default) runs `vault server`
with file storage on the claim `data-oshal-vault-0` and a config rendered from
`infra.vault` into the `oshal-vault-config` ConfigMap. Unseal custody is Shamir and the
key shares stay with you. Nothing in the cluster can unseal it: there is no cloud-KMS
auto-unseal. So a fresh install comes up **sealed and uninitialized**. Every restart
of `oshal-vault-0` seals it again: an upgrade that changes its pod, a node drain, an
eviction.

Initialize once, then unseal with the threshold of shares:

```bash
kubectl -n oshal exec -ti oshal-vault-0 -- vault operator init -key-shares=5 -key-threshold=3
kubectl -n oshal exec -ti oshal-vault-0 -- vault operator unseal   # once per share, up to the threshold
kubectl -n oshal exec -ti oshal-vault-0 -- vault status            # Sealed: false
```

`init` prints the unseal key shares and an initial root token, once. Keep the shares
apart; that is the point of Shamir. Use the root token to set up policies and auth
methods, then revoke it (`vault token revoke <token>`). It belongs in no Kubernetes
Secret and no values file. After any restart, run the `unseal` line again until the
threshold is met.

What degrades, and what does not:

- **The api has no Vault token.** The chart sets `VAULT_ADDR` only. The api reads its
  token from `VAULT_TOKEN` alone
  (`src/features/devops-vault/services/vault-console-service.ts`), and `src/` has no
  AppRole login that could mint a scoped one. So with the defaults the DevOps Vault
  console (`/api/devops/*`) answers 503 `vault_not_configured`, whether Vault is sealed
  or not.
- **With a token you supply.** You can put a policy-scoped `VAULT_TOKEN` in the
  `api.envSecret` Secret; never the root token. Then, while Vault is sealed, the
  console's status reads `sealed` and its reads and writes fail with Vault's own
  "Vault is sealed" (502).
- **Nothing else waits on Vault.** The api, the bots and every other service start and
  run whether Vault is sealed or not; the console routes are the only reader of
  `VAULT_ADDR`/`VAULT_TOKEN` in `src/`. `oshal-vault-0` is Ready while sealed. Its
  probes accept sealed and uninitialized on purpose, so `helm --wait` completes and a
  sealed pod is not restarted in a loop.

Not decided yet, so the chart ships defaults and says so:

- **TLS source.** `infra.vault.tls.enabled` defaults to `false`, the plain in-cluster
  listener. When you turn it on, `infra.vault.tls.secretName` (default
  `oshal-vault-tls`) names a `kubernetes.io/tls` Secret you create: `tls.crt`, `tls.key` and `ca.crt`, for a certificate that names
  `oshal-vault`. The listener then serves it, the api dials `https://oshal-vault:8200`,
  and it trusts that `ca.crt` (only that key is mounted into the api) through
  `NODE_EXTRA_CA_CERTS`.
- **Backup destination.** None. `data-oshal-vault-0` is an ordinary claim, like every
  other one in the durability boundary below.

## Durability boundary

This chart is the **single-box product**, the same posture as a default
`docker compose up`: every workload runs one replica, each stateful service keeps
its data on one ReadWriteOnce claim from the cluster's default StorageClass (or
the one `storageClassName` names), the
credentials are compose's committed dev values, and nothing backs anything up.
That is fine for one person's box. It is **not** a shared-tenant posture, and the
chart does not try to become one: it stops at the boundaries below, and what lies
past them is yours to run.

What persists, by the claim name `kubectl -n <ns> get pvc` shows. The last column is
what `helm uninstall` does to it: a StatefulSet's claims outlive the StatefulSet
(the chart sets no claim retention policy), `oshal-workspace` carries
`helm.sh/resource-policy: keep`, and the other two are deleted with the release.

| Volume (PVC) | Holds | After `helm uninstall` |
|---|---|---|
| `data-oshal-db-0` | Postgres: tickets, agents, the cost ledger | kept |
| `data-oshal-tsdb-0` | TimescaleDB: trading + world series | kept |
| `data-oshal-chromadb-0` | Chroma: RAG + swarm memory | kept |
| `data-oshal-redis-0` | Redis append-only file: the swarm mesh | kept |
| `data-oshal-arangodb-0` | ArangoDB: the graph tier | kept |
| `data-oshal-vault-0` | Vault's file storage (encrypted by Vault; unreadable until unsealed) | kept |
| `oshal-workspace` | the shared workspace, including staged store packages | kept |
| `oshal-api-output` | the api's `/app/output`, where its seeded config lives | deleted |
| `models-oshal-ollama-0` | pulled local models (only with `infra.ollama.inCluster: true`) | kept |
| `oshal-relay-state` | the tailnet relay's node state (only with `relay.enabled: true`) | deleted |

Every claim takes `storageClassName` (chart-wide) or its own override
(`infra.<name>.storageClassName`, `api.outputStorageClassName`,
`swarm.workspaceStorageClassName`, `relay.stateStorageClassName`). Empty leaves the
field out, which means the cluster's default class. A StatefulSet's claim template
cannot change after the first install, so choose the class before it.

| Out of scope here | Boundary switch | The tenant supplies, in the `api.envSecret` Secret |
|---|---|---|
| Durable Postgres: replication, backups, point-in-time restore | `infra.postgres.inCluster: false` | `DATABASE_URL`, `BOOTSTRAP_DATABASE_URL`, `BOT_DATABASE_URL`; chart-declared bots take theirs from `swarm.botDatabaseUrl` |
| Durable Timescale for the trading + world series | `infra.tsdb.inCluster: false` | `TSDB_URL` |
| A Vault operated outside this release (HA, your own unseal custody and backups) | `infra.vault.inCluster: false` | `VAULT_ADDR` |
| Backup and restore of `oshal-workspace`, `data-oshal-chromadb-0` and every other claim above | none: the chart ships no backup job, snapshot or restore path | nothing: these are ordinary PVCs, so protecting them belongs to whatever backs up volumes on your cluster |

Turning a switch off removes that in-cluster workload and withholds exactly the
env listed, so the Secret's value is the one the api reads. The chart has to
withhold it rather than merely allow an override, because an explicit container
`env` entry beats `envFrom`. From there the managed service's own durability
(replicas, backups, restore drills) is the operator's, not the chart's. The chart
sets no Vault token for the api in either Vault posture; the token question is the
[Vault runbook](#vault-runbook)'s.

On the [Terraform](../../terraform/README.md) tenant path the module forwards only
the Postgres switch (`postgres_in_cluster`, with the URLs through
`api_extra_secret_env`). Moving Timescale or Vault out of the cluster there needs
their switches added to the module first.

## Probes, resources and Pod Security

**Probes.** Each workload that has a readiness check uses that same check as its
liveness probe, and adds a startup probe that holds liveness off through a slow
first boot. The api waits up to 10 minutes for Postgres and its bootstrap. The
datastores wait 5 minutes for initdb or crash recovery. ArangoDB asks the
unauthenticated `/_admin/server/availability`. Speaker-diarization sends its key
and a `Host` it admits. Vault's probes pass while it is sealed. The relay has no
probes: tailscaled and socat expose no health endpoint.

**Resources.** Every container requests CPU and memory and has a memory limit:
`api.resources`, `botDefaults.resources`, `infra.<name>.resources`,
`relay.tailscaleResources` / `forwarderResources`. The api's init container
reuses the api's figures. There are no CPU limits, as there never were on the api
and the bots; a CPU limit throttles rather than protects. ArangoDB is told its
memory limit (`ARANGODB_OVERRIDE_DETECTED_TOTAL_MEMORY`) so it sizes its caches to
the container. TimescaleDB's first-init tune sizes Postgres from the memory limit
if there is one, and from the node's memory otherwise. It never re-runs, so a
volume first initialised without a limit needs a limit that covers what it chose
then. [values-docker-desktop.yaml](values-docker-desktop.yaml) halves the default
requests to fit its one node.

**Images.** Every infra image is a pinned tag, never `:latest`. The platform
image (`image.repository` / `image.tag`) is set separately.

**Pod Security.** Every pod runs the RuntimeDefault seccomp profile. Every
container runs with `allowPrivilegeEscalation: false` and drops every capability,
except as the table says. Measured from the render only; admission itself is proven
on a cluster, not here:

| Workload | Runs as | Restricted | Why not |
|---|---|---|---|
| `oshal-db`, `oshal-tsdb` | uid 70, the image's `postgres` user | yes | |
| `oshal-redis` | uid 999, the image's `redis` user | yes | |
| `oshal-vault` | uid 100, the image's `vault` user | yes | |
| `code-server` | uid 1000, the image's `USER` | yes | |
| `speaker-diarization` | uid 10001, the image's `USER` | yes | |
| `oshal-api` and every bot | root | no (Baseline) | the oshal image has no `USER`; and it keeps `DAC_OVERRIDE`, because code-server writes the shared workspace as uid 1000 and root without it cannot write there |
| `oshal-chromadb` | root | no (Baseline) | the image has no `USER` and caches its embedding model under `/root` |
| `oshal-arangodb` | root | no (Baseline) | the image has no `USER`, its entrypoint never drops privileges, and the data volumes it has written are root-owned |
| `oshal-ollama` | root | no (Baseline) | the image has no `USER` and keeps models under `/root/.ollama` |
| `oshal-relay` | root | no (Privileged only) | it mounts `/dev/net/tun` from the host and adds `NET_ADMIN`; off by default |

## Dynamic bots — apps bring their own

An installed app can declare a bot that needs its own node. Under compose the
controller writes a compose overlay and starts the container; on a cluster it
creates a **Deployment + Service in this namespace**, using the same shape as a
chart-declared bot (bot entrypoint, `oshal-shared-env` + `oshal-bot-env`, the
workspace PVC, and a Service named for the bot because that name *is* the DNS the
controller dials). One difference: it does not read `oshal-shared-secret`, so it
needs `JWT_SECRET` copied into `oshal-bot-env` (see [Credentials](#credentials)).
Those runtimes are labelled `oshal.io/dynamic: "true"`, so `helm upgrade` never
adopts or deletes them.

That needs the `rbac:` block — a ServiceAccount plus a **namespace-scoped Role**
(never a ClusterRole) over Deployments/Services. Set `rbac.botLauncher: false` to
withhold it; the controller then degrades to persona-only agents (a failed launch
rolls the creation back rather than half-creating one), and apps whose bots run
*inline on the api* keep working either way.

The launched image is always the chart's `image.repository:tag`, passed to the
controller as `OSHAL_BOT_IMAGE` — **never caller-supplied**, because "create an
agent" must not become "run an arbitrary container in my namespace".

Validate the exact manifest the launcher would POST against your cluster's API
(creates nothing):

```bash
npx tsx scripts/validate-dynamic-bot-manifest.mjs --namespace oshal
```

## Store packages

```bash
--set packages={career-hunter,job-apply}
```

They stage into the workspace PVC via an initContainer **before** the api starts,
because auto-load registers a package's bots and surfaces once, at boot. Re-runs
skip already-staged packages (`store.auditMode: compatible`); `enforce`
revalidates and replaces from the audited SHA. A failed stage fails the pod
rather than booting without an app you asked for. Private stores need a token
Secret — see `store.tokenSecret`. The installer passes `--apps`/bundles through
automatically.

## Publishing (operator-triggered)

`bash scripts/publish-chart.sh` packages this directory and pushes the OCI chart to
`ghcr.io/emeraldcoastsystemsgroup/charts/oshal`. Publish cadence is operator-only.
