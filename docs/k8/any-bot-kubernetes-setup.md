# any-bot Kubernetes Setup Guide

This guide explains how to prepare, render, and optionally apply the new `any-bot-k8s` deployment workspace.

## What this setup gives you

The baseline deployment includes:

- `postgres`
- `redis`
- `chromadb`
- `google-search-mcp`
- `any-bot-api`
- `any-bot-ui`
- `any-bot-gateway`

The gateway is wired for **private internet access through Headscale / Tailscale-compatible mesh networking**.

## What the setup script does

The setup helper is:

```bash
bash scripts/setup-any-bot-k8s.sh
```

There is also an npm-wrapped entrypoint:

```bash
npm run k8:install:any-bot -- --env-file any-bot-k8s/setup.env
```

And a package binary entrypoint:

```bash
npm exec oshal-any-bot-k8s-setup -- --env-file any-bot-k8s/setup.env
```

## Local distribution without publishing to npm

If you want to distribute this as an easy-to-install npm package **without** publishing to a registry, build a local tarball:

```bash
npm run k8:pack:any-bot
```

That writes a `.tgz` package file into:

```text
output/npm/
```

Then copy that tarball to another computer and install it directly:

```bash
npm install -g /path/to/oshal-any-bot-k8s-installer-1.0.0.tgz
```

After install, the command is available as:

```bash
oshal-any-bot-k8s-setup --help
```

This does **not** publish anything to npmjs.org or any other registry.

## Docker-based installer without a registry

If you prefer a Docker-based installer, build the local image:

```bash
npm run k8:docker:installer:build
```

If you want to transfer that Docker installer to another machine **without pushing to any Docker registry**, export it:

```bash
npm run k8:docker:installer:export
```

That writes an archive to:

```text
output/docker/
```

On the target machine, load it with:

```bash
gunzip -c output/docker/oshal-any-bot-k8s-installer-1.0.0.tar.gz | docker load
```

Then run it like this:

```bash
docker run --rm -it \
  -v "$PWD/any-bot-k8s/setup.env:/workspace/setup.env:ro" \
  -v "$PWD/output:/workspace/output" \
  -v "$HOME/.kube:/root/.kube:ro" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  oshal-any-bot-k8s-installer:1.0.0 \
  --env-file /workspace/setup.env \
  --output-dir /workspace/output/k8/any-bot
```

Notes:

- mount `~/.kube` if you want the installer container to talk to your Kubernetes cluster
- mount `/var/run/docker.sock` if you want the installer container to build the converted OSHAL API image from the repository-root `Dockerfile`
- use `--skip-build` if you do **not** want the containerized installer to build the API image

It performs the following steps:

1. Loads required values from your env file
2. Optionally builds the converted OSHAL API image from the repository root
3. Renders `any-bot-k8s` with `kubectl kustomize`
4. Replaces the placeholder Headscale login server, API image tag, and runtime defaults in the rendered stack
5. Generates Kubernetes Secret manifests from your env values
6. Writes output artifacts to `output/k8/any-bot/`
7. Optionally applies the namespace, secrets, and stack to the current cluster

## Prerequisites

Before running the script, make sure you have:

- `kubectl`
- `python3`
- `docker` if you are not using `--skip-build`
- a reachable Kubernetes cluster if you plan to use `--apply`
- a reachable Headscale control plane
- a valid Headscale/Tailscale pre-auth key for the gateway

## Prepare your env file

Copy the example file:

```bash
cp any-bot-k8s/setup.env.example any-bot-k8s/setup.env
```

Then edit `any-bot-k8s/setup.env` and set real values for:

- `POSTGRES_DB`
- `POSTGRES_USER`
- `POSTGRES_PASSWORD`
- `REDIS_URL`
- `TS_AUTHKEY`
- `HEADSCALE_LOGIN_SERVER`

Optional values:

- `ANTHROPIC_API_KEY`
- `PRESENTRON_API_KEY`
- `KEYCLOAK_CLIENT_SECRET`
- `APP_URL`
- `MOCK_OIDC`
- `GOOGLE_SEARCH_MCP_URL`
- `GOOGLE_SEARCH_MCP_IMAGE`
- `IMAGE_TAG`
- `APPLY_MANIFESTS`
- `SKIP_IMAGE_BUILD`

## Basic render-only workflow

If you want the script to prepare everything but **not** apply to the cluster yet:

```bash
npm run k8:install:any-bot -- \
  --env-file any-bot-k8s/setup.env
```

If you already built or pushed the image separately:

```bash
npm run k8:install:any-bot -- \
  --env-file any-bot-k8s/setup.env \
  --skip-build
```

### Rendered output

The script writes these files to:

```text
output/k8/any-bot/
```

Artifacts:

- `generated-secrets.yaml`
- `rendered-stack.yaml`
- `bundle.yaml`

## Apply workflow

If your current `kubectl` context points at a working cluster, you can let the script apply everything:

```bash
npm run k8:install:any-bot -- \
  --env-file any-bot-k8s/setup.env \
  --apply
```

The script applies in this order:

1. `any-bot-k8s/namespace.yaml`
2. `output/k8/any-bot/generated-secrets.yaml`
3. `output/k8/any-bot/rendered-stack.yaml`

## Manual apply commands

If you rendered first and want to apply later:

```bash
kubectl apply -f any-bot-k8s/namespace.yaml
kubectl apply -f output/k8/any-bot/generated-secrets.yaml
kubectl apply -f output/k8/any-bot/rendered-stack.yaml
```

## Validate rollout

After apply:

```bash
kubectl -n any-bot get pods
kubectl -n any-bot get svc
kubectl -n any-bot logs deploy/any-bot-gateway -c tailscale --tail=100
kubectl -n any-bot logs deploy/any-bot-api --tail=100
```

Useful checks:

- `any-bot-api` should pass `/health`
- `any-bot-gateway` should pass the Tailscale `/healthz` probe on port `9002`
- `any-bot-ui` should proxy traffic to `any-bot-api`
- `postgres` should become ready with `pg_isready`
- `redis` should respond to `PING`
- `chromadb` should pass `/api/v1/heartbeat`
- `google-search-mcp` should pass `/health`

## Outside access validation

Once the gateway joins your Headscale network:

1. join an outside machine to the same Headscale network
2. find the gateway tailnet IP or MagicDNS name
3. browse to the gateway over the tailnet
4. confirm the request path flows through:

```text
outside machine -> any-bot-gateway -> any-bot-ui -> any-bot-api
```

## Docker Desktop Kubernetes note

If you are testing locally with Docker Desktop Kubernetes:

- enable Kubernetes in Docker Desktop first
- verify your context before apply:

```bash
kubectl config current-context
kubectl cluster-info
```

If your API server is not reachable, the script can still render artifacts, but apply will fail.

## Troubleshooting

### `kubectl` cannot reach `127.0.0.1:6443`

That means no working Kubernetes API server is available for the active context.

You can still:

- run the setup script without `--apply`
- inspect `output/k8/any-bot/rendered-stack.yaml`
- switch to a valid cluster context later and apply manually

### Tailscale gateway does not connect

Check:

- `HEADSCALE_LOGIN_SERVER`
- `TS_AUTHKEY`
- gateway logs:

```bash
kubectl -n any-bot logs deploy/any-bot-gateway -c tailscale --tail=200
```

### Remote cluster cannot pull the image

If your cluster is not using the same Docker image cache as your workstation:

1. push the image to a registry
2. rerun the script with a registry-backed image tag:

```bash
npm run k8:install:any-bot -- \
  --env-file any-bot-k8s/setup.env \
  --image-tag your-registry.example.com/oshal-api-server:latest \
  --skip-build
```

### Optional MCP features are missing

That is expected in the baseline setup. The current stack intentionally keeps optional companion services disabled until those workloads are added to the cluster.

### `chromadb` host cannot be resolved

The baseline Kubernetes stack now includes an in-cluster `chromadb` Deployment and Service and sets:

- `CHROMADB_HOST=chromadb`
- `CHROMADB_PORT=8000`
- `CHROMADB_URL=http://chromadb:8000`

If you still see host resolution errors, verify:

```bash
kubectl -n any-bot get svc chromadb
kubectl -n any-bot get pods -l app=chromadb
```

## Notes about the local npm tarball

- the tarball is a **local distribution artifact**, not a published package
- it is intended for easy install on other computers you control
- it is a curated installer package that includes the Kubernetes workspace plus the converted root-runtime Docker build context
