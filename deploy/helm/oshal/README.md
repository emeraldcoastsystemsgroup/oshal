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
`DATABASE_URL`, `*_DSN`), fails the render. The name rule is broad on purpose, so it also
refuses a switch that is not a secret but whose name matches, such as compose's
`REMOTE_CLIENT_REQUIRE_NODE_TOKEN`. Set a switch like that on the workload that reads it
(`api.extraEnv` for that one).

The P8 surfaced-package gate is first-class rather than hidden in `extraEnv`:
`api.conciergeCoverageMode` defaults to `enforce` now that every package with `ui.static`,
`ui.dynamic`, or a group `toolbar` names a concierge. Set it to `warn` only for temporary
observation or rollback; any other value makes manifest reads fail closed.

**Runtime-launched bots do not boot on the default posture. This is a chart 0.5.0 regression.**
A bot the controller launches at runtime (see [Dynamic bots](#dynamic-bots--apps-bring-their-own))
is built by `src/features/agent-management/services/kubernetes-bot-launcher.ts`, not by this
chart. Its `envFrom` names `oshal-shared-env` and `oshal-bot-env` only, so it does not get
`oshal-shared-secret`: no `JWT_SECRET`, `ARANGO_ROOT_USER` or `ARANGO_ROOT_PASSWORD`. Chart 0.4.0
kept those keys in `oshal-shared-env`, so such a bot booted. Since 0.5.0 it fails to boot,
because the ConfigMap sets `NODE_ENV=production` and the bot's config
(`any-bot/server/utils/config.js`) then throws `JWT_SECRET must be set in production`. That is
true of every runtime-launched bot with `rbac.botLauncher: true`, the default, until one of two
things happens. Either the launcher reads `oshal-shared-secret` itself, a one-line core fix (add
`{ secretRef: { name: 'oshal-shared-secret' } }` to its `envFrom`) awaiting approval in
[the backlog](../../../docs/BACKLOG.md), or `oshal-bot-env` carries the keys because you copied
them there. Chart-declared bots are not affected. With `rbac.botLauncher` on, `helm install`
prints the copy commands:

```bash
kubectl -n oshal create secret generic oshal-bot-env   # only if it does not exist yet
kubectl -n oshal patch secret oshal-bot-env --type merge \
  -p "{\"data\":$(kubectl -n oshal get secret oshal-shared-secret -o jsonpath='{.data}')}"
```

The copy is a snapshot. Run the patch again after you change `swarm.jwtSecret`,
`infra.arangodb.rootUser` or `infra.arangodb.rootPassword`. With the default
`botDefaults.envSecret: oshal-bot-env`, chart-declared bots list `oshal-bot-env` after
`oshal-shared-secret`, so a stale copy would override the new value for them too.

## Cockpit UI profiles

The cockpit's layout — Home and Jarvis leading the sidebar, the top workspace navigation, every
ribbon tile — comes from a UI profile (`config-seed/profiles/<name>.json`, `UI_PROFILE` picks one,
`oshal-framework` by default). The image ships the tracked profiles in `/app/config-seed.dist/profiles`,
and the api container seeds them into `/config-seed/profiles` (an `emptyDir`) at every start. To run
your own profiles, put them in a ConfigMap and set `api.uiProfilesConfigMap`; it is mounted read-only
in the same place and the seed step does nothing.

The `configSeedSecret` cannot carry them: a Secret mounts flat keys, and mounting it over
`/app/config-seed` is what hid the profiles on the first live install — the api then served a
built-in fallback ribbon with no Jarvis and no workspaces. `tests/unit/chart-ui-profiles.spec.ts`
holds this.

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

### Vault's ServiceAccount and the Kubernetes secrets engine

`oshal-vault-0` runs as its own ServiceAccount, `oshal-vault`
(`infra.vault.serviceAccount`, created by the chart by default). It does not run as the
namespace's `default` ServiceAccount. Every infra pod without an account of its own
shares that one, so RBAC granted to `default` for Vault would reach Postgres, Redis and
the rest as well. `create: false` uses a ServiceAccount you created, under `name`. An
empty name, or the api's ServiceAccount (`rbac.serviceAccountName`), fails the render.
Upgrading from a chart that did not set it changes the Vault pod, so `oshal-vault-0`
restarts and comes back sealed: plan the unseal.

**The chart binds no Role, RoleBinding or ClusterRole to `oshal-vault`.** The Kubernetes
secrets engine needs RBAC in each tenant namespace it issues credentials for. That RBAC
is operator config, applied per tenant. It is not rendered by the chart.

Below is an **example**, for the mode where Vault generates a ServiceAccount for each
credential and binds it to a Role you have already written (`kubernetes_role_name`).
These are the minimal rules for that mode. The tenant namespace is `tenant-a`, and
`tenant-a-reader` is the Role its credentials carry. Apply one copy per tenant, with
both names changed:

```yaml
# EXAMPLE: operator config, one per tenant namespace. Not rendered by the chart.
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: vault-secrets-engine
  namespace: tenant-a
rules:
  - apiGroups: [""]
    resources: ["serviceaccounts"]
    verbs: ["get", "create", "delete"]
  - apiGroups: [""]
    resources: ["serviceaccounts/token"]
    verbs: ["create"]
  - apiGroups: ["rbac.authorization.k8s.io"]
    resources: ["rolebindings"]
    verbs: ["get", "create", "delete"]
  # bind lets Vault create a RoleBinding to the Role it hands out without holding that
  # Role's permissions itself; resourceNames keeps it to that one Role.
  - apiGroups: ["rbac.authorization.k8s.io"]
    resources: ["roles"]
    verbs: ["bind"]
    resourceNames: ["tenant-a-reader"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: vault-secrets-engine
  namespace: tenant-a
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: vault-secrets-engine
subjects:
  - kind: ServiceAccount
    name: oshal-vault
    namespace: oshal
```

It grants nothing cluster-wide, nothing in the `oshal` namespace, no access to Secrets,
and `bind` on no Role but `tenant-a-reader`. Writing `tenant-a-reader` itself, scoped to
what a tenant credential may do, is also yours. The Vault role that hands it out names
the same Role and namespace:

```bash
vault write kubernetes/roles/tenant-a-reader \
  allowed_kubernetes_namespaces=tenant-a kubernetes_role_name=tenant-a-reader token_default_ttl=10m
```

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

On the [Terraform](../../terraform/README.md) tenant path the module forwards
`postgres_in_cluster`, `tsdb_in_cluster`, `arangodb_in_cluster`,
`vault_in_cluster`, `code_server_in_cluster` and `diarization_in_cluster`, each
defaulting to the chart's own default. The URLs go in `api_extra_secret_env`,
which the module mints into the `api.envSecret` Secret. code-server's
browser-facing link goes in `code_server_external_url`. Redis, Chroma and ollama
keep the chart defaults on that path.

## Probes, resources and Pod Security

This section is measured from the workloads this chart renders. A bot the controller
launches at runtime is not one of them, and the last paragraph says what it gets.

**Probes.** Each workload the chart renders that has a readiness check uses that same
check as its liveness probe, and adds a startup probe that holds liveness off through a slow
first boot. The api waits up to 10 minutes for Postgres and its bootstrap. The
datastores wait 5 minutes for initdb or crash recovery. ArangoDB asks the
unauthenticated `/_admin/server/availability`. Speaker-diarization sends its key
and a `Host` it admits. Vault's probes pass while it is sealed. The relay has no
probes: tailscaled and socat expose no health endpoint.

**Resources.** Every container the chart renders requests CPU and memory and has a
memory limit: `api.resources`, `botDefaults.resources`, `infra.<name>.resources`,
`relay.tailscaleResources` / `forwarderResources`. The api's init container
reuses the api's figures. There are no CPU limits, as there never were on the api
and the bots; a CPU limit throttles rather than protects. ArangoDB is told its
memory limit (`ARANGODB_OVERRIDE_DETECTED_TOTAL_MEMORY`) so it sizes its caches to
the container. TimescaleDB's first-init tune sizes Postgres from the memory limit
if there is one, and from the node's memory otherwise. It never re-runs, so a
volume first initialised without a limit needs a limit that covers what it chose
then. [values-docker-desktop.yaml](values-docker-desktop.yaml) halves the default
requests to fit its one node, and leaves room for one bot launched at runtime.

**Namespace defaults.** On a main cluster the chart also renders the
`oshal-container-defaults` LimitRange (`limitRange.enabled`, default on). At admission it
gives `botDefaults.resources` to any container in the namespace that sets no resources: the
requests become its default requests, the memory limit its default limit. Every container
the chart renders sets its own figures, so the LimitRange changes none of them. It defaults
no CPU limit. No chart container sets one, so a default CPU limit would land on all of them
and refuse any whose CPU request is above it. For that reason a CPU limit in
`botDefaults.resources` fails the render while the LimitRange is on.

**Images.** Every infra image is a pinned tag, never `:latest`. The platform
image (`image.repository` / `image.tag`) is set separately.

**Pod Security.** Every pod the chart renders runs the RuntimeDefault seccomp profile.
Every container the chart renders runs with `allowPrivilegeEscalation: false` and drops
every capability, except as the table says. Measured from the render only; admission itself is proven
on a cluster, not here:

| Workload | Runs as | Restricted | Why not |
|---|---|---|---|
| `oshal-db`, `oshal-tsdb` | uid 70, the image's `postgres` user | yes | |
| `oshal-redis` | uid 999, the image's `redis` user | yes | |
| `oshal-vault` | uid 100, the image's `vault` user | yes | |
| `code-server` | uid 1000, the image's `USER` | yes | |
| `speaker-diarization` | uid 10001, the image's `USER` | yes | |
| `oshal-api` and every bot the chart declares | root | no (Baseline) | the oshal image has no `USER`; and it keeps `DAC_OVERRIDE`, because code-server writes the shared workspace as uid 1000 and root without it cannot write there |
| `oshal-chromadb` | root | no (Baseline) | the image has no `USER` and caches its embedding model under `/root` |
| `oshal-arangodb` | root | no (Baseline) | the image has no `USER`, its entrypoint never drops privileges, and the data volumes it has written are root-owned |
| `oshal-ollama` | root | no (Baseline) | the image has no `USER` and keeps models under `/root/.ollama` |
| `oshal-relay` | root | no (Privileged only) | it mounts `/dev/net/tun` from the host and adds `NET_ADMIN`; off by default |

**Capabilities on the api and the chart-declared bots.** Before chart 0.5.0 these containers set no
`securityContext`, so they ran with the container runtime's default capability set. They
now keep only `DAC_OVERRIDE`. That is enough to read and write the files code-server
(uid 1000) creates in the shared workspace. It is not enough to change those files' mode,
owner or timestamps. Linux allows `chmod`, and setting a file's timestamps to anything
other than the current time, only to the file's owner or to a process with `CAP_FOWNER`.
It allows `chown` only with `CAP_CHOWN` (see chmod(2), utimensat(2) and chown(2)). On a
file code-server owns, those calls now fail with `EPERM`. A render cannot show whether any
bot task makes them; that is checked on a cluster.

**Bots launched at runtime.** Of everything above, only the LimitRange reaches a bot the
controller launches at runtime. That bot's Deployment is built by `buildBotDeployment` in
`src/features/agent-management/services/kubernetes-bot-launcher.ts`, not by this chart. It
sets no `resources` and no `securityContext` on the pod or the container, and it has a TCP
readiness probe only. So such a bot sets no seccomp profile (the kubelet's default applies,
which is Unconfined unless the kubelet enables `seccompDefault`). It does not block privilege
escalation, it keeps the container runtime's default capabilities, and it has no liveness or
startup probe. Its resources come from the `oshal-container-defaults` LimitRange above, so a
ResourceQuota that requires requests does not refuse it for lack of them; that is the remedy
the Kubernetes ResourceQuota documentation names. A LimitRange cannot default a
`securityContext` or a probe. Setting those in the launcher is a core change, awaiting
approval in [the backlog](../../../docs/BACKLOG.md). Admission of such a bot is a cluster
check, and nothing here runs it.

## Dynamic bots — apps bring their own

An installed app can declare a bot that needs its own node. Under compose the
controller writes a compose overlay and starts the container; on a cluster it
creates a **Deployment + Service in this namespace**: the bot entrypoint,
`oshal-shared-env` + `oshal-bot-env`, the workspace PVC, and a Service named for
the bot because that name *is* the DNS the controller dials. It is not the same
workload as a chart-declared bot, in two ways. It does not read
`oshal-shared-secret`, so on the default posture it fails to boot until
`JWT_SECRET` is copied into `oshal-bot-env` (see [Credentials](#credentials)).
And it sets no resources, `securityContext`, liveness or startup probe. The
namespace LimitRange supplies its resources, and nothing supplies the rest (see
[Probes, resources and Pod Security](#probes-resources-and-pod-security)).
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
(creates nothing). `--require-server` exits non-zero unless the API server itself
admitted it and exposes `deployments/scale`. Without that flag, no reachable cluster
means a client-side check labelled NOT A PROOF that still exits 0:

```bash
npx tsx scripts/validate-dynamic-bot-manifest.mjs --require-server --namespace oshal --context <ctx>
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
