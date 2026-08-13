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

The installer preflights kubectl/helm, finds (or offers to create) a cluster,
installs the [deploy/helm/oshal](../../deploy/helm/oshal/) chart from the
published OCI package (repo fallback), exposes the cockpit on a NodePort, waits
for health, and opens `/welcome`. Chart reference, fleet presets, and the
how-bots-get-a-brain-on-k8s story: [deploy/helm/oshal/README.md](../../deploy/helm/oshal/README.md).

**Multi-user public tenants** go through [deploy/terraform](../../deploy/terraform/README.md)
instead — its real-OIDC and secret-minting posture guards are the point there.

Never run a kind cluster and the compose swarm on the same machine (documented
OOM pairing); the installer refuses to create that shape.

## Available documents

- [`any-bot-kubernetes-setup.md`](any-bot-kubernetes-setup.md) — **legacy**: the
  pre-chart `any-bot-k8s` render/apply workspace (`npm run k8:install:any-bot`,
  Keycloak-era stack, builds from source). Superseded by the chart path above for
  new installs; kept while the rendered stacks it produced remain in service.
