# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — local kind validation profile. Everything cost-free and laptop-sized: mock auth, noop LLM provider, image side-loaded via `kind load docker-image` (pullPolicy Never), storage shrunk. This profile exists to prove the Terraform, not to be a usable swarm.

kube_context = "kind-oshal-tf"
namespace    = "oshal"

# The ADR-086 Helm chart to release — point at your oshal Helm chart checkout.
chart_path = "CHANGE-ME"

image_repository  = "oshal-bot"
# coldstart = built from ad0b3517+ (contains the idempotent access_audit enforce
# fix, which executes FROM INSIDE the image). Do not point back at :latest until
# latest has been rebuilt from a commit >= ad0b3517, or api boots crash-loop on
# the enforce collision.
image_tag         = "coldstart"
image_pull_policy = "Never" # image is kind-loaded, never pulled

# Local validation auth: mock single-user. NOT a multi-user posture — the
# public-tenant profile is envs/public-tenant.example.tfvars.
mock_oidc         = true
enable_guest_mode = false
app_url           = "http://localhost:15000"

# Zero-cost: bots (none deployed here anyway) would run the noop provider.
force_llm_provider = "noop"

relay_enabled = false

# Durable local cockpit access (see ingress.tf header for the Windows socat
# bridge that publishes this as http://localhost:15000).
nodeport = 30500

# One real bot node makes this a base swarm install, not just a controller.
# research-bot is the chart's canonical example; agent IDs are operator-assigned
# and must match the local registry. Boot/heartbeat needs no LLM credentials.
bots = [
  {
    name         = "research-bot"
    agentId      = "a0000000-0000-0000-0000-00000000000c"
    capabilities = "research,analysis,documentation,investigation,web-search"
  },
]

# Laptop-sized PVCs (kind local-path provisioner).
storage = {
  workspace  = "1Gi"
  api_output = "1Gi"
  postgres   = "2Gi"
  redis      = "512Mi"
  chromadb   = "1Gi"
}

# Keep the api inside the shared 6.2GB Docker VM's headroom.
api_resources = {
  requests = { cpu = "250m", memory = "512Mi" }
  limits   = { memory = "1536Mi" }
}
