# Scripts Module

## Core Runtime Helpers

These are the primary scripts a new reviewer should use first.

### Docker-first install and run

Boot the self-contained core stack:

```bash
bash scripts/install-docker.sh
```

Manage the stack:

```bash
bash scripts/run-docker.sh up
bash scripts/run-docker.sh logs
bash scripts/run-docker.sh ps
bash scripts/run-docker.sh down
```

### Localhost runtime

Run the API server on the host while Docker provides Postgres, Redis, and Chroma:

```bash
bash scripts/start-localhost.sh
```

### Kubernetes bundle rendering

Render the core Kubernetes bundle:

```bash
bash scripts/install-k8s.sh --env-file ops/deployment/oshal-k8s.env.example --skip-build
```

### Legacy bot import

Import the broader persona catalog into the active OSHAL database:

```bash
bash scripts/import-all-bots.sh
```

### Swarm bot lifecycle

Control swarm-local bot containers with restart, rebuild, and rollback:

```bash
bash scripts/swarm-bot-lifecycle.sh restart project-manager
bash scripts/swarm-bot-lifecycle.sh rebuild code-developer
bash scripts/swarm-bot-lifecycle.sh rollback code-developer
```

### Swarm runtime control

Inspect what the swarm is really running and explicitly stop runs or tickets:

```bash
bash scripts/swarm-runtime-control.sh active
bash scripts/swarm-runtime-control.sh --dry-run stop-all "operator cleanup"
bash scripts/swarm-runtime-control.sh stop-run 1c410ce5-053c-43a4-abce-88394672c27d "stuck run"
```

## Repository Sync Helper

The `gitlab-origin-push.ts` script is now a **generic repository sync helper**. It can:

- scan a root directory for Git repositories up to two levels deep
- stop descending once a Git repository boundary is found
- use the existing configured `origin` when a repository already exists
- bootstrap a non-git root into a new repository when configuration is supplied
- ensure a standard `.gitignore` that covers `.env` files and common build output
- create or plan remote repositories for GitHub, GitLab, or generic hosts
- push through the configured provider using credentials from a local env file, process env, or embedded origin credentials

The CLI entrypoint delegates to modular services under `scripts/gitlab-origin-push-core/` so the implementation remains within the project's file-size constraints.

### Configuration and credential resolution

The helper merges configuration from CLI options, explicit env files, root-level `.env*` files, and repository-local `.env*` files. Supported env files include:

- `.env.repo-sync`
- `.env.git-sync`
- `.env.git`
- `.env`
- `.env.local`
- `.env.development`
- `.env.dev`
- `.env.example`
- `.env.dev.example`

Common configuration keys include:

- `REPO_SYNC_PROVIDER` / `GIT_PROVIDER` → `github`, `gitlab`, or `generic`
- `REPO_SYNC_HOST` / `GIT_HOST`
- `REPO_SYNC_OWNER` / `GIT_REPO_OWNER`
- `REPO_SYNC_REPO_NAME` / `GIT_REPO_NAME`
- `REPO_SYNC_ORIGIN_URL` / `GIT_ORIGIN_URL`
- `REPO_SYNC_BRANCH` / `GIT_DEFAULT_BRANCH`
- `REPO_SYNC_VISIBILITY` / `GIT_REPO_VISIBILITY`
- `REPO_SYNC_DESCRIPTION` / `GIT_REPO_DESCRIPTION`
- `REPO_SYNC_COMMIT_MESSAGE` / `GIT_COMMIT_MESSAGE`
- `REPO_SYNC_USERNAME` / `GIT_REPO_USER` / `GIT_USERNAME`
- `REPO_SYNC_PASSWORD` / `GIT_REPO_PASS` / `GIT_PASSWORD`
- `REPO_SYNC_TOKEN` / `GIT_REPO_TOKEN` / `GITHUB_TOKEN` / `GITLAB_TOKEN`
- `GIT_USER_NAME`
- `GIT_USER_EMAIL`

Credential precedence is:

1. Embedded username/password or token in the configured `origin`
2. Repository/root env files
3. `process.env`

### Usage

Dry run only:

```bash
npm run repo:sync
```

## Swarm runtime inspection helper

The scripts module now also contains a Docker swarm inspection helper:

- `swarm-run-inspect.sh`
- `cleanup-runtime-state.ts`

It is meant for exactly the situation where the swarm feels opaque and you need
to see what actually happened for a run without manually stitching together
Postgres queries, `ps`, and Docker logs.

### Quick usage

Inspect the newest run:

```bash
bash scripts/swarm-run-inspect.sh
```

Inspect a specific run:

```bash
bash scripts/swarm-run-inspect.sh 8f939610-71eb-4698-acc1-5dcb845032b6
```

The helper prints:

- the swarm run record with status, error, and duration
- related work items
- execution output
- verification output
- active `cline` worker processes in the `api-server` container
- recent `api-server` Docker logs

## Runtime-state cleanup helper

`cleanup-runtime-state.ts` is a surgical Postgres cleanup tool for stale runtime artifacts identified in Session 108 handover analysis.

### What it targets

- stale `chat_tasks` in `created` status that are old, have zero messages, and are not linked to tickets
- stale `chat_tasks` in `active`/`processing` status that are old and unlinked
- stale `swarm_runs` stuck in `in_progress` with no blocking work items
- optional orphan `work_items` referencing missing `swarm_runs`

### Safety model

- default mode is **dry-run** (no mutations)
- destructive actions run **only** when `--apply` is provided
- all apply actions run in a single transaction
- updates annotate affected records with cleanup metadata

### Usage

Dry-run with defaults:

```bash
npm run cleanup:runtime-state
```

Dry-run with custom thresholds/sources:

```bash
npm run cleanup:runtime-state -- \
  --created-minutes=45 \
  --stuck-hours=8 \
  --run-hours=3 \
  --created-sources=swarmbot-chat,none \
  --stuck-sources=swarmbot-chat,none
```

Apply mutations:

```bash
npm run cleanup:runtime-state -- --apply
```

Include orphan work-item escalation:

```bash
npm run cleanup:runtime-state -- --include-orphan-work-items --orphan-hours=6
```

## Legacy persona bot import helper

The scripts module now also contains a legacy persona migration helper:

- `import-legacy-persona-bots.ts`
- `import-legacy-persona-bots-auth-aliases.ts`

It is designed for migrating old swarm bot personas into OSHAL with tool
authorization behavior preserved.

### What it does

- scans `ai-lab/bot-personas` for `.yaml/.yml` persona files (or custom `--persona-dir`)
- parses mixed legacy schema keys (`agent_id`/`agentId`, `system_prompt`/`systemPrompt`, etc.)
- resolves enabled tools from the `tools` table and maps persona `authorizations` keys via alias rules
- creates missing `agents` or updates existing `agents` (matched by normalized name)
- upserts `agent_tools` rows with normalized `auth_mode` values (`auto`, `ask`, `off`)
- warns on unresolved authorization keys that do not match enabled tools

### Safety model

- default mode is **dry-run** (planning/logging only)
- write mode requires explicit `--apply`
- apply mode runs in a single transaction
- `.env` defaults are loaded automatically when present

### Usage

Show help:

```bash
npm run import:legacy-bots -- --help
```

Dry-run all persona files:

```bash
npm run import:legacy-bots
```

Dry-run subset:

```bash
npm run import:legacy-bots -- --include=gcp-cli-bot,devops-bot
```

Dry-run with exclusions:

```bash
npm run import:legacy-bots -- --exclude=everything-default
```

Apply changes:

```bash
npm run import:legacy-bots -- --apply
```

Real push:

```bash
npm run repo:sync -- --push
```

Bootstrap a non-git root using provider settings:

```bash
npm run repo:sync -- \
  --root /absolute/path \
  --provider github \
  --host github.com \
  --owner your-user-or-org \
  --repo-name your-repo \
  --visibility private
```

## Kubernetes deployment helper

The scripts module now also contains:

- `setup-oshal-k8s.sh`
- `setup-any-bot-k8s.sh`
- `any-bot-local-cli.js`

These helpers render and optionally apply the root `oshal` and `any-bot-k8s` Kubernetes workspaces.

### Root OSHAL quick usage

```bash
npm run k8:setup:oshal -- --env-file ops/deployment/oshal-k8s.env.example --skip-build
```

The root helper:

- renders `ops/deployment/kubernetes/oshal-stack.yaml` into `output/k8/oshal/`
- generates a real `oshal-secrets` manifest from env values
- rewrites the embedded Keycloak client secret and redirect URIs to match the deployment hostname
- strips the default bootstrap dev users unless `INCLUDE_BOOTSTRAP_DEV_USERS=true`
- can optionally build the API image and apply the generated bundle

### any-bot quick usage

```bash
bash scripts/setup-any-bot-k8s.sh --env-file ops/any-bot-k8s/setup.env
```

Convenience package script:

```bash
npm run k8:setup:any-bot -- --env-file ops/any-bot-k8s/setup.env
```

Installation-style npm entrypoint:

```bash
npm run k8:install:any-bot -- --env-file ops/any-bot-k8s/setup.env
```

Local-distribution tarball builder:

```bash
npm run k8:pack:any-bot
```

Docker installer image builder:

```bash
npm run k8:docker:installer:build
```

Docker installer image exporter for no-registry distribution:

```bash
npm run k8:docker:installer:export
```

Package binary entrypoint:

```bash
npm exec oshal-any-bot-k8s-setup -- --env-file ops/any-bot-k8s/setup.env
```

The script:

- optionally builds the converted OSHAL API image
- renders `ops/any-bot-k8s` with `kubectl kustomize`
- injects the real Headscale login server and image tag into the rendered output
- generates Kubernetes Secrets from your env values
- writes artifacts to `output/k8/any-bot/`
- optionally applies the namespace, secrets, and rendered stack to the current cluster

The local packaging helper:

- creates a `.tgz` tarball in `output/npm/`
- does **not** publish anything to a public or private npm registry
- lets you copy the tarball to another machine and install it with `npm install -g /path/to/*.tgz`
- stages a **curated installer package** instead of packaging the whole repository
- excludes unrelated runtime artifacts such as local SQLite databases and backup files

The Docker installer helper:

- builds a curated Docker image containing the installer CLI, manifests, docs, and required `any-bot` build assets
- can optionally export that image to `output/docker/*.tar.gz`
- does **not** require a Docker registry if you move the saved archive file manually
- can use mounted kubeconfig and Docker socket access from the host machine when you want the containerized installer to apply manifests or build the API image

The npm/bin wrapper delegates to the same shell helper, so all CLI options remain the same.

### Notes

- Existing repositories with an `origin` sync to that origin first; configuration is mainly used when a remote must be created or when the root is not yet a Git repository.
- GitHub repositories can be created via the GitHub REST API when `GITHUB_TOKEN` or an equivalent repo-sync token is provided.
- GitLab repositories can be created via the GitLab REST API when `GITLAB_TOKEN` or an equivalent repo-sync token is provided.
- Generic providers are supported for remote URL construction and authenticated HTTPS push targets, but automatic remote creation is dry-run only unless a provider API is explicitly implemented.
- If no token or password is found, the script falls back to the configured remote URL so existing SSH keys or credential helpers can still be used.
- The Kubernetes helper assumes you already have a Headscale control plane and a valid pre-auth key; it does not bootstrap Headscale itself.
- The `k8:pack:any-bot` workflow is for **local distribution only**; it builds a dedicated installer tarball and does not contact the npm registry.
- The Docker installer image also supports **local-only distribution** when exported with `k8:docker:installer:export` and loaded on another machine with `docker load`.

## Local any-bot launcher

The scripts module now also contains a **cross-platform local launcher** for the core any-bot runtime:

- `any-bot-local-cli.js`
- `any-bot-local-deps.compose.yaml`
- `build-any-bot-local-package.js`

This flow is for **macOS, Windows, and Linux** and is intentionally separate from the Kubernetes installer.

### Quick usage

Initialize the local runtime:

```bash
npm run local:any-bot -- init
```

Start locally in the foreground:

```bash
npm run local:start:any-bot
```

Start locally in detached/background mode:

```bash
npm run local:any-bot -- start --detached
```

Check status:

```bash
npm run local:status:any-bot
```

Stop the detached server and dependency containers:

```bash
npm run local:stop:any-bot
```

Build a distributable local installer tarball:

```bash
npm run local:pack:any-bot
```

The local launcher:

- creates a runtime directory under the current user's home directory by default
- writes a generated `any-bot-local.env` file
- defaults to `MOCK_OIDC=true` and `LLM_PROVIDER=noop` for localhost usability
- starts Docker-backed Postgres, Redis, ChromaDB, and Google Search MCP unless `--skip-deps` is used
- runs the compiled OSHAL server on the host at `http://localhost:3456/chat`

The local packaging helper:

- builds the compiled runtime assets before packaging
- stages the minimal host-run runtime (`dist/`, required UI assets, local CLI, migrations, docs)
- emits a local tarball in `output/npm/`
- is intended for **local/no-registry distribution**, just like the Kubernetes installer tarball
