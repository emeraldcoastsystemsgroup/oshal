# headscale

This directory is the OSHAL planning and starter-configuration workspace for a **self-hosted Headscale network**.

It is designed for your exact use case:

- a Kubernetes cluster with lots of internal service-to-service traffic
- one or more nodes outside the cluster that still need secure private connectivity
- infrastructure you own and control
- no requirement to depend on a vendor-managed Tailscale control plane

## Quick answers

### Can Headscale run in Docker?

**Yes.**

Use `headscale/docker-compose.yaml` for the fastest local proof of concept.

### Can you run Kubernetes on Docker Desktop?

**Yes.** Docker Desktop's built-in **single-node Kubernetes cluster** is fine for:

- learning Kubernetes
- validating manifests
- local proof-of-concept testing
- understanding how Headscale fits with your cluster architecture

It is **not** the ideal final home for a real internet-reachable Headscale control plane.

### Should Headscale be the primary network inside Kubernetes?

**Usually no.**

Keep **normal Kubernetes networking inside the cluster**, and use Headscale to connect:

- outside nodes
- gateway nodes
- admin/jump hosts
- specialized worker nodes that live outside the cluster network

## Recommended topology

```text
outside node
    |
    |  (Tailscale client pointed at your Headscale server)
    v
Headscale control plane
    |
    +---- gateway node / VM with access to cluster network
                |
                +---- Kubernetes services / ingress / internal APIs
```

In production, the clean pattern is:

1. **Headscale** runs as the self-hosted control plane.
2. The **outside node** joins the Headscale-managed mesh.
3. A **gateway node** or reachable cluster-adjacent VM also joins that mesh.
4. The gateway exposes or routes traffic to the Kubernetes services you want to reach.

## Folder contents

- `ARCHITECTURE.md` — recommended topology, gateway pattern, Docker Desktop guidance, and rollout advice
- `docker-compose.yaml` — starter Docker Compose deployment for Headscale
- `config/config.yaml` — starter Headscale configuration
- `config/policy.hujson` — permissive starter ACL policy for local lab use
- `kustomization.yaml` — root Kubernetes entrypoint for applying the lab manifests safely
- `kubernetes/` — Kubernetes starter manifests for Docker Desktop or another single-node cluster
- `HANDOVER.md` — status, debt, and next steps for the next developer/session

## Recommended rollout order

### 1. Start with Docker Compose first

This is the fastest way to understand the control plane and registration flow:

```bash
docker compose -f headscale/docker-compose.yaml up -d
curl http://127.0.0.1:8080/health
```

Then edit `headscale/config/config.yaml` so `server_url` points at a **real hostname or IP reachable by your clients**.

### 2. Register your first Headscale user and node

Typical flow:

```bash
docker exec -it oshal-headscale headscale users create agentmesh
docker exec -it oshal-headscale headscale preauthkeys create --user agentmesh --reusable --expiration 24h
```

Then on the outside node:

```bash
tailscale up --login-server https://headscale.example.com --authkey <YOUR_AUTH_KEY> --accept-dns=false
```

### 3. Add a gateway node

Install the Tailscale client on:

- one Kubernetes worker node, or
- a small VM in the same VPC / network as the cluster

Register that node to the same Headscale server. That node becomes the bridge between the outside node and your cluster services.

### 4. Only then move to Kubernetes manifests

Once the basic control-plane and client-registration flow makes sense, use the root kustomization in `headscale/`.

## Docker Desktop Kubernetes path

If you want to use the Docker Desktop single-node cluster:

1. Open **Docker Desktop**.
2. Go to **Settings**.
3. Open **Kubernetes**.
4. Turn on **Enable Kubernetes**.
5. Wait for the single-node cluster to come up.

Then apply the starter manifest:

```bash
kubectl apply -k headscale
kubectl -n oshal-headscale port-forward svc/headscale 8080:8080 9090:9090
```

For a local lab, that is enough.

For a **real outside node on another machine/network**, you will still need:

- a reachable hostname or IP
- TLS / HTTPS
- firewall / routing rules
- optionally a reverse proxy or ingress

## Important production notes

### 1. `server_url` must be reachable by clients

If the outside node cannot reach the `server_url`, registration will fail.

### 2. HTTPS matters in real deployments

This starter workspace assumes you will terminate TLS with:

- an ingress
- Traefik / NGINX / Caddy
- or another reverse proxy in front of Headscale

### 3. DERP is a separate concern

Headscale is the **control plane**.

If two nodes cannot establish a direct peer-to-peer path because of hard NAT or firewall conditions, they may need **DERP relay support**. The starter config keeps the **default public DERP map** for easier first-time success.

If you want **full self-host ownership with no dependency on Tailscale-operated relays**, add a self-hosted DERP plan before production.

### 4. The starter ACL policy is intentionally open

`config/policy.hujson` currently allows broad connectivity so you can get a lab running quickly.

Before production, tighten it so:

- only approved nodes can talk to cluster-facing gateways
- route advertisement is limited
- sensitive services are not broadly reachable

## Recommended final direction for your use case

For your architecture, the best default is:

- **Headscale** as the self-hosted control plane
- **native Kubernetes networking** inside the cluster
- **gateway node(s)** for outside-node access
- **Docker Compose first**, then **Kubernetes** once the model is working

If you want, the next step after this workspace is for me to build either:

1. a **local lab SOP** you can follow click-by-click on Docker Desktop, or
2. a **production-ready version** with ingress, TLS, and tighter ACLs