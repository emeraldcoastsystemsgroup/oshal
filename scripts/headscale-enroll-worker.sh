#!/usr/bin/env bash
# =============================================================================
# OSHAL Headscale Worker Enrollment — ephemeral, pre-tagged pre-auth keys
# =============================================================================
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | New enrollment helper (hardening.md #15/#16): mints a single-use EPHEMERAL pre-auth key pre-tagged tag:worker (1h expiry) via docker exec against the local oshal-headscale container, so worker nodes are automatically scoped by the hardened ACL and their node records vanish on disconnect. Replaces the never-built /api/vpn/enroll route the staged policy used to reference, and supersedes handing out long-lived reusable keys for workers.
# =============================================================================
#
# Run this on the machine hosting the swarm (where the oshal-headscale container runs).
# It prints ONE ephemeral, tag:worker pre-auth key valid for 1 hour. Hand that key to the
# joining worker machine — it is single-use and expires, so nothing durable leaks if the
# handoff channel is compromised.
#
# On the WORKER machine, join with:
#   tailscale up --login-server <headscale-url> --authkey <printed-key> --accept-dns=false
# (Windows workers: scripts/start-local-agent.bat consumes HEADSCALE_AUTHKEY or
#  %USERPROFILE%\.oshal-headscale-authkey and runs the same command.)
#
# NOT for admin/controller machines: ephemeral nodes drop out of the mesh on disconnect.
# Enroll those with a non-ephemeral key (scripts/headscale-setup.sh) and tag them by hand:
#   docker exec oshal-headscale headscale nodes tag -i <id> -t tag:operator
#
# Usage:
#   ./scripts/headscale-enroll-worker.sh                 # user 'agentmesh', 1h expiry
#   HEADSCALE_USER=other ./scripts/headscale-enroll-worker.sh
#   KEY_EXPIRATION=30m ./scripts/headscale-enroll-worker.sh
# =============================================================================

set -euo pipefail

CONTAINER="${HEADSCALE_CONTAINER:-oshal-headscale}"
USER_NAME="${HEADSCALE_USER:-agentmesh}"
KEY_EXPIRATION="${KEY_EXPIRATION:-1h}"
WORKER_TAG="tag:worker"

echo ""
echo "  OSHAL Headscale Worker Enrollment"
echo "  ────────────────────────────────────────"

# ── Step 1: The headscale container must be up ──────────────────────────────
if ! docker exec "$CONTAINER" headscale health &>/dev/null; then
  echo "  ERROR: headscale container '$CONTAINER' is not running or not healthy." >&2
  echo "         Start it first: bash scripts/headscale-setup.sh" >&2
  exit 1
fi

# ── Step 2: Resolve the numeric user id ─────────────────────────────────────
# headscale >= 0.29 requires `preauthkeys create --user <ID>` (numeric), not a name.
# Same resolution pattern as scripts/headscale-setup.sh.
USER_ID="$(docker exec "$CONTAINER" headscale users list -o json 2>/dev/null \
  | python3 -c "import json,sys;print(next((u['id'] for u in json.load(sys.stdin) if u['name']=='$USER_NAME'),''))" 2>/dev/null || true)"
if [[ -z "$USER_ID" ]]; then
  # No python3? Fall back to node (present on the swarm host).
  USER_ID="$(docker exec "$CONTAINER" headscale users list -o json 2>/dev/null \
    | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const u=JSON.parse(d).find(u=>u.name==='$USER_NAME');process.stdout.write(u?String(u.id):'')})" 2>/dev/null || true)"
fi
if [[ -z "$USER_ID" ]]; then
  echo "  ERROR: could not resolve a numeric id for headscale user '$USER_NAME'." >&2
  echo "         Create the user first: bash scripts/headscale-setup.sh" >&2
  exit 1
fi
echo "  User: $USER_NAME (id $USER_ID)"

# ── Step 3: Mint an ephemeral, pre-tagged, single-use key ───────────────────
# --ephemeral : the node's record is removed when it disconnects (right for workers,
#               wrong for admin/controller machines — see header).
# --tags      : the joining node is born carrying tag:worker, so the hardened ACL
#               (infra/headscale/config/policy.hujson) scopes it immediately;
#               no post-join `nodes tag` step, no untagged window.
# NOT --reusable: one key, one machine, then dead.
KEY_OUTPUT=$(docker exec "$CONTAINER" headscale preauthkeys create \
  --user "$USER_ID" \
  --ephemeral \
  --tags "$WORKER_TAG" \
  --expiration "$KEY_EXPIRATION" \
  -o json 2>&1)

AUTH_KEY=$(echo "$KEY_OUTPUT" | sed -nE 's/.*"key"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' | head -1)
if [[ -z "$AUTH_KEY" ]]; then
  echo "  ERROR: could not parse a pre-auth key out of headscale's response:" >&2
  echo "$KEY_OUTPUT" >&2
  exit 1
fi

# ── Step 4: Print the one-time key + join command ───────────────────────────
SERVER_URL="$(awk '/^server_url:/ {print $2; exit}' "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/infra/headscale/config/config.yaml" 2>/dev/null || true)"
[[ -z "$SERVER_URL" ]] && SERVER_URL="<headscale-url>"

echo ""
echo "  Ephemeral worker key (single-use, $KEY_EXPIRATION, pre-tagged $WORKER_TAG):"
echo ""
echo "    $AUTH_KEY"
echo ""
echo "  On the WORKER machine:"
echo ""
echo "    tailscale up --login-server $SERVER_URL --authkey <the-key> --accept-dns=false"
echo ""
echo "  Windows workers: set HEADSCALE_AUTHKEY (or write the key as the single line of"
echo "  %USERPROFILE%\\.oshal-headscale-authkey) and run scripts\\start-local-agent.bat."
echo ""
echo "  The key dies after one use or $KEY_EXPIRATION, whichever comes first."
echo ""
