# OSHAL on Argo Workflows — batch-job prove-out (ADR-078, step 1)

This directory is the **local prove-out scaffold** for [ADR-078](../../../docs/adr/078-kubernetes-argo-batch-and-multi-tenant-proofout.md):
run OSHAL agent work as **Kubernetes-native batch jobs** (Argo Workflows) with
**namespace-per-tenant** isolation layered over the ADR-076 RLS.

It contains concrete, schema-valid manifests — not prose. What is *proven locally*
vs. *needs a live cluster* vs. *absent* is tracked honestly in
[docs/architecture/078-argo-batch-proveout-status.md](../../../docs/architecture/078-argo-batch-proveout-status.md).

## Files

| File | What it is |
|---|---|
| `incident-rca-workflowtemplate.yaml` | The existing OSHAL `incident` ticket-type / `incident-rca` pipeline, expressed as an Argo `WorkflowTemplate` (DAG of steps). |
| `tenant-namespace.example.yaml` | One rendered instance (`acme`) of the per-tenant worker namespace: Namespace + ResourceQuota + LimitRange + default-deny + tenant-scoped NetworkPolicy + ServiceAccount/RBAC + per-tenant DB secret. This is the ADR-078 §4 terraform `tenant/` module as raw YAML. |

## The mapping: OSHAL workflow → Argo Workflow

The source of truth for the pipeline is
[`dispatch-routing.ts`](../../../src/features/swarm-orchestration/services/dispatch-routing.ts)
(`WORKFLOW_PIPELINES[0]`, `ticketType: 'incident'`, `pipeline: 'incident-rca'`) and its dispatcher
`dispatchIncidentTicket()` in
[`queue-manager-service.ts`](../../../src/features/swarm-orchestration/services/queue-manager-service.ts).

| OSHAL concept (today, in-process) | Argo form (this template) |
|---|---|
| A `ticket` of type `incident` | A **Workflow** submission of `oshal-incident-rca` |
| `dispatchIncidentTicket()` phases | The `incident-rca` **DAG** |
| A bot-node executing one phase | A **DAG task = a Job pod** (`bot-node-phase` template) that spins up, does LLM work against the in-cluster model, writes deliverables, and tears down (`podGC`, `ttlStrategy`) |
| `workerBot: rca-specialist` | The `worker-investigate` task |
| opt-in `reviewerBot` + `maxRevisions` | The `reviewer-review` task, guarded by `when: reviewer-bot != ""` (default `""` = one-and-done, exactly like the registry) |
| graph-engine **approval-gate node** | The `approval-gate` **`suspend`** task, guarded by `when: require-approval == true` (resumed via `argo resume`) |
| MODE A/B/C finalize (`INCIDENT_MODE_DISPOSITION`) | The `finalize` task, branching on the worker's emitted `mode` output |
| `recordCost` → `chat_tasks` | The `onExit: record-cost` handler (runs on success or failure) |

### The tenancy mapping (ADR-078 §3)

| RLS / tenancy concept | Kubernetes form |
|---|---|
| Tenant identity (Keycloak realm/claim) | The **namespace** the Workflow is submitted into (`oshal-tenant-<slug>`) |
| "Don't let tenant A see tenant B" | `default-deny-all` + `allow-same-tenant-and-shared` **NetworkPolicy** (no cross-tenant peer) |
| Blast-radius cap | **ResourceQuota** + **LimitRange** per namespace |
| ADR-076 GUC (`oshal.current_sub` / tenant) | Per-tenant **Postgres credentials** in the `oshal-tenant-db` secret — **see the honesty note below** |
| Onboard a tenant | `kubectl apply` (→ terraform `tenant/` module) one rendered copy of `tenant-namespace.example.yaml` |

The point ADR-078 makes: isolation is **namespace + NetworkPolicy + DB isolation**, not just a `WHERE` clause.

> **HONESTY NOTE (double-check 2026-07-08): RLS is NOT currently an isolation leg for batch
> pods.** The shared bot-node runtime wraps its pool with the GUC stamper, and a pod with no
> request identity gets the trusted *system* context (`oshal.is_operator='on'`) — which every
> RLS policy treats as a full bypass, and setting a custom GUC needs no Postgres privilege.
> So a tenant workload pointed at a **shared** Postgres reads every tenant's rows regardless
> of its DB role. Until a tenant-scoped service identity exists (BACKLOG Plan C), the
> `oshal-tenant-db` Secret must point at a **separate per-tenant database** for the DB leg
> of isolation to be real. The graph tier already works this way (`getTenantGraph` → an
> isolated ArangoDB database per tenant).

## Validate

These manifests validate offline (no cluster needed) and, when a cluster with the Argo
CRDs is reachable, against the real Argo schema:

```bash
# 1. Portable structural parse (no cluster) — python or node:
python -c "import yaml,sys; [list(yaml.safe_load_all(open(f))) for f in sys.argv[1:]]" \
  incident-rca-workflowtemplate.yaml tenant-namespace.example.yaml

# 2. kubectl schema validation (client dry-run; validates against installed CRDs):
kubectl apply --dry-run=client --validate=strict -f tenant-namespace.example.yaml
kubectl apply --dry-run=client --validate=strict -f incident-rca-workflowtemplate.yaml

# 3. (needs Argo CLI, not yet installed here) semantic lint of the workflow:
argo lint incident-rca-workflowtemplate.yaml
```

## What this is NOT (read before running)

- **Not a live deploy.** Nothing here has been *submitted* as a running Workflow. The
  templates reference **target-state** container entrypoints — `bot-node-batch.sh`
  (a one-shot single-phase bot-node runner), `finalize-incident.sh`, `record-cost.sh` —
  that are **not built yet**. Today's OSHAL runs these phases in-process via the
  long-lived `QueueManagerService`, not as one-shot Jobs. Turning the queue manager into
  a "thin submitter" that translates an approved batch ticket into a Workflow is the
  ADR-078 §1 work, still to do.
- **Not multi-tenant runtime-proven.** The NetworkPolicy expresses the deny; proving
  tenant A's Job truly cannot reach tenant B needs a running cluster with a
  NetworkPolicy-enforcing CNI and the two-tenant assertion from ADR-078 §Phase 3.
- **No Terraform.** These are the raw YAML the terraform `tenant/` / `argo/` modules will
  render. The modules do not exist (`**/*.tf` → none).
