# Deployment Manifests

This directory contains deployment YAMLs for Docker Compose and Kubernetes across two profiles.

## Profiles

| Profile | Manifest | Cluster / Namespace | Purpose |
|---------|----------|---------------------|---------|
| **oshal** (legacy) | `kubernetes/oshal-stack.yaml` | any / `oshal` | Original single-API stack (no swarm) |

## Files

| File | Description |
|------|-------------|
| `kubernetes/oshal-namespace.yaml` | Standalone namespace creation for `oshal` |
| `kubernetes/oshal-local-k8s.yaml` | Lighter-weight local K8s variant |
| `kubernetes/oshal-stack.yaml` | Legacy oshal stack (api-server, postgres, keycloak, redis, chromadb) |
| `kubernetes/oshal-secrets.example.yaml` | Secret template for oshal |
| `docker-compose.platform.yml` | Legacy compose stack |
| `presentron-integration.yaml` | Optional Presentron deployment |

---

## OSHAL Kubernetes Deployment (Primary)

### Architecture

All bots run the same `${IMAGE_REGISTRY}/oshal-bot:latest` image. Bot identity is set via env vars (`BOT_NAME`, `AGENT_ID`, `BOT_PERSONA_FILE`). The `oshal-api` pod runs migrations via init container and hosts the queue manager + code-server sidecar.

### Infrastructure

| Component | Service | Port |
|-----------|---------|------|
| PostgreSQL 16 | `oshal-db` | 5432 (headless) |
| Redis 7 | `oshal-redis` | 6379 |
| ChromaDB 0.4.24 | `oshal-chromadb` | 8000 |

### Bot Fleet (17 bots)

| # | Deployment | Service | BOT_NAME | Capabilities |
|---|-----------|---------|----------|--------------|
| 1 | oshal-api | oshal-api (3456→5000, 8443→8080) | project-manager | Queue manager, migrations, API server |
| 2 | oshal-task-manager | oshal-task-manager:5000 | task-manager | QA, verification, testing |
| 3 | oshal-graph-analyst | oshal-graph-analyst:5000 | graph-analyst | Graph query, OpenSearch, correlation, RCA, topology |
| 4 | oshal-remediation-writer | oshal-remediation-writer:5000 | remediation-writer | Remediation, scripting, runbooks, K8s, bash |
| 5 | oshal-intake-bot | oshal-intake-bot:5000 | alert-intake-bot | Intake, OpenSearch, classification, routing |
| 6 | oshal-rca-specialist | oshal-rca-specialist:5000 | rca-specialist | Debugging, investigation, root cause, incident analysis |
| 7 | oshal-incident-response | oshal-incident-response:5000 | incident-response-bot | Triage, runbook execution, stakeholder comms |
| 8 | oshal-devops | oshal-devops:5000 | devops-bot | Infrastructure, CI/CD, K8s, Docker, monitoring |
| 9 | oshal-code-developer | oshal-code-developer:5000 | code-developer | Coding, implementation, debugging, API design |
| 10 | oshal-code-reviewer | oshal-code-reviewer:5000 | code-reviewer | Code review, security, quality, architecture |
| 11 | oshal-documentation-writer | oshal-documentation-writer:5000 | documentation-writer | Docs, ADRs, JSDoc, technical writing |
| 12 | oshal-test-engineer | oshal-test-engineer:5000 | test-engineer | Test automation, validation, QA |
| 13 | oshal-research-bot | oshal-research-bot:5000 | research-bot | Research, analysis, web search |
| 14 | oshal-tester-bot | oshal-tester-bot:5000 | tester-bot | QA standards, acceptance criteria |
| 15 | oshal-system-architect | oshal-system-architect:5000 | system-architect | Architecture, design, system modeling |
| 16 | oshal-incident-remediation | oshal-incident-remediation:5000 | incident-remediation-bot | Investigation, RCA, remediation scripting, topology |
| 17 | oshal-queue-bot | oshal-queue-bot:5000 | queue-bot | Quality review, deliverable assessment |

### Port Map

| Service Port | Target | Description |
|-------------|--------|-------------|
| oshal-api:3456 | pod 5000 | Bot API / queue manager |
| oshal-api:8443 | pod 8080 | code-server (workspace browser) |
| All bot svcs:5000 | pod 5000 | Individual bot HTTP endpoints |

### Deploy / Update

```bash
# Full deploy

# Hot-patch JS overlays between image builds
kubectl create configmap oshal-hot-patches -n oshal \
  --from-file=queue-manager-service.js=dist/features/swarm-orchestration/services/queue-manager-service.js \
  --from-file=ticket-view-detail-renderer.js=src/pages/cockpit/js/views/ticket-view-detail-renderer.js \
  --from-file=agent-profile-controller.js=dist/features/agent-profile/controllers/agent-profile-controller.js \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl rollout restart deployment/oshal-api -n oshal

# Rolling restart all bots
kubectl rollout restart deployment -n oshal
```

### Port-Forward for Local Access

```bash
kubectl -n oshal port-forward svc/oshal-api 3456:3456 8443:8443
```

### Config Seed

LLM provider credentials and provider config are stored in the `oshal-config-seed` ConfigMap, mounted at `/app/config-seed/`, and copied to `/app/output/` by the `config-seeder` init container before app boot. Files: `global-config.json`, `secrets.json`.

### Hot Patches

The `oshal-hot-patches` ConfigMap overlays compiled JS files into the running container, allowing hot-fixes between full image rebuilds. It is optional — after a full `docker build` from TypeScript source, the image already contains all changes. Mounted files:
- `queue-manager-service.js`
- `ticket-view-detail-renderer.js`
- `agent-profile-controller.js`

### External Dependencies (cross-namespace)

| Service | Namespace | Address |
|---------|-----------|---------|
| OpenSearch | example-ns | `opensearch.observability.svc.cluster.local:9200` |
| Graph Correlation API | example-ns | `graph-api.observability.svc.cluster.local:8000` |
| NATS | example-ns | `nats-client.observability.svc.cluster.local:4222` |
| AI Gateway | observability | `ai-gateway.observability.svc.cluster.local:8080` |
| Memgraph | example-ns | `memgraph.observability.svc.cluster.local:7687` |
| Graph Visualizer | example-ns | `alerting-graph-visualizer.observability.svc.cluster.local:8000` |

---

## oshal Deployment (Legacy)

### Docker Compose

```bash
docker compose -f deployment/docker-compose.platform.yml --env-file .env up --build -d
docker compose -f deployment/docker-compose.platform.yml down
```

### Kubernetes

```bash
# Rendered bundle via helper
cp deployment/oshal-k8s.env.example deployment/oshal-k8s.env
npm run k8:setup:oshal -- --env-file deployment/oshal-k8s.env --image-tag registry.example.com/oshal-api-server:2026-03-11
kubectl apply -f output/k8/oshal/bundle.yaml

# Or apply base manifest directly
kubectl apply -f deployment/kubernetes/oshal-stack.yaml
```

Port-forward:

```bash
kubectl -n oshal port-forward svc/api-server 3456:3456 1455:1455
kubectl -n oshal port-forward svc/keycloak 8080:8080
```

## Runtime Notes

- OSHAL uses `MOCK_OIDC=true` — no Keycloak. The oshal stack uses Keycloak (`MOCK_OIDC=false`).
- LLM provider for OSHAL is `openai-codex` with `gpt-4.1` by default. See `BUILD.md` for multi-harness details.
- `NODE_TLS_REJECT_UNAUTHORIZED=0` is set in OSHAL config for internal OpenSearch TLS.
- The `oshal-readonly-runtime` ClusterRole gives bot pods read-only access to cluster resources (pods, deployments, events, metrics) for live investigation.
