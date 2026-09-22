# Deployment Manifests

> **LEGACY — DO NOT DEPLOY.** Everything Kubernetes in this directory, except `argo/`, belongs to
> the quarantined pre-chart generation. The current Kubernetes path is the Helm chart at
> [`deploy/helm/oshal`](../../deploy/helm/oshal/README.md), installed with
> `bash scripts/oshal-install.sh --mode 4 --admin-email you@example.com`. Start with
> [docs/k8/README.md](../../docs/k8/README.md); the decision is
> [ADR-129](../../docs/adr/129-codeless-k8s-install-path.md). Multi-user tenants go through
> [deploy/terraform](../../deploy/terraform/README.md).

## What is in this directory

| File | Status | What it is |
|------|--------|------------|
| `kubernetes/oshal-stack.yaml` | legacy, do not deploy | The original single-API stack (api-server, postgres, keycloak, redis, chromadb) in namespace `oshal`. It runs `oshal-api-server:latest`, an image nothing in this repo builds, with Keycloak `start-dev` on port 3456. |
| `kubernetes/oshal-secrets.example.yaml` | legacy | The Secret template for that stack. |
| `oshal-k8s.env.example` | legacy | The env file `scripts/setup-oshal-k8s.sh` reads to render that stack. |
| `presentron-integration.yaml` | legacy, do not deploy | A Presentron Deployment in the legacy `oshal` namespace. Its image, `presentron:latest`, is built by nothing in this repo. |
| `docker-compose.platform.yml` | legacy | The legacy compose stack. The current compose stack is `docker-compose.oshal-local.yml` at the repo root. |
| [`argo/`](argo/README.md) | ADR-078 prove-out | The Argo WorkflowTemplate and per-tenant namespace examples. Not part of the legacy generation; its README says what is proven. |

Every legacy manifest carries a `LEGACY — DO NOT DEPLOY` banner at the top of the file.

## What an earlier revision of this README described

An earlier revision headed a section "OSHAL Kubernetes Deployment (Primary)". It described a
17-bot `oshal-bot` stack, tabled `kubernetes/oshal-namespace.yaml` and
`kubernetes/oshal-local-k8s.yaml`, and documented an `oshal-hot-patches` ConfigMap and an
`oshal-readonly-runtime` ClusterRole. None of those exist in any manifest in this repository, and
the section's "Full deploy" heading had no command under it. That section was removed. The stack
the chart deploys today is documented in
[deploy/helm/oshal/README.md](../../deploy/helm/oshal/README.md).

## Rendering the legacy stack anyway

The legacy helpers refuse to run by default and print the current path instead. The files are
kept, not deleted, while the operator decides between deleting the legacy generation and keeping
it quarantined. To render the legacy bundle on purpose:

```bash
cp ops/deployment/oshal-k8s.env.example ops/deployment/oshal-k8s.env
OSHAL_ALLOW_LEGACY_K8S=1 bash scripts/setup-oshal-k8s.sh \
  --env-file ops/deployment/oshal-k8s.env --skip-build
```

It writes the bundle to `output/k8/oshal/` and applies nothing unless you add `--apply`.
