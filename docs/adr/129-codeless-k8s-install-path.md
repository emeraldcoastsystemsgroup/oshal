# ADR-129: The codeless Kubernetes install path

**Status:** Accepted (2026-08-13)

## Context

Kubernetes was a first-class hosting environment on paper and an impossible one in
practice. `oshal-install.sh --mode 4` printed clone-and-terraform instructions
instead of installing anything, and the Helm chart those instructions depended on
never made the ADR-115 trunk cutover — it lived only in the private archive, so
both tfvars shipped `chart_path = "CHANGE-ME"` and a fresh clone of the public
repo could not deploy to k8s at all. The images were already public on GHCR; the
chart was the missing half. The operator's requirement for a fresh-machine
install: k8s hosting, **no source checkout, no build, pull only from the
registry** — the same contract mode 1 already honors for compose.

The stranded chart (0.1.5) had also drifted behind three landed platform changes:
the codex fleet floor (ADR-128), the 2026-08-12 seeding repair (compose no longer
force-copies the config seed over runtime config), and K5 (bots connect as the
least-privilege `oshal_bot` role, never the superuser). And its defaults were
Kyma-shaped: APIRule and the tailnet relay rendered unconditionally, which fails
the entire install on any generic cluster (no APIRule CRD, no headscale, possibly
no NET_ADMIN).

## Decision

1. **The chart lives in the trunk at [deploy/helm/oshal](../../deploy/helm/oshal/)**
   as version 0.2.0 — the single source of k8s workload truth. Public-cut changes:
   registry-pull defaults (`ghcr.io/emeraldcoastsystemsgroup/oshal-bot`), Kyma
   APIRule + relay flipped to **opt-in**, an `api.service.type`/`nodePort` knob for
   ingress-less cockpit access, and parity fixes for the three drifts above.
2. **Fleet lists are generated, never hand-typed.**
   [scripts/generate-chart-fleet.mjs](../../scripts/generate-chart-fleet.mjs)
   derives `fleets.kernel`/`fleets.full` from `docker-compose.oshal-local.yml`
   (the reference deployment) into a marker-fenced block; exclusions are logged,
   not silent — docker-socket bots (no daemon in a pod) and compose-profile
   services (a default `up` never started them either). `fleet: custom` renders
   exactly the `bots:` list; presets render preset + extras, deduped, preset wins.
   Guard: [tests/unit/chart-fleet-parity.spec.ts](../../tests/unit/chart-fleet-parity.spec.ts).
3. **The installer is the codeless path.** `oshal-install.sh --mode 4` and
   `oshal-install.ps1 -Kubernetes` preflight kubectl/helm, detect (or, bash-side,
   offer to create) a cluster — refusing to create kind beside a running compose
   swarm, the 2026-07-18 OOM pairing — resolve the chart from the **published OCI
   package first** with a download-then-extract repo fallback, wire the same
   `--admin-email` → `MOCK_OIDC_EMAIL/NAME/SUB` + `OSHAL_OPERATOR_EMAILS` identity
   as mode 1 (shared `local_sub`/`LocalSub`), install with `--wait`, expose via
   NodePort, poll `/api/health`, and open `/welcome`.
4. **Chart publishing is operator-triggered.**
   [scripts/publish-chart.sh](../../scripts/publish-chart.sh) pushes
   `oci://ghcr.io/emeraldcoastsystemsgroup/charts/oshal`, refuses to package a
   chart dir that differs from `origin/main` (publish what landed), and prints the
   one-time GHCR visibility flip. Until that first publish, installers work via
   the repo fallback — fetching the chart files is not a source build.
5. **Terraform keeps the multi-user tenant.** `deploy/terraform` now defaults
   `chart_path` to the in-repo chart and passes a `fleet` variable (default
   `custom`, preserving 0.1.x semantics for existing tfvars). Its OIDC/secret
   posture guards remain the reason multi-user tenants go through it; the
   installer path is the single-box swarm.
6. **How bots get a brain on k8s (single-box answer).** There are no vendor-CLI
   OAuth mounts on a cluster. The default is the `/welcome` wizard's hosted/BYO
   connection (browser-side, per-user, zero secrets in values); fleet-wide vendor
   API keys can live in the optional `oshal-bot-env` Secret; `--no-ai` records the
   explicit no-model posture. This closes the "bot LLM auth on k8s: UNDECIDED"
   item for the single-user shape — the multi-user BYOK-per-login story stays open.

## Amendment (2026-08-13, same day): the shared-service tier ships

The first cut listed "store staging is compose-only" and "tsdb/Arango/Vault/
code-server aren't chart-templated" as accepted caps. The operator rejected both,
correctly, and the check is one line of compose: **none of
`oshal-tsdb`, `oshal-arangodb`, `oshal-vault`, `code-server`, or
`speaker-diarization` carries a `profiles:` key**, so every default
`docker compose up` starts them. They are core framework, not extras — omitting
them shipped a k8s install that looked healthy while trading had no series store,
`/api/graph` 503'd, there was no vault, no workspace IDE, and no local
transcription. "Not templated yet" was under-building described as a boundary.

Chart 0.3.0 closes both:

7. **The shared-service tier is templated** — all five, each behind
   `infra.<name>.inCluster`, defaulting **on** (matching a default compose `up`).
   Ollama is templated too but defaults **off**, because compose gates it behind
   the `local-llm` profile. Critically, each service's **URL env is wired and
   gated on the same flag** (`TSDB_URL`, `ARANGO_*` in the shared bot env,
   `VAULT_ADDR`/`TOKEN`, `SPEAKER_DIARIZATION_URL`, `OLLAMA_HOST`): a StatefulSet
   nothing points at is a no-op, and advertising a URL for a service that was
   switched off converts a clean degrade (ADR-045's null connector) into
   connection-refused on every call.
8. **Store packages stage via an api initContainer** into the workspace PVC the
   chart already mounts, so `--apps`/bundles work on k8s. It runs before the api
   container because auto-load registers a package's bots and surfaces once, at
   boot; it is idempotent in compatible mode and **fatal** on failure — booting
   without an app the operator asked for is precisely the silent-cap failure this
   amendment exists to remove.

Two security decisions came out of doing it properly rather than fast:
**code-server is ClusterIP-only** (it runs `--auth none` over a read-write shared
workspace; compose contains that by binding `127.0.0.1`, and the cluster
equivalent is a port-forward — a NodePort default would have published an
unauthenticated IDE with full workspace access), and **Vault ships dev-mode with
no PVC**, so it cannot imply durability it does not have.

Guard: [tests/unit/chart-infra-parity.spec.ts](../../tests/unit/chart-infra-parity.spec.ts)
derives the shared-service set **from compose**, so a future profile-less infra
service that nobody templates goes red. It was mutation-tested nine ways; the
first version had two holes worth recording, both classic: `TSDB_URL` matched
`TSDB_URL_DISABLED` (substring, not exact key), and deleting the entire tsdb
workload still passed because a sibling template referenced the same values flag.
A guard that cannot go red is not a guard.

## Amendment 2 (2026-08-13): apps bring their bots, on any substrate

Amendment 1 made an installed app's *files* arrive on a cluster. It did not make
its *bots* run, and the operator named the consequence: that defeats the purpose
of the app model. The gap was not in the chart — it was in the platform.

`AgentFactoryService.deployWithContainer` / `createAndStartAgent` — the path an
app package, the Bot Forge, and the cockpit's create-and-start all use — was
hard-wired to Docker: `DynamicComposeService` writes a compose overlay and
`BotContainerSpawnerService` shells `docker compose up -d`. Inside a pod there is
no compose file and no docker socket, so on Kubernetes the launch could only fail
and roll the creation back. Suggesting operators pre-list an app's bot in Helm
values (or install the whole fleet) was a static workaround for a dynamic model.

9. **Bot launching gets a substrate seam.** `BotRuntimeLauncher` is what the
   factory talks to. `ComposeBotRuntimeLauncher` preserves the existing behavior
   exactly (overlay, then `up -d`); `KubernetesBotRuntimeLauncher` creates a
   Deployment + Service in the controller's own namespace via the in-cluster
   ServiceAccount — raw HTTPS against the API, because the surface is three verbs
   on two resource types and a client library is a large dependency for that. The
   workload it renders is the chart's bot shape, so a dynamically-launched bot and
   a chart-declared one are indistinguishable at runtime; it is labelled
   `oshal.io/dynamic` so Helm never adopts or deletes it. Substrate is detected
   from `KUBERNETES_SERVICE_HOST` (kubelet-injected), not a config flag someone
   can set wrong.

Security decisions, because this is the controller creating workloads:

- **The image is always the platform image** from `OSHAL_BOT_IMAGE`, never
  caller-supplied. `BotLaunchSpec` has no image field at all — otherwise "create
  an agent" becomes "run an arbitrary container in my namespace", which given the
  known injection surface is not theoretical.
- **RBAC is a namespace-scoped Role**, never a ClusterRole: Deployments and
  Services in the tenant's own namespace, plus read-only pods for status. No
  secrets, no nodes, no RBAC objects. `rbac.botLauncher: false` withholds it and
  degrades to persona-only agents.
- **Names are DNS-1123-validated** before they reach an API path.

Proof beyond assertions: `scripts/validate-dynamic-bot-manifest.mjs` renders the
exact manifest the launcher POSTs and pushes it through
`kubectl apply --dry-run=server`, so the **real API server** admits it (creating
nothing) rather than a mock agreeing with itself — the real-boundary rule. Run
2026-08-13 against a live cluster: both objects admitted.

The refactor also exposed a live defect in the *compose* path, caught by the
existing create-and-start guard: rollback awaited `stopBot(...).catch()`, so a
spawner whose stop threw skipped the overlay cleanup entirely and left a dynamic
compose entry behind for a deleted agent — on the rollback path, where the
container usually does not exist, which is exactly when it fires. Fixed, with a
regression case.

Out of scope, logged in BACKLOG rather than half-done: the cockpit's
enable/disable **toggle** (`agent-status-routes`) still constructs the compose
pair directly, so on k8s that toggle is inert.

## Amendment 3 (2026-08-14): the installer owns its prerequisites

Mode 4 still assumed `kubectl`, `helm`, and a cluster already existed, and exited
with a link when they didn't. "Codeless" that requires three manual installs first
is a handoff wearing an installer's name.

10. **Prerequisites are installed, not linked.** kubectl and helm come from their
    official sources into `/usr/local/bin` when writable, else `~/.local/bin` —
    never a silent `sudo`. When no cluster is reachable the installer stands one
    up: **k3s** on Linux (native, no Docker in the path, survives reboot, and
    NodePorts land straight on the host — the right answer for a server) or
    **kind** wherever Docker runs. Windows does the same through winget
    (`Kubernetes.kubectl`, `Helm.Helm`, `Kubernetes.kind`, `Docker.DockerDesktop`)
    and re-reads `PATH` from the registry after each install so the run continues
    instead of demanding a new terminal.

Two invariants make this safe to `curl | bash`: **every system-touching step asks
first**, and a non-interactive shell **declines** rather than surprise-installing
(`--yes` / `-Yes` consents up front for unattended runs). The kind-beside-a-running-
compose-swarm refusal stays. Docker Desktop's Kubernetes toggle is a GUI setting
the installer deliberately does not poke at — kind gives the same result
scriptably on the engine already present.

Guard: [tests/unit/k8s-installer-prereqs.spec.ts](../../tests/unit/k8s-installer-prereqs.spec.ts)
**runs the real script** with a minimal PATH and no tty and asserts it exits
non-zero, names the missing tool, and leaves the sandboxed HOME empty — the
safety property is behavioral, so grepping the source would not have proven it.
Mutation-tested five ways; the one that matters (making the non-interactive branch
consent) turns the behavioral test red by actually downloading a binary.

## Consequences

- A fresh machine goes from zero to a browser-ready swarm with two commands and
  registry pulls only; `helm install oci://…` becomes a one-liner once the
  operator publishes the chart.
- Compose remains the reference deployment; the generator + guard make the chart
  follow it instead of drifting (the counts rule, applied to a fleet).
- Remaining caps, tracked in BACKLOG: the workspace PVC is RWO, so single-node
  clusters are the supported default and multi-node needs an RWX StorageClass;
  the in-cluster tier ships dev-parity credentials, single replicas, and no
  backup story — fine for a single-box swarm, replaced by managed services and
  Secrets for a shared tenant.
- Template-level proof (helm lint + render matrix + real-tarball fallback fetch)
  ran on the dev box; a live cluster install was deliberately **not** run there —
  Docker Desktop k8s beside the 44-container swarm is the documented OOM pairing.
  First live proof belongs to the operator's second machine, which is the use
  case this ADR exists for.
