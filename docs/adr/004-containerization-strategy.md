# ADR-004: Containerization Strategy and "loke" Namespace

**Status:** Accepted  
**Date:** 2026-03-07  
**Deciders:** Development Team  
**Context:** Phase 2, Session 2 — Containerization

---

## Context

The OSHAL project requires containerization to:
1. Ensure consistent development and deployment environments
2. Simplify dependency management and reduce "works on my machine" issues
3. Enable horizontal scaling and orchestration in the future
4. Isolate services (API server, Keycloak, PostgreSQL) for security and maintainability
5. Support the user's request to add Keycloak to a new namespace called "loke"

### Current State
- Keycloak and PostgreSQL are containerized via `docker-compose.yml`
- API server runs locally (not containerized)
- No namespace isolation or logical grouping of services
- Environment configuration via `.env` file (local-only)

### Requirements
- Containerize the entire codebase (API server + Keycloak ecosystem)
- Implement a "loke" namespace for Keycloak and identity-related services
- Maintain backward compatibility with existing configuration
- Follow all governance rules (FSD, logging, documentation, file constraints)
- Keep setup simple for POC phase (avoid over-engineering)

---

## Decision

### 1. Container Orchestration: Docker Compose

**We will use Docker Compose for container orchestration in the POC phase.**

**Rationale:**
- **Simplicity:** Docker Compose is simpler to set up and maintain than Kubernetes for local development and POC validation
- **Familiarity:** Existing setup already uses Docker Compose for Keycloak
- **Sufficient for POC:** The current project phase is "Interactive Mode — Project Preparation" (per `PROJECT-STATUS.md`), not production deployment
- **Migration Path:** Docker Compose can be easily migrated to Kubernetes later (Phase 3 or 4) when production requirements are finalized
- **Developer Experience:** Lower barrier to entry for contributors; no need for minikube/kind/k3s setup

**Alternatives Considered:**
- **Kubernetes (local):** Rejected due to complexity and overhead for POC phase; can revisit in Phase 3
- **Docker Swarm:** Rejected due to declining community support and limited ecosystem
- **Podman Compose:** Rejected to avoid introducing new tooling dependencies

---

### 2. Namespace Implementation: Docker Networks + Labels

**We will simulate the "loke" namespace using a dedicated Docker network and service labels.**

**Approach:**
```yaml
networks:
  loke:
    driver: bridge
    labels:
      namespace: loke
      purpose: "Identity and authentication services"

services:
  keycloak:
    networks:
      - loke
    labels:
      namespace: loke
      service: identity-provider
  
  postgres:
    networks:
      - loke
    labels:
      namespace: loke
      service: identity-database
  
  api-server:
    networks:
      - loke  # Connects to loke for OIDC flows
      - default  # Also on default for external access
    labels:
      namespace: default
      service: api-server
```

**Rationale:**
- **Logical Separation:** Dedicated network isolates Keycloak/PostgreSQL traffic from external services
- **Security:** Non-loke services cannot access loke network without explicit configuration
- **Discoverability:** Labels make it easy to identify which services belong to which namespace
- **Migration Path:** This structure maps cleanly to Kubernetes namespaces (network → namespace, labels → labels)
- **Backward Compatibility:** Existing services continue to work; API server can access both networks

**Alternatives Considered:**
- **Single Network with Labels Only:** Rejected due to lack of network isolation
- **Multiple Docker Compose Files:** Rejected due to added complexity in managing multiple files
- **Kubernetes from Start:** Rejected (see Decision 1)

---

### 3. API Server Container Architecture

**We will use a simple single-stage Dockerfile with Node.js Alpine image.**

**Approach:**
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY src/api/ ./src/api/
EXPOSE 3456
CMD ["node", "src/api/server.js"]
```

**Rationale:**
- **Lightweight:** Alpine-based images are small (< 50MB for Node.js)
- **Production Dependencies Only:** `npm ci --only=production` reduces image size and attack surface
- **Simple:** Single-stage build is easier to debug and maintain during POC phase
- **Fast Builds:** Fewer layers = faster build and push times

**Alternatives Considered:**
- **Multi-Stage Build:** Rejected for POC phase; can add in Phase 3 for production optimization
- **Full Node.js Image (non-Alpine):** Rejected due to larger image size (300MB+ vs. 50MB)
- **Distroless Image:** Rejected due to complexity and debugging challenges in POC phase

---

### 4. Environment Configuration Strategy

**We will use `.env` for local development and `docker-compose.yml` environment overrides for containers.**

**Approach:**
- **Local Development:** Use existing `.env` file (API server runs on host)
- **Containerized Development:** Override specific variables in `docker-compose.yml`:
  ```yaml
  api-server:
    env_file:
      - .env
    environment:
      - KEYCLOAK_URL=http://keycloak:8080  # Internal container networking
      - APP_URL=http://api-server:3456      # Internal container networking
  ```

**Rationale:**
- **Backward Compatibility:** Developers can still run API server locally with `.env`
- **Container Networking:** Overrides ensure services use internal Docker DNS (keycloak, postgres) instead of localhost
- **No Duplication:** Single source of truth (`.env`) with minimal overrides
- **Secrets Management:** Still uses `.env` for secrets (acceptable for POC; future: Vault/Secrets Manager)

**Alternatives Considered:**
- **Separate `.env.docker` File:** Rejected due to duplication and maintenance burden
- **Docker Secrets:** Rejected as overkill for POC phase (Swarm-specific or Compose v2+ feature)
- **Hardcoded Values:** Rejected due to lack of flexibility and security concerns

---

## Consequences

### Positive
- **Consistent Environments:** All developers and CI/CD will use identical containerized setup
- **Easy Onboarding:** `docker compose up` is the only command needed to start the entire stack
- **Namespace Isolation:** "loke" network provides logical and network-level separation for identity services
- **Migration Ready:** Clean path to Kubernetes when production requirements are defined
- **Governance Compliant:** Follows FSD, logging, documentation, and testing standards
- **Maintainable:** Simple architecture is easy to understand, debug, and extend

### Negative
- ⚠️ **Not Production-Ready:** Docker Compose is not suitable for production orchestration (use k8s in Phase 3)
- ⚠️ **Secrets in .env:** Not secure for production (future: integrate with Vault, AWS Secrets Manager, etc.)
- ⚠️ **Single-Host Limitation:** Docker Compose does not support multi-host deployments (use k8s for scale-out)
- ⚠️ **Namespace Simulation:** Docker networks are not true namespaces (use k8s for RBAC, resource quotas, etc.)

### Neutral
- ℹ️ **Build Time:** Developers will need to rebuild containers when changing code (use volume mounts for hot-reload if needed)
- ℹ️ **Learning Curve:** Team members unfamiliar with Docker will need basic training (mitigated by simplicity of Compose)

---

## Implementation Notes

### Phase 2 (Current)
1. Create `Dockerfile` in project root (or `src/api/Dockerfile` if FSD requires it)
2. Update `docker-compose.yml` with:
   - `loke` network definition
   - `api-server` service with `loke` network membership
   - Environment variable overrides for container networking
   - Labels for namespace identification
3. Test containerized setup:
   - `docker compose up --build`
   - Verify API server on http://localhost:3456
   - Verify Keycloak on http://localhost:8080
   - Run Playwright tests against containerized services
4. Update documentation (README, HANDOVER) with containerization instructions

### Phase 3 (Future)
- Evaluate Kubernetes for production deployment
- Implement multi-stage Docker builds for size optimization
- Integrate with secrets management (Vault, AWS Secrets Manager)
- Add health checks, readiness probes, liveness probes
- Implement CI/CD pipeline with container registry (ECR, GCR, DockerHub)

---

## References

- User Request: "containerize this code base adding keycloak to the new namespace.loke"
- [ADR-003: Authentication Mechanism](003-authentication-mechanism.md) — OIDC/Keycloak integration
- PROJECT-STATUS.md — Current project phase and timeline
- [Docker Compose Documentation](https://docs.docker.com/compose/)
- [Feature-Sliced Design](../../CLAUDE.md#feature-sliced-design-typescript-side) — Architecture standards

---

## Supersedes

None.

## Superseded By

⚠️ **Partially superseded by [ADR-019: Per-Bot Docker Container Architecture](019-per-bot-container-architecture.md)** for swarm mode deployment. ADR-004's single `api-server` container model remains valid for standalone/single-bot development, but swarm mode now uses per-bot containers (one container per bot role, ports 3010-3016) with shared infrastructure (Redis, Postgres, ChromaDB). See ADR-019 for the full per-bot container architecture.
