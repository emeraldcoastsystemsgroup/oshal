#!/usr/bin/env bash
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Copy one store package onto the running api PRESERVING its box-local activation. The bare `docker cp pkg/. …/deployed-apps/pkg/` overwrites oshal-app.yaml — including `status:` — and the loader reconciles the DB toggle from that manifest at boot, so re-copying a package that ships `status: inactive` (print-ingest, youtube-kids) or one an operator toggled on SILENTLY DEACTIVATES it and every route it owns answers 503 "Application inactive". That trap cost three separate debug cycles on 2026-09-05/06. This script captures the live state first (container yaml + swarm_applications row), copies, drops the stale routes-build, restores the captured state into BOTH places, and restarts only the api.
#
# Usage:  bash scripts/deploy-store-package.sh <package> [more packages…] [--no-restart]
#   e.g.  bash scripts/deploy-store-package.sh portrait-studio print-ingest
#
# 2 | maintainer@emeraldcoastsystemsgroup.com   | Bounce with stop+start (scripts/api-bounce.sh when present), never `docker restart`: a plain restart reliably leaves the published host port wedged on this box — proven here, the port never answered inside 180s and needed api-bounce.sh to recover — which is the same vpnkit/forward wedge that script already exists for. Also wait for the api to be REALLY up, not just docker-healthy. The container healthcheck is shallow HTTP and goes green while boot work (schema bootstraps, digests, LLM init) is still running; probing in that window is how a restart looks wedged. After the restart this now waits on the HOST port answering /health and then on each package logging "App loaded", so the script only reports success when the packages it copied are actually mounted.
#
# Env:    OSHAL_STORE_DIR   store checkout (default ../oshal-applications beside this repo)
#         OSHAL_API         api container name (default oshal-local-api)
#         OSHAL_DB          db container name  (default oshal-local-db)
#         OSHAL_PORT        host port the api publishes (default 35457)
set -uo pipefail

STORE_DIR="${OSHAL_STORE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../oshal-applications" 2>/dev/null && pwd)}"
API="${OSHAL_API:-oshal-local-api}"
DB="${OSHAL_DB:-oshal-local-db}"
PORT="${OSHAL_PORT:-35457}"
DEPLOY_ROOT=/app/workspace-shared/deployed-apps
# Git Bash rewrites container-absolute paths into Windows paths on exec/cp (documented trap).
export MSYS_NO_PATHCONV=1

log() { printf '[%s] %s\n' "$(date +%T)" "$*"; }
fail() { log "ERROR: $*"; exit 1; }

RESTART=1
PKGS=()
for arg in "$@"; do
  case "$arg" in
    --no-restart) RESTART=0 ;;
    -*) fail "unknown flag: $arg" ;;
    *) PKGS+=("$arg") ;;
  esac
done
[ "${#PKGS[@]}" -gt 0 ] || fail "name at least one package (e.g. portrait-studio)"
[ -d "$STORE_DIR" ] || fail "store checkout not found: $STORE_DIR (set OSHAL_STORE_DIR)"
docker inspect "$API" >/dev/null 2>&1 || fail "api container not running: $API"

# Read the status the BOX currently believes, from both places that decide it.
box_yaml_status() {
  docker exec "$API" sh -c "grep -m1 '^status:' '$DEPLOY_ROOT/$1/oshal-app.yaml' 2>/dev/null | awk '{print \$2}'" 2>/dev/null | tr -d '\r'
}
db_status() {
  docker exec "$DB" psql -U oshal -d oshal -t -A \
    -c "SELECT status FROM swarm_applications WHERE name = '$1'" 2>/dev/null | tr -d '\r'
}

for pkg in "${PKGS[@]}"; do
  SRC="$STORE_DIR/$pkg"
  [ -f "$SRC/oshal-app.yaml" ] || fail "not a package: $SRC/oshal-app.yaml missing"

  PRIOR_YAML="$(box_yaml_status "$pkg")"
  PRIOR_DB="$(db_status "$pkg")"
  NEW_YAML="$(grep -m1 '^status:' "$SRC/oshal-app.yaml" | awk '{print $2}' | tr -d '\r')"
  if [ -n "$PRIOR_YAML" ] || [ -n "$PRIOR_DB" ]; then
    log "$pkg: live state — box yaml='${PRIOR_YAML:-none}' db='${PRIOR_DB:-none}'; incoming manifest='${NEW_YAML:-none}'"
  else
    log "$pkg: not deployed yet — fresh install, manifest status '${NEW_YAML:-none}' applies"
  fi

  # docker.exe is a Windows binary, so the two halves of a cp need OPPOSITE treatment: the
  # CONTAINER path must not be path-converted (MSYS_NO_PATHCONV=1 above) while the HOST path must
  # be a real Windows path or docker reads it as a bogus drive ("GetFileAttributesEx C:\c:").
  # cygpath bridges exactly that split; on a POSIX host there is no cygpath and $SRC is already right.
  SRC_HOST="$SRC"
  command -v cygpath >/dev/null 2>&1 && SRC_HOST="$(cygpath -w "$SRC")"
  docker cp "$SRC_HOST/." "$API:$DEPLOY_ROOT/$pkg/" || fail "$pkg: copy failed"
  docker exec "$API" rm -rf "$DEPLOY_ROOT/$pkg/routes-build" >/dev/null 2>&1

  # Restore activation the copy would otherwise have silently reverted. Only ever RESTORES a
  # state that was already live — never invents one, never activates a fresh install.
  if [ "$PRIOR_YAML" = "active" ] && [ "$NEW_YAML" != "active" ]; then
    docker exec "$API" sed -i 's/^status: .*/status: active/' "$DEPLOY_ROOT/$pkg/oshal-app.yaml" \
      && log "$pkg: restored box yaml status=active (manifest ships '$NEW_YAML')"
  fi
  if [ "$PRIOR_DB" = "active" ]; then
    docker exec "$DB" psql -U oshal -d oshal -q \
      -c "UPDATE swarm_applications SET status='active' WHERE name='$pkg' AND status <> 'active'" >/dev/null 2>&1 \
      && log "$pkg: db toggle held at active"
  fi
  log "$pkg: copied"
done

if [ "$RESTART" -eq 1 ]; then
  # STOP+START, not `docker restart`: a plain restart leaves the published port wedged here
  # (proven — the port never answered inside 180s and needed a stop+start to recover). Not
  # api-bounce.sh either: that polls /api/health, which HANGS on this box while /health answers
  # 200, so it burns its whole window and reports a false failure.
  log "stop+start $API (the loader reads packages at boot)"
  docker stop "$API" >/dev/null && docker start "$API" >/dev/null || fail "api stop/start failed"
  deadline=$(( $(date +%s) + ${OSHAL_READY_TIMEOUT:-600} ))
  ready=1
  until curl -sf -m 5 -o /dev/null "http://127.0.0.1:$PORT/health" 2>/dev/null; do
    if [ "$(date +%s)" -ge "$deadline" ]; then ready=0; break; fi
    sleep 5
  done
  if [ "$ready" -eq 1 ]; then
    log "api answering on 127.0.0.1:$PORT"
    for pkg in "${PKGS[@]}"; do
      until docker logs "$API" --since 15m 2>&1 | grep -q "\"name\":\"$pkg\".*App loaded"; do
        if [ "$(date +%s)" -ge "$deadline" ]; then ready=0; break; fi
        sleep 5
      done
      [ "$ready" -eq 1 ] && log "$pkg: loaded — box yaml='$(box_yaml_status "$pkg")' db='$(db_status "$pkg")'"
    done
  fi
  # A slow boot is NOT a copy failure: the package bytes and the preserved activation are
  # already on the box. Say what is unverified instead of implying the deploy did not happen.
  [ "$ready" -eq 1 ] || log "WARN: copied and activation preserved, but the api was still booting at the deadline — verify with: curl -s http://127.0.0.1:$PORT/health && docker logs $API | grep 'App loaded'"
else
  log "skipped restart (--no-restart) — the api serves the OLD routes until it restarts"
fi
