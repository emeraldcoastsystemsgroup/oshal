# any-bot-k8s

This directory contains a **root-level Kubernetes deployment workspace** for deploying `any-bot` with:

- **Postgres**
- **Redis**
- **ChromaDB**
- **Google Search MCP**
- **any-bot API**
- **any-bot UI**
- a **secure gateway deployment**
- **Headscale-compatible overlay network settings** so outside machines can reach the gateway securely over the internet

This workspace is intentionally scoped to the **core any-bot stack plus the runtime-critical Google Search MCP dependency**. Other optional companion services such as Plane integrations, Chroma MCP, and Presentron remain out of the baseline deployment.

## Architecture

This workspace uses the following model:

```text
outside machine
    |
    |  Headscale / Tailscale-compatible encrypted mesh
    v
any-bot-gateway (tailscale sidecar + nginx proxy)
    |
    v
any-bot-ui (nginx edge)
    |
    v
any-bot-api (Node/Express)
 / /|\ \
v v v v
postgres redis chromadb google-search-mcp
```

### Why this shape?

- `any-bot-api` runs the converted OSHAL runtime built from the repository-root `Dockerfile` and served by `src/app/server.ts`
- `any-bot-ui` gives you a separate UI deployment boundary, even though the current API image still serves the HTML application
- `any-bot-gateway` is the secure overlay-network entrypoint for internet-reachable private access
- the gateway joins your **Headscale-managed mesh** and exposes the stack to approved outside nodes

## Important design note

This gateway is implemented as a **Kubernetes deployment**, not a physical Kubernetes node.

That is good for:

- proof of concept
- Docker Desktop or single-node lab work
- first-pass internet-secure private access through Headscale

For a heavier production environment, you may later decide to move the gateway to:

- a dedicated VM
- a DaemonSet on selected worker nodes
- or a more advanced ingress/VPN edge pattern

## Files

- `kustomization.yaml` — root Kustomize entrypoint
- `namespace.yaml` — dedicated namespace
- `any-bot-stack.yaml` — main stack resources
- `secrets.example.yaml` — secret template for API and gateway auth
- `HANDOVER.md` — next-session state and follow-up work

## What gets deployed

### Postgres

- in-cluster PostgreSQL deployment and service
- persistent storage for the converted runtime's registry/bootstrap data
- credentials sourced from `any-bot-secrets`
- internal-only access from the API on port `5432`

### Redis

- persistent Redis deployment
- append-only persistence enabled
- internal-only access from the API

### ChromaDB

- in-cluster ChromaDB deployment and service
- persistent storage for vector data
- reachable from the API as `http://chromadb:8000`
- included to resolve the canonical `CHROMADB_HOST=chromadb` runtime expectation

### Google Search MCP

- in-cluster Google Search MCP deployment and service
- exposed to the API/runtime as `http://google-search-mcp:8080/mcp`
- health-checked on `/health`
- uses Supergateway to publish the official Google Search stdio server as a streamable HTTP endpoint

### any-bot API

- uses the converted OSHAL root-runtime image (`oshal-api-server:latest` by default)
- listens on application port `3456` plus callback port `1455`
- uses `/health` for startup, readiness, and liveness probes
- defaults to `MOCK_OIDC=true` so the stack is locally testable without an external Keycloak dependency
- mounts persistent volumes for:
  - `/app/output`
  - `/app/workspace`
  - `/app/workspace-shared`
- connects to Postgres, Redis, ChromaDB, and Google Search MCP through in-cluster service discovery

### any-bot UI

- nginx deployment that fronts the API service
- acts as a dedicated UI entrypoint service
- can later be replaced by a true static frontend image if you split the UI build
- includes proxy settings for long-lived HTTP connections used by SSE and Socket.IO style upgrade flows

### Secure gateway

- nginx proxy container
- `tailscale/tailscale` sidecar container
- Headscale-compatible environment variables and secret wiring
- designed so approved outside machines can reach the gateway over the internet through the mesh
- runs the Tailscale sidecar in **userspace mode** so the gateway no longer depends on a privileged container for the baseline deployment
- uses `TS_DEST_IP=127.0.0.1` so incoming tailnet traffic is forwarded to the in-pod nginx gateway proxy
- exposes a local Tailscale health endpoint on port `9002` for pod readiness/liveness checks

## Secure internet access model

This stack does **not** assume an open public ingress by default.

Instead, the secure default is:

1. run **Headscale** somewhere reachable
2. create a **pre-auth key**
3. put that key in `any-bot-k8s/secrets.example.yaml`
4. deploy `any-bot-gateway`
5. join your outside machine to the same Headscale network
6. access any-bot through the gateway's **tailnet IP** or your Headscale DNS setup

That means the service works **over the internet**, but through an encrypted private overlay rather than by exposing the app directly to the public web.

## Build and deploy flow

### Fast path: use the setup script

If you want a repeatable setup flow, use the helper script:

```bash
cp any-bot-k8s/setup.env.example any-bot-k8s/setup.env
# edit setup.env with real values

npm run k8:install:any-bot -- \
  --env-file any-bot-k8s/setup.env
```

If your cluster is ready and reachable, you can also let the script apply the manifests:

```bash
npm run k8:install:any-bot -- \
  --env-file any-bot-k8s/setup.env \
  --apply
```

If you prefer the package binary entrypoint, you can also use:

```bash
npm exec oshal-any-bot-k8s-setup -- --env-file any-bot-k8s/setup.env
```

If you want to distribute the installer to another computer **without publishing to npm**, build a local tarball:

```bash
npm run k8:pack:any-bot
```

Then install that tarball on the other machine with:

```bash
npm install -g /path/to/oshal-any-bot-k8s-installer-1.0.0.tgz
```

If you prefer a Docker-based installer instead of npm install, you can also build a local installer image:

```bash
npm run k8:docker:installer:build
```

Or export it for copy-to-another-machine use without any registry:

```bash
npm run k8:docker:installer:export
```

The script writes rendered artifacts to:

```text
output/k8/any-bot/
```

For the full walkthrough, see:

- `docs/k8/any-bot-kubernetes-setup.md`

### 1. Build the API image

From the repo root:

```bash
docker build -t oshal-api-server:latest -f Dockerfile .
```

If your cluster cannot use the local Docker image cache, retag and push it to your registry first.

### 2. Fill in secrets

Edit:

- `any-bot-k8s/secrets.example.yaml`

At minimum, set:

- `POSTGRES_DB`
- `POSTGRES_USER`
- `POSTGRES_PASSWORD`
- `REDIS_URL`
- `TS_AUTHKEY`

Optionally set:

- `ANTHROPIC_API_KEY`
- `PRESENTRON_API_KEY`
- `KEYCLOAK_CLIENT_SECRET`
- `APP_URL`
- `MOCK_OIDC`
- `GOOGLE_SEARCH_MCP_URL`
- `GOOGLE_SEARCH_MCP_IMAGE`

And replace placeholder Headscale values in:

- `any-bot-k8s/any-bot-stack.yaml`

Specifically update the gateway login server value inside `TS_EXTRA_ARGS` so it points at your real Headscale control plane.

If you are using the setup script, the script injects your `HEADSCALE_LOGIN_SERVER` value into the rendered output automatically.
It can also override the default `APP_URL`, `MOCK_OIDC`, and image tag values during render.

### 3. Apply secrets

```bash
kubectl apply -f any-bot-k8s/secrets.example.yaml
```

### 4. Deploy the stack

```bash
kubectl apply -k any-bot-k8s
```

### 5. Verify rollout

```bash
kubectl -n any-bot get pods
kubectl -n any-bot get svc
kubectl -n any-bot logs deploy/any-bot-gateway -c tailscale --tail=100
```

## How outside access works

Once the gateway joins Headscale successfully:

- an outside machine that also joins the same Headscale network can reach the gateway
- the gateway proxies traffic to `any-bot-ui`
- `any-bot-ui` proxies app traffic to `any-bot-api`

Typical access path:

```text
outside machine -> headscale mesh -> any-bot-gateway -> any-bot-ui -> any-bot-api
```

## Current limitations

- the UI deployment is currently an nginx front door to the API service, not yet a separately built static application image
- the gateway pattern is optimized for secure private internet access, not open public ingress
- optional MCP-dependent services beyond Google Search remain disabled by default, so this baseline stack still does not include Chroma MCP, Presentron, or Plane MCP
- ChromaDB itself is included because the baseline RAG path needs a real in-cluster vector store endpoint
- if you disable `MOCK_OIDC`, you must provide the additional Keycloak settings expected by the converted runtime before relying on browser login flows
- if you want public HTTPS access for normal browsers, add an ingress controller and TLS on top of this
- if you want the gateway to advertise full cluster routes, extend the Headscale/Tailscale sidecar configuration further

## Recommended next step

After this baseline, the next most useful follow-up is one of:

1. add a **public ingress + TLS** option for browser access
2. tighten **NetworkPolicy** rules further for production
3. convert the current UI proxy into a **real static frontend image**
4. harden the gateway into a **VM or DaemonSet-based edge**
