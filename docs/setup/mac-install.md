# macOS Install Guide

This guide is the fastest way to run the standalone/core convenience OSHAL stack on a Mac.

Historical operator context:

- `http://localhost:3456/cockpit/` remains the historical/default OSHAL app surface.
- this guide focuses on the separate standalone convenience stack exposed on `:35456`.

## Requirements

- macOS with Terminal access
- Docker Desktop installed and running
- Git

Optional for localhost mode:

- Node.js 20+
- npm

## Recommended Path: Docker

From the repo root:

```bash
bash scripts/install-docker.sh
```

That starts the core OSHAL stack with:

- Postgres
- Redis
- ChromaDB
- OSHAL API server

## Open These Standalone Convenience URLs

- app: `http://localhost:35456`
- chat: `http://localhost:35456/chat`
- cockpit: `http://localhost:35456/cockpit/`
- swagger: `http://localhost:35456/docs` (legacy alias: `/api-docs`)
- health: `http://localhost:35456/health`
- standalone convenience callback listener: `http://localhost:51455/auth/callback`

Historical/default operator surface (not what this helper boots):

- app: `http://localhost:3456`
- cockpit: `http://localhost:3456/cockpit/`

Redirect/auth note:

- in swarm-local mode, the project-manager bot is the default callback owner on `:1455`
- `:51455` belongs only to the standalone convenience stack host mapping and should not be confused with the default operator/app port

## Runtime Refresh Shortcut

```bash
bash oshal.sh status
bash oshal.sh refresh-core
```

The standalone/core Docker runtime is not hot-swapped. Rebuild or refresh the API container after TypeScript changes.

## Docker Commands

Follow logs:

```bash
bash scripts/run-docker.sh logs
```

Stop the stack:

```bash
bash scripts/run-docker.sh down
```

Reset the stack:

```bash
bash scripts/run-docker.sh reset
```

## Localhost Mode on Mac

If you want to run the Node server directly on macOS while keeping the backing services in Docker:

```bash
npm install
bash scripts/start-localhost.sh
```

Default local backing-service ports:

- Postgres: `55432`
- Redis: `56379`
- ChromaDB: `58000`

## Notes

- The scripts create `.env` from `.env.example` if needed.
- The default Docker path uses `MOCK_OIDC=true` so you can boot without real Keycloak setup.
- The self-registering and self-learning bot loop is still the main unfinished product gap.
