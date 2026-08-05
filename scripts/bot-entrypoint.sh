#!/bin/sh
# =============================================================================
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation — per-bot persona loading entrypoint
# 2 | maintainer@emeraldcoastsystemsgroup.com   | Added setup-cline-auth.sh, dev mode hot-swap with nodemon, proper oshal aligned startup
# 3 | maintainer@emeraldcoastsystemsgroup.com   | Added shared config seed: copies global-config.json + secrets.json from /app/config-seed/ to per-bot output if not present
# 4 | maintainer@emeraldcoastsystemsgroup.com   | Step 1c (ADR-081): when OSHAL_DEV_REPO_URL is set, clone/refresh the bot's own platform-repo working copy at /app/dev-repo (idempotent: clone-if-missing else fetch + pull --rebase), enable the versioned guard hooks (core.hooksPath .githooks), set the git identity, and wire an env-reading credential helper (OSHAL_DEV_REPO_TOKEN — never persisted to .git/config). Non-fatal: a bot with a stale/absent clone still boots and reports the state.
# 5 | maintainer@emeraldcoastsystemsgroup.com   | Fix ticket-time dev-repo git auth (BACKLOG 2026-07-09): the helper lived ONLY in /root/.gitconfig, but the codex harness spawns ticket work with HOME=<workspace>/.codex-home, so ticket-time git never loaded it ("could not read Username"). Helper is now ALSO repo-local (HOME-independent) and falls back to a container-local /run/oshal-dev-token file (mode 600, NOT on any volume — dies with the container) in case the codex spawn env is scrubbed. The secret still never persists.
# 6 | maintainer@emeraldcoastsystemsgroup.com   | Corrected BOT_RUNTIME comments to match the current bot-node controller/worker split so docs and entrypoint guidance agree.
# 7 | maintainer@emeraldcoastsystemsgroup.com   | Refuse the unsigned legacy any-bot HTTP runtime whenever delegation verification/signing material enables the task-bound security posture.
# =============================================================================
#
# @description Bot startup entrypoint for per-container architecture.
# Mirrors oshal startup: setup-cline-auth.sh → persona YAML loading → server start.
# In dev mode, uses nodemon + ts-node for hot-swap. In prod, uses compiled JS.
#
# Environment variables:
#   BOT_PERSONA_FILE   — path to persona YAML (e.g. /app/ai-lab/bot-personas/project-manager.yaml)
#   BOT_NAME           — override for bot name (falls back to YAML .name field)
#   AGENT_ID           — override for agent ID (falls back to YAML .agent_id or .name)
#   CONFIG_OUTPUT_DIR  — config output directory (default: ./output)
#   NODE_ENV           — development enables hot-swap via nodemon + ts-node
# =============================================================================

set -e

echo "=========================================="
echo " OSHAL Bot Entrypoint"
echo "=========================================="
echo "BOT_NAME:         ${BOT_NAME:-<not set>}"
echo "BOT_PERSONA_FILE: ${BOT_PERSONA_FILE:-<not set>}"
echo "AGENT_ID:         ${AGENT_ID:-<not set>}"
echo "PORT:             ${PORT:-3456}"
echo "NODE_ENV:         ${NODE_ENV:-production}"
echo "=========================================="

CONFIG_DIR="${CONFIG_OUTPUT_DIR:-./output}"
mkdir -p "$CONFIG_DIR"

# ── Step 1: Cline CLI auth setup (same as oshal) ─────────────────────────────
if [ -f /app/scripts/setup-cline-auth.sh ]; then
  echo "[bot-entrypoint] Running setup-cline-auth.sh ..."
  bash /app/scripts/setup-cline-auth.sh 2>&1 || echo "[bot-entrypoint] setup-cline-auth.sh completed with warnings (non-fatal)"
fi

# ── Step 1b: Shared config seed (swarm-level provider config) ────────────────
# If a config-seed directory exists with global-config.json or secrets.json,
# copy them to the per-bot output dir (only if not already present).
# This enables "configure once, apply to all bots" workflow.
SEED_DIR="/app/config-seed"
if [ -d "$SEED_DIR" ]; then
  for f in global-config.json secrets.json llm-config.json; do
    if [ -f "$SEED_DIR/$f" ] && [ ! -f "$CONFIG_DIR/$f" ]; then
      cp "$SEED_DIR/$f" "$CONFIG_DIR/$f"
      echo "[bot-entrypoint] Seeded $f from shared config-seed"
    fi
  done
fi

# ── Step 1c: Platform-repo working copy (ADR-081, oshal-developer) ───────────
# When OSHAL_DEV_REPO_URL is set this bot develops OSHAL itself: keep its OWN
# clone at /app/dev-repo (a named volume — NEVER the live/deployed tree, which is
# hot-swap-mounted on the api). Idempotent (clone-if-missing else refresh) and
# non-fatal: a bot with a stale or absent clone still boots and reports the state.
if [ -n "${OSHAL_DEV_REPO_URL:-}" ]; then
  DEV_REPO_DIR="${OSHAL_DEV_REPO_DIR:-/app/dev-repo}"
  DEV_REPO_BRANCH="${OSHAL_DEV_REPO_BRANCH:-main}"
  dev_repo_setup() {
    # The SECRET is never persisted: not in any .gitconfig, not in the remote URL, not
    # on the dev-repo volume. The helper is an env-reading shim with a fallback to a
    # container-local (NON-volume, dies-with-container) token file — needed because the
    # codex harness spawns ticket work with HOME=<workspace>/.codex-home and a scrubbed
    # env, so neither the GLOBAL gitconfig nor the entrypoint's env reach ticket-time git
    # (live failure 2026-07-09: "could not read Username for https://github.com").
    if [ -n "${OSHAL_DEV_REPO_TOKEN:-}" ]; then
      printf '%s' "$OSHAL_DEV_REPO_TOKEN" > /run/oshal-dev-token && chmod 600 /run/oshal-dev-token
    fi
    DEV_CRED_HELPER='!f() { echo "username=x-access-token"; echo "password=${OSHAL_DEV_REPO_TOKEN:-$(cat /run/oshal-dev-token 2>/dev/null)}"; }; f'
    git config --global credential.helper "$DEV_CRED_HELPER" || return 1
    if [ ! -d "$DEV_REPO_DIR/.git" ]; then
      echo "[bot-entrypoint] Cloning platform repo ($DEV_REPO_BRANCH) into $DEV_REPO_DIR ..."
      git clone --branch "$DEV_REPO_BRANCH" "$OSHAL_DEV_REPO_URL" "$DEV_REPO_DIR" || return 1
    fi
    cd "$DEV_REPO_DIR" || return 1
    # REPO-LOCAL helper is the one ticket-time git actually loads (HOME-independent).
    git config --local credential.helper "$DEV_CRED_HELPER"
    git config core.hooksPath .githooks           # the repo's versioned guard hooks gate bot commits too
    git config user.name "OSHAL Developer Bot"
    git config user.email "maintainer@emeraldcoastsystemsgroup.com"
    git fetch origin "$DEV_REPO_BRANCH" 2>/dev/null && git pull --rebase origin "$DEV_REPO_BRANCH" 2>/dev/null \
      || echo "[bot-entrypoint] dev-repo refresh failed (offline or no token) — continuing with the existing checkout"
    echo "[bot-entrypoint] dev-repo ready at $(git rev-parse --short HEAD 2>/dev/null || echo '<unknown>') on $DEV_REPO_BRANCH"
    cd /app || return 1
  }
  dev_repo_setup || { echo "[bot-entrypoint] dev-repo setup failed (non-fatal) — the bot boots without a working clone"; cd /app; }
fi

# ── Step 2: Persona loading ──────────────────────────────────────────────────
if [ -n "$BOT_PERSONA_FILE" ] && [ -f "$BOT_PERSONA_FILE" ]; then
  echo "[bot-entrypoint] Loading bot persona from $BOT_PERSONA_FILE ..."

  # Extract fields using yq (installed in Dockerfile — mikefarah/yq v4)
  # Note: use // "" not // empty (empty is jq syntax, not yq)
  YAML_NAME=$(yq -r '.name // ""' "$BOT_PERSONA_FILE")
  YAML_ROLE=$(yq -r '.role // ""' "$BOT_PERSONA_FILE")
  YAML_AGENT_ID=$(yq -r '.agent_id // .name // ""' "$BOT_PERSONA_FILE")
  YAML_PERSPECTIVE=$(yq -r '.perspective // ""' "$BOT_PERSONA_FILE")
  YAML_CAPABILITIES=$(yq -r '(.capabilities // []) | join(",")' "$BOT_PERSONA_FILE")
  YAML_MAX_CONCURRENT=$(yq -r '.max_concurrent // 3' "$BOT_PERSONA_FILE")
  YAML_SCOPE=$(yq -r '.scope // "shared"' "$BOT_PERSONA_FILE")
  YAML_SELECTOR=$(yq -r '.selector_descriptor // ""' "$BOT_PERSONA_FILE")

  # Resolve effective values (env overrides YAML)
  EFFECTIVE_NAME="${BOT_NAME:-$YAML_NAME}"
  EFFECTIVE_AGENT_ID="${AGENT_ID:-$YAML_AGENT_ID}"

  # Write bot persona as JSON for the Node.js server to consume via readJsonConfig
  # Using jq for safe JSON serialization of multi-line strings
  jq -n \
    --arg name "$EFFECTIVE_NAME" \
    --arg role "$YAML_ROLE" \
    --arg agentId "$EFFECTIVE_AGENT_ID" \
    --arg perspective "$YAML_PERSPECTIVE" \
    --arg capabilities "$YAML_CAPABILITIES" \
    --arg maxConcurrent "$YAML_MAX_CONCURRENT" \
    --arg scope "$YAML_SCOPE" \
    --arg selectorDescriptor "$YAML_SELECTOR" \
    --arg personaFile "$BOT_PERSONA_FILE" \
    '{
      name: $name,
      role: $role,
      agentId: $agentId,
      perspective: $perspective,
      capabilities: $capabilities,
      maxConcurrent: ($maxConcurrent | tonumber),
      scope: $scope,
      selectorDescriptor: $selectorDescriptor,
      personaFile: $personaFile
    }' > "$CONFIG_DIR/bot-persona.json"

  echo "[bot-entrypoint] Bot persona written to $CONFIG_DIR/bot-persona.json"
  echo "[bot-entrypoint]   name=$EFFECTIVE_NAME  role=$YAML_ROLE  agentId=$EFFECTIVE_AGENT_ID"
  echo "[bot-entrypoint]   capabilities=$YAML_CAPABILITIES"
else
  echo "[bot-entrypoint] No BOT_PERSONA_FILE set or file not found — using default Cline persona"
fi

# ── Step 3: Redis registration (announce presence) ───────────────────────────
if [ -n "$REDIS_URL" ] && command -v redis-cli >/dev/null 2>&1; then
  EFFECTIVE_NAME="${BOT_NAME:-agent}"
  EFFECTIVE_PORT="${PORT:-5000}"
  echo "[bot-entrypoint] Registering with Redis at $REDIS_URL as $EFFECTIVE_NAME on port $EFFECTIVE_PORT ..."
  # Non-fatal — if Redis is not yet up, the server will retry at runtime
  redis-cli -u "$REDIS_URL" SET "bot:${EFFECTIVE_NAME}:status" "starting" EX 300 2>/dev/null || true
fi

# ── Step 4: Start the server ─────────────────────────────────────────────────
# BOT_RUNTIME controls which server process starts:
#   "swarm"    → swarm controller (node dist/app/server.js) — handles orchestration
#   "bot-node" → first-class worker (node dist/app/bot-node-server.js) — handles LLM execution
#   "any-bot"  → slim legacy/testing server (node any-bot/server/app.js)
#   (default)  → swarm controller (backward compatible)
#
# Per any-bot-swarm-separation-design.md:
#   - Bot containers run BOT_RUNTIME=bot-node (they own LLM execution)
#   - The API/PM container runs BOT_RUNTIME=swarm or omits it (orchestration only)

BOT_RUNTIME="${BOT_RUNTIME:-swarm}"

if [ "$BOT_RUNTIME" = "any-bot" ]; then
  if [ -n "${OSHAL_DELEGATION_PUBLIC_KEYS:-}" ] || [ -n "${OSHAL_DELEGATION_SIGNING_PRIVATE_KEY:-}" ]; then
    echo "[bot-entrypoint] FATAL: BOT_RUNTIME=any-bot cannot run while HTTP delegation enforcement is configured." >&2
    echo "[bot-entrypoint] Use BOT_RUNTIME=bot-node; the legacy runtime has no Ed25519 verifier or shared replay ledger." >&2
    exit 78
  fi
  echo "[bot-entrypoint] ANY-BOT RUNTIME — starting any-bot server (LLM execution node) ..."
  echo "[bot-entrypoint]   The swarm controller dispatches work to this node via HTTP."
  echo "[bot-entrypoint]   This node handles: provider config, credentials, CLI spawning, cost capture."

  # Any-bot uses its own port (default 5000)
  export PORT="${PORT:-5000}"

  # Slim any-bot HTTP server (no swarm participation — legacy/testing only)
  # Canonical server: preserves owner scoping, BYO routing, and provider records.
  # swarm-node.js is a legacy harness and is not a supported BOT_RUNTIME target.
  exec node any-bot/server/app.js

elif [ "$BOT_RUNTIME" = "bot-node" ]; then
  echo "[bot-entrypoint] BOT-NODE RUNTIME — first-class swarm participant (TypeScript + any-bot providers)"
  echo "[bot-entrypoint]   Consumes own Redis envelopes. Executes via any-bot LLM stack."
  echo "[bot-entrypoint]   No cockpit, no OIDC, no Plane, no voice."
  export PORT="${PORT:-5000}"
  exec node dist/app/bot-node-server.js

elif [ "$NODE_ENV" = "development" ]; then
  echo "[bot-entrypoint] DEV MODE — installing dev deps for hot-swap ..."
  npm install --legacy-peer-deps --prefer-offline 2>&1 | tail -5

  echo "[bot-entrypoint] Starting dev server with hot-swap (nodemon + ts-node) ..."
  exec npx nodemon \
    --watch src \
    --ext ts,js,json,html,css \
    --ignore "src/pages/chat/ui/dist/**" \
    --ignore "src/api/dist/**" \
    --ignore "node_modules/**" \
    --exec "npx ts-node --project tsconfig.json -r tsconfig-paths/register src/app/server.ts" \
    --signal SIGTERM \
    --delay 1
else
  echo "[bot-entrypoint] PRODUCTION MODE — starting compiled server ..."
  exec node dist/app/server.js
fi
