#!/usr/bin/env bash
# =============================================================================
# OSHAL Local Agent — run the SAME server every Docker bot runs, on bare metal
# =============================================================================
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Local agent launcher — identical to Docker bot, runs on host, full cockpit + chat + swarm
# =============================================================================
#
# This is NOT a separate app. It runs the same src/app/server.ts that every
# Docker bot runs. You get /chat, /cockpit, bot settings, MCP config — everything.
# The only difference is it runs on your Mac/PC instead of in a container.
#
# Usage:
#   ./scripts/start-local-agent.sh                    # local dev (localhost Redis + Postgres)
#   REDIS_URL=redis://100.64.0.2:6379 \
#   DATABASE_URL=postgresql://oshal:oshalpass@100.64.0.2:5432/oshal \
#     ./scripts/start-local-agent.sh                  # remote swarm over VPN
# =============================================================================

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Source .env for secrets (same as Docker env_file) ─────────────────────────
# Save PORT before sourcing because .env has the container-internal PORT (3456/5000)
_SAVED_PORT="${PORT:-}"
if [[ -f "$PROJECT_DIR/.env" ]]; then
  set -a
  source "$PROJECT_DIR/.env"
  set +a
fi
# Restore local agent port — .env PORT is for Docker containers, not localhost
export PORT="${_SAVED_PORT:-3099}"

# ── Sync API key into Cline CLI config (Docker bots do this via bot-entrypoint) ─
if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
  CLINE_CFG="${HOME}/.cline/config.json"
  mkdir -p "$(dirname "$CLINE_CFG")"
  if [[ -f "$CLINE_CFG" ]]; then
    node -e "
      const fs = require('fs');
      const cfg = JSON.parse(fs.readFileSync('$CLINE_CFG','utf8'));
      cfg.anthropicApiKey = process.env.ANTHROPIC_API_KEY;
      fs.writeFileSync('$CLINE_CFG', JSON.stringify(cfg, null, 2));
    " 2>/dev/null
  else
    echo "{\"anthropicApiKey\":\"${ANTHROPIC_API_KEY}\"}" > "$CLINE_CFG"
  fi
fi

# ── Stable agent ID (persisted across restarts) ─────────────────────────────
EDGE_ID_FILE="${HOME}/.oshal-edge-agent-id"
if [[ -z "${AGENT_ID:-}" ]]; then
  if [[ -f "$EDGE_ID_FILE" ]]; then
    export AGENT_ID="$(cat "$EDGE_ID_FILE")"
  else
    export AGENT_ID="$(uuidgen 2>/dev/null || node -e "console.log(require('crypto').randomUUID())" | tr '[:upper:]' '[:lower:]')"
    echo "$AGENT_ID" > "$EDGE_ID_FILE"
  fi
fi

# ── Identity ─────────────────────────────────────────────────────────────────
export BOT_NAME="${BOT_NAME:-edge-$(hostname -s 2>/dev/null || echo local)}"
export BOT_ROLE="${BOT_ROLE:-edge/local-executor}"
export AGENT_CAPABILITIES="${AGENT_CAPABILITIES:-edge-agent,mcp,local-executor}"

# ── Infrastructure (defaults for local dev, override for remote) ─────────────
export REDIS_URL="${REDIS_URL:-redis://localhost:6379}"
export DATABASE_URL="${DATABASE_URL:-postgresql://oshal:oshalpass@localhost:5432/oshal}"
export CHROMADB_URL="${CHROMADB_URL:-http://localhost:8000}"

# ── Server config ────────────────────────────────────────────────────────────
export HOST="${HOST:-0.0.0.0}"
export NODE_ENV="${NODE_ENV:-development}"
export CONFIG_OUTPUT_DIR="${CONFIG_OUTPUT_DIR:-${PROJECT_DIR}/output-local-agent}"
export CONFIG_WRITE_MODE="${CONFIG_WRITE_MODE:-split}"

# ── Swarm mode (same as Docker bots) ────────────────────────────────────────
export SWARM_MODE="container"
export ENABLE_AGENT_SWARM="true"
export ENABLE_QUEUE_MANAGER="false"
export ENABLE_AGENT_SCHEDULER="false"
export RUN_MIGRATIONS="false"
export MOCK_OIDC="${MOCK_OIDC:-true}"

# ── LLM (inherit from environment or use defaults) ──────────────────────────
export LLM_PROVIDER="${LLM_PROVIDER:-claude-code}"
export LLM_MODEL="${LLM_MODEL:-claude-sonnet-4-5-20250929}"

# ── Output dir + config seed (same as bot-entrypoint.sh) ─────────────────────
mkdir -p "$CONFIG_OUTPUT_DIR"
SEED_DIR="$PROJECT_DIR/config-seed"
if [[ -d "$SEED_DIR" ]]; then
  for f in global-config.json secrets.json llm-config.json; do
    if [[ -f "$SEED_DIR/$f" ]]; then
      cp "$SEED_DIR/$f" "$CONFIG_OUTPUT_DIR/$f"
    fi
  done
fi

echo ""
echo "  ┌──────────────────────────────────────────────────┐"
echo "  │  OSHAL Local Agent                               │"
echo "  ├──────────────────────────────────────────────────┤"
echo "  │  AGENT_ID : ${AGENT_ID}"
echo "  │  BOT_NAME : ${BOT_NAME}"
echo "  │  PORT     : ${PORT}"
echo "  │  REDIS    : ${REDIS_URL}"
echo "  │  POSTGRES : ${DATABASE_URL}"
echo "  │  CHROMA   : ${CHROMADB_URL}"
echo "  └──────────────────────────────────────────────────┘"
echo ""
echo "  Open in browser: http://localhost:${PORT}"
echo ""

cd "$PROJECT_DIR"
exec npx ts-node --project tsconfig.json -r tsconfig-paths/register src/app/server.ts
