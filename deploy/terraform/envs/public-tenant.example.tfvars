# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — the multi-user SINGLE PUBLIC TENANT posture, as a copy-and-fill template. One namespace = one tenant; many users share it via real OIDC; per-user isolation comes from the app (ADR-076 RLS + oshal_app role, per-user AES-GCM connector tokens), not from Kubernetes. Copy to terraform.tfvars (gitignored) and fill the CHANGE-ME values — never commit real secrets.
# 2 | maintainer@emeraldcoastsystemsgroup.com   | Full production bot fleet (35 bots) extracted from docker-compose.oshal-local.yml for the weekend prod-on-k8s migration: name = compose service name (= registry container = the DNS the controller dials), botName/personaFile where they differ, per-bot codex overrides + UI/store env as extraEnv. self-healing-bot deliberately absent (its remediation tools are docker-socket-bound — invalid on k8s).

# Target cluster (gaming-PC kind, any k8s ≥1.27).
kube_context = "CHANGE-ME" # e.g. kind-oshal-tf
namespace    = "oshal-public"

# The ADR-086 Helm chart to release (the single source of workload truth).
chart_path = "CHANGE-ME" # path to your oshal Helm chart checkout

# Public deployments pull from a registry (kind side-loading is local-only).
image_repository  = "ghcr.io/CHANGE-ME/oshal-bot"
image_tag         = "latest"
image_pull_policy = "IfNotPresent"

# ── Multi-user auth: REAL OIDC (terraform refuses to apply if these are empty
# while mock_oidc=false — that guard is the point of this profile). ───────────
mock_oidc          = false
app_url            = "https://oshal.example.com"
oidc_issuer_url    = "CHANGE-ME" # e.g. https://login.microsoftonline.com/<tenant>/v2.0
oidc_client_id     = "CHANGE-ME"
oidc_client_secret = "CHANGE-ME"
session_secret     = "CHANGE-ME" # long random string; rotating it logs everyone out

# Anonymous visitors get an isolated guest identity (public-demo pattern);
# real logins always win. Set false for a members-only tenant.
enable_guest_mode = true

swarm_service_secret = "CHANGE-ME" # bot↔controller service auth
jwt_secret           = "CHANGE-ME" # any-bot execution layer (never the dev default)

# Real LLM execution on the bots (BYOK on the swarm default login — never
# vendor API keys per bot).
force_llm_provider = "claude-code"
force_llm_model    = "claude-sonnet-4-6"

# ── Cockpit exposure: pick ONE ────────────────────────────────────────────────
# Plain k8s + ingress-nginx + cert-manager:
ingress_enabled    = true
ingress_class_name = "nginx"
ingress_host       = "oshal.example.com"
ingress_tls_secret = "oshal-cockpit-tls"

# In-cluster Postgres with a real password. For managed Postgres set
# postgres_in_cluster=false and put DATABASE_URL + BOOTSTRAP_DATABASE_URL in
# api_extra_secret_env instead.
postgres_in_cluster = true
postgres_password   = "CHANGE-ME"

# Optional extras:
# api_extra_env        = { REJECT_LOOP_TICKETS = "true" }
# api_extra_secret_env = { WORLD_INGEST_TOKEN = "…", DATABASE_URL = "…", BOOTSTRAP_DATABASE_URL = "…" }

# ── Production bot fleet ──────────────────────────────────────────────────────
# Extracted from docker-compose.oshal-local.yml (the compose stack is the
# reference deployment). `name` is the Service/DNS name — it MUST match the
# swarm-bot-registry `container:` field (BotNodeClient dials
# http://<container>:5000). `botName`/`personaFile` are set only where they
# differ from the name-derived defaults. Per-bot FORCE_LLM_* mirrors compose:
# codex bots shell out to scripts/oshal-*.js in their sandbox (claude-code-as-
# root can't auto-approve bash). Registry harnessType still wins at dispatch.
#
# NOT in this fleet (deliberate):
#  - self-healing-bot — its tools restart docker containers via the socket;
#    invalid on k8s until it grows a kubectl sibling.
#  - project-manager — inline on the api container, not a bot node.
#  - apply-operator / linkedin-profile-operator — registry-only personas that
#    execute on the operator's desktop worker, never in the cluster.
bots = [
  # ── Platform / engineering ──
  {
    name         = "oshal-task-manager"
    botName      = "task-manager"
    personaFile  = "/app/ai-lab/bot-personas/task-manager.yaml"
    agentId      = "a0000000-0000-0000-0000-000000000006"
    capabilities = "qa,verification,testing"
  },
  {
    name         = "code-developer"
    agentId      = "a0000000-0000-0000-0000-000000000002"
    capabilities = "coding,implementation,debugging,refactoring,feature-development,bug-fixing,api-design"
  },
  {
    name         = "devops-bot"
    agentId      = "a0000000-0000-0000-0000-000000000008"
    capabilities = "infrastructure,cicd,kubernetes,docker,monitoring,scripting,bash,deployment"
  },
  {
    name         = "code-reviewer"
    agentId      = "a0000000-0000-0000-0000-000000000003"
    capabilities = "code-review,security,quality,best-practices,architecture-review"
  },
  {
    name         = "documentation-writer"
    agentId      = "a0000000-0000-0000-0000-000000000004"
    capabilities = "documentation,readme,adr,jsdoc,technical-writing,handover"
  },
  {
    name         = "research-bot"
    agentId      = "a0000000-0000-0000-0000-00000000000c"
    capabilities = "research,analysis,documentation,investigation,web-search,competitive-analysis"
  },
  {
    name         = "tester-bot"
    agentId      = "a0000000-0000-0000-0000-00000000000e"
    capabilities = "testing,qa,test-standards,acceptance-criteria,test-automation"
  },
  {
    name         = "test-engineer"
    agentId      = "a0000000-0000-0000-0000-000000000005"
    capabilities = "testing,validation,verification,test-automation,qa,acceptance-criteria"
  },
  {
    name         = "system-architect"
    agentId      = "a0000000-0000-0000-0000-000000000018"
    capabilities = "architecture,design,system-modeling,technical-specification,decomposition,research,analysis"
  },
  {
    name         = "queue-bot"
    agentId      = "f0000000-0000-0000-0000-000000000001"
    capabilities = "quality-review,deliverable-assessment,feedback-generation"
  },
  {
    name         = "oshal-developer"
    agentId      = "de000000-0000-0000-0000-000000000001"
    capabilities = "platform-development,typescript,feature-slice-design,documentation-quality,codebase-indexing,self-hosting"
    extraEnv     = { FORCE_LLM_PROVIDER = "openai-codex", FORCE_LLM_MODEL = "gpt-5.5" }
  },
  # ── Incident / ops ──
  {
    name         = "rca-specialist"
    agentId      = "a0000000-0000-0000-0000-000000000016"
    capabilities = "debugging,investigation,root-cause,incident,analysis,troubleshooting"
  },
  {
    name         = "incident-response-bot"
    agentId      = "a0000000-0000-0000-0000-00000000000b"
    capabilities = "incident-response,triage,runbook-execution,stakeholder-communication"
  },
  {
    name         = "incident-remediation-bot"
    agentId      = "e0000000-0000-0000-0000-000000000100"
    capabilities = "incident-investigation,root-cause-analysis,remediation-scripting,topology-analysis,log-analysis,infrastructure-inspection"
  },
  {
    name         = "cloud-ops-bot"
    agentId      = "d0000000-0000-0000-0000-000000000002"
    capabilities = "gcp-inventory,gcp-projects,gcp-compute,gcp-enabled-apis,gcp-cost-optimization,gcp-health-audit,gcp-iam-audit"
    extraEnv = {
      FORCE_LLM_PROVIDER = "openai-codex"
      FORCE_LLM_MODEL    = "gpt-5.5"
      BOT_UI_LABEL       = "Cloud"
      BOT_UI_URL         = "/cockpit/?app=cloud"
      BOT_UI_ICON        = "codicon codicon-cloud"
    }
  },
  # ── Assistant / orchestration ──
  {
    name         = "jarvis-bot"
    botName      = "oshal-assistant"
    personaFile  = "/app/ai-lab/bot-personas/oshal-assistant.yaml"
    agentId      = "a0000000-0000-0000-0000-000000000050"
    capabilities = "intent-routing,cross-app-orchestration,answer-synthesis"
    extraEnv = {
      FORCE_LLM_PROVIDER   = "openai-codex"
      FORCE_LLM_MODEL      = "gpt-5.5"
      JOBHUNTER_STORE_ROOT = "/app/output/career-hunter-data"
      BOT_UI_LABEL         = "Assistant"
      BOT_UI_URL           = "/cockpit/?app=jarvis"
      BOT_UI_ICON          = "codicon codicon-sparkle"
    }
  },
  {
    name         = "general-bot"
    personaFile  = "/app/ai-lab/bot-personas/everything-default.yaml"
    agentId      = "a0000000-0000-0000-0000-000000000099"
    capabilities = "general-assistance,cross-domain-synthesis,web-research,overflow-fallback"
    extraEnv     = { FORCE_LLM_PROVIDER = "openai-codex", FORCE_LLM_MODEL = "gpt-5.5" }
  },
  # ── Communications / social ──
  {
    name         = "email-bot"
    botName      = "communications-bot"
    personaFile  = "/app/ai-lab/bot-personas/email-summarizer.yaml"
    agentId      = "b0000000-0000-0000-0000-000000000001"
    capabilities = "email-summarization,gmail-triage,outlook-mail,calendar-digest,meeting-agenda,reply-drafting,inbox-triage,social-signals-feed,social-publishing"
    extraEnv = {
      FORCE_LLM_PROVIDER = "openai-codex"
      FORCE_LLM_MODEL    = "gpt-5.5"
      BOT_UI_LABEL       = "Email"
      BOT_UI_URL         = "/api/email/inbox"
      BOT_UI_ICON        = "codicon codicon-mail"
    }
  },
  {
    name         = "facebook-bot"
    agentId      = "a0000000-0000-0000-0000-000000000021"
    capabilities = "social-media,facebook-api,content-publishing,community-engagement,comment-management,feed-monitoring"
    extraEnv = {
      BOT_UI_LABEL = "Facebook"
      BOT_UI_URL   = "/api/facebook-auth/app"
      BOT_UI_ICON  = "codicon codicon-globe"
    }
  },
  {
    name         = "social-writer-bot"
    botName      = "social-writer"
    personaFile  = "/app/ai-lab/bot-personas/social-writer.yaml"
    agentId      = "a0000000-0000-0000-0000-000000000040"
    capabilities = "post-drafting,voice-matching,content-refinement,personal-branding,linkedin-post-drafting,x-post-drafting,facebook-page-post-drafting,caption-writing,hook-and-cta-crafting"
    extraEnv     = { FORCE_LLM_PROVIDER = "openai-codex", FORCE_LLM_MODEL = "gpt-5.5" }
  },
  # (Career bots removed 2026-07-21 — Career Hunter carved to its store add-on; the package
  #  registers cb…0001 with its own engine, so no core career bot definitions are provisioned.)
  # ── Concierge apps ──
  {
    name         = "eats-bot"
    botName      = "eats-concierge"
    personaFile  = "/app/ai-lab/bot-personas/eats-concierge.yaml"
    agentId      = "b0080000-0000-0000-0000-000000000001"
    capabilities = "restaurant-search,menu-browse,food-order-building,uber-eats-checkout-handoff,dietary-filtering,cuisine-preferences"
    extraEnv = {
      FORCE_LLM_PROVIDER = "openai-codex"
      FORCE_LLM_MODEL    = "gpt-5.5"
      BOT_UI_LABEL       = "Order Food"
      BOT_UI_URL         = "/cockpit/?app=eats"
      BOT_UI_ICON        = "codicon codicon-flame"
    }
  },
  {
    name         = "rides-bot"
    botName      = "rides-concierge"
    personaFile  = "/app/ai-lab/bot-personas/rides-concierge.yaml"
    agentId      = "b0090000-0000-0000-0000-000000000001"
    capabilities = "ride-fare-estimate,ride-options-comparison,rideshare-trip-planning,uber-ride-handoff,ride-preference-learning"
    extraEnv = {
      FORCE_LLM_PROVIDER = "openai-codex"
      FORCE_LLM_MODEL    = "gpt-5.5"
      BOT_UI_LABEL       = "Rides"
      BOT_UI_URL         = "/cockpit/?app=rides"
      BOT_UI_ICON        = "codicon codicon-rocket"
    }
  },
  {
    name         = "shopping-bot"
    botName      = "shopping-concierge"
    personaFile  = "/app/ai-lab/bot-personas/shopping-concierge.yaml"
    agentId      = "b0070000-0000-0000-0000-000000000001"
    capabilities = "product-search,retail-price-comparison,shopping-list-management,cross-retailer-cart-building,rollback-deal-tracking,retail-checkout-handoff,purchase-preference-memory"
    extraEnv     = { FORCE_LLM_PROVIDER = "openai-codex", FORCE_LLM_MODEL = "gpt-5.5" }
  },
  {
    name         = "spotify-bot"
    botName      = "spotify-concierge"
    personaFile  = "/app/ai-lab/bot-personas/spotify-concierge.yaml"
    agentId      = "b00a0000-0000-0000-0000-000000000001"
    capabilities = "spotify-music-search,spotify-playlist-building,music-recommendation,music-taste-learning,now-playing-awareness"
    extraEnv     = { FORCE_LLM_PROVIDER = "openai-codex", FORCE_LLM_MODEL = "gpt-5.5" }
  },
  {
    name         = "travel-bot"
    botName      = "travel-concierge"
    personaFile  = "/app/ai-lab/bot-personas/travel-concierge.yaml"
    agentId      = "b00c0000-0000-0000-0000-000000000001"
    capabilities = "flight-search,hotel-search,car-search,fare-price-intelligence,fare-watch,trip-itinerary-planning,traveller-preference-learning,booking-handoff"
    extraEnv     = { FORCE_LLM_PROVIDER = "openai-codex", FORCE_LLM_MODEL = "gpt-5.5" }
  },
  {
    name         = "movies-bot"
    botName      = "movies-concierge"
    personaFile  = "/app/ai-lab/bot-personas/movies-concierge.yaml"
    agentId      = "b00b0000-0000-0000-0000-000000000001"
    capabilities = "movie-tv-discovery,title-search,where-to-watch-streaming,watchlist-curation,movie-taste-learning,showtimes-handoff"
    extraEnv     = { FORCE_LLM_PROVIDER = "openai-codex", FORCE_LLM_MODEL = "gpt-5.5" }
  },
  # ── Home / weather ──
  {
    name         = "home-bot"
    agentId      = "d0000000-0000-0000-0000-000000000001"
    capabilities = "smart-home-control,smartthings,device-control,scene-execution,home-automation"
    extraEnv = {
      FORCE_LLM_PROVIDER = "openai-codex"
      FORCE_LLM_MODEL    = "gpt-5.5"
      BOT_UI_LABEL       = "Smart Home"
      BOT_UI_URL         = "/cockpit/?app=home"
      BOT_UI_ICON        = "codicon codicon-home"
    }
  },
  {
    name         = "weather-bot"
    agentId      = "a0000000-0000-0000-0000-000000000036"
    capabilities = "current-weather,weather-forecast,local-weather-report,weather-data-formatting"
    extraEnv     = { FORCE_LLM_PROVIDER = "openai-codex", FORCE_LLM_MODEL = "gpt-5.5" }
  },
  # ── Finance / trading / identity ──
  {
    name         = "finance-bot"
    botName      = "finance-analyst"
    personaFile  = "/app/ai-lab/bot-personas/finance-analyst.yaml"
    agentId      = "a0000000-0000-0000-0000-000000000044"
    capabilities = "personal-finance-brief,net-worth-analysis,account-balance-aggregation,portfolio-holdings-review,spending-and-cashflow-analysis,budget-tracking"
    extraEnv     = { FORCE_LLM_PROVIDER = "openai-codex", FORCE_LLM_MODEL = "gpt-5.5" }
  },
  {
    name         = "trading-bot"
    botName      = "trading-analyst"
    personaFile  = "/app/ai-lab/bot-personas/trading-analyst.yaml"
    agentId      = "a0000000-0000-0000-0000-000000000046"
    capabilities = "market-signal-analysis,trade-decision,decision-tree-justification,portfolio-audit,autopilot-pnl,order-forensics,risk-gate-forensics"
    extraEnv     = { FORCE_LLM_PROVIDER = "openai-codex", FORCE_LLM_MODEL = "gpt-5.5" }
  },
  {
    name         = "identity-bot"
    botName      = "identity-advisor"
    personaFile  = "/app/ai-lab/bot-personas/identity-advisor.yaml"
    agentId      = "a0000000-0000-0000-0000-000000000045"
    capabilities = "connection-inventory-review,access-health-review,expired-login-detection,duplicate-account-detection,stale-connection-detection,missing-connector-suggestion,default-account-check"
    extraEnv     = { FORCE_LLM_PROVIDER = "openai-codex", FORCE_LLM_MODEL = "gpt-5.5" }
  },
  # ── Content / storage ──
  {
    name         = "storage-bot"
    botName      = "storage-assistant"
    personaFile  = "/app/ai-lab/bot-personas/storage-assistant.yaml"
    agentId      = "a0000000-0000-0000-0000-000000000041"
    capabilities = "storage-target-config,github-repo-create,file-store-listing,storage-backend-routing,storage-management"
    extraEnv     = { FORCE_LLM_PROVIDER = "openai-codex", FORCE_LLM_MODEL = "gpt-5.5" }
  },
  {
    name         = "deck-builder-bot"
    botName      = "deck-builder"
    personaFile  = "/app/ai-lab/bot-personas/deck-builder.yaml"
    agentId      = "a0000000-0000-0000-0000-000000000042"
    capabilities = "presentation-outline,slide-structure,deck-template-recommendation,pitch-deck-drafting,deck-guidance"
    extraEnv     = { FORCE_LLM_PROVIDER = "openai-codex", FORCE_LLM_MODEL = "gpt-5.5" }
  },
]
