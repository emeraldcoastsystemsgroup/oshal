# DevOps Cockpit — topology discovery, node deployment, and the connectivity matrix

**Status:** Phase 1 (Vault broker console) **shipped + live** 2026-07-18; Phase 2+ **designed, not built** — this doc *identifies the connectivity choices* so we can pick per environment rather than hard-wire one.
**Builds on:** [ADR-040 DevOps/Vault Swarm](../adr/040-devops-vault-swarm.md) · [ADR-013 Headscale overlay](../adr/013-headscale-self-hosted-overlay-network.md) · [ADR-045 graph tier](../adr/045-two-tier-graph-database-and-connector.md) · [edge-node / remote-client](edge-agent-architecture.md) · the A2A surface (`src/shared/types/a2a.ts`).

The premise (operator, 2026-07-18): the DevOps cockpit is not one integration — it is a **fabric** the operator points at their own infrastructure, and *every* environment answers the connectivity question differently. So we enumerate the choices and let the operator select, self-discover where we can, and light up each connection green/yellow/red.

---

## Phase 1 — SHIPPED: the credential spine

The credential broker is the load-bearing primitive and it is **live** (superadmin-gated console at `/api/devops/console`):

- **vault-bot + `VaultConsoleService`** drive a real HashiCorp Vault — KV secrets, scoped ACL policies, the **broker** (mint short-TTL scoped creds → inspect lease → revoke), and the **postgresql dynamic-secrets engine** (real self-expiring DB logins).
- **Green / yellow / red creds light** — `working` / `can't reach the server` / `denied|sealed`, from an unauthenticated health probe + an authenticated `lookup-self`. This is the pattern every *other* connection below reuses.
- Token stays server-side; mutations are `confirm:true` + written to the governance audit trail.

Everything below hangs off this spine: a specialist never holds a standing cloud key — it asks the broker for a short-TTL scoped credential per task.

---

## Phase 2 — "startup step one": topology discovery from the logged-in CLIs

**Discover what nodes exist before doing anything.** OSHAL's standing doctrine is *drive the vendor's own CLI, host-side, never broker its OAuth* ([ai-provider-login-mechanics] memory). The already-logged-in CLIs on the box **are** the access + the inventory source. A discovery pass shells each present CLI read-only and assembles a topology:

| CLI (if logged in) | Discovery calls (read-only) | Yields |
|---|---|---|
| `aws` | `sts get-caller-identity`, `ec2 describe-instances`, `eks list-clusters`, `ssm describe-instance-information` | accounts, regions, EC2 hosts, EKS clusters, SSM-managed nodes |
| `gcloud` | `projects list`, `compute instances list`, `container clusters list` | GCP projects, GCE VMs, GKE clusters |
| `az` | `account show`, `vm list`, `aks list` | subscriptions, Azure VMs, AKS clusters |
| `kubectl` | `config get-contexts`, `get nodes`, `get ns` | clusters, node pools, namespaces |
| `terraform` | `workspace list`, `state list`, backend config | managed resources + **where state lives** (see §Terraform selector) |
| `ssh`/`~/.ssh/config` | parse hosts (no connect) | bare boxes reachable by key |
| `docker context` | `context ls`, `node ls` (swarm) | container hosts |

The result is a **topology graph** — this is exactly the [ADR-045 graph tier](../adr/045-two-tier-graph-database-and-connector.md)'s job: nodes = {account, cluster, node pool, instance, box}, edges = {member-of, runs-on, peers-with, manages}. "Know what nodes are there" is an ingest + NL-query over the graph connector, not a new store.

**Connectivity choice surfaced here:** which discovery sources to trust, and whether discovery runs on the api box only or fans out to already-connected nodes.

---

## Phase 3 — node deployment: get an agent onto the discovered nodes

"Deploy a bot to nodes" has **no single right answer** — it depends on the node's trust and NAT posture. Identify all four; let the operator pick per target:

| Option | How | Direction | Best when | Trade-off |
|---|---|---|---|---|
| **AWS SSM** | `ssm send-command` runs the installer via the SSM agent already on EC2 | push (OSHAL → node) | EC2/SSM-managed fleets | AWS-only; needs the SSM agent + IAM |
| **SSH push** | run the one-line installer over an existing key | push | boxes in `~/.ssh/config` | needs inbound SSH + a key OSHAL can use |
| **HTTPS self-register** | node runs a curl one-liner → installs `@oshal/chat` edge CLI → **registers back over HTTPS** | pull (node → OSHAL) | anything behind NAT / no inbound | node must be able to reach OSHAL; token bootstrap |
| **Image startup hook** | bake "fetch latest install + register" into the AMI / container entrypoint / cloud-init | pull, on boot | autoscaling fleets, ephemeral nodes | needs image ownership; version pinning |
| **kubectl apply** | deploy the agent as a DaemonSet/Deployment | in-cluster | k8s clusters | needs cluster-admin at deploy time |

The **HTTPS self-register** + **image startup hook** paths are the NAT-friendly default (pull model) and reuse the existing edge installer (`@oshal/chat`, [edge-node doc](edge-agent-architecture.md)). "A script you add to the image startup to get the latest install" = the startup hook row.

**Bidirectional remote node.** Once registered, the CLI on each box must be reachable *both ways* (OSHAL dispatches work to it; it reports back). Three transports already exist in the codebase — this is a selection, not a new build:

- **Headscale overlay** ([ADR-013](../adr/013-headscale-self-hosted-overlay-network.md)) — every node joins a private mesh; bidirectional by construction, NAT-traversing. The heaviest but most capable.
- **A2A gateway** (`src/shared/types/a2a.ts`, transports `headscale-http`/`http`/`sse`/`stdio`) — the external-agent surface; not yet production-proven.
- **HTTPS long-poll / SSE** — node holds an outbound connection; OSHAL pushes work down it. Lightest, NAT-friendly, no inbound.

---

## Phase 4 — the spatial selectors (where infra config lives)

State and login config live in **different places per shop**; self-discover, then let the operator set it. Each gets a green/yellow/red test.

**Terraform state selector** — "where is terraform kept":
- local `terraform.tfstate` · S3 backend (+ DynamoDB lock) · Terraform Cloud/Enterprise · a git repo · a specific box.
- Self-discover by scanning for `*.tf` `backend` blocks + `terraform.tfstate`; the operator confirms/overrides. The selector is **independent** of the cloud creds (state can live in S3 while the plan touches GCP).

**k8s login patterns** — self-discover kubeconfig contexts, then classify each context's auth: static kubeconfig · in-cluster ServiceAccount · cloud IAM (`aws eks get-token` / `gcloud ... get-credentials` / `az aks get-credentials`) · OIDC. The operator picks which contexts the k8s specialist may use.

**Vault config** — "set a Vault option to let the user configure Vault with creds." Today Vault is env (`VAULT_ADDR`/`VAULT_TOKEN`); Phase 4 adds a **Connect-Vault** flow (parallel to the connector OAuth flows): address + auth method (Token / AppRole / TLS cert / OIDC), stored encrypted, with the shipped traffic-light as its live test-connection.

---

## Phase 5 — the specialists (personas, brokered creds)

Each specialist is a persona + tools that **pulls a short-TTL scoped credential from the Phase-1 broker per task**, acts, and lets the lease expire. Following OSHAL's "the persona is the swarm" model (one bot per ticket-type, self-gating quality):

- **CI/CD specialist** — GitHub Actions / GitLab CI / Jenkins / ArgoCD: trigger, watch, rollback, drift; deploys are review-gated, never silent.
- **Infra specialist** — Terraform plan + drift (apply is human-gated), cloud resource ops via the brokered cloud cred.
- **k8s specialist** — cluster inspection, event/log correlation, remediation scripts for human review (never auto-apply to prod).
- **vault-bot** (shipped) — the credential-broker specialist the others depend on.
- **observability specialist** (from the ADR-040 roster) — Splunk / ServiceNow query + root-cause correlation.

Privileged specialists need the **per-session ephemeral runtime** (per-session tmpfs, no residual credential, bounded blast radius) — the remaining ADR-040 build and the security-review gate before any of them touch a real cloud.

---

## The connectivity matrix (the thing to decide per environment)

Every target crosses four axes. This is the menu the cockpit must present (and self-fill where discovery can):

| Target | Reach / transport | Auth model | Direction | NAT posture |
|---|---|---|---|---|
| AWS account | SSM · SSH · cloud API | logged-in `aws` CLI → IAM · Vault-brokered STS | push / pull | outbound-only OK via SSM |
| GCP project | SSH · cloud API | logged-in `gcloud` → SA · Vault-brokered | push / pull | outbound-only OK |
| Azure sub | SSH · cloud API | logged-in `az` · Vault-brokered | push / pull | outbound-only OK |
| k8s cluster | kubectl · in-cluster agent | kubeconfig ctx · in-cluster SA · cloud IAM | in-cluster / pull | agent = outbound-only |
| Bare box | SSH · HTTPS-register · overlay | SSH key · bootstrap token · overlay identity | push / pull / bidi | register = NAT-friendly |
| Terraform state | S3 · TFC · git · local | brokered / backend creds | read/write | follows the backend |
| Vault | HTTPS | Token · AppRole · TLS · OIDC | pull | outbound-only |

**Health, everywhere:** each row lights **🟢 working / 🟡 can't reach / 🔴 denied** — the pattern already shipped for Vault, generalized to every connection so the operator sees the whole fabric at a glance.

---

## Live process trace — the terminal reflects EVERYTHING while acting (operator, 2026-07-18)

Non-negotiable for the active side: the moment the cockpit *makes changes* (a broker issue/revoke,
a CLI shell-out, a remote node firing), the operator must watch it happen — a live, streaming,
Claude-CLI-style scroll of every command, its stdout/stderr, and every remote-node event. "You
don't fire privileged commands into a black box." Mode-scoped by the operator's own rule: *not
needed for passive/read use, required whenever we're actively changing things* — so the trace pane
is quiet/collapsed by default and opens to a firehose when an active operation runs.

**The substrate already exists — this is wiring, not a new subsystem:**
- `StreamManager` (`src/features/streaming`) + `/api/stream/:taskId` — live SSE task-execution
  streaming (session-scoped: a client only sees the tasks it initiated). Chat already streams
  token-by-token; Jarvis streams; the **Developer Console already streams a live agent session**
  (`/api/dev-console/sessions/:id/stream`, SSE) — the closest existing thing to "Jarvis as a CLI."
- The **mesh** (`oshal:mesh:agent.{agentId}`, Redis streams) already carries remote-node / bot
  activity — a trace subscriber turns "node X fired" into a live frame.
- ADR-107 **run-trace** is the *post-hoc* waterfall (phase → bot → LLM-call → cost) — the after
  view; the live trace is its real-time twin, and they share the same event vocabulary.

**The gap (what to build):** a unified **live process-trace terminal** in the DevOps console that
subscribes to (a) every command/tool execution + its stdout/stderr, (b) mesh remote-node events,
(c) broker/state changes, and renders them as a live superadmin-gated scroll. The privileged
DevOps actions shipped in Phase 1 currently log to Pino + the audit trail but do **not** yet emit
live stdout frames — wiring them (and every future discovery shell-out / remote-node dispatch) to
publish stream frames is the concrete work. It pairs with topology discovery as the first slice:
discovery's read-only CLI shell-outs become the first commands you *watch scroll live*.

**FIRST SLICE SHIPPED 2026-07-18** — `GET /api/devops/trace/stream` (SSE) + `DevopsTraceHub` +
a terminal pane in the console: every Vault action publishes a frame (mutations `start`→`ok`/`error`,
reads `info`) and the pane scrolls live. Frame text is **secret-redacted** (a whitelist — paths /
versions / accessors / ttls / counts, never `data`/`token`/`password`). Remaining: fan in the mesh
(remote-node "fired" events) and future CLI shell-outs onto the same bus.

**Channel-isolation rule (the security lesson, operator, 2026-07-18)** — the old cross-bot SSE
fan-out (clients subscribing to *everything* instead of their own channel) must not recur. Two
mechanisms, verified in code:
- The generic task stream (`StreamManager` / `GET /api/stream/:taskId`) is filtered by task
  (`shouldReceiveEvent`: exact task, or a session client's own known tasks — `'all'` ≠ "hear
  everything"), the any-bot *Issue #022* fix. BUT it does **no ownership check on subscribe** —
  isolation there leans on mount-auth + unguessable ids. **Not sufficient for privileged output.**
- The correct pattern for a privileged trace (used by the Dev Console and now the DevOps trace):
  **subscribe is gated AND owner-scoped.** `DevopsTraceHub.publish` delivers a frame ONLY to sinks
  registered under `frame.actor`; there is no "all" channel and no taskId a caller can pass to
  widen its subscription, and the route is `requireSuperAdmin`. A bot or another user cannot attach
  to the operator's infra firehose even if it guesses the channel id. Remote nodes stay on their
  own per-agent mesh channels (`oshal:mesh:agent.{id}`); the server fans them **in** and does a
  single owner-scoped fan-**out**. This is the rule for every future streaming surface that carries
  privileged output.

## Sequencing (done-when lives in [BACKLOG](../BACKLOG.md))

1. **[shipped]** Vault broker console + creds traffic-light.
2. Topology discovery pass → graph (read-only CLI shell-out, ADR-045 ingest).
3. Connect-Vault flow + generalized per-connection traffic-light.
4. Terraform-state + k8s-context selectors (self-discover + override).
5. Node deploy: HTTPS self-register + image startup hook first (NAT-friendly), then SSM/SSH/kubectl.
6. Bidirectional remote node over one selected transport (overlay vs long-poll).
7. Specialists (CI/CD → infra → k8s), each behind the ephemeral runtime + a security review.

**Non-negotiables carried from the platform:** superadmin-gated; mutations `confirm:true` + audited; no standing cloud keys (broker per task); apply/deploy human-gated; every remote node is operator-owned and consented; commands never leave the sim/broker path without an explicit gate.
