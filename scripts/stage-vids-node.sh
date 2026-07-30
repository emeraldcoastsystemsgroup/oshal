#!/usr/bin/env bash
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ | AUTHOR                                    | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Stage the render node's copy of the vids-operator renderer, and smoke-test it. Written after finding the node missing episode-render.js AND the whole renderer src/ — the render stage could not have run, and nothing said so.
#
# THE PROBLEM THIS SOLVES
#
# The render node runs a COPY of packages/oshal-vids-operator, not the repo. On
# 2026-07-29 that copy was missing episode-render.js and every module it requires,
# so `dispatchStoryboardedEpisode` shelled into a file that was not there and the
# failure surfaced as a generic task error. The files had only ever been placed by
# hand, months earlier, and nothing re-placed them.
#
# Run this after ANY change to the renderer, and after any node rebuild.
#
# Usage:
#   bash scripts/stage-vids-node.sh                 # stage + smoke-test
#   bash scripts/stage-vids-node.sh --check         # smoke-test only, push nothing
#
# Env:
#   CONTROL_PLANE_URL   default http://127.0.0.1:35457
#   VIDS_RENDER_CLIENT_ID  the node (default: read from .env)
#   VIDS_NODE_PKG_DIR   the package dir ON THE NODE (default C:\oshal-vidsop)
set -euo pipefail

CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

CONTROL_PLANE_URL="${CONTROL_PLANE_URL:-http://127.0.0.1:35457}"
NODE_PKG="${VIDS_NODE_PKG_DIR:-C:\\oshal-vidsop}"
CLIENT="${VIDS_RENDER_CLIENT_ID:-}"
if [ -z "$CLIENT" ] && [ -f .env ]; then
  CLIENT=$(sed -n 's/^VIDS_RENDER_CLIENT_ID=//p' .env | tr -d '\r' | head -1)
fi
[ -n "$CLIENT" ] || { echo "ERR: set VIDS_RENDER_CLIENT_ID (or put it in .env)" >&2; exit 2; }

RN=(node scripts/codex-remote-node.mjs)
COMMON=(--client="$CLIENT" --url="$CONTROL_PLANE_URL" --timeoutMs=180000)

# Everything episode-render.js reaches at require time, plus the lazy ones it may reach at run time.
FILES=(
  "episode-render.js"
  "src/agent/story-extend.js"
  "src/media/assemble.js"
  "src/media/narrate.js"
  "src/storage/store.js"
  "src/storage/drive.js"
)

if [ "$CHECK_ONLY" -eq 0 ]; then
  echo "staging $((${#FILES[@]})) file(s) to $NODE_PKG on $CLIENT"
  # The directories must exist before a push can land in them.
  "${RN[@]}" shell "${COMMON[@]}" \
    --cmd="foreach (\$d in @('src\\agent','src\\media','src\\storage')) { New-Item -ItemType Directory -Force -Path (Join-Path '$NODE_PKG' \$d) | Out-Null }; 'dirs ready'" >/dev/null

  for f in "${FILES[@]}"; do
    remote="$NODE_PKG\\$(printf '%s' "$f" | tr '/' '\\')"
    if "${RN[@]}" push "${COMMON[@]}" --local="packages/oshal-vids-operator/$f" --remote="$remote" | grep -q '"bytes"'; then
      echo "  ok   $f"
    else
      echo "  FAIL $f" >&2; exit 1
    fi
  done
fi

# The smoke test is the whole point: both lines must answer, or the render stage is dead.
echo "smoke-testing the node's renderer…"
OUT=$("${RN[@]}" shell "${COMMON[@]}" --cmd="Set-Location '$NODE_PKG'; & 'C:\\Program Files\\nodejs\\node.exe' -e \"try{require('./src/agent/story-extend');require('./src/media/assemble');require('./src/storage/store');console.log('LOADS_OK')}catch(e){console.log('LOAD_FAIL '+e.message)}\"; & 'C:\\Program Files\\nodejs\\node.exe' episode-render.js" 2>&1 || true)

echo "$OUT" | grep -q 'LOADS_OK' || { echo "SMOKE FAILED: the renderer does not load on the node"; echo "$OUT" | tail -20; exit 1; }
echo "$OUT" | grep -q 'EPISODE_ERR no plan given' || { echo "SMOKE FAILED: episode-render.js did not answer"; echo "$OUT" | tail -20; exit 1; }
echo "SMOKE OK — the node loads the renderer and episode-render.js answers"
