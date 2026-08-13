# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — input surface for deploying ONE OSHAL tenant onto ONE k8s cluster/namespace (per-tenant isolation model: multi-tenant = run this module once per tenant, never a shared-DB SaaS). The multi-user single-public-tenant posture is expressed here: mock_oidc=false forces real OIDC vars, guest mode is an explicit opt-in, and every secret is a sensitive var minted into the oshal-api-env Secret — never a values-file literal.
# 2 | maintainer@emeraldcoastsystemsgroup.com   | bots[] gains botName + personaFile optionals (chart 0.1.5): the production fleet has ~17 bots whose BOT_NAME/persona differ from the Service/DNS name, and the object type would otherwise reject those keys.
# 3 | maintainer@emeraldcoastsystemsgroup.com   | ADR-129: chart_path now DEFAULTS to the in-repo chart (../helm/oshal) — the chart lives in this trunk since 0.2.0, so a fresh clone deploys without a CHANGE-ME hunt. Override still supported for a pulled OCI chart directory or an out-of-tree checkout.

# ── Cluster targeting ─────────────────────────────────────────────────────────

variable "kubeconfig_path" {
  description = "Path to the kubeconfig used by both providers. ~ is expanded."
  type        = string
  default     = "~/.kube/config"
}

variable "kube_context" {
  description = "Kubeconfig context to deploy into (e.g. kind-oshal-tf). Required on purpose — never inherit kubectl's current context."
  type        = string
}

variable "namespace" {
  description = "Namespace for this tenant. One namespace = one tenant (enterprise isolation model); a second tenant is a second module instance with a different namespace."
  type        = string
  default     = "oshal"
}

variable "chart_path" {
  description = "Path to the oshal Helm chart directory (the single source of workload truth). Defaults to the in-repo chart; absolute, or relative to the directory terraform runs in."
  type        = string
  default     = "../helm/oshal"
}

# ── Image ─────────────────────────────────────────────────────────────────────

variable "image_repository" {
  description = "OSHAL image repository. Local kind: 'oshal-bot' (kind load docker-image + pull_policy Never). Remote clusters: a registry, e.g. ghcr.io/<owner>/oshal-bot."
  type        = string
  default     = "oshal-bot"
}

variable "image_tag" {
  description = "Image tag for api and bots."
  type        = string
  default     = "latest"
}

variable "image_pull_policy" {
  description = "Kubernetes imagePullPolicy. 'Never' for kind-loaded local images, 'IfNotPresent' for registries."
  type        = string
  default     = "IfNotPresent"
}

# ── Multi-user auth posture (single public tenant) ────────────────────────────

variable "mock_oidc" {
  description = "true = MOCK_OIDC dev auth (local validation only — every visitor is the same mock user). false = real OIDC multi-user login; requires oidc_issuer_url, oidc_client_id, oidc_client_secret, session_secret, app_url."
  type        = bool
  default     = false
}

variable "enable_guest_mode" {
  description = "Allow anonymous visitors an isolated capability-restricted guest identity on the public tenant (ENABLE_GUEST_MODE). Real logins always win over guest sessions."
  type        = bool
  default     = false
}

variable "app_url" {
  description = "Public base URL of the cockpit (OIDC redirect origin), e.g. https://oshal.example.com."
  type        = string
  default     = "http://localhost:5000"
}

variable "oidc_issuer_url" {
  description = "OIDC issuer URL (any IdP — Entra, Keycloak, Google). Required when mock_oidc=false."
  type        = string
  default     = ""
}

variable "oidc_client_id" {
  description = "OIDC client id. Required when mock_oidc=false."
  type        = string
  default     = ""
}

variable "oidc_client_secret" {
  description = "OIDC client secret. Required when mock_oidc=false."
  type        = string
  default     = ""
  sensitive   = true
}

variable "session_secret" {
  description = "SESSION_SECRET for OIDC session cookie encryption. Required when mock_oidc=false."
  type        = string
  default     = ""
  sensitive   = true
}

variable "jwt_secret" {
  description = "JWT_SECRET for the any-bot execution layer (shared env). Empty = the chart's committed dev-parity value, acceptable ONLY for local validation; public tenants must set a real one (guarded)."
  type        = string
  default     = ""
  sensitive   = true
}

variable "swarm_service_secret" {
  description = "SWARM_SERVICE_SECRET — bot↔controller service auth. Empty = not set (local noop validation only)."
  type        = string
  default     = ""
  sensitive   = true
}

variable "api_extra_env" {
  description = "Additional NON-secret env for the api (merged into the chart's api.extraEnv), e.g. { REJECT_LOOP_TICKETS = \"true\" }."
  type        = map(string)
  default     = {}
}

variable "api_extra_secret_env" {
  description = "Additional SECRET env for the api, merged into the oshal-api-env Secret (connector keys, WORLD_INGEST_TOKEN, DATABASE_URL override for managed Postgres, …)."
  type        = map(string)
  default     = {}
  sensitive   = true
}

# ── Ingress (choose at most one exposure path) ────────────────────────────────

variable "ingress_enabled" {
  description = "Create a plain-k8s Ingress for the cockpit. The app enforces its own OIDC; the ingress only routes."
  type        = bool
  default     = false
}

variable "ingress_class_name" {
  description = "IngressClass for the cockpit Ingress."
  type        = string
  default     = "nginx"
}

variable "ingress_host" {
  description = "Hostname for the cockpit Ingress, e.g. oshal.example.com. Required when ingress_enabled."
  type        = string
  default     = ""
}

variable "ingress_tls_secret" {
  description = "TLS secret name for the Ingress host. Empty = no TLS block (terminate elsewhere)."
  type        = string
  default     = ""
}

variable "nodeport" {
  description = "If non-zero (30000-32767), expose the cockpit as a NodePort Service — the durable local-cluster access path (kind/dev clusters without an ingress controller). 0 = disabled."
  type        = number
  default     = 0
}

# ── Infra ─────────────────────────────────────────────────────────────────────

variable "postgres_in_cluster" {
  description = "true = run postgres:16 in-cluster (StatefulSet). false = managed Postgres: supply DATABASE_URL + BOOTSTRAP_DATABASE_URL via api_extra_secret_env."
  type        = bool
  default     = true
}

variable "postgres_password" {
  description = "In-cluster Postgres superuser password (dev parity default — override for anything reachable beyond your own machine)."
  type        = string
  default     = "oshal"
  sensitive   = true
}

variable "storage" {
  description = "PVC sizes. Shrink for local kind; grow for real tenants."
  type = object({
    workspace  = optional(string, "5Gi")
    api_output = optional(string, "8Gi")
    postgres   = optional(string, "8Gi")
    redis      = optional(string, "2Gi")
    chromadb   = optional(string, "4Gi")
  })
  default = {}
}

variable "api_resources" {
  description = "Resource requests/limits for the api container."
  type = object({
    requests = optional(map(string), { cpu = "500m", memory = "1Gi" })
    limits   = optional(map(string), { memory = "3Gi" })
  })
  default = {}
}

# ── Swarm behavior ────────────────────────────────────────────────────────────

variable "force_llm_provider" {
  description = "Process-level LLM provider default for bots (registry overrides win). 'noop' = zero-cost validation deploys; real tenants set claude-code/codex/…"
  type        = string
  default     = "noop"
}

variable "force_llm_model" {
  description = "Model paired with force_llm_provider (empty = provider default)."
  type        = string
  default     = ""
}

variable "relay_enabled" {
  description = "Deploy the ADR-086 tailnet relay (headscale federation). Off by default — single-cluster tenants don't need it."
  type        = bool
  default     = false
}

variable "fleet" {
  description = "Chart fleet preset: custom (default — bots[] below is authoritative, 0.1.x semantics), kernel, or full (the chart's generated compose-parity presets; bots[] then renders as extras on top)."
  type        = string
  default     = "custom"
  validation {
    condition     = contains(["custom", "kernel", "full"], var.fleet)
    error_message = "fleet must be one of: custom, kernel, full."
  }
}

variable "bots" {
  description = "Bot-node deployments (chart bots[] passthrough). Empty = controller-only; agent IDs are centrally assigned (ADR-086 §4). name = the Service/DNS name the controller dials (compose service-name parity — must match the registry's container field); botName = the agent's BOT_NAME when it differs (chart defaults it to name); personaFile = absolute in-image persona path when it isn't /app/ai-lab/bot-personas/<name>.yaml."
  type = list(object({
    name         = string
    agentId      = string
    capabilities = string
    botName      = optional(string)
    personaFile  = optional(string)
    extraEnv     = optional(map(string), {})
  }))
  default = []
}
