# oshal Helm chart

The single source of k8s workload truth for oshal (ADR-129). One chart, two roles:
`main` (swarm controller + infra + bot fleet) and `bot-pod` (federated contributor
bots joining a main swarm over a headscale tailnet).

## Codeless install (recommended)

You don't need this repo checked out — the installer drives everything and pulls
only from the registry:

```bash
curl -fsSLO https://raw.githubusercontent.com/emeraldcoastsystemsgroup/oshal/main/scripts/oshal-install.sh
bash oshal-install.sh --mode 4 --admin-email you@example.com
```

(Windows: `.\scripts\oshal-install.ps1 -Kubernetes -AdminEmail you@example.com`.)

That checks kubectl/helm and the cluster, installs the chart (published OCI package
first, repo fallback), exposes the cockpit on a NodePort, waits for health, and
opens `/welcome` in your browser.

Direct helm, once the OCI chart is published:

```bash
helm install oshal oci://ghcr.io/emeraldcoastsystemsgroup/charts/oshal \
  -n oshal --create-namespace --wait \
  --set api.service.type=NodePort
```

Defaults are pull-ready: `ghcr.io/emeraldcoastsystemsgroup/oshal-bot:latest`,
in-cluster Postgres/Redis/Chroma, mock single-user auth, the kernel bot fleet.

## Fleet presets

`fleet: kernel` (default — the Tier-0 kernel bots), `full` (every compose bot-node
eligible on k8s), or `custom` (exactly your `bots:` list). `kernel`/`full` render
the preset plus `bots:` extras, deduped by name (preset wins).

The preset lists are **generated** from
[docker-compose.oshal-local.yml](../../../docker-compose.oshal-local.yml) — never
hand-edit them. After changing a bot in compose:

```bash
node scripts/generate-chart-fleet.mjs --write
```

`tests/unit/chart-fleet-parity.spec.ts` goes red when they drift. Excluded on
purpose (logged by the generator): docker-socket bots (no docker daemon in a pod)
and compose-profile services (`build`/`incident`/`extras`/… — a default compose
`up` never started those either; add them via `bots:` if your cluster wants them).

## How bots get a brain on k8s

There are **no vendor-CLI OAuth mounts** here (compose bind-mounts `~/.codex` etc.;
a cluster has no such host state). Reasoning comes from:

1. **The /welcome wizard** (default, zero secrets in values): connect a hosted/BYO
   model in the browser after install — stored per-user in the DB.
2. **Vendor API keys** in the optional `oshal-bot-env` Secret
   (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY`), created out-of-band:
   `kubectl -n oshal create secret generic oshal-bot-env --from-literal=OPENAI_API_KEY=…`
3. `--no-ai` posture: `swarm.forceLlmProvider=noop` — an explicit no-model box.

The shared-env default follows the codex fleet floor (`openai-codex` / `gpt-5.5`);
per-bot registry overrides still win.

## Postures

- **Local/dev (default):** `MOCK_OIDC=true` — no sign-in page; pair with
  `MOCK_OIDC_EMAIL/NAME/SUB` in `api.extraEnv` (the installer does) or every
  visitor is the shared demo identity.
- **Multi-user public tenant:** use the [Terraform layer](../../terraform/README.md) —
  it refuses to deploy without real OIDC + minted secrets, and owns
  Ingress/NodePort exposure, namespace, and posture guards. The chart stays the
  workload truth either way.
- **Kyma:** `cockpit.apiRule.enabled=true` (the APIRule CRD exists only there).
- **Federation:** `relay.enabled=true` on main + a `role: bot-pod` release per
  contributor cluster — see [values-bot-pod.example.yaml](values-bot-pod.example.yaml).
  Bot-pod clusters never receive a DATABASE_URL (trust rule).

## Not in the chart (yet)

TimescaleDB, ArangoDB, Vault, code-server, ollama, speaker-diarization — compose-only
infra. Features degrade accordingly (graph 503s, trading stays on compose). See
BACKLOG "k8s parity" entries before assuming otherwise.

## Publishing (operator-triggered)

`bash scripts/publish-chart.sh` packages this directory and pushes the OCI chart to
`ghcr.io/emeraldcoastsystemsgroup/charts/oshal`. Publish cadence is operator-only.
