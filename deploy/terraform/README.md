# oshal on Kubernetes via Terraform

Terraform layer over the in-repo Helm chart ([deploy/helm/oshal](../helm/oshal/) —
`chart_path` defaults to it since ADR-129). Terraform owns **cluster targeting,
tenant namespace, secret minting, exposure, and posture guards**; the chart stays
the single source of workload truth. One module apply = **one tenant** (per-tenant
isolation model — a second tenant is a second apply with a different
`namespace`/state, never a shared-DB multi-tenant instance).

> **Just want oshal on a k8s box?** You don't need Terraform (or this repo):
> `bash oshal-install.sh --mode 4` is the codeless path — helm + registry images
> only. See [deploy/helm/oshal/README.md](../helm/oshal/README.md). This layer is
> for **multi-user public tenants**, where its OIDC/secret posture guards are the
> point.

| Path | What |
|---|---|
| `*.tf` | The module — namespace, `oshal-api-env` Secret, `helm_release`, optional plain-k8s Ingress |
| [envs/local-kind.tfvars](envs/local-kind.tfvars) | Local validation profile: kind, mock auth, noop LLM, laptop-sized |
| [envs/public-tenant.example.tfvars](envs/public-tenant.example.tfvars) | Multi-user **single public tenant** template: real OIDC, guest mode, registry image, ingress + TLS |
| [local-kind/cluster.yaml](local-kind/cluster.yaml) | 3-node kind cluster (1 control-plane + 2 workers) for the local proveout |

## Local proveout (kind on Docker)

```bash
kind create cluster --config deploy/terraform/local-kind/cluster.yaml
kind load docker-image oshal-bot:latest --name oshal-tf --nodes oshal-tf-worker,oshal-tf-worker2
cd deploy/terraform
terraform init
terraform apply -var-file envs/local-kind.tfvars   # chart_path defaults to ../helm/oshal
kubectl --context kind-oshal-tf -n oshal port-forward svc/oshal-api 15000:5000
# → http://localhost:15000/cockpit/   (mock auth — single mock user, local only)
kind delete cluster --name oshal-tf   # full teardown
```

The local Docker VM is shared with the compose swarm — the kind cluster and the
local profile are deliberately small. The kind cluster is disposable; nothing in
it is shared state.

## Multi-user single-public-tenant deployment

Copy [envs/public-tenant.example.tfvars](envs/public-tenant.example.tfvars) to
`terraform.tfvars` (gitignored) and fill the `CHANGE-ME`s. The posture is enforced,
not advisory:

- **`mock_oidc = false` refuses to plan** unless `oidc_issuer_url`, `oidc_client_id`,
  `oidc_client_secret`, and `session_secret` are all set — a public tenant can't
  ship on dev auth by omission.
- **Users, not tenants, are the sharing unit.** All users log into the one tenant
  via real OIDC (any IdP). Per-user isolation is the app's job and is switched on
  here: `OSHAL_APP_ROLE_BOOTSTRAP=true` (always) runs migrations as the bootstrap
  role, enforces core RLS, and provisions the least-privilege `oshal_app` runtime
  role (ADR-076); connector tokens are per-user AES-GCM (ADR-042).
- **Guest mode is explicit** (`enable_guest_mode`) — anonymous visitors get an
  isolated, capability-restricted guest identity (the public-demo pattern); a real
  login always wins.
- **Secrets are Terraform inputs**, minted into the `oshal-api-env` Secret
  (`envFrom` on the api). Nothing secret is a Helm values literal, and root-level
  `terraform.tfvars` is gitignored.
- **Exposure is one of**: plain-k8s `Ingress` (nginx + TLS secret) or a NodePort
  Service — both route-everything, because the app enforces its own OIDC per
  route (`authRequired:false` + `requiresAuth`).
- **Postgres**: in-cluster StatefulSet with a real password, or
  `postgres_in_cluster=false` + managed `DATABASE_URL`/`BOOTSTRAP_DATABASE_URL`
  via `api_extra_secret_env` (the precondition insists).

State for real tenants belongs in a remote backend (S3/azurerm/…) — add a
`backend` block per deployment; local state is only acceptable for the kind
proveout.

## Production fleet + weekend-migration checklist (2026-07)

Decision 2026-07-18: **production runs on k8s** (migrating to a larger server);
**development stays on the operator box's compose stack**. The public-tenant
template now carries the full 35-bot production fleet extracted from
[docker-compose.oshal-local.yml](../../docker-compose.oshal-local.yml) —
`name` = compose service name = registry `container:` (the DNS the controller
dials), with `botName`/`personaFile` overrides and per-bot codex env where
compose has them. Chart ≥ 0.1.5 required (`botName` support).

Before the weekend apply, in order:

1. **Image in a registry.** Build from a commit **≥ `ad0b3517`** (the
   access_audit enforce fix executes from *inside* the image — older images
   crash-loop a virgin DB) via `git archive HEAD | docker build …`, push to
   e.g. `ghcr.io/<owner>/oshal-bot`, set `image_repository`/`image_tag`.
   `kind load` side-loading is local-only.
2. **Mint real secrets** in `terraform.tfvars` (gitignored): the four OIDC
   values, `session_secret`, `jwt_secret`, `swarm_service_secret`,
   `postgres_password`. Register the OIDC app under
   maintainer@emeraldcoastsystemsgroup.com (partner-app rule).
3. **Config-seed + bot-env Secrets** in the namespace (chart `envFrom`/mounts,
   both `optional`): `oshal-config-seed` (global-config.json, secrets.json) and
   `oshal-bot-env` (per-fleet secret env). Without them bots boot with defaults.
4. **OPEN — bot LLM auth on k8s.** Compose bind-mounts the host's OAuth logins
   (`~/.codex`, `~/.claude`, `~/.gemini` volumes); the chart has **no
   equivalent** — the kind proveout ran `noop`. Options: (a) vendor API keys in
   `oshal-bot-env` (works today, but breaks the BYOK-on-swarm-login rule and
   costs API-rate money), or (b) chart work to mount a creds Secret/PVC at the
   CLI home paths — which also needs a token-refresh story (the host keepalive
   refreshes OAuth 2-hourly; a static Secret goes stale). **Decide before the
   weekend; without it every bot heartbeats but no LLM executes.**
5. **Not yet in the chart** (compose-only infra): TimescaleDB (`oshal-tsdb` —
   trading), ArangoDB (graph — `/api/graph` degrades to 503, acceptable),
   Vault, code-server, speaker-diarization, ollama, cloudflared/headscale.
   Features degrade accordingly — **trading cannot run on k8s until tsdb is
   templated**; keep trading on the dev box or add the template first.
6. **Remote state backend** (S3/azurerm/…) before the first production apply —
   local tfstate is kind-proveout-only.
7. After apply: `kubectl -n <ns> get pods` all Ready, `/api/agents` shows the
   fleet `active`, and a bot heartbeat exists in Redis
   (`oshal:runtime-agent:<agentId>`).

## What this is not

- Not a second manifest source — workloads render from the Helm chart only.
- Not cluster provisioning — kind/managed cluster creation stays outside
  the module (`local-kind/cluster.yaml` is a convenience, not managed state).
- Not the federation path — bot-pod contributor clusters keep using the chart's
  `role: bot-pod` values flow.
