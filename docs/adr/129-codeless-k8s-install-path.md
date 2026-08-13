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

## Consequences

- A fresh machine goes from zero to a browser-ready swarm with two commands and
  registry pulls only; `helm install oci://…` becomes a one-liner once the
  operator publishes the chart.
- Compose remains the reference deployment; the generator + guard make the chart
  follow it instead of drifting (the counts rule, applied to a fleet).
- Honest caps, tracked in BACKLOG: store-package staging (`--apps`/bundles) is
  compose-only today; TimescaleDB/Arango/Vault/code-server are not chart-templated
  (trading stays off k8s; graph degrades 503); the workspace PVC is RWO —
  single-node clusters are the supported default, multi-node needs RWX.
- Template-level proof (helm lint + render matrix + real-tarball fallback fetch)
  ran on the dev box; a live cluster install was deliberately **not** run there —
  Docker Desktop k8s beside the 44-container swarm is the documented OOM pairing.
  First live proof belongs to the operator's second machine, which is the use
  case this ADR exists for.
