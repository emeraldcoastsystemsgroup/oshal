# ADR-014: any-bot Kubernetes Deployment with Headscale-Compatible Secure Gateway

**Status:** Accepted — implemented (reconciled 2026-07-31): the workspace ships as `ops/any-bot-k8s/` (stack + kustomization + secrets/env examples) with `scripts/setup-any-bot-k8s.sh` and `docs/k8/any-bot-kubernetes-setup.md`; the platform-wide k8s/Argo/Terraform layer came later under ADR-078 (`ops/deployment/`, `deploy/terraform/`)  
**Date:** 2026-03-10  
**Deciders:** OSHAL project team  
**Technical Story:** Phase 11 Session 23 — any-bot Kubernetes + Secure Gateway Workspace

---

## Context

The project needs a root-level deployment workspace for `any-bot` that can run in Kubernetes with:

- Redis
- a any-bot API workload
- a any-bot UI workload
- a secure gateway pattern that works over the internet

The user also wants the gateway to align with the previously established self-hosted overlay-network direction rather than relying on a vendor-managed control plane.

That means the deployment design must support:

1. standard Kubernetes service composition inside the cluster
2. secure outside access through a gateway component
3. compatibility with a Headscale-managed mesh for private internet transport

---

## Decision

OSHAL will use a **Kubernetes deployment workspace** that treats `any-bot` as a multi-component stack:

1. **Redis** for queue/state storage
2. **any-bot API** as the main Node.js workload
3. **any-bot UI** as a dedicated nginx-facing frontend boundary
4. **any-bot gateway** as a secure edge deployment using a Headscale-compatible Tailscale sidecar

### Network model

- Internal Kubernetes traffic remains native Kubernetes networking.
- The secure internet-access path is **outside node -> Headscale mesh -> gateway -> UI -> API**.
- The gateway is implemented first as a **pod-based deployment**, not a dedicated physical cluster node.

### Deployment model

- The API image is built from the existing `any-bot/Dockerfile`.
- UI is initially represented as an nginx deployment that fronts the API service.
- Secrets for AWS, Redis, JWT, and Headscale auth are kept externalized in a secret template.
- The secure gateway uses a Tailscale sidecar in **userspace mode** and forwards incoming tailnet traffic to an in-pod nginx proxy.
- The baseline deployment disables optional MCP companion services so the core `any-bot` stack can bootstrap without external platform dependencies.

---

## Consequences

### Positive

1. Provides a concrete Kubernetes baseline for any-bot deployment.
2. Preserves secure internet access through a private overlay mesh.
3. Keeps the cluster networking model simple and Kubernetes-native.
4. Establishes a clean place for later ingress, TLS, and static frontend hardening.
5. Reduces baseline gateway privilege requirements by using Tailscale userspace networking.

### Negative

1. The current UI deployment is still a proxy front to the API, not a fully separate built frontend artifact.
2. The secure internet path assumes external machines also join the Headscale-managed network.
3. Optional MCP-backed features are not available until their supporting services are deployed and re-enabled.

### Mitigations

- Use the current manifests as a baseline, not the final hardened production edge.
- Follow up with ingress/TLS or a VM-based gateway if public browser access becomes a requirement.
- Tighten secrets, policy, and network settings as environment-specific values become known.
- Re-enable MCP-related environment flags only when the corresponding services are present in the cluster.

---

## Alternatives Considered

### 1. Expose any-bot directly through a public ingress first

**Not selected** because the user explicitly asked for secure gateway access that works over the internet, and a private overlay-network path is a better match for that requirement.

### 2. Keep any-bot as a single deployment with no UI split

**Not selected** because the user requested separate UI and API deployment concerns.

### 3. Use a dedicated VM gateway instead of Kubernetes immediately

**Not selected for the first pass** because the user asked for Kubernetes manifests and a cluster-oriented deployment workspace.

---

## References

- `any-bot-k8s/README.md`
- `any-bot-k8s/any-bot-stack.yaml`
- `any-bot-k8s/secrets.example.yaml`
- `any-bot-k8s/HANDOVER.md`
- `headscale/README.md`
- `ralf/phase-11-session-23-any-bot-k8s-gateway-task-brief.md`
- `ralf/phase-11-session-23-any-bot-k8s-gateway-completion.md`