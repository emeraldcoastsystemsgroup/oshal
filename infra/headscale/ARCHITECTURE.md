# Headscale Architecture for OSHAL Agent Networking

## Goal

Create a self-hosted networking pattern that allows:

- Kubernetes workloads to keep using normal cluster networking
- one or more outside nodes to securely reach selected internal services
- control-plane ownership to stay on infrastructure you manage

## Core design

### What Headscale is doing here

Headscale is the **coordination/control plane** for clients using the Tailscale protocol.

It is **not** replacing Kubernetes CNI networking inside the cluster.

### What should stay native to Kubernetes

Inside the cluster, keep using your normal:

- Pod networking
- Service networking
- ingress
- internal DNS

That keeps cluster traffic simple and avoids layering an unnecessary mesh over every pod.

## Recommended topology

```text
                          +----------------------+
                          |  Headscale control   |
                          |  plane               |
                          +----------+-----------+
                                     |
              +----------------------+----------------------+
              |                                             |
              v                                             v
      +---------------+                           +------------------+
      | outside node  |                           | gateway node     |
      | agent / VM    |                           | or gateway VM    |
      +-------+-------+                           +--------+---------+
              |                                            |
              | tailnet / overlay                          | cluster-reachable network
              |                                            |
              v                                            v
                                            +-------------------------------+
                                            | Kubernetes services / ingress |
                                            | internal APIs / agent workers |
                                            +-------------------------------+
```

## How the outside node connects

1. The outside node runs the **Tailscale client**.
2. It points to **your Headscale server** using `--login-server`.
3. A gateway node also joins the same Headscale-managed network.
4. The outside node reaches the gateway over the overlay network.
5. The gateway reaches the internal Kubernetes services.

## Two good access patterns

### Pattern A — Gateway / reverse proxy access

The outside node talks to:

- a gateway VM
- an ingress endpoint
- or an internal API exposed behind a gateway node

This is the simplest and cleanest first step.

**Use this first** if you are still learning the setup.

### Pattern B — Subnet router

The gateway node advertises routes for the cluster-adjacent network, and the outside node learns those routes over the overlay.

This is better when the outside node needs access to:

- several internal services
- a VPC subnet
- multiple internal endpoints without a single reverse proxy choke point

This is more powerful, but also more operationally sensitive.

## Container vs Kubernetes guidance

### Can Headscale run in a Docker container?

Yes — and that is the **best place to start**.

Why:

- simpler logs
- simpler storage
- faster iteration
- easier to understand registration flow before involving Kubernetes

### Can Headscale run in Kubernetes?

Yes — especially for:

- a local lab
- a proof of concept
- a single-node Docker Desktop cluster

### Should the final control plane live inside the same cluster it helps connect to?

Usually **not as the first production design**.

Reasons:

- if the cluster is unhealthy, you may lose part of your network entry path
- debugging is harder when the network control plane depends on the platform it helps you reach
- a small dedicated VM or container host is often simpler and more resilient

## Docker Desktop recommendation

Docker Desktop's single-node cluster is a good place to learn:

- how manifests apply
- how the service and PVC behave
- how to port-forward Headscale locally

But remember:

- it is a **local lab**
- it is not automatically internet-reachable
- your outside node will not magically reach a laptop-hosted cluster without DNS, routing, TLS, and firewall work

## Control plane vs data plane

### Control plane

Handled by **Headscale**:

- device registration
- user/node identity
- key coordination
- route coordination

### Data plane

Usually direct node-to-node encrypted traffic when peers can connect.

If peers cannot connect directly, relay behavior depends on available DERP configuration.

## DERP guidance

The included starter configuration keeps the **default public DERP map** for ease of initial setup.

That means:

- you still own the Headscale control plane
- peer data is still encrypted
- but relay fallback may still depend on public Tailscale-operated DERP infrastructure unless you replace it

If your requirement is **strictly no external relay/control dependency**, then your production follow-up should include:

- a self-hosted DERP strategy
- TLS for the DERP endpoint
- firewall and UDP/STUN review

## Suggested rollout order

### Phase 1 — Local lab on Docker Compose

Use `headscale/docker-compose.yaml`.

Goal:

- prove registration works
- learn user/key/node workflow
- verify the outside node can attach

### Phase 2 — Add one gateway node

Use one gateway node or gateway VM to expose:

- ingress
- internal API endpoints
- or routed subnets

Goal:

- prove outside-node-to-cluster access works cleanly

### Phase 3 — Docker Desktop Kubernetes lab

Use `kubectl apply -k headscale`.

Goal:

- understand Kubernetes packaging
- validate storage and service definitions
- keep the architecture conceptually aligned with a future real cluster

### Phase 4 — Production hardening

Move to a reachable production host or real cluster with:

- stable DNS
- TLS
- tighter ACLs
- route approvals
- DERP decision made explicitly

## Recommended production baseline

If you want the simplest operationally sound production direction:

1. Run **Headscale** in Docker on a small dedicated VM.
2. Put **Caddy / NGINX / Traefik** in front for HTTPS.
3. Register:
   - outside nodes
   - one or two gateway nodes
4. Keep **Kubernetes networking native**.
5. Tighten ACL policy after the first successful end-to-end test.

## What not to do first

- Do not try to put every pod on the overlay on day one.
- Do not use Docker Desktop as the assumed final production environment.
- Do not leave the starter ACL policy wide open in production.
- Do not assume Headscale alone solves hard-NAT relay needs without DERP planning.