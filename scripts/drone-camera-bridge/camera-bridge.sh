#!/usr/bin/env bash
#
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — one-command camera->OSHAL
#                     |                             | bridge: start the OpenCV MJPEG server for a camera source
#                     |                             | AND a sim drone node that declares it as DRONE_VIDEO_URL,
#                     |                             | so ?app=drone shows the REAL feed in its Live-camera card.
#                     |                             | Live-proven with the host webcam 2026-07-18. Reuses the
#                     |                             | DRONE_VIDEO_URL passthrough — never a raw browser->device
#                     |                             | link. Ctrl-C tears both down.
#
# Usage:
#   bash scripts/drone-camera-bridge/camera-bridge.sh [options]
#     --source <idx|url>  camera index (0=default webcam) or capture URL   (default 0)
#     --id <droneId>      fleet id the camera appears under                (default camera-1)
#     --label <text>      overlay text burned into the frame               (default "OSHAL camera")
#     --stream-port <n>   MJPEG server port                                (default 8090)
#     --node-port <n>     drone-node HTTP port                             (default 4104)
#     --api <url>         OSHAL api base                                   (default http://127.0.0.1:35457)
#
# GoPro Hero over USB "webcam mode": enable webcam mode, plug in, find the new
# camera index (python webcam-mjpeg.py lists nothing — use --source 1/2/...), then
# run this with --source <that index> --id camera-hero.
#
# Requires: python with opencv-python + flask; SWARM_SERVICE_SECRET in .env (repo root).
set -euo pipefail

SOURCE=0
DRONE_ID=camera-1
LABEL="OSHAL camera"
STREAM_PORT=8090
NODE_PORT=4104
API_URL=http://127.0.0.1:35457

while [ $# -gt 0 ]; do
  case "$1" in
    --source) SOURCE="$2"; shift 2;;
    --id) DRONE_ID="$2"; shift 2;;
    --label) LABEL="$2"; shift 2;;
    --stream-port) STREAM_PORT="$2"; shift 2;;
    --node-port) NODE_PORT="$2"; shift 2;;
    --api) API_URL="$2"; shift 2;;
    *) echo "unknown option: $1" >&2; exit 2;;
  esac
done

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

SECRET="$(grep -E '^SWARM_SERVICE_SECRET=' "$ROOT/.env" | cut -d= -f2- || true)"
if [ -z "$SECRET" ]; then
  echo "SWARM_SERVICE_SECRET not found in $ROOT/.env — a drone node refuses to start without it." >&2
  exit 1
fi

VIDEO_URL="http://127.0.0.1:${STREAM_PORT}/video"

echo "Starting MJPEG bridge: source=$SOURCE -> $VIDEO_URL"
python "$HERE/webcam-mjpeg.py" "$SOURCE" "$STREAM_PORT" "$LABEL" &
CAM_PID=$!
cleanup() { echo; echo "Stopping camera bridge…"; kill "$CAM_PID" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

# Wait for the stream to answer before the node advertises it.
for _ in $(seq 1 20); do
  if curl -s -m 1 -o /dev/null "http://127.0.0.1:${STREAM_PORT}/"; then break; fi
  sleep 0.5
done

echo "Starting drone node '$DRONE_ID' advertising the feed (Live-camera card in ?app=drone)…"
cd "$ROOT"
SWARM_SERVICE_SECRET="$SECRET" \
  DRONE_NODE_ID="$DRONE_ID" \
  DRONE_NODE_PORT="$NODE_PORT" \
  DRONE_NODE_ENDPOINT="http://host.docker.internal:${NODE_PORT}" \
  OSHAL_API_URL="$API_URL" \
  DRONE_VIDEO_URL="$VIDEO_URL" \
  npm run drone:node
