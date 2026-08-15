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

## Available documents

- [`any-bot-kubernetes-setup.md`](any-bot-kubernetes-setup.md) — **legacy**: the
  pre-chart `any-bot-k8s` render/apply workspace (`npm run k8:install:any-bot`,
  Keycloak-era stack, builds from source). Superseded by the chart path above for
  new installs; kept while the rendered stacks it produced remain in service.
