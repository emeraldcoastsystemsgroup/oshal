#!/usr/bin/env bash
# =============================================================================
# OSHAL Edge Agent Launcher
# =============================================================================
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Edge agent launcher — auto-detects local vs remote Redis, generates stable AGENT_ID
# =============================================================================
#
# Usage:
#   ./scripts/start-edge-agent.sh                # local dev (auto-detects Redis)
#   ./scripts/start-edge-agent.sh --remote       # prompts for Headscale Redis URL
#
# Override anything via env vars:
#   REDIS_URL=redis://100.64.0.2:6379 AGENT_ID=... ./scripts/start-edge-agent.sh
# =============================================================================

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Stable agent ID ─────────────────────────────────────────────────────────
# Generate once, persist in ~/.oshal-edge-agent-id so restarts keep the same identity.
EDGE_ID_FILE="${HOME}/.oshal-edge-agent-id"

if [[ -z "${AGENT_ID:-}" ]]; then
  if [[ -f "$EDGE_ID_FILE" ]]; then
    AGENT_ID="$(cat "$EDGE_ID_FILE")"
    echo "  Using persisted AGENT_ID: $AGENT_ID (from $EDGE_ID_FILE)"
  else
    AGENT_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
    echo "$AGENT_ID" > "$EDGE_ID_FILE"
    echo "  Generated new AGENT_ID: $AGENT_ID (saved to $EDGE_ID_FILE)"
  fi
fi
export AGENT_ID

# ── Bot identity defaults ───────────────────────────────────────────────────
export BOT_NAME="${BOT_NAME:-edge-$(hostname -s 2>/dev/null || echo 'local')}"
export BOT_ROLE="${BOT_ROLE:-edge/local-executor}"

# ── Redis URL detection ─────────────────────────────────────────────────────
if [[ -z "${REDIS_URL:-}" ]]; then
  if [[ "${1:-}" == "--remote" ]]; then
    echo ""
    echo "  Remote mode — enter the Redis URL reachable over Headscale VPN."
    echo "  Example: redis://100.64.0.2:6379"
    echo ""
    read -rp "  REDIS_URL: " REDIS_URL
    if [[ -z "$REDIS_URL" ]]; then
      echo "ERROR: REDIS_URL is required in remote mode" >&2
      exit 1
    fi
  else
    # Local dev: try the swarm-local Redis on 6379, then core on 56379
    REDIS_URL="redis://localhost:6379"
    echo "  Local dev mode — using REDIS_URL=$REDIS_URL"
  fi
fi
export REDIS_URL

# ── MCP server (optional) ──────────────────────────────────────────────────
# Set MCP_COMMAND and MCP_ARGS env vars to attach a local MCP server.
# Example:
#   export MCP_COMMAND=npx
#   export MCP_ARGS='["@modelcontextprotocol/server-filesystem", "/Users/me/projects"]'

echo ""
echo "  ┌─────────────────────────────────────────────┐"
echo "  │  OSHAL Edge Agent                           │"
echo "  ├─────────────────────────────────────────────┤"
echo "  │  AGENT_ID : ${AGENT_ID}  │"
echo "  │  BOT_NAME : ${BOT_NAME}"
echo "  │  REDIS_URL: ${REDIS_URL}"
if [[ -n "${MCP_COMMAND:-}" ]]; then
echo "  │  MCP      : ${MCP_COMMAND} ${MCP_ARGS:-}"
else
echo "  │  MCP      : (none — set MCP_COMMAND to enable)"
fi
echo "  └─────────────────────────────────────────────┘"
echo ""

cd "$PROJECT_DIR"
exec npx ts-node -r tsconfig-paths/register scripts/edge-agent.ts
