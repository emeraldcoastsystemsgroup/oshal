# ADR-078 Argo batch prove-out — as-built vs target (step 1 status)

**Date:** 2026-07-05
**Scope:** the *first step* of the [ADR-078](../adr/078-kubernetes-argo-batch-and-multi-tenant-proofout.md)
local prove-out — a **design + scaffold** pass. This note keeps the claim honest:
what is proven locally, what still needs a live cluster, and what is absent.

## What step 1 produced

- [`ops/deployment/argo/incident-rca-workflowtemplate.yaml`](../../ops/deployment/argo/incident-rca-workflowtemplate.yaml)
  — the existing `incident` ticket-type / `incident-rca` pipeline
  (`WORKFLOW_PIPELINES[0]` in `dispatch-routing.ts`) expressed as an Argo `WorkflowTemplate` DAG.
- [`ops/deployment/argo/tenant-namespace.example.yaml`](../../ops/deployment/argo/tenant-namespace.example.yaml)
  — one rendered instance of the per-tenant worker namespace (Namespace + ResourceQuota +
  LimitRange + default-deny + tenant-scoped NetworkPolicy + SA/RBAC + per-tenant DB secret).
- [`ops/deployment/argo/README.md`](../../ops/deployment/argo/README.md) — the OSHAL→Argo and
  RLS→namespace mapping tables.

The OSHAL→Argo mapping is faithful to the real dispatcher (`dispatchIncidentTicket()`):
worker (`rca-specialist`) → optional reviewer (opt-in `reviewerBot`) → MODE A/B/C finalize,
with `recordCost → chat_tasks` as the `onExit` handler and the graph approval-gate node as a
`suspend` step.

## Environment observed during this step (material — the ADR premise moved)

ADR-078 and the project memory recorded Docker Desktop **k8s as disabled** (2026-06-12), which
framed step 1 as pure design. During this step the local environment was **different**:

- A Kubernetes control plane **was reachable** (`kubectl cluster-info` → `https://127.0.0.1:58232`).
- The **Argo Workflows CRDs were installed** (`workflowtemplates.argoproj.io` et al.) and an
  `argo` namespace existed — **freshly** (created ~1 minute before this check), i.e. a cluster
  stand-up was in progress in parallel, not something this step performed.

This step did **not** enable k8s, install Argo, create the tenant namespace, or submit a
Workflow. It used the reachable cluster **read-only** for schema validation only.

## Proven locally (this step)

| Claim | Method | Result |
|---|---|---|
| Both manifests are well-formed multi-doc YAML | `python -c yaml.safe_load_all` | PASS — `incident-rca-workflowtemplate.yaml` = 1 doc (`WorkflowTemplate`); `tenant-namespace.example.yaml` = 9 docs (Namespace, ResourceQuota, LimitRange, 2×NetworkPolicy, ServiceAccount, Role, RoleBinding, Secret) |
| Tenant manifest conforms to the built-in k8s schemas | `kubectl apply --dry-run=client --validate=strict` | PASS (exit 0) — all 9 objects "created (dry run)" |
| WorkflowTemplate conforms to the **real Argo CRD schema** | `kubectl apply --dry-run=client --validate=strict` (Argo CRDs installed on the reachable cluster) | PASS (exit 0) — `workflowtemplate.argoproj.io/oshal-incident-rca created (dry run)` |
| The mapping (OSHAL phase → Argo step; RLS tenant → namespace) is defined and traceable to source | README tables cross-referenced to `dispatch-routing.ts` / `queue-manager-service.ts` | Defined |

## Needs a live cluster (not proven here)

- **Actual Workflow submission** — `argo submit` / a real ticket → Workflow → Job pod →
  cost row, end to end (ADR-078 Phase 2). Not run.
- **Semantic lint** — `argo lint` (the Argo CLI is not installed here; only the CRDs are).
  Client dry-run validates fields against the CRD schema but not Argo's controller-side
  workflow semantics.
- **Two-tenant network isolation** — proving tenant A's Job cannot reach tenant B's data or
  network needs a running cluster with a NetworkPolicy-**enforcing** CNI plus the two-tenant
  assertion extending `verify:rls` (ADR-078 Phase 3). The policy *expresses* the deny; nothing
  here demonstrates enforcement.
- **In-cluster model serving** — the `model-endpoint` points at an
  `ollama.oshal-model.svc` Service that has not been stood up.

## Absent (not built)

- **The one-shot bot-node batch entrypoint.** The DAG's `bot-node-phase` container calls a
  target-state `scripts/bot-node-batch.sh` that runs a *single phase then exits*. OSHAL today
  runs phases in-process via the long-lived `QueueManagerService` + `bot-node-server.ts`; no
  one-shot batch runner exists. Likewise `finalize-incident.sh` and `record-cost.sh` are
  target-state hooks. Turning `QueueManagerService` into a thin **Workflow submitter** is the
  core ADR-078 §1 build and is not started.
- **Terraform.** `**/*.tf` → none. These YAMLs are what the terraform `tenant/` and `argo/`
  modules (ADR-078 §4) will render; the modules do not exist.
- **Argo CD GitOps delivery** (ADR-078 §5) — not wired.

## Honest one-line status (step 1, 2026-07-05 — superseded by the addendum below)

> ADR-078 step 1 = the incident-rca pipeline and a namespace-per-tenant boundary are
> **designed and schema-valid** (validated against the live-installed Argo CRD + k8s schemas
> via `kubectl --dry-run=client`); **running** them still needs the one-shot bot-node batch
> entrypoint, a submitted Workflow, a two-tenant network-isolation proof, and Terraform — none
> of which this step built or claims.

---

# Addendum — step 2 (2026-07-08): two premises above were WRONG

Two assumptions in the note above were tested and disproved on the live `docker-desktop` cluster.

## 1. "Two-tenant network isolation needs a NetworkPolicy-enforcing CNI" — FALSE

Docker Desktop's CNI **does** enforce NetworkPolicy. Proven with a control, so "blocked" cannot be
confused with "nothing is listening":

| Check | Result |
|---|---|
| tenant-b → tenant-a podIP, **no policy** (control) | **200, serves HTML** — pods listen, cross-ns routing works |
| tenant-a → tenant-b podIP, `default-deny-ingress` | **blocked** |

**But the deny was one-directional:** only `tenant-b` carried a policy, so tenant-b could freely
reach into tenant-a. Fixed by applying the ADR's symmetric model (default-deny-all Ingress+Egress,
re-granting only same-tenant east-west + DNS) to **both** namespaces:

- Manifest: [`tenant-network-policies.yaml`](../../ops/deployment/argo/tenant-network-policies.yaml)
- Repeatable assertion: `bash scripts/governance/verify-tenant-isolation.sh`
- **Before:** 2 passed, 5 failed (`tenant-b REACHED tenant-a`). **After:** 7 passed, 0 failed.

ADR-078 Phase 3's *network* half is now proven locally. Its *data* half (`verify:rls`) is separate.

## 2. "Argo is not installed here" — no longer true

`argo-workflows v4.0.7` is installed into the `argo` namespace; `workflow-controller` and
`argo-server` are Running. What that now buys us, beyond the old client-side dry-run:

| Claim | Method | Result |
|---|---|---|
| The WorkflowTemplate is accepted by the **real** Argo CRD | `kubectl apply --server-side` into `tenant-a` (the submitter stamps the tenant ns, per the template's own comment) | PASS — `oshal-incident-rca` exists with entrypoint `incident-rca` and 5 templates |
| Argo's **runtime** actually executes workflows on this cluster | submitted a minimal `busybox` Workflow | **Succeeded**; pod logged `argo runtime ok on this cluster` |

### Two gotchas worth keeping

- **`kubectl apply` cannot install the big Argo CRDs.** It writes a `last-applied-configuration`
  annotation that exceeds the 262144-byte limit, so `workflows`, `workflowtemplates`, `cronworkflows`
  and `clusterworkflowtemplates` silently fail while the Deployments succeed. Use
  `kubectl apply --server-side --force-conflicts`.
- **Argo's `install.yaml` does not grant its own `argo` SA executor permissions.** A workflow's main
  container runs and succeeds, then the `wait` sidecar dies with `exit code 64:
  workflowtaskresults.argoproj.io is forbidden` and the Workflow reports `Error` — the work happened,
  the bookkeeping didn't. Granted via [`argo-executor-rbac.yaml`](../../ops/deployment/argo/argo-executor-rbac.yaml).
  **Per-tenant workflows are unaffected:** `tenant-namespace.example.yaml` already grants
  `workflowtaskresults: [create, patch]` to the per-tenant `oshal-workflow` SA. The ADR artifact was right.

## 3. The one-shot batch entrypoint — BUILT (2026-07-08)

The DAG's `bot-node-phase` task called `/app/scripts/bot-node-batch.sh`, which did not exist. It does now.

- **`src/app/bot-node-runtime.ts`** — the bot-node bootstrap (identity → Postgres under the RLS GUC
  wrapper → repositories → any-bot LLM stack → envelope execution handler), **extracted** out of
  `bot-node-server.ts`'s unexported `start()`. Both entrypoints now share ONE construction path
  instead of duplicating ~250 lines of provider wiring. `bot-node-server.ts` fell 767 → 511 lines.
- **`src/app/bot-node-batch.ts`** — synthesises exactly one `MeshEnvelope` for its
  `(ticket, agent, phase)`, runs it through the *same* execution handler the long-lived server uses
  (so cost still lands in `chat_tasks`), writes the classified MODE to `mode.txt` where the DAG's
  output parameter points, closes the pool, and exits 0/1 for Argo to branch on.
- **`scripts/bot-node-batch.sh`** — seeds the shared provider config the way `bot-entrypoint.sh` does,
  then `exec node dist/app/bot-node-batch.js "$@"`.

Verified: `tsc --noEmit` clean · `tsc -p tsconfig.server.json` emits `dist/app/bot-node-batch.js` (the
path the shell script execs) · 12 new unit tests · **900/900 existing unit tests still pass**, so the
extraction is behaviour-preserving · the edited WorkflowTemplate still server-side applies against the
live Argo CRD.

**A bug the tests caught:** `EnvelopeExecutionResult` is `{ success, output?, error? }` — there is no
`response` field; the text lives *inside* `output`. Reading `result.response` type-checks under a cast
and would have silently classified **every** phase as `mode=unknown` forever.

## 4. The finalize + cost hooks — BUILT (2026-07-08)

All three scripts the DAG invokes now exist; their flags were cross-checked against the template.

- **`src/app/finalize-incident.ts`** (`--ticket-id --mode`) maps the DAG's MODE output to a ticket
  disposition using the **same** `INCIDENT_MODE_DISPOSITION` table the in-process pipeline uses — not a
  second copy. An unclassified phase **completes** the ticket rather than stranding it.
- **`src/app/record-cost.ts`** (`--ticket-id --workflow-status`) writes ONE workflow-level `chat_tasks`
  **run marker carrying zero cost**. Each `bot-node-phase` pod already recorded its own per-call cost
  row through the shared execution handler, so billing the run again here would **double-count every
  Argo workflow in every cost report**. The marker makes the run visible and linked to its ticket — it
  is not a second bill. A regression test locks the zeros in.
- **`src/features/swarm-orchestration/services/rca-mode.ts`** — `readRcaMode` +
  `INCIDENT_MODE_DISPOSITION` extracted out of `queue-manager-service` (which re-exports them, so every
  existing call site and test is unchanged). This lets the batch path read the mode from the canonical
  source — **line 1 of `RCA-REPORT.md`** — without dragging the whole queue manager (Redis, dispatch)
  into a one-shot Job pod. `bot-node-batch` now prefers `readRcaMode()` and only falls back to scanning
  the response text, so the batch and in-process paths can never disagree about the same run.

**A footgun the tests caught:** `finalize-incident` originally fell back to `process.env.MODE`. `MODE`
is a generic env var — vitest sets `MODE=test`, bundlers set `MODE=production` — so that fallback would
have silently hijacked the ticket disposition. Removed; a test now asserts that `MODE=C` in the
environment cannot escalate a ticket.

Verified: `tsc --noEmit` clean · all three hooks emit to `dist/app/` (the exact paths the shell scripts
exec) · 25 new unit tests · **910/913 unit tests pass** — the 3 skips are docker-gated specs that pass
when run in isolation (`sandboxUsable()` loses its probe race under full-suite parallel load) · the
edited template still server-side applies to the live Argo CRD.

## Still absent

- **A real in-cluster run.** The batch entrypoint has NOT been executed inside Argo: the `bot-image`
  must be rebuilt to contain `dist/app/bot-node-batch.js` and loaded into the cluster's containerd,
  and the per-tenant `oshal-tenant-db` Secret + `oshal-workflow` SA must exist in the tenant namespace.
- **`QueueManagerService` as a thin Workflow submitter** — the remaining half of ADR-078 §1, not started.
- **Terraform** (`**/*.tf` → none) and **Argo CD GitOps delivery** (§5) — not wired.
- **In-cluster model serving** — the `model-endpoint` points at `ollama.oshal-model.svc`. Ollama now
  runs in *compose* (see [local-llm runbook](../runbooks/local-llm-profile.md)); the k8s Service does not exist yet.

# Addendum — step 3 (2026-07-08, same day): the adversarial double-check

A 30-finding multi-agent review of steps 1-2's own output confirmed 17 defects (two live-proven
against the running cluster/DB by the reviewers themselves). All are fixed; the load-bearing ones:

| Defect (confirmed 2/2 adversarial votes) | Fix |
|---|---|
| **The batch envelope carried no work content** — `workUnits` is the only carrier on the non-direct path; the pod would have burned a real LLM call investigating nothing | `--title/--description` flow from the workflow params into a work unit that also states the RCA-REPORT.md MODE contract |
| **`externalId` missing** → cost rows/ticket links never attributed to the ticket | envelope sets `externalId` |
| **Workspace-root divergence** — the prompt assembler preferred `/app/workspace` while `resolveMode` read `/app/workspace-shared`: Mode C escalations would silently become `completed_no_mode` | template sets `SHARED_WORKSPACE_ROOT` + `WORKSPACE_DIR` |
| **The `when` expression errored EVERY default run** (unquoted `""` substitution → govaluate parse error → whole Workflow `Error`, finalize `Omitted`; live-reproduced) | quoted substitution (live-verified: empty → Skipped → finalize runs) |
| **`in_process_discovery → customer_action` rejected by VALID_TRANSITIONS** — mode A/B (the two mainline dispositions) could never finalize; the in-process pipeline had the same latent bug, silently downgrading A/B to `escalated` (live ticket history confirmed) | transition added; batch phase now moves the ticket to `in_process_discovery` at start (submitter contract: submit tickets in `approved`); a test drives every disposition through the real TicketService |
| **Tenant egress starved the tenant's own workload** — the applied policies dropped the `oshal`/`oshal-model` grants the example defines, and NEITHER file granted the kube-apiserver (an ipBlock, invisible locally because kindnet exempts it) | grants restored + apiserver ipBlock in both files; `verify-tenant-isolation.sh` now asserts the dependency grants too (13/13) |
| **The image never contained the hook scripts** — the Dockerfile COPY whitelist (and `.dockerignore` allowlist) excluded all three; no rebuild could ever produce a working image | both whitelists fixed |
| **`processing`-forever run marker** polluting active-task counts; `--workflow-status` parsed but dropped | terminal status stamped from workflow status + `ticket_task_links` row via `linkTask` |
| **RLS tenancy overclaim** — the GUC wrapper stamps `is_operator='on'` for identity-less pods, a full RLS bypass on ANY per-tenant role | claim corrected here, in the template and the README: the DB isolation leg requires a per-tenant DATABASE until a tenant-scoped service identity exists (BACKLOG Plan C) |
| Deliverables died with the pod; a reviewer reviewed an empty workspace | shared `workspace-pvc` volume + `tenant-workspace-pvc.example.yaml` (RWO ok single-node; RWX needed multi-node) |
| `LLM_BASE_URL` was dead config (nothing reads it) | replaced with `OLLAMA_HOST`, the env the cline harness actually reads |
| `AGENT_ID` name-matching gap (names only resolve via `BOT_NAME`) | template sets `BOT_NAME` too; `worker-bot` default is now the resolved UUID with the submitter contract documented |
| Executor RBAC bound only the `argo` SA — a plain `argo submit -n argo` used `default` and reproduced the exit-64 failure | `default` SA added to the binding |

Also fixed in the same sweep (Telegram surface, same session's commits): the webhook dispatched
under the ANONYMOUS RLS identity so the linked user's connectors/BYO-LLM silently never resolved
(now re-enters the linked user's identity); the webhook secret doubled as a URL path segment,
persisting one unredactable copy per delivery into container logs and the append-only audit log
(now header-only on a fixed path); group messages could deliver a linked user's private reply into
the group (private chats only in v1); per-message task ids gave conversations zero continuity (now
per-chat).

## Honest one-line status (step 2)

> Argo is **installed and proven to run workflows** on the local cluster, the incident-rca
> `WorkflowTemplate` is **accepted by the real CRD** in a tenant namespace, and cross-tenant network
> isolation is **enforced and asserted in both directions**. What remains before a ticket can run as
> a Workflow is OSHAL-side, not cluster-side: the one-shot batch entrypoint. No production server or
> GPU box is required to get here.
