# ADR-078 — Kubernetes migration, Argo batch-job orchestration, and multi-tenant proof-out

- **Status:** Proposed — 2026-07-05. Records the plan to move OSHAL from a single-node Docker-Compose
  stack to a Kubernetes deployment where (a) agent work runs as **batch jobs** (Argo Workflows),
  (b) the cluster is **IaC-provisioned** (Terraform — absent at writing), and (c) **multi-tenant (MT)
  isolation** is proven at the container/namespace boundary. No cluster changes yet.
- **Status note 2026-07-19:** the `oshal-stack.yaml` sibling manifests cited under "What exists
  today" (the cluster deploy manifest + the local-k8s/namespace descriptors) were **deleted
  in the 2026-07-19 de-brand sweep** (they could only target the retired landscape) — only
  `oshal-stack.yaml` + `oshal-secrets.example.yaml` remain in
  [ops/deployment/kubernetes/](../../ops/deployment/kubernetes/). The "no Terraform" gap below is
  also dated: a Terraform deployment layer landed 2026-07-18 at [deploy/terraform/](../../deploy/terraform/).
- **Date:** 2026-07-05
- **Related:** [ADR-076 (tenant-aware RLS + least-privilege DB role)](076-tenant-aware-rls-and-least-privilege-db-role.md),
  [ADR-035 (multi-tenant SaaS foundation — Proposed)](035-multi-tenant-saas-foundation.md),
  [ADR-042 (IoT connector tenancy / space+org)](042-iot-connector-tenancy.md),
  [ADR-036 (bot-owned application architecture)](036-bot-owned-application-architecture.md),
  [ops/deployment/kubernetes/](../../ops/deployment/kubernetes/), [ops/any-bot-k8s/](../../ops/any-bot-k8s/)

## Context

### The real potential this targets

OSHAL's honest category is an **on-prem / datacenter agent-orchestration control plane** — the tier
*beneath* assistant apps, for orgs that cannot or will not send data to cloud LLM APIs. The founding
instinct ("doesn't everyone run the LLM in their own datacenter and run the agent work as a batch
job?") is exactly the regulated/sovereign pattern, and the architecture already fits it:

- **Controller/worker split** — the swarm controller never calls an LLM; bot-nodes own all LLM
  execution ([CLAUDE.md](../../CLAUDE.md)). That is a scheduler + worker-pool shape, which is what
  Kubernetes + a batch engine model natively.
- **Ticket/queue backend** — a Postgres `tickets` table + a polling `QueueManagerService` that
  dispatches units of work. A "ticket" is already a job.
- **Pluggable *local* LLM providers** — Ollama / LM Studio / LiteLLM are first-class
  ([provider-definitions.ts](../../src/features/llm-provider/services/provider-definitions.ts)), so the
  model can live in-cluster on a GPU node.

This is not a hypothetical market. The local prove-out evidence
(adr078-local-proveout-2026-07-05.md) covers the
Gardener + EKS shape with NVIDIA GPU worker nodes, a Terraform runner, and strict data-egress
constraints — precisely where "agent jobs as k8s batch workloads against an in-cluster model" is a
requirement, not a preference.

### What exists today

- **k8s manifests (partial):** [oshal-stack.yaml](../../ops/deployment/kubernetes/oshal-stack.yaml)
  (api + Keycloak real-OIDC + Postgres + Redis + Chroma), the cluster deploy manifest (already aimed at
  a COP dev env), and a meshed [any-bot-k8s](../../ops/any-bot-k8s/) stack with a Headscale gateway.
- **DB-enforced multi-USER isolation:** ADR-076 is live on `oshal-local` — non-superuser `oshal_app`
  owner + `FORCE ROW LEVEL SECURITY` across ~80 tables, with a `verify:rls` two-user proof.

### The gaps (honest)

- **No Terraform** in the repo (`**/*.tf` → none). The cluster is hand-applied YAML.
- **No scale story:** manifests are `replicas: 1`, no HPA, single Postgres, no failover.
- **No batch engine:** the `QueueManagerService` is an in-process poller, not a k8s-native job runner.
- **Multi-TENANT is not built.** ADR-076 gives multi-*user* (RLS). True multi-*org* is ADR-035
  (*Proposed*). "Prove out MT" means choosing and demonstrating a tenant-isolation boundary.

## Decision

Migrate to Kubernetes with three additions on top of the existing manifests: **Argo Workflows** for
agent batch jobs, **Argo CD** for GitOps delivery, **Terraform** for the cluster/infra — and prove a
**namespace-per-tenant** isolation model. Prove it on a self-owned cluster first; the employer GovCloud
is out of scope (see boundary note).

### 1. Agent work as batch jobs (Argo Workflows) — the founding vision, realized

Map the existing model onto Kubernetes-native batch, rather than replacing it:

| OSHAL concept today | k8s / Argo form |
|---|---|
| A `ticket` of a batch-eligible type | An **Argo Workflow** submission |
| A workflow phase / dispatch path (build swarm, incident-RCA, manifest-worker, graph) | Workflow **DAG** of steps |
| A bot-node executing one phase | A Workflow **step = a Job pod** (spins up, does LLM work against the in-cluster model endpoint, writes results to Postgres/object store, tears down) |
| `recordCost` → `chat_tasks` | Step exit-handler writes the cost ledger row |
| Approval-gate node (graph engine) | Argo **`suspend`** step, resumed on approval |

The interactive/direct-sync "fast path" stays as a long-lived Deployment (sub-second, no job spin-up).
So: **long-lived services for interactive work; ephemeral Argo Jobs for batch/scheduled agent work** —
which is the "run it as a batch job" model stated at the outset. The `QueueManagerService` becomes a
thin submitter that translates an approved batch ticket into a Workflow, instead of dispatching
in-process.

### 2. In-cluster model serving (data never leaves)

Run the model in the cluster on the GPU node (Ollama or vLLM as a Deployment behind a Service);
bot-node Jobs point their provider `baseUrl` at that in-cluster endpoint. This is what makes the
datacenter/sovereign story true rather than aspirational — no token leaves the tenant boundary.

### 3. Multi-tenancy model — **namespace-per-tenant** (the decision to prove)

Three candidate boundaries; we pick the middle one and prove it:

| Model | Isolation | Cost/ops | Fit |
|---|---|---|---|
| Shared cluster + RLS only | soft (DB rows) | lightest | already have it (ADR-076); insufficient alone for regulated MT |
| **Namespace-per-tenant** (recommended) | **hard at pod/network boundary** | moderate | shared control plane; per-tenant worker namespace + NetworkPolicy + ResourceQuota + per-tenant DB schema/role. Credible for federal/regulated. |
| Cluster-per-tenant | hardest | heaviest | overkill until a customer demands it |

**Recommended:** one shared control plane (api/Keycloak/queue), and **per-tenant worker namespaces**
where the Argo Jobs run — each with a `NetworkPolicy` (deny cross-tenant), a `ResourceQuota`, its own
service account, and a per-tenant Postgres role/schema layered on the ADR-076 RLS. Tenant identity flows
from Keycloak realm/claim → GUC (`oshal.current_sub` / tenant) → the namespace the Workflow is submitted
into. This is "containers containerized for the MT requirement": the isolation is the namespace + network
policy + DB role, not just a `WHERE` clause. (If a future customer needs it, cluster-per-tenant is a
config change, not a redesign.)

### 4. Terraform (the missing IaC)

Introduce a Terraform module set so the cluster is reproducible rather than hand-applied:

```
infra/terraform/
  modules/
    cluster/        # the k8s cluster (kind/k3d for local; EKS/Gardener for real)
    oshal-platform/ # namespaces, RLS DB role, Keycloak realm, secrets wiring
    tenant/         # per-tenant namespace + NetworkPolicy + ResourceQuota + DB role (the MT unit)
    argo/           # Argo Workflows + Argo CD install + RBAC
  envs/
    local/          # kind/k3d — the prove-out target
    <sanctioned-lab>/
```

The `tenant/` module is the important one: onboarding a tenant = `terraform apply` of one module
instance. That is the MT proof made mechanical.

### 5. GitOps delivery (Argo CD)

Argo CD watches the repo and reconciles the platform + per-tenant manifests. This matches the target
environment's existing pattern (Gardener/EKS + a Terraform runner + CI) and makes the deployment
auditable and reproducible — itself part of the enterprise-credibility story.

### Phased prove-out (reversible first, real cluster last)

1. **Local cluster (kind or k3d, or re-enable Docker Desktop k8s — disabled, backup exists).** Stand up
   the existing `oshal-stack.yaml` + an in-cluster Ollama. Prove OSHAL runs on k8s at all.
2. **Batch path:** install Argo Workflows; convert one batch ticket type to a Workflow submission; prove
   a ticket → Workflow → Job pod → cost row, end to end.
3. **Two-tenant isolation proof:** stand up two `tenant/` namespaces; prove tenant A's Job cannot reach
   tenant B's data or network (extend `verify:rls` with a namespace/network assertion). This is the MT
   proof.
4. **Terraform + Argo CD** wrap 1–3 so the whole thing is `terraform apply` + GitOps, not hand-kubectl.
5. **Sanctioned real cluster** only after 1–4 are green.

## Consequences

- **Positive:** this is simultaneously (a) the honest expression of OSHAL's real potential — on-prem
  agent orchestration running agent work as batch jobs against a datacenter-local model — and (b) the
  single strongest portfolio artifact for the stated job goal: *"self-hosted agent platform on
  Kubernetes, agent workloads as Argo Workflows batch jobs against a local LLM, GitOps-delivered via
  Argo CD, Terraform-provisioned, with namespace-per-tenant isolation over DB-enforced RLS."* That is a
  staff/platform-engineer sentence.
- **Cost:** real multi-week infra work. Argo + GPU model-serving + per-tenant networking is not a
  weekend. Scope it to the local prove-out first; do not let it balloon.
- **Boundary (important):** the referenced GovCloud/DOC landscape is an **employer environment**.
  Deploying a personal OSS project into it is an authorization/governance line, not a technical step.
  All prove-out happens on a **self-owned or explicitly sanctioned** cluster; the employer GovCloud is
  out of scope unless separately authorized as a sanctioned lab.
- **Reversibility:** Docker-Compose (`docker-compose.oshal-local.yml`) stays the canonical dev stack
  throughout. The k8s path is additive and proven in parallel, not a cutover, until step 5.
- **Relationship to ADR-035:** this ADR delivers the *infrastructure* isolation (namespace/network/DB
  role) that ADR-035's SaaS foundation assumed. It does not build billing, realm-per-tenant
  provisioning UX, or seat licensing — those remain ADR-035, still Proposed.
