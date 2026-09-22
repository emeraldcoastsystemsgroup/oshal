# Docker Desktop Kubernetes live proofs (2026-09-21/22)

**Scope:** what was measured on one live Docker Desktop Kubernetes cluster, organised by the items of
the [remote-cluster work package](remote-cluster-work-package.md). The chart was installed on the
development box on the operator's explicit direction, as the package's status note records.

**Provenance.** Every live-cluster claim below comes from the operator's raw evidence record of the
run, which is not tracked in this repository. Values and timestamps are as measured. A clause the
record does not contain is marked as not proven, not inferred. Commit SHAs and guard files are
repository facts. This note follows the honesty model of
[the ADR-078 step status](../architecture/078-argo-batch-proveout-status.md): what is proven, what
needs another run or a decision, and what is absent.

**Labels.** PASS means the record shows the done-when clause met on this cluster. PARTIAL means some
clauses are met and some are not. NOT RUN means the proof was not attempted (item 10: not attempted because
item 1's publish is missing). BLOCKED means a proof that ran up to a missing external prerequisite
(the trading clause: the route answered 503 `broker_not_configured`). A DEFECT is
a proof that ran and showed the platform doing the wrong thing.

## The cluster

- Docker Desktop Kubernetes v1.36.1 (kind provisioning), one node, `desktop-control-plane`.
- CNI: kindnet (DaemonSet `kindnet`).
- StorageClasses: `standard` (default) and `hostpath`, both `rancher.io/local-path`, both
  `VOLUMEBINDINGMODE WaitForFirstConsumer`.
- API server endpoint: `172.19.0.2:6443`.

## Summary

| Item | Result | In one line |
|---|---|---|
| 5 — Pod Security and quota | **PARTIAL** | Pod Security measured by server-side dry-run; the quota and a real restricted install were NOT RUN |
| 10 — codeless install end to end | **NOT RUN** | blocked on item 1 (publish and GHCR visibility) |
| 11 — shared-service tier | **PARTIAL** | graph, transcription, package survival and the ArangoDB degrade PASS; the trading series clause is BLOCKED |
| 12 — bot-launcher live boundary | **PARTIAL** | the validator PASS; the cockpit toggle against a real Deployment found a DEFECT |
| 13 — tenant NetworkPolicy | **PASS** | 13 passed, 0 failed, with an enforcement control, on kindnet |
| 14 — Vault Kubernetes secrets engine | **PARTIAL** | Vault initialized and unsealed; the engine was not configured |
| 16 — ADR-119 kill drill | **PASS** | the alert fired, reached the api and cleared |
| 17 — structural questions | **PARTIAL** | one node, so the multi-node workspace question cannot be answered here; the CNI is recorded |

Items 3 and 4 (the chart halves of Vault hardening and the credential move) were also measured after
the 0.5.0 upgrade; they are recorded under [Items 3 and 4](#items-3-and-4-chart-halves).

---

## Item 5 — Pod Security admission: PARTIAL

**Proven.** A server-side dry-run of the chart at `8898f2fb` into two namespaces, `pss-baseline` and
`pss-restricted`, labelled `pod-security.kubernetes.io/enforce=<level>` and `enforce-version=latest`.
The command was `helm template ... | kubectl apply -n <ns> --dry-run=server -f -`, for the defaults
and for `-f values-docker-desktop.yaml`.

| Level | Result |
|---|---|
| baseline | 0 PodSecurity warnings in both postures. **PASS.** |
| restricted | Warnings for exactly `oshal-api` (`DAC_OVERRIDE` add and `runAsNonRoot`), every `oshal.io/bot` Deployment (the same two; kubectl collapses the 21 identical "bot" warnings into one line), `oshal-arangodb` and `oshal-chromadb` (`runAsNonRoot`). This matches the chart README's prediction. |
| server dry-run | 71 objects accepted, 0 errors. |

**Not run.** The ResourceQuota half, and a real install into a restricted namespace. A second full
install does not fit a 7.6 GiB node beside the live one.

## Item 10 — codeless install end to end: NOT RUN

Installer mode 4 pulls `ghcr.io/emeraldcoastsystemsgroup/oshal-bot`. That image is stale
(2026-07-26) and not proven public, so this item is **blocked on item 1** (the publish and the GHCR
visibility flip). The install on this cluster was a manual `helm upgrade --install` of the local chart
with a side-loaded image. The `/welcome` wizard and a jarvis turn were not proven.

## Item 11 — shared-service tier: PARTIAL

| Done-when clause | Result | Measured |
|---|---|---|
| `/api/graph` answers instead of 503 | **PASS** | `POST /api/graph/query {"aql":"RETURN 1"}` → 200 `{"rows":[1]}`; `GET /api/graph/neighbors` → 200. |
| A trading query returns series from the in-cluster tsdb | **BLOCKED** | The api reaches the in-cluster TimescaleDB 2.30.0, and the hypertables `public.world_metrics` and `public.world_pulls` are present. `/api/trading-charts/bars` → 503 `broker_not_configured`: there are no Alpaca paper keys on this cluster. |
| A transcription round-trips through the diarization Service | **PASS**, on a source-built image | On the published `ghcr.io/emeraldcoastsystemsgroup/oshal-speaker-diarization:latest`, `POST /v1/diarize` → 200 in 3.4s (`sherpa-onnx-1.13.1/pyannote-segmentation-3.0/3dspeaker-eres2net`), but `/v1/transcribe` → 404: the published image predates the source. With the source-built image side-loaded (`oshal-speaker-diarization:source-20260916`), `/v1/transcribe` → 200 in 13.8s (`asrModelId sherpa-onnx-1.13.1/moonshine-base-en-int8`) and `/v1/diarize` → 200. |
| A staged store package serves and survives an api restart | **PASS** | 64 to 71 apps reloaded across 7 api restarts. The little-monsters package's migrations 019, 020, 021 and 024 were applied from the package. |
| `infra.arangodb.inCluster=false` degrades the graph cleanly | **PASS** | `--set infra.arangodb.inCluster=false`: the StatefulSet was removed, the claim `data-oshal-arangodb-0` was kept, `ARANGO_URL` was withheld, `/api/graph/query` → 503 `{"error":"graph_engine_unavailable","message":"ARANGO_URL not configured"}`, and the api log had 0 connection-refused or DNS errors. |

The transcription PASS used a side-loaded image. The chart's default image does not serve
`/v1/transcribe`; that is an open defect, [below](#the-published-diarization-image-has-no-v1transcribe).

## Item 12 — bot-launcher live boundary: PARTIAL

**Proven.** `validate-dynamic-bot-manifest.mjs --require-server --context docker-desktop` exited 0,
printing `dry-run mode: server (validated by the real API server; nothing created)` and
`OK: the API server exposes deployments/scale with verbs [get, patch, update]`. **PASS.**

**DEFECT FOUND.** The cockpit enable/disable toggle against a real Deployment does not scale it.
Details and the decision it needs are [below](#the-cockpit-toggle-scales-the-wrong-deployment).

## Item 13 — tenant NetworkPolicy: PASS (CNI kindnet)

- `tenant-network-policies.yaml` was applied with its hardcoded `172.26.0.4/32` replaced by the live
  `172.19.0.2/32`.
- `verify-tenant-isolation.sh`: 13 passed, 0 failed, exit 0.
- **Enforcement control**, from a policy-free pod in `default`: tenant-b was blocked with its
  policies in place, REACHED with the tenant-b policies removed, and blocked again after they were
  restored. kindnet enforces NetworkPolicy.
- **`oshal` → tenant ingress** (the `oshal-api` pod to the tenant-a and tenant-b web pods): blocked.
  Tenant ingress admits same-tenant sources only.
- **Tenant → `oshal` egress**: tenant-a → `http://oshal-api.oshal.svc:5000/api/health` →
  `{"status":"ok"}`. The grant and DNS both work.

This is the NetworkPolicy half of the item. The database and row half runs off the cluster
(work package section 4.4) and is not in this record.

## Item 14 — Vault Kubernetes secrets engine: PARTIAL

**Proven.** `oshal-vault-0` was initialized (`vault operator init -key-shares=5 -key-threshold=3`;
the output is kept by the operator, outside the repository and the cluster) and unsealed with 3 of 5
shares: `initialized=true sealed=false storage=file version=1.18.5`.

**Not proven.** The engine was NOT configured. Creating the least-privilege RBAC for it needs operator
approval on this box, so issue, use and revoke did not run.

**Finding.** The chart's Vault pod ran as the namespace's `default` ServiceAccount, which every infra
pod shares. Any RBAC the engine needs would have been granted to all of them. Vault needs its own
ServiceAccount. **Fixed in the chart** by `1338d6ad`: `infra.vault.serviceAccount`, the chart README's
Vault runbook (with the engine's per-tenant RBAC as an operator example), and the guard
`tests/unit/chart-vault-service-account.spec.ts`. No live run of that change is in this record.

**Owed.** The root token has not been revoked; it is needed to finish the engine setup. The runbook's
revoke step is owed.

## Item 16 — ADR-119 kill drill: PASS

Monitoring: kube-prometheus-stack 91.4.1, 22 oshal targets up (1 `oshal-core` and 21
`oshal-swarm-bots`), five `Swarm*` rules loaded.

| Time (UTC) | Event |
|---|---|
| 22:32:46Z | `weather-bot` scaled to 0 |
| 22:33:42Z | `SwarmContainerDown` pending |
| 22:34:41Z | `SwarmContainerDown` firing |
| 22:34:57Z | active in Alertmanager |
| 22:34:58Z | api logs "Landed alert envelope" (source `alertmanager`), consolidated onto incident `SwarmContainerDown::oshal-local-weather-bot` |
| by 22:36:49Z | restored; cleared in Prometheus and in Alertmanager |

## Item 17 — structural questions: PARTIAL

- **Multi-node workspace claim:** not answerable here. The cluster has one node. The binding mode
  is recorded under [The cluster](#the-cluster).
- **CNI:** kindnet, and it enforces NetworkPolicy (item 13).

## Items 3 and 4 (chart halves)

Measured after the 0.5.0 upgrade (image and chart `8898f2fb`, then `3b3dd478` and `8a6dc1e5`):
`helm upgrade --wait` exited 0, 30/30 pods Ready with 0 restarts, and `/api/version` reported commit
`8898f2fb`.

- **Item 3, Vault (chart half): PASS.** `oshal-vault-0` was 1/1 Ready while `initialized=false
  sealed=true storage=file`. `/api/devops/status` → 403, because `OSHAL_DEV_CONSOLE_ENABLED` is unset
  (the compose default), so the `vault_not_configured` answer was not observable here.
- **Item 4, credentials: PASS.** `oshal-shared-env` has no credential keys. Bots `envFrom`
  `oshal-shared-env`, `oshal-shared-secret` and `oshal-bot-env`, carry no `BOOTSTRAP_DATABASE_URL`,
  and connect as DB user `oshal_bot`. `/api/graph` works with the ArangoDB credentials from the
  Secret.

---

## Defects found and fixed live

Each fix shipped with its guard in the same commit.

| Defect | Measured | Fix | Guard |
|---|---|---|---|
| **The config-seed Secret hid the UI profiles.** Mounted over `/app/config-seed`, it hid the image's profiles, so the api served the built-in fallback ribbon (no Jarvis, no workspace navigation). | Live-fixed first with ConfigMap `oshal-ui-profiles` at `/config-seed/profiles`. After the 0.5.0 upgrade, with the chart's default emptyDir seed: "UIProfileService initialised", dir `/config-seed/profiles`, 3 profiles; `/api/ui/profile` → `oshal-framework`, 75 ribbon items led by Home, Jarvis, Switchboard. | `8898f2fb` | `tests/unit/chart-ui-profiles.spec.ts` |
| **The api's Postgres wait probe hung.** It sat about 4 minutes on a socket opened just before `oshal-db-0` was replaced. | Probe 02:37:58, database restart 02:38:05. | `3b3dd478`: each attempt bounded (pg 5s timeouts, `timeout 15`). | `tests/unit/chart-db-wait-probe.spec.ts` runs the rendered probe against an accept-and-never-answer listener. |
| **A ConfigMap change did not roll the pods.** Re-enabling ArangoDB changed only the ConfigMap, so the api kept answering 503. | After the fix: graph store "ok - 3 graph databases" (the same data on the reused claim `pvc-064a32c6`), `/api/graph/query` `RETURN 1` → 200. | `8a6dc1e5`: `checksum/shared-env` and `checksum/shared-secret` annotations. | `tests/unit/chart-config-rollout.spec.ts` |

## Defects found and NOT fixed

These need core changes or operator action, so each is a [BACKLOG](../BACKLOG.md) entry and nothing
here changes them.

### The cockpit toggle scales the wrong Deployment

`PATCH /api/agents/<id>/status` on `weather-analyst` (`a0000000-...-004a`) made the launcher scale
`deployments.apps "weather-analyst"` → 404 NotFound. The chart's Deployment is `weather-bot`, the
compose service name. The agent row flipped inactive and back to active, but the pod never scaled:
replicas stayed 1. This affects every chart bot whose agent name differs from its service name.
The fix is core (the launcher resolving the Deployment by a chart label) and needs operator approval.

### Opt-in apps revert on every api boot

An app whose manifest says `status: inactive` reverts on every api boot, through the upsert `CASE`
in `src/features/swarm-apps/services/swarm-app-repository.ts`. That then fails the groups that need
it: intelligent-career needs print-ingest, and marketing-suite needs brand-graphics. The fix is core
and needs operator approval.

### The published diarization image has no `/v1/transcribe`

`ghcr.io/emeraldcoastsystemsgroup/oshal-speaker-diarization:latest` predates the service source and
answers `/v1/transcribe` with 404. A source-built image answers it with 200 (item 11). The fix is a
republish, which rides on item 1. `values-docker-desktop.yaml` (SEQ 4) records the side-load
override a box with compose's source-built image can use until then.

### Open, store side: little-monsters looks for its migration at a core path

Captured on the api boot of 2026-09-22T02:54:51Z, at level 50:
`{"module":"education-schema","migrationPath":"/app/scripts/migrations/019-education-platform.sql","msg":"Education migration file not found; schema bootstrap skipped"}`.
The emitter is **not core**. It is the store package itself:
`little-monsters/src-routes/education-schema.ts:219` (compiled to `routes/education-schema.js`)
resolves `path.resolve(process.cwd(), 'scripts/migrations/019-education-platform.sql')`, a path
from before the app was carved out of the kernel. It is harmless on this cluster: the platform
applied the package's own `migrations/019`, `020`, `021` and `024` from the package in the same boot
(item 11), so the schema exists. The fix belongs in oshal-applications (resolve the package's own
`migrations/` directory, or drop the redundant bootstrap), which needs a package version bump and
its audit record re-bound.

---

## Absent here

- A second node, so no multi-node scheduling observation (item 17).
- Alpaca paper keys, so no trading series (item 11).
- An `oshal-bot` image that is current and proven public, and a published OCI chart, so no codeless
  install (item 10).
- A configured Vault Kubernetes secrets engine, so no issue/use/revoke (item 14).
- Headroom for a second full install, so no quota or real restricted install (item 5).

## Honest one-line status

> On one single-node Docker Desktop cluster (kindnet), the tenant NetworkPolicy proof and the ADR-119
> kill drill PASS. The shared-service tier, the bot-launcher boundary, Pod Security, Vault and the
> structural questions are PARTIAL. The codeless install was NOT RUN, and the trading clause is
> BLOCKED. Three defects were fixed live with guards. Three more are open and need core work or a
> republish, and a fourth is open in the little-monsters store package.
