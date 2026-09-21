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

No credential is rendered into a ConfigMap. The chart keeps its own in two Secrets:

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
chart. Its `envFrom` names `oshal-shared-env` and `oshal-bot-env` only. It gets `JWT_SECRET` and
`ARANGO_ROOT_*` only if your `oshal-bot-env` Secret carries them.

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
| `infra.vault` | `oshal-vault` | devops vault — **dev mode**, in-memory | on |
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

⚠ **Vault is `server -dev`** (compose parity): in-memory, auto-unsealed, fixed
root token, no PVC — it loses everything on restart. Real deployments set
`infra.vault.inCluster: false` and point `VAULT_ADDR`/`VAULT_TOKEN` at a real
Vault.

## Durability boundary

This chart is the **single-box product**, the same posture as a default
`docker compose up`: every workload runs one replica, each stateful service keeps
its data on one ReadWriteOnce claim from the cluster's default StorageClass, the
credentials are compose's committed dev values, and nothing backs anything up.
That is fine for one person's box. It is **not** a shared-tenant posture, and the
chart does not try to become one: it stops at the boundaries below, and what lies
past them is yours to run.

What persists, by the claim name `kubectl -n <ns> get pvc` shows:

| Volume (PVC) | Holds |
|---|---|
| `data-oshal-db-0` | Postgres: tickets, agents, the cost ledger |
| `data-oshal-tsdb-0` | TimescaleDB: trading + world series |
| `data-oshal-chromadb-0` | Chroma: RAG + swarm memory |
| `data-oshal-redis-0` | Redis append-only file: the swarm mesh |
| `data-oshal-arangodb-0` | ArangoDB: the graph tier |
| `oshal-workspace` | the shared workspace, including staged store packages |
| `oshal-api-output` | the api's `/app/output`, where its seeded config lives |
| `models-oshal-ollama-0` | pulled local models (only with `infra.ollama.inCluster: true`) |
| `oshal-relay-state` | the tailnet relay's node state (only with `relay.enabled: true`) |

Vault has no claim at all: `server -dev` keeps everything in memory.

| Out of scope here | Boundary switch | The tenant supplies, in the `api.envSecret` Secret |
|---|---|---|
| Durable Postgres: replication, backups, point-in-time restore | `infra.postgres.inCluster: false` | `DATABASE_URL`, `BOOTSTRAP_DATABASE_URL`, `BOT_DATABASE_URL`; chart-declared bots take theirs from `swarm.botDatabaseUrl` |
| Durable Timescale for the trading + world series | `infra.tsdb.inCluster: false` | `TSDB_URL` |
| A real Vault: persistent storage, sealing, a token that is not the dev root | `infra.vault.inCluster: false` | `VAULT_ADDR`, `VAULT_TOKEN` |
| Backup and restore of `oshal-workspace`, `data-oshal-chromadb-0` and every other claim above | none: the chart ships no backup job, snapshot or restore path | nothing: these are ordinary PVCs, so protecting them belongs to whatever backs up volumes on your cluster |

Turning a switch off removes that in-cluster workload and withholds exactly the
env listed, so the Secret's value is the one the api reads. The chart has to
withhold it rather than merely allow an override, because an explicit container
`env` entry beats `envFrom`. From there the managed service's own durability
(replicas, backups, restore drills) is the operator's, not the chart's.

On the [Terraform](../../terraform/README.md) tenant path the module forwards only
the Postgres switch (`postgres_in_cluster`, with the URLs through
`api_extra_secret_env`). Moving Timescale or Vault out of the cluster there needs
their switches added to the module first.

## Dynamic bots — apps bring their own

An installed app can declare a bot that needs its own node. Under compose the
controller writes a compose overlay and starts the container; on a cluster it
creates a **Deployment + Service in this namespace**, using the same shape as a
chart-declared bot (bot entrypoint, `oshal-shared-env` + `oshal-bot-env`, the
workspace PVC, and a Service named for the bot because that name *is* the DNS the
controller dials). Those runtimes are labelled `oshal.io/dynamic: "true"`, so
`helm upgrade` never adopts or deletes them.

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
