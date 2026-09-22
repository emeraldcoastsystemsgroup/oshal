# Core Setup Guide

This guide covers the standalone/core convenience runtime for OSHAL.

Historical operator context:

- `http://localhost:3456/cockpit/` remains the historical/default OSHAL app surface.
- this guide documents the separate standalone convenience stack exposed on `:35456`.

For a Mac-specific walkthrough, see [macOS Install Guide](./mac-install.md).

## Fastest Start

```bash
bash scripts/install-docker.sh
```

That launches:

- `oshal-db`
- `oshal-redis`
- `oshal-chromadb`
- `api-server`

## Standalone Convenience URLs

- app: `http://localhost:35456`
- chat: `http://localhost:35456/chat`
- cockpit: `http://localhost:35456/cockpit/`
- swagger: `http://localhost:35456/docs` (legacy alias: `/api-docs`)
- health: `http://localhost:35456/health`
- standalone convenience callback listener: `http://localhost:51455/auth/callback`

Historical/default operator surface (not started by this helper path):

- app: `http://localhost:3456`
- cockpit: `http://localhost:3456/cockpit/`

Redirect/auth note:

- historical intent is that callback ownership belongs to an existing bot node, defaulting to the project-manager bot on `:1455`
- this standalone convenience stack keeps a separate host mapping on `:51455` only as a convenience wrapper around its internal `:1455` listener

## Runtime Refresh Shortcut

```bash
bash oshal.sh status
bash oshal.sh refresh-core
```

This standalone convenience mode is not hot-swapped. Rebuild or refresh the API container after TypeScript changes.

## Docker Management

Start or rebuild:

```bash
bash scripts/run-docker.sh up
```

Stop:

```bash
bash scripts/run-docker.sh down
```

Watch logs:

```bash
bash scripts/run-docker.sh logs
```

Reset volumes:

```bash
bash scripts/run-docker.sh reset
```

## Localhost Mode

Run the API server on your host while keeping the stateful services in Docker:

```bash
npm install
bash scripts/start-localhost.sh
```

Default localhost assumptions:

- `MOCK_OIDC=true`
- Postgres on `localhost:55432`
- Redis on `localhost:56379`
- ChromaDB on `localhost:58000`

## Kubernetes Mode

Kubernetes installs use the Helm chart at `deploy/helm/oshal`, with no source checkout and no
build:

```bash
bash scripts/oshal-install.sh --mode 4 --admin-email you@example.com
```

Start with [docs/k8/README.md](../k8/README.md); the decision is
[ADR-129](../adr/129-codeless-k8s-install-path.md). The older `scripts/install-k8s.sh` bundle
renderer belongs to the legacy, pre-chart generation. It is quarantined and refuses to run unless
`OSHAL_ALLOW_LEGACY_K8S=1` is set.

## Environment Expectations

The helper scripts create `.env` from `.env.example` if it does not exist.

For the core Docker path, the important defaults are already injected by `docker-compose.core.yml`, including:

- runtime database connection
- Redis connection
- ChromaDB connection
- mock authentication mode

## Known Gap

The self-registering and self-learning bot loop is not fully live yet. Dynamic provisioning works, but autonomous bot growth is still the main unfinished platform capability.
