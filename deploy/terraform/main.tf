# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — namespace + oshal-api-env Secret + helm_release over the ADR-086 chart (chart_path). Terraform owns cluster-shape and secret-minting; the chart stays the single source of workload truth (no duplicated manifests). Preconditions make the multi-user posture unfakeable: mock_oidc=false refuses to plan without real OIDC config, so a "public tenant" can never ship with dev auth by omission.

locals {
  # Real-OIDC readiness: all four must be present for a multi-user deployment.
  oidc_ready = alltrue([
    var.oidc_issuer_url != "",
    var.oidc_client_id != "",
    var.oidc_client_secret != "",
    var.session_secret != "",
  ])

  # Secret env for the api (chart envFrom oshal-api-env). Empty values are
  # dropped so the Secret only carries what was actually configured.
  api_secret_env = merge(
    { for k, v in {
      SESSION_SECRET       = var.session_secret
      OIDC_ISSUER_URL      = var.oidc_issuer_url
      OIDC_CLIENT_ID       = var.oidc_client_id
      OIDC_CLIENT_SECRET   = var.oidc_client_secret
      SWARM_SERVICE_SECRET = var.swarm_service_secret
    } : k => v if v != "" },
    var.api_extra_secret_env,
  )

  # Helm deep-merges these over the chart's values.yaml defaults, so only the
  # keys Terraform actually decides are set here.
  chart_values = {
    role = "main"

    image = {
      repository = var.image_repository
      tag        = var.image_tag
      pullPolicy = var.image_pull_policy
    }

    relay = {
      enabled = var.relay_enabled
    }

    infra = {
      postgres = {
        inCluster = var.postgres_in_cluster
        password  = var.postgres_password
        storage   = var.storage.postgres
      }
      redis    = { storage = var.storage.redis }
      chromadb = { storage = var.storage.chromadb }
    }

    api = {
      envSecret     = "oshal-api-env"
      outputStorage = var.storage.api_output
      resources     = var.api_resources
      extraEnv = merge(
        {
          MOCK_OIDC                = var.mock_oidc ? "true" : "false"
          ENABLE_GUEST_MODE        = var.enable_guest_mode ? "true" : "false"
          OSHAL_APP_ROLE_BOOTSTRAP = "true"
          APP_URL                  = var.app_url
        },
        var.api_extra_env,
      )
    }

    swarm = merge(
      {
        forceLlmProvider = var.force_llm_provider
        forceLlmModel    = var.force_llm_model
        workspaceStorage = var.storage.workspace
      },
      var.jwt_secret != "" ? { jwtSecret = var.jwt_secret } : {},
    )

    bots = var.bots
  }
}

resource "kubernetes_namespace_v1" "tenant" {
  metadata {
    name = var.namespace
    labels = {
      "app.kubernetes.io/part-of" = "oshal"
      "oshal.io/tenant"           = var.namespace
    }
  }
}

resource "kubernetes_secret_v1" "api_env" {
  count = length(local.api_secret_env) > 0 ? 1 : 0

  metadata {
    name      = "oshal-api-env"
    namespace = kubernetes_namespace_v1.tenant.metadata[0].name
    labels = {
      "app.kubernetes.io/part-of" = "oshal"
    }
  }

  data = local.api_secret_env
}

resource "helm_release" "oshal" {
  name      = "oshal"
  chart     = var.chart_path
  namespace = kubernetes_namespace_v1.tenant.metadata[0].name

  values = [yamlencode(local.chart_values)]

  wait    = true
  timeout = 900

  depends_on = [kubernetes_secret_v1.api_env]

  lifecycle {
    precondition {
      condition     = var.mock_oidc || local.oidc_ready
      error_message = "mock_oidc=false (multi-user public tenant) requires oidc_issuer_url, oidc_client_id, oidc_client_secret and session_secret. Refusing to deploy a public tenant on dev auth."
    }
    precondition {
      condition     = var.mock_oidc || var.jwt_secret != ""
      error_message = "mock_oidc=false (multi-user public tenant) requires jwt_secret — the chart's dev-parity JWT_SECRET must never reach a public tenant."
    }
    precondition {
      condition     = var.postgres_in_cluster || contains(keys(var.api_extra_secret_env), "DATABASE_URL")
      error_message = "postgres_in_cluster=false requires DATABASE_URL (and BOOTSTRAP_DATABASE_URL) in api_extra_secret_env."
    }
  }
}
