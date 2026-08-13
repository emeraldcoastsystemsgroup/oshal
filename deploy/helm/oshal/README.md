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

## Shared services

The chart runs the same service tier a default `docker compose up` does, each
behind `infra.<name>.inCluster`:

| values key | Service | Powers | Default |
|---|---|---|---|
| `infra.postgres` | `oshal-db` | tickets, agents, cost ledger | on |
| `infra.redis` | `oshal-redis` | the swarm mesh | on |
| `infra.chromadb` | `oshal-chromadb` | RAG + swarm memory | on |
| `infra.tsdb` | `oshal-tsdb` | trading + world series (`TSDB_URL`) | on |
| `infra.arangodb` | `oshal-arangodb` | graph tier, `/api/graph` (`ARANGO_URL`) | on |
| `infra.vault` | `oshal-vault` | devops vault — **dev mode**, in-memory | on |
| `infra.codeServer` | `code-server` | workspace IDE behind the cockpit's `/code` | on |
| `infra.diarization` | `speaker-diarization` | local transcription (audio stays in-cluster) | on |
| `infra.ollama` | `oshal-ollama` | local models (`OLLAMA_HOST`) | **off** (compose gates it behind `local-llm`) |

Turning one off also withholds its URL env — that is the degradation switch, not
an oversight: an unset `ARANGO_URL` makes the graph connector return `null` and
`/api/graph` answer 503, which is the designed behavior. Point a feature at a
managed service by setting `inCluster: false` and supplying the URL through
`api.envSecret`.

⚠ **code-server is ClusterIP-only.** It runs `--auth none` over a read-write
shared workspace, so anyone who reaches it owns the workspace. Compose contains
that by binding `127.0.0.1`; here, use
`kubectl -n <ns> port-forward svc/code-server 8444:8080`. Do not expose it
without putting authentication in front of it.

⚠ **Vault is `server -dev`** (compose parity): in-memory, auto-unsealed, fixed
root token, no PVC — it loses everything on restart. Real deployments set
`infra.vault.inCluster: false` and point `VAULT_ADDR`/`VAULT_TOKEN` at a real
Vault.

## Store packages

```bash
--set packages={career-hunter,job-apply}
```

They stage into the workspace PVC via an initContainer **before** the api starts,
because auto-load registers a package's bots and surfaces once, at boot. Re-runs
skip already-staged packages (`store.auditMode: compatible`); `enforce`
revalidates and replaces from the audited SHA. A failed stage fails the pod
rather than booting without an app you asked for. Private stores need a token
Secret — see `store.tokenSecret`. The installer passes `--apps`/bundles through
automatically.

## Publishing (operator-triggered)

`bash scripts/publish-chart.sh` packages this directory and pushes the OCI chart to
`ghcr.io/emeraldcoastsystemsgroup/charts/oshal`. Publish cadence is operator-only.
