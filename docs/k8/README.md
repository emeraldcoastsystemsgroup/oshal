# docs/k8

Kubernetes-focused operating documentation for oshal.

## The current path: codeless install (ADR-129)

oshal installs onto any Kubernetes cluster (Docker Desktop, kind, k3s, managed)
with **no source checkout and no build** — helm + registry images only:

```bash
curl -fsSLO https://raw.githubusercontent.com/emeraldcoastsystemsgroup/oshal/main/scripts/oshal-install.sh
bash oshal-install.sh --mode 4 --admin-email you@example.com
```

Windows (PowerShell):

```powershell
.\scripts\oshal-install.ps1 -Kubernetes -AdminEmail you@example.com
```

You need **nothing preinstalled**: the installer offers to install `kubectl` and
`helm`, and — when no cluster is reachable — to stand one up (**k3s** on Linux,
**kind** wherever Docker is running; on Windows it offers Docker Desktop, kubectl,
Helm and kind by winget id). Every step asks first; add `--yes` / `-Yes` for an
unattended install.

The installer preflights kubectl/helm, finds (or offers to create) a cluster,
installs the [deploy/helm/oshal](../../deploy/helm/oshal/) chart from the
published OCI package (repo fallback), exposes the cockpit on a NodePort, waits
for health, and opens `/welcome`. Chart reference, the shared-service table, and
the how-bots-get-a-brain-on-k8s story:
[deploy/helm/oshal/README.md](../../deploy/helm/oshal/README.md).

Bundles and apps work the same as on compose — they stage into the workspace
before the api boots:

```bash
bash oshal-install.sh --mode 4 --bundle jobs                 # curated set
bash oshal-install.sh --mode 4 --apps dnd,game-show          # individual packages
```

The install brings up the same service tier a default `docker compose up` does
(Postgres, Redis, Chroma, TimescaleDB, ArangoDB, Vault, code-server,
speaker-diarization), each switchable via `infra.<name>.inCluster`.

**Multi-user public tenants** go through [deploy/terraform](../../deploy/terraform/README.md)
instead — its real-OIDC and secret-minting posture guards are the point there.

Never run a kind cluster and the compose swarm on the same machine (documented
OOM pairing); the installer refuses to create that shape.

## Docker Desktop Kubernetes and monitoring

- [`deploy/helm/oshal/values-docker-desktop.yaml`](../../deploy/helm/oshal/values-docker-desktop.yaml)
  is the overlay for Docker Desktop's built-in Kubernetes running a locally built image. The image
  is side-loaded into the node (`pullPolicy: Never`). The cockpit is a LoadBalancer on
  `localhost:5000`, because Docker Desktop does not publish NodePorts to the host. Bot requests are
  sized for one ~7.6 GiB node. `swarm.extraEnv` carries compose's platform switches, including
  `APP_PACKAGE_DYNAMIC_ROUTES=1`; without it protected store apps fail activation closed. The
  file's header has the install commands.
- [`deploy/monitoring/install-monitoring.sh`](../../deploy/monitoring/install-monitoring.sh) is the
  cluster form of the compose monitoring stack, run after the chart is installed. It installs
  kube-prometheus-stack with
  [`kube-prometheus-stack.values.yaml`](../../deploy/monitoring/kube-prometheus-stack.values.yaml)
  and loads `ops/monitoring/alert-rules.yml` as a PrometheusRule. It also routes the `Swarm*`
  alerts to the api's fail-closed `/api/alerts/alertmanager` intake with a generated
  `ALERT_WEBHOOK_TOKEN`.

What a live run of both measured is recorded in the
[remote-cluster work package](remote-cluster-work-package.md) status note (2026-09-21).

## Available documents

- [`any-bot-kubernetes-setup.md`](any-bot-kubernetes-setup.md) — **legacy**: the
  pre-chart `any-bot-k8s` render/apply workspace (`npm run k8:install:any-bot`,
  Keycloak-era stack, builds from source). Superseded by the chart path above for
  new installs; kept while the rendered stacks it produced remain in service.

## The remote-cluster work package

[remote-cluster-work-package.md](remote-cluster-work-package.md) — every Kubernetes item in this
repository, gathered for a machine that runs a real cluster. The development box runs the whole
swarm in docker compose and does not host one, so the package also states what must never be
attempted there. It carries the measured state of the chart, the Argo and Terraform material, the
guards that pass with no cluster present, the work in dependency order with each item's done-when,
and the proofs that only a live cluster can give.
