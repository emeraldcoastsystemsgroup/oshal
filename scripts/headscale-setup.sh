#!/usr/bin/env bash
# =============================================================================
# OSHAL Headscale Bootstrap
# =============================================================================
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | One-shot Headscale setup: detect LAN IP, configure, start, create user + authkey, print Tailscale connect command
# =============================================================================
#
# Run this on the machine hosting the swarm (where Docker Compose runs).
# It will:
#   1. Detect your LAN IP
#   2. Write the correct server_url into the Headscale config
#   3. Start the Headscale container
#   4. Create the 'agentmesh' user
#   5. Generate a reusable pre-auth key (24h expiry)
#   6. Print the exact Tailscale command to run on edge-agent machines
#
# Usage:
#   ./scripts/headscale-setup.sh
#   ./scripts/headscale-setup.sh 192.168.1.50    # override LAN IP detection
# =============================================================================

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
HEADSCALE_DIR="$PROJECT_DIR/infra/headscale"

echo ""
echo "  OSHAL Headscale Bootstrap"
echo "  ────────────────────────────────────────"

# ── Step 1: Detect LAN IP ───────────────────────────────────────────────────
if [[ -n "${1:-}" ]]; then
  LAN_IP="$1"
  echo "  Using provided IP: $LAN_IP"
else
  # macOS: route + ifconfig.  Linux: hostname -I
  if command -v route &>/dev/null && [[ "$(uname)" == "Darwin" ]]; then
    IFACE="$(route -n get default 2>/dev/null | awk '/interface:/ {print $2}')"
    LAN_IP="$(ifconfig "$IFACE" 2>/dev/null | awk '/inet / && !/127.0.0.1/ {print $2; exit}')"
  elif command -v hostname &>/dev/null; then
    LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
  fi

  if [[ -z "${LAN_IP:-}" ]]; then
    echo "  ERROR: Could not detect LAN IP. Pass it as an argument:" >&2
    echo "    ./scripts/headscale-setup.sh 192.168.1.50" >&2
    exit 1
  fi
  echo "  Detected LAN IP: $LAN_IP"
fi

# ── Step 2: Write server_url into Headscale config ──────────────────────────
# Port 8085, NOT 8080. infra/headscale/docker-compose.yaml publishes "8085:8080":
# 8080 is the container-internal listen_addr and nothing listens on it from the host.
# This script used to hardcode :8080 and then sed it over a working config, silently
# breaking every node that had already joined.
HEADSCALE_PORT="${HEADSCALE_PORT:-8085}"
HEADSCALE_URL="http://${LAN_IP}:${HEADSCALE_PORT}"
CONFIG_FILE="$HEADSCALE_DIR/config/config.yaml"

if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "  ERROR: Headscale config not found at $CONFIG_FILE" >&2
  exit 1
fi

# Never rewrite a server_url that already works. Re-running setup on a live mesh must
# not change the address existing nodes dial. Override deliberately with FORCE_SERVER_URL=1.
EXISTING_URL="$(awk '/^server_url:/ {print $2; exit}' "$CONFIG_FILE" 2>/dev/null || true)"
if [[ -n "$EXISTING_URL" && "$EXISTING_URL" != "$HEADSCALE_URL" && "${FORCE_SERVER_URL:-0}" != "1" ]]; then
  echo "  Keeping the existing server_url: $EXISTING_URL"
  echo "  (detected LAN IP suggests $HEADSCALE_URL — set FORCE_SERVER_URL=1 to overwrite,"
  echo "   but every node that already joined dials the old address.)"
  HEADSCALE_URL="$EXISTING_URL"
elif grep -q '^server_url:' "$CONFIG_FILE"; then
  sed -i.bak "s|^server_url:.*|server_url: ${HEADSCALE_URL}|" "$CONFIG_FILE"
  rm -f "${CONFIG_FILE}.bak"
  echo "  Updated config: server_url: $HEADSCALE_URL"
else
  echo "  WARNING: No server_url line found in config — adding it" >&2
  echo "server_url: ${HEADSCALE_URL}" >> "$CONFIG_FILE"
fi

# ── Step 3: Create data directories ─────────────────────────────────────────
mkdir -p "$HEADSCALE_DIR/data/lib" "$HEADSCALE_DIR/data/run"

# ── Step 4: Start Headscale container ───────────────────────────────────────
echo "  Starting Headscale container..."
docker compose -f "$HEADSCALE_DIR/docker-compose.yaml" up -d

# Wait for it to be healthy
echo -n "  Waiting for Headscale to be healthy"
for i in $(seq 1 30); do
  if docker exec oshal-headscale headscale health &>/dev/null; then
    echo " OK"
    break
  fi
  echo -n "."
  sleep 2
  if [[ $i -eq 30 ]]; then
    echo ""
    echo "  ERROR: Headscale didn't become healthy in 60s" >&2
    docker logs oshal-headscale --tail 20
    exit 1
  fi
done

# ── Step 5: Create user ────────────────────────────────────────────────────
# `users create` still takes a positional NAME. Only `preauthkeys create --user`
# changed to a numeric id (headscale >= 0.29), so resolve the id here.
USER_NAME="agentmesh"
if docker exec oshal-headscale headscale users list 2>/dev/null | grep -q "$USER_NAME"; then
  echo "  User '$USER_NAME' already exists"
else
  docker exec oshal-headscale headscale users create "$USER_NAME"
  echo "  Created user: $USER_NAME"
fi

USER_ID="$(docker exec oshal-headscale headscale users list -o json 2>/dev/null \
  | python3 -c "import json,sys;print(next((u['id'] for u in json.load(sys.stdin) if u['name']=='$USER_NAME'),''))" 2>/dev/null || true)"
if [[ -z "$USER_ID" ]]; then
  # No python3? Fall back to a grep/sed pass over the JSON.
  USER_ID="$(docker exec oshal-headscale headscale users list -o json 2>/dev/null \
    | tr ',' '\n' | grep -B0 -A0 '"id"' | head -1 | sed -E 's/[^0-9]//g')"
fi
if [[ -z "$USER_ID" ]]; then
  echo "  ERROR: could not resolve the numeric id for user '$USER_NAME'." >&2
  echo "         headscale >= 0.29 requires 'preauthkeys create --user <ID>', not a name." >&2
  exit 1
fi
echo "  User id: $USER_ID"

# ── Step 6: Generate pre-auth key ──────────────────────────────────────────
echo "  Generating reusable pre-auth key (24h expiry)..."
AUTH_KEY_OUTPUT=$(docker exec oshal-headscale headscale preauthkeys create \
  --user "$USER_ID" \
  --reusable \
  --expiration 24h \
  -o json 2>&1)

# Parse the JSON. v0.29 keys are shaped `hskey-auth-<mixed case, hyphens, underscores>`,
# so the old '[a-f0-9]{48,}' regex matched nothing and the fallback then assigned the
# entire stdout blob as the "key".
AUTH_KEY=$(echo "$AUTH_KEY_OUTPUT" | sed -nE 's/.*"key"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' | head -1)
if [[ -z "$AUTH_KEY" ]]; then
  echo "  ERROR: could not parse a pre-auth key out of headscale's response:" >&2
  echo "$AUTH_KEY_OUTPUT" >&2
  exit 1
fi

# ── Step 7: Print results ──────────────────────────────────────────────────
echo ""
echo "  ╔═══════════════════════════════════════════════════════════════╗"
echo "  ║  Headscale is running!                                       ║"
echo "  ╠═══════════════════════════════════════════════════════════════╣"
echo "  ║                                                               ║"
echo "  ║  Server URL : $HEADSCALE_URL"
echo "  ║  User       : $USER_NAME"
echo "  ║                                                               ║"
echo "  ║  Pre-auth key (24h, reusable):                               ║"
echo "  ║  $AUTH_KEY"
echo "  ║                                                               ║"
echo "  ╠═══════════════════════════════════════════════════════════════╣"
echo "  ║  On the EDGE AGENT machine (Mac/PC), install Tailscale and   ║"
echo "  ║  run:                                                         ║"
echo "  ║                                                               ║"
echo "  ║  tailscale up \\                                              ║"
echo "  ║    --login-server $HEADSCALE_URL \\                           ║"
echo "  ║    --authkey $AUTH_KEY \\                                     ║"
echo "  ║    --accept-dns=false                                        ║"
echo "  ║                                                               ║"
echo "  ║  Then find this server's Tailscale IP:                       ║"
echo "  ║    tailscale status                                          ║"
echo "  ║                                                               ║"
echo "  ║  And start the edge agent:                                   ║"
echo "  ║    REDIS_URL=redis://<this-server-tailscale-ip>:6379 \\      ║"
echo "  ║    ./scripts/start-edge-agent.sh                             ║"
echo "  ╚═══════════════════════════════════════════════════════════════╝"
echo ""

# Also enroll THIS machine so it gets a Tailscale IP that edge agents can reach
if command -v tailscale &>/dev/null; then
  echo "  Tailscale is installed on this machine."
  TS_STATUS=$(tailscale status 2>&1 || true)
  if echo "$TS_STATUS" | grep -q "Tailscale is stopped"; then
    echo "  Enrolling this machine into the Headscale mesh..."
    sudo tailscale up \
      --login-server "$HEADSCALE_URL" \
      --authkey "$AUTH_KEY" \
      --accept-dns=false
    echo "  This machine is now on the Headscale mesh."
    echo "  Tailscale IP: $(tailscale ip -4 2>/dev/null || echo '(check: tailscale ip -4)')"
    echo ""
    echo "  Edge agents should use:"
    echo "    REDIS_URL=redis://$(tailscale ip -4 2>/dev/null || echo '<tailscale-ip>'):6379"
  else
    echo "  Tailscale status: already running or connected."
    echo "  Tailscale IP: $(tailscale ip -4 2>/dev/null || echo '(check: tailscale ip -4)')"
  fi
else
  echo "  NOTE: Tailscale is NOT installed on this machine."
  echo "  Install it (https://tailscale.com/download) so this machine"
  echo "  gets a Tailscale IP that edge agents can route to."
fi
