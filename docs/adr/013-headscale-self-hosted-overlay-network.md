# ADR-013: Headscale Self-Hosted Overlay Network for External Agent Nodes

**Status:** Accepted — implemented (reconciled 2026-07-31; the 2026-03-10 status had gone stale): `infra/headscale/` ships the compose + config + hardened ACL policy (+ k8s resources), with `scripts/headscale-setup.sh` + `scripts/headscale-enroll-worker.sh`, runbooks (`docs/runbooks/headscale-acl-hardening.md`, `docs/runbooks/remote-swarm-node-enrollment.md`), the ACL guard `tests/unit/headscale-policy.spec.ts`, and the A2A `headscale-http` transport (`src/shared/types/a2a.ts`)  
**Date:** 2026-03-10  
**Deciders:** OSHAL project team  
**Technical Story:** Phase 11 Session 22 — Headscale Architecture Workspace

---

## Context

OSHAL needs a networking pattern that allows:

- Kubernetes-hosted workloads to communicate normally inside the cluster
- one or more nodes outside the cluster to connect privately to selected internal services
- infrastructure ownership to remain under project control
- avoidance of dependence on a vendor-managed Tailscale control plane for the primary coordination layer

The user specifically wants a self-hosted solution that can support agent-to-agent communication without treating Kubernetes itself as the thing being replaced.

The key architecture question is not just which product to use, but **where** it should sit in the topology:

- inside Docker as a simple first deployment
- inside Kubernetes for local lab use
- or on a dedicated host for production resilience

---

## Decision

OSHAL will use **Headscale** as the preferred self-hosted control plane for overlay-network access between external nodes and cluster-adjacent gateway nodes.

### Networking model

1. **Native Kubernetes networking remains the default inside the cluster.**
2. **Headscale is used for external-node connectivity, not as the primary pod-to-pod network.**
3. **Gateway nodes or gateway VMs** will bridge the Headscale-managed overlay network to the Kubernetes-accessible network.

### Deployment model

1. **Docker Compose** is the preferred first-step deployment for learning, validation, and local proof of concept.
2. **Docker Desktop single-node Kubernetes** is acceptable as a local lab for manifest validation.
3. **Production preference** is a dedicated VM or similarly stable host with containerized Headscale behind TLS, unless a real production Kubernetes environment and ingress stack are already available and well understood.

### Dependency boundary

The starter configuration may retain the default public DERP map for ease of first-time success, but production environments that require strict infrastructure ownership should explicitly decide whether to self-host DERP.

---

## Consequences

### Positive

1. Preserves self-hosted control-plane ownership.
2. Avoids unnecessary complexity by leaving in-cluster networking native.
3. Provides a clean pattern for connecting outside nodes via gateway nodes.
4. Allows simple Docker-based lab work before Kubernetes hardening.
5. Aligns with the user's stated preference for Headscale over Tailscale SaaS.

### Negative

1. Adds operational work compared with fully managed Tailscale.
2. Requires explicit DNS/TLS/reachability design before outside nodes can connect from real external networks.
3. DERP and hard-NAT handling remain a separate decision if full self-hosting is required.
4. ACLs and route approvals must be tightened before production.

### Mitigations

- Start with a small Docker Compose lab.
- Add a single gateway node first.
- Keep the first ACL policy simple, then tighten it after connectivity is proven.
- Treat DERP as an explicit production hardening step rather than an implicit assumption.

---

## Alternatives Considered

### 1. Tailscale managed service

**Not selected** because the user explicitly wants infrastructure ownership and to avoid relying on a vendor-managed control plane.

### 2. Running overlay networking directly across all Kubernetes pods

**Not selected** because it adds complexity where native Kubernetes networking is already the correct baseline.

### 3. Docker Desktop Kubernetes as the long-term production location

**Not selected** because it is appropriate for local lab work, not as the assumed final production control-plane environment.

### 4. Nebula as the first solution

**Not selected for this workspace** because Headscale better matches the user's desired operating model and decision path.

---

## References

- `headscale/README.md`
- `headscale/ARCHITECTURE.md`
- `headscale/HANDOVER.md`
- `headscale/docker-compose.yaml`
- `headscale/config/config.yaml`
- `headscale/kustomization.yaml`
- `ralf/phase-11-session-22-headscale-architecture-task-brief.md`
- `ralf/phase-11-session-22-headscale-architecture-completion.md`

---

## Related ADRs

- [ADR-004: Containerization Strategy and "loke" Namespace](./004-containerization-strategy.md)
- [ADR-011: Agent Framework Architecture with Cline CLI Integration Layer](./011-agent-framework-architecture.md)
- [ADR-012: OS Control MCP Adoption Strategy](./012-os-mcp-adoption-strategy.md)