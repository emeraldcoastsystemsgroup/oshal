#!/bin/sh
# =============================================================================
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation — swarm-level config seeding for per-bot containers
# =============================================================================
#
# @description Seeds shared provider config to all bot containers.
# Place your global-config.json and/or secrets.json in ./config-seed/
# and all bots will inherit them on next restart (if they don't already have local overrides).
#
# Usage:
#   ./scripts/seed-swarm-config.sh                    # Interactive — prompts for API key
#   ANTHROPIC_API_KEY=sk-... ./scripts/seed-swarm-config.sh   # Non-interactive
#
# After seeding:
#   docker compose -f docker-compose.swarm-local.yml restart
# =============================================================================

set -e

SEED_DIR="$(dirname "$0")/../config-seed"
mkdir -p "$SEED_DIR"

echo "=========================================="
echo " OSHAL Swarm Config Seeder"
echo "=========================================="
echo "Seed directory: $SEED_DIR"
echo ""

# ── Provider config ──────────────────────────────────────────────────────────
if [ ! -f "$SEED_DIR/global-config.json" ]; then
  PROVIDER="${LLM_PROVIDER:-claude-code}"
  MODEL="${LLM_MODEL:-claude-sonnet-4-5-20250929}"

  echo "Creating global-config.json with provider=$PROVIDER model=$MODEL"
  cat > "$SEED_DIR/global-config.json" <<EOF
{
  "mode": "act",
  "actModeApiProvider": "$PROVIDER",
  "actModeApiModelId": "$MODEL",
  "planModeApiProvider": "$PROVIDER",
  "planModeApiModelId": "$MODEL"
}
EOF
  echo "  ✅ Written: $SEED_DIR/global-config.json"
else
  echo "  ⏭  global-config.json already exists — skipping"
fi

# ── API key / secrets ────────────────────────────────────────────────────────
if [ ! -f "$SEED_DIR/secrets.json" ]; then
  API_KEY="${ANTHROPIC_API_KEY:-}"

  if [ -z "$API_KEY" ]; then
    echo ""
    echo "No ANTHROPIC_API_KEY env var set."
    echo "Enter your Anthropic API key (or press Enter to skip):"
    read -r API_KEY
  fi

  if [ -n "$API_KEY" ]; then
    cat > "$SEED_DIR/secrets.json" <<EOF
{
  "anthropicApiKey": "$API_KEY"
}
EOF
    echo "  ✅ Written: $SEED_DIR/secrets.json"
  else
    echo "  ⏭  No API key provided — secrets.json not created"
    echo "     Bots will use ANTHROPIC_API_KEY from .env if set"
  fi
else
  echo "  ⏭  secrets.json already exists — skipping"
fi

echo ""
echo "=========================================="
echo " Config seed ready. To apply:"
echo "   1. Restart containers:"
echo "      docker compose -f docker-compose.swarm-local.yml restart"
echo "   2. Or to force re-seed (delete existing per-bot configs):"
echo "      docker compose -f docker-compose.swarm-local.yml down -v"
echo "      docker compose -f docker-compose.swarm-local.yml up -d"
echo "=========================================="