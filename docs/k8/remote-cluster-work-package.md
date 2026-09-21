# Kubernetes remote-cluster work package

**Audience:** an agent or engineer on a **different machine** — a box with headroom that will run a
real Kubernetes cluster. You have this repo. You do not have the operator's development stack.

## Why this document exists

The operator's development box runs the full oshal swarm in docker compose and has no headroom for
a cluster. All Kubernetes work is therefore tagged for a separate machine. **Nothing in this package
may be attempted on the development box.**

That is a binding operator decision, recorded in `docs/BACKLOG.md` under **"Vault cloud secrets
engines"** (line 1531 at time of writing; BACKLOG line numbers drift, so navigate by the `###`
heading):

> **Decision (operator, 2026-09-21): the Kubernetes engine moves to a REMOTE CLUSTER BOX; the
> lifecycle proof happens here on the Postgres engine.** The operator will stand up a Kubernetes
> instance on a separate machine with headroom — this development box runs the whole swarm in docker
> compose and will not host a cluster. […] an agent working on this box must SKIP cluster work and
> say so rather than installing k3s/kind/minikube or running `kubectl` here.

A second operator decision sets the priority. `docs/BACKLOG.md` **"Codeless k8s install — first
live-cluster proof (ADR-129)"** (line 887) reads:

> **Decision (operator, 2026-09-20): PARKED, low priority -- end of the list.** No Kubernetes target
> exists yet and nothing on the box depends on this; the live proof waits until a real second machine
> or a customer cluster exists.

Parked is a statement about ordering, not cancellation. This package is what gets picked up when a
cluster box exists.

**Status note (2026-09-21) — one Docker Desktop Kubernetes install on the development box.** On the
operator's explicit direction, and as an exception to section 1, the chart was installed on this
box's Docker Desktop Kubernetes (kind provisioning, v1.36). Measured:

- A full-fleet `helm upgrade --install` (30 pods) reached all-Ready only after the ArangoDB and
  speaker-diarization readiness-probe fixes.
- NodePorts are not host-reachable there; LoadBalancer Services map to `localhost`
  ([`values-docker-desktop.yaml`](../../deploy/helm/oshal/values-docker-desktop.yaml)).
- The api failed activation closed for every protected store app until
  `APP_PACKAGE_DYNAMIC_ROUTES=1` reached it.
- kube-prometheus-stack 91.4.1 ([`deploy/monitoring`](../../deploy/monitoring)) scraped 22 oshal
  targets (1 core + 21 bots), all up, with the five `Swarm*` rules loaded. Item 16's templating
  question was answered with a separate stack, not with chart templates.
- 54 of 61 store apps staged; 7 were refused on audit-record version drift in the store.

Not done: installer mode 4 was not run (the install was a manual `helm upgrade --install`); the
`/welcome` wizard and a jarvis turn were not proven; the OCI chart was not published; delegation
signing keys were absent, so protected dispatch refuses.

**Provenance of every claim below.** This document was assembled from four measured sweeps of the
tree on `main` (backlog, deploy configuration, ADRs/docs, code and guards). Every factual claim
carries a `file:line`. Where the sweeps disagreed with each other or with the tree, that is called
out inline rather than smoothed over. Nothing here was inferred from a grep line alone.

---

## 1. Scope and boundary

### What this package covers

Everything in the repo that targets Kubernetes: the Helm chart at
[`deploy/helm/oshal`](../../deploy/helm/oshal), the Terraform tenant module at
[`deploy/terraform`](../../deploy/terraform), the Argo/tenant manifests at
[`ops/deployment/argo`](../../ops/deployment/argo), the codeless installer's Kubernetes mode, the
Kubernetes surfaces in `src/` (section 2h), the k8s-touching guards in `tests/unit/`, the legacy
generation in `ops/` plus the `package.json` scripts that still invoke it, and the cluster-gated
clauses of the backlog entries named in section 3.

### Do NOT do on the development box

- Do not install k3s, kind, minikube or Docker Desktop Kubernetes there.
- Do not run `kubectl`, `helm install`/`helm upgrade`, or `terraform apply` against anything there.
- Do not run [`scripts/governance/verify-tenant-isolation.sh`](../../scripts/governance/verify-tenant-isolation.sh)
  there — it `kubectl exec`s into live pods.
- Do not run [`scripts/oshal-install.sh`](../../scripts/oshal-install.sh) `--mode 4` or
  [`scripts/oshal-install.ps1`](../../scripts/oshal-install.ps1) `-Kubernetes` there. Both will
  install `kubectl`/`helm`/`kind` and can **create** a cluster (`scripts/oshal-install.sh:443-478`).
  The installer already refuses to create a kind cluster beside a running compose swarm; do not work
  around that refusal.
- Do not run [`scripts/oshal-harbor-build-push.sh`](../../scripts/oshal-harbor-build-push.sh)
  there — it `kubectl apply`s and waits for rollout (`:261-272`).
- Do not run [`scripts/oshal-deploy.sh`](../../scripts/oshal-deploy.sh) there. It is the
  **development-box compose deploy**, not a Kubernetes command: `:71` pins
  `COMPOSE_FILE=docker-compose.oshal-local.yml` and `:213`, `:243` and `:299` run
  `docker compose up -d --force-recreate` against the operator's running swarm.
- Do not run [`scripts/publish-images.sh`](../../scripts/publish-images.sh) there **as a way out of
  a refusal**. It refuses unless a local `oshal-bot:latest` carries a commit label equal to
  `origin/main` (`:36-40`), and its own remediation line (`:38`) points at `scripts/oshal-deploy.sh`
  — following that line on the development box recreates the swarm. See item 1.

Offline rendering is not cluster work and is safe anywhere: `helm lint`, `helm template`,
`kubectl apply --dry-run=client`, `terraform fmt`/`validate`, and every
`tests/unit/chart-*.spec.ts`. The four chart guards plus `k8s-installer-prereqs` run with no cluster
by construction.

### What stays on the development box

- The docker compose stack — that is the reference deployment, and ADR-129 says so
  (`docs/adr/129-codeless-k8s-install-path.md:201`: "Compose remains the reference deployment").
  The chart is generated *from* compose (`scripts/generate-chart-fleet.mjs`).
- The local Vault. The hardening work approved under `docs/BACKLOG.md` **"Production Vault
  hardening"** (line 1507) — persistent storage, TLS, an AppRole login path, removal of the root
  token from `docker-compose.oshal-local.yml` — is explicitly "HARDEN IN PLACE NOW" against that
  box. Only the *Helm half* of the root-token removal and the still-unnamed "host or cluster" target
  belong here (item 3 below).
- The two-tenant **database and row** isolation proof. The 2026-09-21 decision under **"Two-tier
  tenant provisioning"** (line 1487) moved that proof off Kubernetes NetworkPolicy and onto a
  cross-tenant Postgres connection and row read. It runs on a disposable PostgreSQL, not here. See
  section 4 for the boundary between the two halves.
- Everything else that does not need a cluster.

---

## 2. What exists today

There are **two Kubernetes generations side by side in this repo, and only one is real.** Knowing
which is which is the first thing to get right, because the stale one sits one directory away from
the live one and several docs still point at it.

### 2a. The current generation — real

| Artefact | State |
|---|---|
| [`deploy/helm/oshal`](../../deploy/helm/oshal) | **Real.** `Chart.yaml:23` is `version: 0.4.0`. Lints clean and renders clean on helm v4.1.3 across four value combinations (main defaults; `role=bot-pod`; `fleet=full` + packages; managed-Postgres with services off). |
| Bot fleet lists | **Generated, not hand-typed.** [`scripts/generate-chart-fleet.mjs`](../../scripts/generate-chart-fleet.mjs) derives them from `docker-compose.oshal-local.yml`; [`tests/unit/chart-fleet-parity.spec.ts`](../../tests/unit/chart-fleet-parity.spec.ts) fails on drift. |
| [`deploy/terraform`](../../deploy/terraform) | **Real.** Preconditions make the multi-user posture unfakeable: `main.tf:121-124` requires all four OIDC values when `mock_oidc=false`, `:125-128` requires `jwt_secret`, `:129-132` requires a `DATABASE_URL` secret when Postgres is external. `providers.tf` requires an explicit `kube_context` with no default. |
| Installer mode 4 | **Real.** `scripts/oshal-install.sh:363` (`if [ "$MODE" = "4" ]; then`) is the mode-4 branch, under the section comment at `:359`; `scripts/oshal-install.ps1:172` (`if ($Kubernetes) {`, under its own section comment at `:169`) is the PowerShell sibling. The chart source is **OCI-then-repo**: `:497` tries `helm show chart "$OCI_REF"`, and `:500-509` falls back to the public `codeload.github.com` tarball, so a fresh box installs before any chart publish (`:493` says so outright). |
| In-cluster bot launcher | **Real.** `src/features/agent-management/services/kubernetes-bot-launcher.ts` talks raw HTTPS to the in-pod apiserver. `src/features/agent-management/services/bot-runtime-launcher-resolver.ts` is fail-closed: in a pod with unreadable ServiceAccount credentials it returns a refusing launcher rather than shelling `docker`. |
| Chart guards | **Real, and template-level only.** `tests/unit/chart-{fleet-parity,infra-parity,durability-boundary,bot-launcher-rbac}.spec.ts` plus `tests/unit/k8s-installer-prereqs.spec.ts`. `chart-durability-boundary` shells the real `helm template` and throws rather than skipping if helm is absent. `k8s-installer-prereqs` actually spawns the installer with a minimal PATH and asserts it refuses. |
| [`docs/k8/README.md`](./README.md) | **Accurate.** Every path it cites resolves, and it correctly demotes the legacy path. This is the doc to read first. |
| [`docs/architecture/deployment-runtime-topology.md`](../architecture/deployment-runtime-topology.md) | **Accurate**, reconciled (`:23-28` demotes the legacy trees explicitly). |

**Template inventory, measured** (`ls -1 deploy/helm/oshal/templates/`): `NOTES.txt`, `_helpers.tpl`,
and the YAML templates `api`, `apirule`, `arangodb`, `bots`, `chromadb`, `code-server`,
`diarization`, `ollama`, `postgres`, `rbac`, `redis`, `relay`, `shared-env-configmap`, `tsdb`,
`vault`, `workspace-pvc` — sixteen YAML templates plus the two non-template files. Earlier sweeps
reported "19" and "20"; neither is what the directory holds. Treat the names, not a remembered
count, as the inventory.

Beside the chart's own `values.yaml` sits
[`values-bot-pod.example.yaml`](../../deploy/helm/oshal/values-bot-pod.example.yaml) — the
contributor **federated bot-pod** example (`role: bot-pod` at `:12`; bots + tailnet relay only, no
controller and no databases, per its header at `:8-10`). It is the values file behind the
`role=bot-pod` render combination above, and it is the starting point for any second cluster that
only contributes bots.

### 2b. Known defects and dev-only postures in the current chart

These are measured, not inferred. They are the difference between "renders" and "installs for
production".

- **`rbac.botLauncher=false` crash-loops the api.** Confirmed by render diff. `BOT_DATABASE_URL` is
  emitted only inside `{{- if .Values.rbac.botLauncher }}` (`deploy/helm/oshal/templates/api.yaml:154-168`),
  but `OSHAL_APP_ROLE_BOOTSTRAP: "true"` stays on (`values.yaml:177`), so `api.yaml:116` runs
  `scripts/governance/provision-app-role.mjs`, which reads `process.env.BOT_DATABASE_URL` (`:655`)
  and calls `parsePostgresUrl(botUrl, 'BOT_DATABASE_URL')` (`:144`), which emits
  `BOT_DATABASE_URL is required` at `:121`. The chart's own `|| { …; exit 1; }` then restarts the
  pod forever. `values.yaml:362-368` presents `botLauncher: false` as a *supported* degrade. No
  guard covers it — `grep BOT_DATABASE_URL tests/unit/chart-*.spec.ts` returns nothing.
- **Mock OIDC is the default, not an opt-in.** `values.yaml:176` ships `MOCK_OIDC: "true"` with no
  paired `MOCK_OIDC_EMAIL`/`NAME`/`SUB`. `values.yaml:171-174` states plainly that without those,
  every visitor is the same shared demo identity. Only Terraform forces real OIDC.
- **Secrets in a ConfigMap.** `templates/shared-env-configmap.yaml:49` renders `JWT_SECRET`;
  `:60-61` render `ARANGO_ROOT_USER`/`ARANGO_ROOT_PASSWORD`. `swarm.jwtSecret` is overridable; the
  Arango root password has no secret path at all.
- **Vault ships dev mode with a fixed root token.** `templates/vault.yaml:29` is
  `args: ["server", "-dev"]`; `:31-32` inject `values.yaml:116`'s `devRootToken: oshal-dev-root`;
  `templates/api.yaml:177-178` puts that same token on the api as a literal container env.
  `inCluster` defaults to true. Documented as a dev posture in `values.yaml:110-113` and
  ADR-129:100-101 — not hidden, but on by default.
- **Runtime Postgres passwords are hardcoded in the template, not values.**
  `templates/api.yaml:150` is the literal `postgresql://oshal_app:oshal-app-dev@oshal-db:5432/…`.
  There is no values override for the `oshal_app` DSN. `scripts/governance/provision-app-role.mjs:162-164`
  whitelists exactly these two dev passwords when the host is `oshal-db`, so the password-strength
  guard does not catch them. `postgres.inCluster=false` is the only escape.
- **No livenessProbe or startupProbe anywhere.** `grep -rn "livenessProbe\|startupProbe" deploy/helm/oshal/templates/`
  returns nothing. A wedged-but-listening pod is removed from its Service and then sits there.
- **No `storageClassName`, `PodDisruptionBudget`, `NetworkPolicy`, `nodeSelector`, `tolerations` or
  `affinity`.** Same grep method, zero hits across the chart.
- **No HPA template.** `deploy/helm/oshal/templates/` has no `hpa.yaml`. The workspace PVC is
  ReadWriteOnce (ADR-129:203-205), so single-node is the supported default.
- **Container resource requests/limits exist on the api and the bots, and on nothing else.** Only
  two templates set container `resources`: `api.yaml:199` (from `values.yaml:179-181`) and
  `bots.yaml:87` (from `values.yaml:228-230`). Rendered with `fleet=full` and every
  `infra.*.inCluster=true`, 31 workloads come out: the api and 21 bot Deployments carry requests
  **and** limits; the nine infra workloads — `oshal-db`, `oshal-redis`, `oshal-chromadb`,
  `oshal-tsdb`, `oshal-arangodb`, `oshal-ollama`, `oshal-vault`, `code-server`,
  `speaker-diarization` — carry no container `resources` at all. Read the greps carefully: the
  `resources:` keys in `postgres.yaml:55`, `redis.yaml:46`, `tsdb.yaml:54`, `chromadb.yaml:51`,
  `arangodb.yaml:50`, `ollama.yaml:57`, `api.yaml:19`, `relay.yaml:17` and `workspace-pvc.yaml:14`
  are **PVC `requests.storage`**, not container CPU/memory, and mistaking them for the latter is
  how a sweep concludes the datastores are provisioned when they are not.
- **`securityContext` appears in three templates only** — `diarization.yaml:39`, `relay.yaml:61`,
  `vault.yaml:37`. No template sets a pod-level `securityContext`, and `Dockerfile.oshal` sets no
  `USER`, so the api and every bot run as the image's default user.
- **`code-server` runs `--auth none`** over the read-write shared workspace
  (`templates/code-server.yaml:29`), contained only by its default ClusterIP. The value
  `infra.codeServer.serviceType` will accept NodePort.

### 2c. Publishing — unproven from disk

- CI publishes `${REGISTRY}/${{ github.repository }}/oshal-control-plane`
  (`.github/workflows/ci.yml:49`), i.e. `ghcr.io/emeraldcoastsystemsgroup/oshal/oshal-control-plane`,
  from the build-and-push step at `:246-253`.
- **That CI never runs by itself.** `ci.yml:43-44` is `on: workflow_dispatch:` and nothing else;
  `:15` records that it was made manual-only deliberately after per-push and hourly CI twice took
  the account's hosted-runner minutes to zero; `:24` is a boxed standing rule — "MANUAL-ONLY. DO NOT
  ADD `push:`, `schedule:` OR `pull_request:`" — enforced by `scripts/check-workflow-triggers.js`
  (`:35-36`). The push step's condition (`:251`) fires only on an explicit Run-workflow against
  `main`. **Any proposal that starts "make CI publish…" has to live inside that rule.**
- The chart's default image is `ghcr.io/emeraldcoastsystemsgroup/oshal-bot` (`values.yaml:24`).
- **CI never publishes the image the chart installs.** That image and the OCI chart are pushed by
  operator-run scripts instead ([`scripts/publish-images.sh`](../../scripts/publish-images.sh),
  [`scripts/publish-chart.sh`](../../scripts/publish-chart.sh) — `OCI_REPO` at `:21`).
- `scripts/publish-images.sh:15-16` records that GHCR packages are created **private** and that
  flipping them public is a manual UI step. Whether the packages exist or are public cannot be
  determined from the tree.
- **What that does and does not block.** The **chart** is obtainable without any publish: the
  installer's fallback at `oshal-install.sh:500-509` fetches `deploy/helm/oshal` from the public
  repo tarball. The **image** has no such fallback — `oshal-install.sh:523` forces
  `image.repository=${REGISTRY}/oshal-bot` with `REGISTRY` defaulting to
  `ghcr.io/emeraldcoastsystemsgroup` (`:55`), so mode 4 pulls from GHCR or it pulls nothing.
  **Therefore: whether a default `helm install` can pull its image today is unproven, and the
  `helm show chart oci://…` done-when clause needs the chart publish regardless.** Settle both
  first (item 1).
- Both publish scripts refuse to publish anything that is not `origin/main` (`publish-images.sh:36-40`,
  `publish-chart.sh:34-38`). That part is solid — and it is also why item 1 cannot be run just
  anywhere; see item 1's "where this runs".

### 2d. The legacy generation — do not deploy

- [`ops/deployment/kubernetes/oshal-stack.yaml`](../../ops/deployment/kubernetes/oshal-stack.yaml)
  runs `image: oshal-api-server:latest` (`:596`) — a tag nothing in this repo builds. It commits a
  real `Secret` containing literal `REPLACE_ME` values (`:59-70`), runs Keycloak `start-dev`, has
  zero resource limits, and uses port 3456 / `/health` (both divergent from the current platform).
- [`ops/any-bot-k8s/`](../../ops/any-bot-k8s) is the same `oshal-api-server:latest` tag
  (`any-bot-stack.yaml:496`) with `MOCK_OIDC: "true"` on a stack whose purpose is reachability from
  outside machines. Credit where due: it is the only bundle shipping per-datastore NetworkPolicies.
- [`ops/deployment/README.md`](../../ops/deployment/README.md) is the worst doc in the set. It heads
  a section "OSHAL Kubernetes Deployment (Primary)", tables `kubernetes/oshal-namespace.yaml` and
  `kubernetes/oshal-local-k8s.yaml` at `:14-15` (the directory holds only `oshal-secrets.example.yaml`
  and `oshal-stack.yaml`), documents an `oshal-hot-patches` ConfigMap and an `oshal-readonly-runtime`
  ClusterRole that exist in no manifest anywhere, and its "`# Full deploy`" heading at `:71` is a
  comment followed by a blank line — the primary deploy command is literally absent.
- [`ops/deployment/presentron-integration.yaml`](../../ops/deployment/presentron-integration.yaml)
  is a third member of this generation that neither the "current" nor the "legacy" list usually
  catches: a real `kind: Deployment` named `presentron` in namespace `oshal` (`:13`, `:15-16`)
  running `image: presentron:latest` (`:31`) — a third tag nothing in this repo builds. It is
  tabled as "Optional Presentron deployment" in `ops/deployment/README.md:20`, and
  `PRESENTRON_API_KEY: "REPLACE_ME"` sits in the legacy Secret at `oshal-stack.yaml:70`.
- `docs/deployment-models.md:110-112`, `docs/framework-developer-guide.md:80`,
  `docs/architecture/core-runtime-overview.md:88-93` and `docs/setup/core-setup.md:95-100` all still
  route a reader to this generation. `core-runtime-overview.md`'s "Kubernetes mode" section gives
  only `scripts/install-k8s.sh`, which wraps the Keycloak-era `scripts/setup-oshal-k8s.sh`
  (`:16` defaults `IMAGE_TAG="oshal-api-server:latest"`).
- **`package.json` ships this generation as runnable scripts and a published bin**, which is the
  reason "just delete the docs" is not enough. `package.json:17` exposes
  `"oshal-any-bot-k8s-setup": "./scripts/setup-any-bot-k8s-cli.js"` as a `bin`, so it reaches
  anyone who installs the package; `:96-103` are eight `k8:*` scripts (`k8:setup:oshal`,
  `k8:install:oshal`, `k8:bootstrap`, `k8:setup:any-bot`, `k8:install:any-bot`, `k8:pack:any-bot`,
  `k8:docker:installer:build`, `k8:docker:installer:export`) pointing at `setup-oshal-k8s.sh`,
  `install-k8s.sh`, `setup-any-bot-k8s-cli.js` and
  `build-any-bot-k8s-{installer-image,local-package}.sh`. The supporting tooling
  (`scripts/any-bot-k8s-installer.Dockerfile`, `scripts/build-any-bot-k8s-installer-image.sh`,
  `scripts/build-any-bot-k8s-local-package.sh`, `scripts/setup-any-bot-k8s-cli.js`) is all still on
  disk. Whatever item 9 decides — delete or quarantine — has to cover these too.

### 2e. Argo and tenant material — examples, and one applied instance

- [`ops/deployment/argo/tenant-namespace.example.yaml`](../../ops/deployment/argo/tenant-namespace.example.yaml)
  is an **example**, rendered concretely for a tenant named "acme": Namespace + ResourceQuota +
  LimitRange + default-deny NetworkPolicy + tenant-scoped allow + ServiceAccount + least-privilege
  Role/RoleBinding + a per-tenant DB Secret. Two placeholders it flags itself: a Docker-Desktop node
  IP hardcoded as the apiserver `ipBlock` (`:126`), and a literal `__SET_AT_DEPLOY_TIME__`
  `DATABASE_URL` (`:179`).
- [`ops/deployment/argo/tenant-network-policies.yaml`](../../ops/deployment/argo/tenant-network-policies.yaml)
  is the **applied** tenant-a/tenant-b instance. Same hardcoded apiserver IP at `:101` and `:155`.
  Measured structure, reported as structure and not as a claimed breakage: the egress rules allow
  reaching the shared `oshal` namespace, but the ingress rules allow only same-tenant sources — so
  under these policies nothing in `oshal` can open a connection *into* a tenant namespace. The
  file's own header (`:19-22`) records an earlier rendering that proved isolated while silently
  breaking the workload, so this asymmetry is worth an observation rather than an assumption.
  **What is already proven, and must not be re-litigated as an open question:** `:24-25` records
  "Enforcement is REAL here: Docker Desktop's CNI enforces NetworkPolicy (proven 2026-07-08 —
  ADR-078's status note assumed otherwise)", and
  `docs/architecture/078-argo-batch-proveout-status.md:86` heads that finding
  `"Two-tenant network isolation needs a NetworkPolicy-enforcing CNI" — FALSE`, with a control
  (`:93-94`) and a result at `:102` ("**Before:** 2 passed, 5 failed … **After:** 7 passed, 0
  failed"), later 13/13 at `:204`. What remains open is narrower: whether the *remote box's* CNI
  enforces, and the `oshal` → tenant ingress direction — which
  `scripts/governance/verify-tenant-isolation.sh` does not test and says so at `:68-69` (the
  `oshal`/`oshal-model` namespaces do not exist on the cluster that proof ran against).
- [`ops/deployment/argo/argo-executor-rbac.yaml`](../../ops/deployment/argo/argo-executor-rbac.yaml)
  grants `workflowtaskresults` create/patch to the `argo` namespace's default workflow
  ServiceAccount. Read its header before running anything in item 15: `:4-8` records that without
  it "a Workflow's MAIN container runs and succeeds, but the `wait` sidecar fails with exit code 64
  and the Workflow lands in phase `Error` — a confusing failure where the work actually happened.
  Verified on argo-workflows v4.0.7, 2026-07-08." `:10-12` notes per-tenant workflows do not need
  it — `tenant-namespace.example.yaml` already grants the same verbs to the per-tenant SA.
- [`ops/deployment/argo/tenant-workspace-pvc.example.yaml`](../../ops/deployment/argo/tenant-workspace-pvc.example.yaml)
  is the per-tenant shared workspace claim. `:11-13` states the access-mode rule that item 17's
  first question is about: "ReadWriteOnce works on a single-node cluster … A multi-node cluster
  needs RWX-capable storage (NFS/CephFS/EFS) for worker + reviewer pods to share it." `:4-9`
  records why it exists — without it the worker's deliverables die with the pod and a reviewer
  reviews an empty workspace.
- [`ops/deployment/argo/incident-rca-workflowtemplate.yaml`](../../ops/deployment/argo/incident-rca-workflowtemplate.yaml)
  is well-formed (ttlStrategy + podGC, onExit cost recording, per-tenant ServiceAccount, a suspend
  node for approvals) with **two blocking defaults**: `bot-image` is `any-bot:latest` (`:88`), a tag
  no build path produces, and `model-endpoint` is
  `http://ollama.oshal-model.svc.cluster.local:11434` (`:85`) — **no manifest in this repo creates
  an `oshal-model` namespace or Service.**
- `ops/deployment/argo/README.md` contradicts its own directory in three places: `:80-83` says the
  batch entrypoints are "not built yet" (`scripts/bot-node-batch.sh`, `scripts/finalize-incident.sh`,
  `scripts/record-cost.sh` and `src/app/bot-node-batch.ts` all exist — and the batch leg has grown
  a telemetry half since: `src/app/bot-node-batch-telemetry.ts`,
  `src/app/routes/batch-job-telemetry-routes.ts`, `tests/unit/batch-job-telemetry.spec.ts`, which
  `bot-node-batch.ts`'s change-log SEQ 2 describes as shipped); `:86-88` says proving tenant
  isolation "needs a running cluster with a NetworkPolicy-enforcing CNI", which the 2026-07-08
  addendum above disproved as a blocker on Docker Desktop; and `:89-90` says "No Terraform … The
  modules do not exist" (`deploy/terraform` holds six `.tf` files). Its honesty note at `:49-57`
  about RLS not being an isolation leg for batch pods is still accurate and still important.

### 2f. Guards — what would silently pass

This is the part that matters most to someone arriving with a cluster. **There are no automated
gates that contact a cluster.** No step in `.github/workflows/{ci,security,publish-gate}.yml`
deploys to, renders for, or reaches a cluster, and `scripts/ci-local.sh` contains zero Kubernetes
gates (`grep -in "kube\|helm\|k8s\|terraform"` over it returns nothing). The nightly gate is green
on Kubernetes with no cluster contact of any kind — an absent boundary, not a lying one.

One Kubernetes-adjacent posture decision does live in CI, and a cluster-box agent should know it
rather than rediscover it: `ci.yml:306` passes `skip-dirs: /usr/local/bin` to Trivy, justified at
`:292-297` because that directory holds vendored third-party release binaries — "kubectl, helm,
argocd, yq" — whose CVEs are compiled into upstream's builds ("21 of 33 HIGHs were
argocd/kubectl/helm internals with no newer release to bump to"). So the image ships those clients
and the security gate deliberately does not score them.

Two specific traps:

1. **[`scripts/validate-dynamic-bot-manifest.mjs`](../../scripts/validate-dynamic-bot-manifest.mjs)
   degrades silently.** It is cited in three places as the live-boundary closure for the k8s
   launcher (`deploy/helm/oshal/README.md:186`, `docs/adr/129-codeless-k8s-install-path.md:149`,
   `docs/governance/real-boundary-regression-audit.md`). With `kubectl` present and no cluster,
   `reachable` is false (`:30`), it runs `--dry-run=client`, prints
   `WARNING: client-side only` (`:64`), **exits 0**, and skips the `deployments/scale` discovery
   check entirely — `:97-99` is the `else` branch that warns instead of failing. It also has no
   automated caller: grepping `scripts/` and `.github/` for its name returns only its own usage
   comment.
2. **`scripts/evidence/competitive-score-evidence.ts:360`** scores "Kubernetes setup path exists"
   with a `fileExists()` on `scripts/setup-oshal-k8s.sh` — a published number satisfied by a file
   being on disk.

By contrast, `scripts/governance/verify-tenant-isolation.sh` does **not** silently pass: it exits 2
on missing kubectl (`:23`), unreachable cluster (`:24`) and missing pods (`:31`). Its problem is the
opposite — nothing invokes it. Same grep, no callers.

`ops/deployment/argo/*.yaml` and `deploy/terraform/*.tf` have **no validator of any kind** — not
kubeconform, not `kubectl --dry-run`, not `terraform validate`, not a spec. All of those would run
cluster-free.

### 2g. Monitoring does not reach Kubernetes

`ops/monitoring/prometheus.yml` discovers targets only through `docker_sd_configs` against the
Docker API. `grep -rn "kubernetes_sd_configs\|ServiceMonitor\|PodMonitor" ops/ deploy/` returns
nothing. **A chart install is entirely unmonitored.**

### 2h. Kubernetes surfaces inside `src/` — three, not one

The in-cluster launcher is the one everybody finds. Two others exist and both bear on what a
cluster box will see.

- **The launcher (correct, and fail-closed).**
  `src/features/agent-management/services/kubernetes-bot-launcher.ts` uses no Kubernetes client
  library — it `import https` (`:11`) and reads the in-pod ServiceAccount from
  `/var/run/secrets/kubernetes.io/serviceaccount` (`:22`). `package.json` confirms the absence:
  there is no Kubernetes client dependency, only the `k8:*` script names.
  `bot-runtime-launcher-resolver.ts:84` is the fail-closed line.
- **The tool registry ships a `kubernetes` tool family with a kubeconfig auth type.**
  `src/features/tool-registry/services/tool-registry-baseline-tools.ts` registers `kubectl`
  (`:193`, `category: 'kubernetes'` `:196`, `authGroup: 'kubernetes'` `:202`), `helm` (`:262`,
  `authGroup` `:271`) and `argocd` (`:285`, `authGroup` `:294`) as baseline tools; `kubectl`'s
  `usageInstructions` is "Use execute_command with kubectl when cluster credentials are available."
  (`:207`). `src/features/tool-switch/services/switch-framework-service.ts:329` maps
  `kubernetes: ToolAuthType.KUBECONFIG`. **This is a credential-bearing Kubernetes surface**, and
  it is the one that touches section 5's "any cloud credential reaching a bot environment" row: a
  kubeconfig is exactly such a credential. Anything done here has to respect that row, not route
  around it.
- **A persona prompt asserts live `kubectl` and hardcodes three node hostnames.**
  `src/features/swarm-orchestration/services/phase-dispatch-prompts.ts:117` tells the incident
  investigator "You have LIVE access to OpenSearch, Kubernetes (kubectl), Graph API, and the
  PostgreSQL ticket DB"; `:130-138` issue six `kubectl` commands; `:139` reads "kubectl WORKS in
  this container. Real nodes: ip-10-194-224-124, ip-10-194-225-189, ip-10-194-227-35."; and `:140`
  tells the bot that reporting a connection failure without running the command "is hallucination
  — STOP and run the command." `:130` already hedges correctly ("kubectl is LIVE **when a
  kubeconfig is mounted** — discover the cluster, never assume it"), so `:139` contradicts the line
  nine above it. On a cluster-less box this is the one Kubernetes claim in the codebase that is
  false by construction, and `:140` actively punishes the bot for reporting the truth. Fix `:139`
  and the node list with item 9; it needs no cluster.

---

## 3. The work, in order

Ordered so that what unblocks others comes first. Items 2–9 need no cluster and are ordinary repo
work that can be done anywhere, including before the cluster box exists. Item 1 needs no cluster
either, but it is **not** "anywhere": it needs a docker daemon and a release image built from
`origin/main` — see its "where this runs" note. Items 10–17 need the cluster.

Done-when text is quoted from `docs/BACKLOG.md` where an entry exists, cited by entry heading.
Where no backlog entry exists, that is stated and the acceptance test is the sweep's own
measurement — those are proposals, not operator decisions.

**Two backlog entries are cluster-gated but get no item of their own here.** Named so they do not
fall through both this package and the development box's queue:

- `docs/BACKLOG.md:1006` **"Real-boundary regression doctrine"** — `:1021` reads "Every remaining
  row besides those two is deployment-, hardware-, **cluster**- or vendor-token-gated and is dated
  in its own row." This is the parent of the owed audit rows that items 7 and 12 both hang on; its
  done-when ("the audit contains no unresolved local boundary", `:1022`) does not close here, but
  the rows items 7 and 12 touch are its children.
- `docs/BACKLOG.md:2851` **"DevOps cockpit Phase 2+"** — `:2852` includes "discover/override
  Terraform and **Kubernetes contexts**". Nothing in this package builds it, and nothing here
  should: the entry's done-when (`:2853`) is about NATed nodes, topology and brokered credentials,
  and the credential half is governed by section 5's "any cloud credential reaching a bot
  environment" row. Listed so a cluster box does not treat it as newly unblocked.

---

### 1. Settle image and chart reachability, and the image-name mismatch

**Cluster: no.** Unblocks the install proof — but read what it actually blocks before ordering
around it.

**What is and is not blocked.** The **chart** is not blocked: `oshal-install.sh:497` tries the OCI
ref and `:500-509` falls back to the public repo tarball, and the comment at `:493` says the
fallback exists precisely "so a fresh box works even before the operator's first chart publish."
The **image** is blocked: `:523` forces `image.repository=${REGISTRY}/oshal-bot` (`REGISTRY`
defaults to `ghcr.io/emeraldcoastsystemsgroup`, `:55`) with no fallback, so mode 4 needs that GHCR
package to exist and be public. The `helm show chart oci://…` done-when clause below is separately
blocked on the chart publish even though the install is not.

**Do:** publish the runtime image and the OCI chart, flip the GHCR packages public, and resolve
which repository the chart should default to — today they are different names
(`.github/workflows/ci.yml:49` vs `deploy/helm/oshal/values.yaml:24`). The clean option is to point
`values.yaml:24` at what CI publishes. **The other option — "make CI publish what the chart
installs" — runs into a standing rule**: `ci.yml:24` forbids adding `push:`, `schedule:` or
`pull_request:`, `:43-44` is `workflow_dispatch` only, and `scripts/check-workflow-triggers.js`
fails the gate if any workflow regains an automatic trigger. CI can be *renamed* to publish the
right image; it cannot be made to publish *automatically*. A publish therefore stays an operator
action either way.

**Where this runs — NOT just anywhere.** `scripts/publish-images.sh:36-40` refuses unless a
**local** `oshal-bot:latest` carries a commit label equal to `origin/main`, so this needs a docker
daemon, a release image built from `origin/main`, and the operator's GHCR token from `.env`. On a
bare remote box the refusal fires immediately and its remediation line (`:38`) points at
`scripts/oshal-deploy.sh` — **do not follow that line on the development box**: `oshal-deploy.sh:71`
targets `docker-compose.oshal-local.yml` and `:213`/`:243`/`:299` force-recreate the running swarm.
This item belongs wherever the release image is built, under the operator's hand.

**Files:** [`scripts/publish-images.sh`](../../scripts/publish-images.sh),
[`scripts/publish-chart.sh`](../../scripts/publish-chart.sh),
`deploy/helm/oshal/values.yaml:24`, `.github/workflows/ci.yml:43-49`, `:246-253`. The GHCR
visibility flip is a GitHub UI action by an org admin, not a repo change.

**Done-when** (from **"Codeless k8s install — first live-cluster proof (ADR-129)"**, third clause):
> `helm show chart oci://ghcr.io/emeraldcoastsystemsgroup/charts/oshal` succeeds anonymously.

The name mismatch has no backlog entry; the acceptance test is that `helm template` with default
values names an image that `docker pull` can fetch anonymously.

---

### 2. Fix `rbac.botLauncher=false`, and add the guard that would have caught it

**Cluster: no.**

**Do:** make the api's bootstrap path consistent with the documented degrade. Either emit
`BOT_DATABASE_URL` regardless of `rbac.botLauncher`, or stop running the bot-role half of
`provision-app-role.mjs` when the launcher is off. Add a chart spec that renders with
`--set rbac.botLauncher=false` and asserts the api container still has every env its bootstrap
command reads.

**Files:** `deploy/helm/oshal/templates/api.yaml:116`, `:154-168`;
`deploy/helm/oshal/values.yaml:177`, `:362-368`;
`scripts/governance/provision-app-role.mjs:121` (the failing assertion), `:144` (its call site),
`:655` (the env read); a new or extended `tests/unit/chart-*.spec.ts`.

**Done-when:** no backlog entry. Proposed: `helm template … --set rbac.botLauncher=false` renders an
api whose bootstrap command has every variable it dereferences, and a guard goes red when
`BOT_DATABASE_URL` is removed while `OSHAL_APP_ROLE_BOOTSTRAP` stays on. Per CLAUDE.md's
guard-per-fix rule, the guard ships in the same change.

---

### 3. Remove the Vault root token from the chart

**Cluster: no.** This is the Helm half of an already-approved decision, and it is an ordinary file
edit.

**Do:** stop running `server -dev`, stop shipping `devRootToken`, and stop injecting that token into
the api pod. The compose half of the same removal belongs to the development box and is not this
package's work.

**Files:** `deploy/helm/oshal/templates/vault.yaml:29`, `:31-32`;
`deploy/helm/oshal/values.yaml:109-116`; `deploy/helm/oshal/templates/api.yaml:174-179`.

**Done-when** (from **"Production Vault hardening"**):
> a non-local deployment runs without a root token in application config, survives restart/unseal,
> and completes authenticated issue/use/revoke with audit evidence.

That entry's 2026-09-21 decision names the removal target precisely: the root token goes "**in both
places it ships**" — `docker-compose.oshal-local.yml` *and* "the Helm chart, which today runs
`server -dev` (`deploy/helm/oshal/templates/vault.yaml`), sets `devRootToken` (`values.yaml`) and
injects that root token into the api pod (`templates/api.yaml`)". The entry stays open on one clause
only: "the target host or cluster, its TLS certificate source and its backup destination are named
later". **Naming that target is a decision this package can inform but cannot make.**

---

### 4. Move chart secrets out of the ConfigMap and give `oshal_app` a values path

**Cluster: no.**

**Do:** render `JWT_SECRET` and the ArangoDB root credentials into a Secret rather than a ConfigMap,
and add a values override for the `oshal_app` DSN. Note `deploy/helm/oshal/templates/api.yaml:5`
records why `api.envSecret` cannot supply it today — explicit container env beats `envFrom` — so
this needs a template change, not a values change alone.

**Files:** `deploy/helm/oshal/templates/shared-env-configmap.yaml:49`, `:60-61`;
`deploy/helm/oshal/templates/api.yaml:149-152`; `deploy/helm/oshal/templates/bots.yaml:66-74`;
`deploy/helm/oshal/values.yaml`.

**Done-when:** no backlog entry. Proposed: a default render contains no credential value in any
`kind: ConfigMap`, and a render with an `oshal_app` password supplied through values carries that
password rather than `oshal-app-dev`.

---

### 5. Production-readiness baseline on the chart

**Cluster: no** to write; the effect is only observable on a cluster.

**Do:** add `livenessProbe`s, container resource requests/limits on the nine infra workloads that
have none (`oshal-db`, `oshal-redis`, `oshal-chromadb`, `oshal-tsdb`, `oshal-arangodb`,
`oshal-ollama`, `oshal-vault`, `code-server`, `speaker-diarization`), a `securityContext` on the
templates that lack one (all but `diarization.yaml:39`, `relay.yaml:61`, `vault.yaml:37` — and the
image has no `USER`), a `storageClassName` override on every claim, and a pinned tag or digest in
place of `:latest`. Each is a measured absence, listed with its grep or its render in section 2b.
The api and the bots already carry requests and limits; do not re-add them there.

**Files:** every workload template under `deploy/helm/oshal/templates/`, and `values.yaml` for the
new keys.

**Done-when:** no backlog entry. Proposed: rendering under a namespace with a restricted Pod
Security Standard label and a `ResourceQuota` that requires requests produces no pod the admission
controller would refuse. That render is cluster-free; the admission check itself is item 11.

---

### 6. Forward the remaining infra switches through Terraform

**Cluster: no.** Small and mechanical.

**Do:** add `infra.tsdb`, `infra.arangodb`, `infra.vault`, `infra.codeServer` and
`infra.diarization` `inCluster` booleans to the module. Today `main.tf:46-54` sets only
postgres/redis/chromadb, and Helm deep-merges — so a tenant Terraform *refused* to deploy on mock
OIDC still ships dev-mode Vault, the Arango root password in a ConfigMap, and `code-server --auth
none` in the same namespace.

**Files:** `deploy/terraform/main.tf:46-54`, `deploy/terraform/variables.tf`.

**Done-when:** no backlog entry, but the gap is acknowledged at `deploy/helm/oshal/README.md:157-160`:
"the module forwards only the Postgres switch … Moving Timescale or Vault out of the cluster there
needs their switches added to the module first." Proposed: a Terraform plan with those variables set
renders a chart with each service external.

---

### 7. Make the manifest validator fail instead of exiting 0, and wire both governance scripts

**Cluster: no** to fix; the real assertion then needs one.

**Do:** give `scripts/validate-dynamic-bot-manifest.mjs` a mode that treats "no cluster reachable" as
a failure rather than a warning, so it cannot be cited as closure evidence while proving nothing.
Then give it and `scripts/governance/verify-tenant-isolation.sh` a caller — neither has one today.

**Files:** `scripts/validate-dynamic-bot-manifest.mjs:30`, `:53-57`, `:63-65`, `:72-99`;
whatever gate you add them to.

**Done-when:** no backlog entry. `docs/governance/real-boundary-regression-audit.md` records the
owed half against `tests/unit/bot-status-toggle-substrate.spec.ts`: "the live `deployments/scale`
discovery check is due on the next reachable cluster". Proposed: the validator exits non-zero when
asked for a server-side proof it cannot perform, and the audit row's status moves from owed to
green on the cluster run (item 12).

---

### 8. Add a cluster-free validator for the Argo manifests and the Terraform module

**Cluster: no.**

**Do:** run `ops/deployment/argo/*.yaml` through kubeconform or `kubectl apply --dry-run=client`,
and `deploy/terraform` through `terraform fmt -check` and `terraform validate`, in the local gate.
Note `terraform fmt -check -recursive` currently flags `envs/local-kind.tfvars` and `outputs.tf`.
Cover all five Argo manifests, not the three the tenant work touches — `argo-executor-rbac.yaml`
and `tenant-workspace-pvc.example.yaml` are in that directory too.

**Files:** `scripts/ci-local.sh`, `ops/deployment/argo/*.yaml`, and the six
`deploy/terraform/*.tf`: `main.tf`, `variables.tf`, `outputs.tf`, `providers.tf`, `versions.tf` and
`ingress.tf`.

**Done-when:** no backlog entry. Proposed: a malformed edit to any Argo manifest or `.tf` file turns
the gate red.

---

### 9. Reconcile the stale documentation and settle the legacy generation

**Cluster: no.** Do this before the cluster work, so nobody following a doc applies the wrong stack.

**Do:** point the Kubernetes rows in `docs/deployment-models.md:30`, `:108-114`,
`docs/framework-developer-guide.md:80`, `docs/architecture/core-runtime-overview.md:88-93` and
`docs/setup/core-setup.md:95-100` at [`docs/k8/README.md`](./README.md) and ADR-129. Fix
`ops/deployment/README.md` (the absent deploy command at `:71`, the two tabled files that do not
exist at `:14-15`, the ConfigMap and ClusterRole that exist nowhere). Fix every root-relative
`any-bot-k8s/` path in `docs/k8/any-bot-kubernetes-setup.md` (`grep -n "any-bot-k8s/"` that file
and skip the `oshal-any-bot-k8s-*` product names) — the workspace is at `ops/any-bot-k8s/`, and the
script's own usage line (`scripts/setup-any-bot-k8s.sh:53`) already has the right path. Fix
`ops/deployment/argo/README.md:79-85`, `:86-88` and `:89-90`. Decide whether the legacy generation
is deleted or explicitly quarantined — and remember from section 2d that the decision has to cover
`package.json:17` (a published `bin`) and `package.json:96-103` (eight `k8:*` scripts), not docs
alone.

**Also on this item, and higher-traffic than anything above:**

- `docs/README.md:71` — the canonical docs index routes the Kubernetes row at `docs/k8/README.md`
  (correct) but annotates it "(the manifests themselves live in `ops/any-bot-k8s/`)", which points
  at the legacy workspace rather than `deploy/helm/oshal`.
- `docs/README.md:55-85` — the topic-folder table has **no `kubernetes/` row**, so this folder is
  unindexed from the canonical guide. CLAUDE.md requires new documentation to get "a topic folder
  under `docs/` … and an entry in that folder's `README.md`". Note that the done-when below cannot
  catch this: `node scripts/docs-link-check.js` is already clean, because a missing row is not a
  broken link.
- `src/features/swarm-orchestration/services/phase-dispatch-prompts.ts:139` — "kubectl WORKS in
  this container. Real nodes: ip-10-194-224-124, ip-10-194-225-189, ip-10-194-227-35." Contradicts
  the correctly hedged `:130` nine lines above and is false on any box without a mounted
  kubeconfig. Section 2h has the full shape.

Two documentation inconsistencies to resolve as part of this:

- `docs/adr/035-multi-tenant-saas-foundation.md:3` still reads "Status: **Proposed** … no tenant
  provisioning script exists", while the 2026-09-21 decision under **"Two-tier tenant
  provisioning"** says "ADR-035 is amended and ACCEPTED on that basis". The ADR file was never
  touched. *(The "no provisioning script exists" half is still true: no `provision-tenant` path is
  tracked.)*
- `docs/adr/129-codeless-k8s-install-path.md:162-164` says the cockpit enable/disable toggle "still
  constructs the compose pair directly, so on k8s that toggle is inert" and points at BACKLOG. That
  was fixed — `src/app/routes/agent-status-routes.ts` and
  `src/features/agent-management/services/kubernetes-bot-launcher.ts` (which gained `setRunning` via
  the scale subresource) — and no matching BACKLOG entry exists. The caveat outlived its defect.
- The **"k8s shared-service tier"** entry says "chart 0.3.0"; `deploy/helm/oshal/Chart.yaml:23`
  reads `version: 0.4.0`.

**Done-when:** no backlog entry. Proposed: `node scripts/docs-link-check.js` stays clean, and no doc
in `docs/` routes a reader to `oshal-api-server:latest` as a current path.

---

### 10. Stand up the cluster and run the codeless install end to end

**Cluster: YES.** This is the headline proof and the gate for everything after it.

**Do:** on the remote box, run `bash scripts/oshal-install.sh --mode 4 --admin-email …` (or
`scripts/oshal-install.ps1 -Kubernetes`) with only kubectl, helm and the installer present.

**Files:** `scripts/oshal-install.sh:363-600`, `scripts/oshal-install.ps1:169-340`,
`deploy/helm/oshal/**`. On the Terraform path the NodePort the done-when names comes from
`deploy/terraform/ingress.tf:14-16` (the `oshal-api-nodeport` Service, rendered when
`var.nodeport > 0`); its comment at `:8-13` records that Windows Docker Desktop node ports are not
host-reachable directly and gives the socat bridge that makes them so.

**Done-when** (from **"Codeless k8s install — first live-cluster proof (ADR-129)"**):
> a fresh box reaches `/welcome` in a browser via the NodePort with only kubectl+helm+the installer
> present, a model connects through the wizard and a jarvis turn answers, and
> `helm show chart oci://ghcr.io/emeraldcoastsystemsgroup/charts/oshal` succeeds anonymously.

---

### 11. Prove the shared-service tier

**Cluster: YES.** Every clause of its done-when is prefixed "on a real cluster".

**Do:** exercise the five behaviours the tier restores.

**Files:** `deploy/helm/oshal/templates/{tsdb,arangodb,vault,code-server,diarization,ollama}.yaml`,
`deploy/helm/oshal/templates/api.yaml:56-91` (the store-package initContainer).

**Done-when** (from **"k8s shared-service tier — live proof of the features it restores (ADR-129
amendment)"**):
> on a real cluster — a staged store package serves its surface and survives an api pod restart; a
> trading query returns series from the in-cluster tsdb; `/api/graph` answers instead of 503; a
> transcription round-trips through the diarization Service; and
> `helm upgrade --set infra.arangodb.inCluster=false` degrades the graph cleanly (null connector, no
> connection-refused) rather than erroring.

---

### 12. Close the bot-launcher live boundary

**Cluster: YES.**

**Do:** run `scripts/validate-dynamic-bot-manifest.mjs` against the real API server (server-side
dry-run plus the `deployments/scale` discovery check), then exercise the cockpit enable/disable
toggle against a real Deployment.

**Files:** `scripts/validate-dynamic-bot-manifest.mjs:72-99`,
`src/features/agent-management/services/kubernetes-bot-launcher.ts`,
`docs/governance/real-boundary-regression-audit.md` (the row to update).

**Done-when:** no backlog entry. The audit's own owed line is the criterion: "the live
`deployments/scale` discovery check is due on the next reachable cluster". Record the result in the
audit row rather than in prose.

---

### 13. Render a tenant and run the NetworkPolicy isolation assertion

**Cluster: YES** for this half only. The database/row half of the same proof runs on the
development box (section 4).

**Do:** substitute the real apiserver endpoint for the hardcoded Docker-Desktop IP, supply a real
per-tenant `DATABASE_URL` from a sealed-secrets or external-secrets source, apply two tenants, and
run the assertion.

**Files:** `ops/deployment/argo/tenant-namespace.example.yaml:126`, `:179`;
`ops/deployment/argo/tenant-network-policies.yaml:101`, `:155`;
`scripts/governance/verify-tenant-isolation.sh`.

**Done-when** (from **"Two-tier tenant provisioning"**, namespace half):
> `provision-tenant.sh <name> --tenancy=isolated|shared` renders the correct namespace/database
> policy and a two-tenant proof blocks cross-tenant database and row access.

The 2026-09-21 decision narrows this to `--tenancy=isolated` only and states that the script "ships
one tenancy … and the flag keeps its name so a second value can be added later without changing the
interface". It also states the current script's limit precisely: "`scripts/governance/verify-tenant-isolation.sh`
today checks only Kubernetes NetworkPolicy between two example namespaces (90 lines, no SQL)".
Measured and confirmed: the file is 90 lines and asserts NetworkPolicy objects at `:55-61`.

---

### 14. Configure the Vault Kubernetes secrets engine

**Cluster: YES**, and sequenced after item 3.

**Do:** configure the Kubernetes secrets engine with a service account and a least-privilege role,
then prove the credential lifecycle.

**Files:** `src/features/devops-vault/services/vault-console-service.ts` — `:172-175` is the
engine-agnostic `issue()` with its `{engine, role}` dynamic-secret branch, and `:206-235` is
`setupDb`, the wired PostgreSQL engine mount. Both verified against the tree. Plus Vault
configuration on the cluster.

**Done-when** (from **"Vault cloud secrets engines"**):
> the role issues a short-TTL credential, a real read succeeds, revocation makes reuse fail, and no
> standing cloud key is stored by a bot.

The 2026-09-21 decision splits this deliberately: the **Kubernetes** engine is this box's work; the
same lifecycle proof against the already-wired **PostgreSQL** engine happens on the development box,
and is sequenced after "Production Vault hardening" "because evidence gathered against a `-dev`
Vault with a known root token proves little".

---

### 15. Argo execution and promotion — blocked, read before starting

**Cluster: YES**, and **blocked on three separate things.** Do not start this expecting it to close.

**Do (eventually):** add the missing `oshal-model` Service, make `QueueManagerService` submit
Workflows, run one real incident-RCA ticket in cluster, and wire the `dev -> main -> Argo CD`
promotion.

**Files:** `ops/deployment/argo/incident-rca-workflowtemplate.yaml:85`, `:88`;
`src/features/swarm-orchestration/services/queue-manager-service.ts`; Argo CD Application manifests
that do not yet exist anywhere in `ops/` or `deploy/`.

**Done-when** (from **"Argo ticket execution and promotion"**):
> the ticket completes in an isolated Workflow with cost/output evidence and the promoted revision
> syncs automatically without local batch execution.

**The three blocks, measured:**

1. The WorkflowTemplate's `model-endpoint` points at an `oshal-model` Service that no manifest
   creates. Adding it is one clause of **"All-local Ollama profile"**, whose done-when is: "Compose
   and Kubernetes both resolve the local endpoint and evidence records a successful ticket,
   latency/throughput, and zero available cloud credentials."
2. That entry's *other* clause — "register a Cline-harness Ollama bot" — is refused outright by the
   platform's fail-closed posture (`src/app/bot-node-execution-handler.ts` refuses cline as an
   unbrokered autonomous CLI). **So the entry as written cannot close today by either route.** This
   needs a design decision, not an afternoon.
3. Making `QueueManagerService` a Workflow submitter is a core change. CLAUDE.md's scope rule
   ("The core is load-bearing and should almost never be touched … If a fix genuinely needs core,
   say so and get approval first") applies — get operator approval before writing it.

`bot-image: any-bot:latest` (`:88`) is a fourth, smaller problem: `scripts/oshal-deploy.sh:73`
builds `oshal-bot:latest`. Fix the default as part of item 9 or here.

---

### 16. Decide whether Kubernetes is a supported deployment class for the ADR-119 health signal

**Cluster: no** to decide and template; **yes** for the kill drill.

**Do:** decide the question, then — if yes — template Prometheus/Alertmanager config or a
ServiceMonitor into the chart, keyed on the same `oshal.tier` label the compose discovery uses.

**Files:** `ops/monitoring/prometheus.yml`, `ops/monitoring/alert-rules.yml`, new chart templates.

**Done-when** (from **"Container-health collection without cAdvisor names"**):
> killing a real OSHAL container triggers the ADR-119 signal on **every supported deployment class**.

The measured gap: `deploy/helm` carries no Prometheus or alert config, so if Kubernetes counts as a
supported class it has no ADR-119 signal at all. The only kill drill on record ran on the
development box.

---

### 17. Settle the two structural questions only a cluster can answer

**Cluster: YES.**

- **Does the multi-node local-kind profile strand the workspace claim?**
  `deploy/terraform/local-kind/cluster.yaml:9-12` declares one control-plane and two workers, while
  `deploy/helm/oshal/templates/workspace-pvc.yaml:5` states ReadWriteOnce is safe only on a
  single-node target. `deploy/terraform/envs/local-kind.tfvars` then deploys two pods that both
  mount it. `ops/deployment/argo/tenant-workspace-pvc.example.yaml:11-13` states the same rule for
  the tenant workspace: RWO works on one node, multi-node needs RWX storage. What the scheduler
  does with two pods and one RWO claim is a property of the cluster's provisioner, and this
  document makes no prediction about it. **Observe it, don't predict it** — record the binding mode
  the cluster actually reports (`kubectl get storageclass -o wide`) alongside the result. Note that
  the same tfvars file pins `image_tag = "coldstart"` with `image_pull_policy = "Never"` (`:14-20`)
  — a machine-local tag that exists only where someone `kind load`ed it, so this profile is
  unusable on a fresh clone as written.
- **Does the remote box's CNI enforce NetworkPolicy, and does the `oshal` → tenant ingress
  direction behave as intended?** Scope this narrowly: *whether NetworkPolicy can be enforced at
  all* is already answered on record — `tenant-network-policies.yaml:24-25` and
  `078-argo-batch-proveout-status.md:86` (with the control at `:93-94`, 7/0 at `:102`, 13/13 at
  `:204`) settle it for Docker Desktop's CNI. What is genuinely open is (a) the same result on
  whatever CNI this cluster runs, and (b) the ingress/egress asymmetry in section 2e, which
  `verify-tenant-isolation.sh` does not cover and says so at `:68-69`. Do not re-run the settled
  half as if it were unknown; do record which CNI produced (a).

---

## 4. What must be proven on the cluster

Each proof: the command, and what output means pass.

### 4.1 First live install (item 10)

```bash
bash scripts/oshal-install.sh --mode 4 --admin-email you@example.com
```

**Pass:** the installer exits 0; a browser on the node network reaches `/welcome` through the
NodePort; the wizard connects a model; a jarvis turn answers.

```bash
helm show chart oci://ghcr.io/emeraldcoastsystemsgroup/charts/oshal
```

**Pass:** succeeds with **no `helm registry login`** — anonymous is the point. A 401 or 404 means
the GHCR visibility flip has not happened.

### 4.2 Shared-service tier (item 11)

Five separate observations, from **"k8s shared-service tier"**:

| Observation | Pass |
|---|---|
| Stage a store package, then `kubectl delete pod` the api | the surface serves before and after the restart |
| Run a trading query | series come back from the in-cluster tsdb |
| `GET /api/graph` | answers; **503 is fail** (503 is the no-ArangoDB state) |
| Submit a transcription | round-trips through the diarization Service |
| `helm upgrade --set infra.arangodb.inCluster=false` | the graph degrades cleanly — null connector, **not** connection-refused |

### 4.3 The bot-launcher boundary (item 12)

```bash
node scripts/validate-dynamic-bot-manifest.mjs --namespace oshal --context <ctx>
```

**Pass:** the output says `dry-run mode: server (validated by the real API server; nothing created)`
**and** `OK: the API server exposes deployments/scale with verbs [...]`.

**Fail, and this is the trap:** `dry-run mode: client` followed by
`WARNING: client-side only` and `WARNING: no cluster reachable`. The script **exits 0** in that
state (`:64`, `:97-99`). A zero exit code is not the pass signal here — the two `server` lines are.

### 4.4 Two-tenant isolation — both halves, and where each runs

This proof was **split by the operator on 2026-09-21**, and the split is the important part.

**The database and row half does NOT run here.** The decision under **"Two-tier tenant
provisioning"** states that `scripts/governance/verify-tenant-isolation.sh` "today checks only
Kubernetes NetworkPolicy between two example namespaces (90 lines, no SQL), so the new proof has to
attempt a cross-tenant **database** connection and a cross-tenant **row** read and show both
refused." Both are refusable on a disposable PostgreSQL, so that half is **agent-actionable on the
development box with no cluster** and is not this package's work. Expect it to be done there.

**The NetworkPolicy half runs here** (item 13):

```bash
bash scripts/governance/verify-tenant-isolation.sh
```

**Pass:** exit 0 with the same-namespace control passing, both cross-tenant directions denied, both
`default-deny-all` and `allow-same-tenant` present in each namespace, and the egress grants
asserted.
**Not a pass:** exit 2. That means kubectl is missing (`:23`), no cluster is reachable (`:24`), or
the `app=web` pods are absent (`:31`) — a refusal, not a failure, and not evidence of anything.

Combined, the two halves satisfy the entry's done-when: "a two-tenant proof blocks cross-tenant
database and row access."

### 4.5 Vault Kubernetes secrets engine — issue, use, revoke (item 14)

Three observations against the hardened Vault (item 3 first):

1. **Issue** — the least-privilege role issues a credential with a short TTL.
2. **Use** — a real read against the cluster succeeds with that credential.
3. **Revoke** — after revocation, reusing the same credential **fails**.

**Pass:** all three, plus no standing cloud key stored by any bot. That is the done-when of **"Vault
cloud secrets engines"** verbatim. Evidence gathered against a `-dev` Vault does not count — the
entry's decision says so directly.

### 4.6 Structural questions (item 17)

- **Multi-node workspace:** deploy two workspace-mounting pods on the multi-node kind profile.
  Record what the scheduler actually did — `kubectl get pod -o wide` plus any `Pending` pod's
  events, and the StorageClass's volume binding mode. A `Pending` pod with a volume-node-affinity
  conflict confirms the chart's RWO warning; both `Running` on one node does not disprove it, it
  just means placement happened to agree.
- **NetworkPolicy enforcement:** the item 13 run *is* this proof for **this** cluster's CNI. Record
  which CNI — that is the whole new information, because enforcement itself is already on record
  for Docker Desktop (`078-argo-batch-proveout-status.md:86`, `:102`, `:204`). The `oshal` → tenant
  ingress direction is **not** covered by that run; `verify-tenant-isolation.sh:68-69` says why. If
  you want it, stand up a pod in an `oshal` namespace and try to reach a tenant pod, and report
  that as its own observation.

### 4.7 ADR-119 kill drill (item 16, if Kubernetes is a supported class)

Kill a real oshal pod. **Pass:** the ADR-119 signal fires. There is nothing to fire from today —
the chart ships no monitoring, so this proof depends on item 16's templating work.

---

## 5. Explicitly out of scope

Each with its reason. Do not build these; do not propose them as improvements.

| Out of scope | Reason |
|---|---|
| **The shared-database tenant tier** | Operator decision 2026-09-21 under **"Two-tier tenant provisioning"**: "**ISOLATED-ONLY.** ADR-035 is amended and ACCEPTED on that basis; the shared tier is recorded as a future option with a trigger, not built." The trigger is named: "a real customer whose economics require sharing one database". Until then an isolated database per tenant is both the cheaper build and the stronger boundary. |
| **The tenant-scoped Postgres service identity (ADR-076)** | The same decision: "What this decision explicitly does NOT approve: the tenant-scoped Postgres service identity that would replace the operator-equivalent system context… That is a core DB-role change, it is required only by the shared tier, and the shared tier has no customer." |
| **Cloud-KMS auto-unseal** | Operator decision 2026-09-21 under **"Production Vault hardening"**: "**Unseal custody: Shamir, shares held by the operator**, not cloud-KMS auto-unseal — no cloud account and no cloud credential in the api environment." The accepted consequence, which belongs in the runbook rather than being discovered: after any restart the hardened Vault is SEALED until the operator unseals it by hand. |
| **The AWS STS secrets engine** | Decision under **"Vault cloud secrets engines"**: "The AWS STS engine is not adopted: no AWS account exists in this project's footprint, and the operator's custody preference is self-hosted." |
| **Any cloud credential reaching a bot environment** | Standing operator directive. The done-when of "Vault cloud secrets engines" encodes it: "no standing cloud key is stored by a bot." **A kubeconfig is such a credential**, and the tool registry already declares the surface that would carry one (`switch-framework-service.ts:329` maps `kubernetes: ToolAuthType.KUBECONFIG`; section 2h). Wiring cluster credentials into a bot environment to make item 12 or 15 easier is the thing this row forbids. |
| **HPA / autoscaling / "elastic scale"** | No HPA template exists in the chart, and ADR-129:203-205 states the workspace PVC is RWO so single-node clusters are the supported default. Public-facing copy in `docs/OSHAL-WHITEPAPER.md:189` claims "Kubernetes for elastic scale" with nothing behind it — that is a copy defect to fix in item 9, not a feature to build here. |
| **The legacy Kubernetes generation as a deploy target** | `ops/deployment/kubernetes/oshal-stack.yaml` and `ops/any-bot-k8s/` both run `oshal-api-server:latest`, a tag nothing in this repo builds. ADR-129 made `deploy/helm/oshal` the install source. Item 9 decides delete-or-quarantine; do not invest in them. |
| **Argo CD promotion and the Workflow submitter, as an afternoon's work** | Three measured blocks (item 15): the missing `oshal-model` Service, the cline fail-closed posture refusing the registered-bot clause, and a core `QueueManagerService` change that needs operator approval first. |
| **Application code and store packages** | CLAUDE.md Rule 0c. Applications ship from the store repo; there must be zero `oshal-app.yaml` tracked in this repo. `swarm-apps/*.yaml` is a fixed set of kernel-resident manifests, and widening it is an ADR-level decision. |
| **Anything on the development box** | Section 1. |

---

## 6. Coordination

- **Claim this work in `COLLABORATE.md` on the machine doing it.** That file is deliberately
  untracked (`.gitignore:265`) — it is local to a working directory and does not merge through git.
  The development box has its own separate copy; posting there does not tell anyone here, and
  posting here does not tell anyone there. Claim narrowly, release when done, read the thread before
  you start.
- **Changes still land through this repo's normal flow.** Branch → commit → push → open a PR →
  merge, per CLAUDE.md Rule 0. One active development branch per repo at a time: `git fetch origin
  && git branch -r` and check open PRs before minting a second. Never commit directly to `main`.
- **The publish gate is the wall.** `scripts/publish-gate.sh` runs fail-closed on every push. Never
  bypass it, and never "fix" a hit by narrowing a pattern to the file that tripped it — gate on the
  identifier, not on where it has appeared. This is a public-track repo; there is no sanitizer
  between a commit and the world.
- **Guard-per-fix applies.** Every bug fixed here ships its regression guard in the same change, and
  a guard must cross the boundary whose failure it claims to prevent. A chart render is not evidence
  about admission; a client-side dry-run is not evidence about an API server. Record scoped doubles
  and their real companion in
  [`docs/governance/real-boundary-regression-audit.md`](../governance/real-boundary-regression-audit.md).
- **Report what you measured.** If a proof did not run, say it did not run. `docs/architecture/078-argo-batch-proveout-status.md`
  is the model for this — it separates "Proven locally", "Needs a live cluster (not proven here)"
  and "Absent (not built)", and it retracts its own earlier premises where they turned out wrong.
  Note that its Terraform line is now stale: its `:188` says `**/*.tf → none`, and `deploy/terraform` holds
  six `.tf` files.

---

## Reference

- [ADR-129 — The codeless Kubernetes install path](../adr/129-codeless-k8s-install-path.md) — Accepted (2026-08-13). The live decision.
- [ADR-078 — Kubernetes migration, Argo batch-job orchestration, and multi-tenant proof-out](../adr/078-kubernetes-argo-batch-and-multi-tenant-proofout.md) — still **Proposed**.
- [ADR-035 — Multi-Tenant SaaS Foundation](../adr/035-multi-tenant-saas-foundation.md) — file still reads Proposed; see item 9.
- [ADR-076 — Tenant-aware RLS and least-privilege DB role](../adr/076-tenant-aware-rls-and-least-privilege-db-role.md)
- [ADR-040 — DevOps Vault swarm](../adr/040-devops-vault-swarm.md)
- [ADR-013 — Headscale self-hosted overlay network](../adr/013-headscale-self-hosted-overlay-network.md) — native Kubernetes networking stays the default inside the cluster; the overlay is for external nodes only.
- [ADR-014 — any-bot Kubernetes deployment with a Headscale-compatible gateway](../adr/014-any-bot-k8s-headscale-gateway.md) — the legacy workspace; the ADR does not say "legacy", `docs/k8/README.md` does.
- [docs/k8/README.md](./README.md) — the accurate operating index for the current path.
- [docs/architecture/deployment-runtime-topology.md](../architecture/deployment-runtime-topology.md) — the reconciled topology doc.
- [docs/architecture/078-argo-batch-proveout-status.md](../architecture/078-argo-batch-proveout-status.md) — the honest as-built ledger for the Argo work.
- [deploy/helm/oshal/README.md](../../deploy/helm/oshal/README.md) — chart reference and the durability boundary.
- [deploy/terraform/README.md](../../deploy/terraform/README.md) — the multi-user tenant path. Note `:73-75` carries a "production runs on k8s" decision statement that no ADR reflects and that has not happened.
- [docs/backlog/triage-2026-09-15.md](../backlog/triage-2026-09-15.md) — per-entry evidence for most of section 3.
- [docs/backlog/hardening.md](../backlog/hardening.md) — item 15 is the Headscale ACL application; its Kubernetes connection is provenance only (the policy file is the Docker/Kubernetes source, and ADR-014 is the k8s gateway). Steps (a)–(d) are node tagging and policy application on the existing docker fleet and need no cluster. Runbook: [headscale-acl-hardening.md](../runbooks/headscale-acl-hardening.md).
