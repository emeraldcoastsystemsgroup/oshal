#!/usr/bin/env bash
# =============================================================================
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Pass --build-arg GIT_SHA=$HEAD_SHA so the image carries its commit INSIDE the container (ENV, read by /api/version + the update-check daemon), not only in the docker label the runtime can't see. Also populates the OCI image.revision label that stayed "unknown".
# 2 | maintainer@emeraldcoastsystemsgroup.com   | Bot tier recreates in BATCHES (recreate_bots; same OSHAL_UP_BATCH_SIZE/SETTLE knobs as oshal-up.sh, 0=single-shot): the one-shot force-recreate of ~34 bots is the same concurrent cold-start spike that OOM-crashed the 6 GB engine twice on 2026-07-23; rollback path batches too.
# 3 | maintainer@emeraldcoastsystemsgroup.com   | Initial — THE one verified deploy command, born from the 2026-07-19 deploy incident. Encodes every lesson: build from COMMITTED HEAD (git archive) and stamp the image with the commit; classify app services by their compose-declared image (oshal-bot:latest) so infra can never be swept into a recreate (the incident: a hand-typed name filter missed the oshal- prefix and force-recreated the DB); NEVER pipe `docker compose up` (SIGPIPE killed a recreate mid-flight); --remove-orphans (stale name conflict); api first + FULLY up (healthy + auto-load, the oshal-up.sh contract) then bots; deploy-parity-check is a HARD gate here (advisory in oshal-up); auto-rollback to the pre-deploy image on any post-recreate failure.
# =============================================================================
#
# Usage:  bash scripts/oshal-deploy.sh [--skip-build] [--no-rollback] [--allow-unpushed] [--dry-run]
#   --dry-run         preflight + image verify (with --skip-build: no build) + print
#                     the exact recreate plan, touch nothing
#   --skip-build      deploy the existing oshal-bot:latest (skips archive+build; the
#                     commit-label check downgrades to a report line)
#   --no-rollback     on failure, stop and report instead of auto-rolling back
#   --allow-unpushed  deploy a HEAD that origin/main doesn't have (Rule 0 says push
#                     first — this flag exists for emergency hotfix order only)
#
# Contract:
#   - Deploys COMMITTED HEAD. The working tree is irrelevant (multi-agent tree is
#     routinely mid-edit). Commit + push first; uncommitted work never ships.
#   - Touches ONLY services whose compose image is oshal-bot:latest (api + bots).
#     Infra (db/redis/chroma/arango/tsdb/vault/cloudflared/...) is never recreated.
#   - Success = api fully up (healthy + swarm-app auto-load) + bots recreated +
#     parity clean + /health 200 + zero unhealthy app containers.
#   - Any post-recreate failure triggers rollback to the pre-deploy image
#     (tagged oshal-bot:deploy-rollback at start) unless --no-rollback.
# EXIT:   0 deployed+verified   1 failed (rolled back if enabled)   2 preflight error

set -uo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.oshal-local.yml}"
DC=(docker compose -f "$COMPOSE_FILE")
IMAGE=oshal-bot:latest
ROLLBACK_TAG=oshal-bot:deploy-rollback
API_SERVICE=oshal-api
API_CONTAINER=oshal-local-api
API_HEALTH="${API_URL:-http://127.0.0.1:35457/health}"  # 127.0.0.1: dodges the known wslrelay ::1 wedge
STATE_DIR="${OSHAL_DEPLOY_STATE:-$HOME/.oshal-deploy}"
mkdir -p "$STATE_DIR"
RUN_LOG="$STATE_DIR/deploy-$(date +%Y%m%d-%H%M%S).log"

SKIP_BUILD=0; NO_ROLLBACK=0; ALLOW_UNPUSHED=0; DRY_RUN=0
for a in "$@"; do case "$a" in
  --skip-build) SKIP_BUILD=1 ;;
  --no-rollback) NO_ROLLBACK=1 ;;
  --allow-unpushed) ALLOW_UNPUSHED=1 ;;
  --dry-run) DRY_RUN=1 ;;
  *) echo "unknown flag: $a" >&2; exit 2 ;;
esac; done
[ "$DRY_RUN" -eq 1 ] && SKIP_BUILD=1  # dry-run is READ-ONLY: never rebuilds :latest

log() { printf '[%s] %s\n' "$(date +%T)" "$*" | tee -a "$RUN_LOG"; }
fail2() { log "PREFLIGHT: $*"; exit 2; }

# Git for Windows ships coreutils timeout; degrade to unbounded if absent.
if ! command -v timeout >/dev/null 2>&1; then timeout() { shift; "$@"; }; fi

# ── Single-instance lock (same pattern as ci-local.sh; 2h stale-steal).
LOCK="$STATE_DIR/lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  ts=$(cat "$LOCK/ts" 2>/dev/null || echo 0)
  if [ $(( $(date +%s) - ts )) -gt 7200 ]; then rm -rf "$LOCK"; mkdir "$LOCK" || fail2 "lock race"; log "stale lock stolen"
  else fail2 "another deploy is in progress"; fi
fi
date +%s >"$LOCK/ts"
trap 'rm -rf "$LOCK"' EXIT
trap 'rm -rf "$LOCK"; exit 130' INT TERM

# ── Preflight ────────────────────────────────────────────────────────────────
docker info >/dev/null 2>&1 || fail2 "docker daemon not reachable"
git rev-parse --git-dir >/dev/null 2>&1 || fail2 "not a git repo"
[ "$(git rev-parse --abbrev-ref HEAD)" = "main" ] || fail2 "not on main (Rule 0)"
HEAD_SHA=$(git rev-parse HEAD)
git fetch --quiet origin main 2>/dev/null || log "warn: fetch failed — comparing against last-known origin/main"
if [ "$HEAD_SHA" != "$(git rev-parse origin/main)" ] && [ "$ALLOW_UNPUSHED" -ne 1 ]; then
  fail2 "HEAD != origin/main — push first (or --allow-unpushed for an emergency)"
fi

# ── Rollback anchor: whatever :latest is NOW is what we return to on failure.
PREV_ID=$(docker image inspect --format '{{.Id}}' "$IMAGE" 2>/dev/null || true)
if [ -n "$PREV_ID" ]; then
  [ "$DRY_RUN" -eq 1 ] || docker tag "$IMAGE" "$ROLLBACK_TAG"
  log "rollback anchor: $ROLLBACK_TAG -> ${PREV_ID:7:12}"
else
  NO_ROLLBACK=1; log "no existing $IMAGE — first deploy, rollback disabled"
fi

# ── Build from COMMITTED HEAD, stamped with the commit ──────────────────────
if [ "$SKIP_BUILD" -ne 1 ]; then
  log "building $IMAGE from committed HEAD ${HEAD_SHA:0:12} (log: $RUN_LOG)"
  if ! git archive HEAD | timeout 3600 docker build \
      --label "oshal.git.commit=$HEAD_SHA" --build-arg "GIT_SHA=$HEAD_SHA" \
      -t "$IMAGE" -f Dockerfile.oshal - >>"$RUN_LOG" 2>&1; then
    log "BUILD FAILED — nothing was recreated, stack untouched. See $RUN_LOG"; exit 1
  fi
fi

# ── Verify the IMAGE before touching any container ──────────────────────────
NEW_ID=$(docker image inspect --format '{{.Id}}' "$IMAGE")
LABEL=$(docker image inspect --format '{{index .Config.Labels "oshal.git.commit"}}' "$IMAGE" 2>/dev/null || true)
if [ "$SKIP_BUILD" -ne 1 ] && [ "$LABEL" != "$HEAD_SHA" ]; then
  log "IMAGE VERIFY FAILED: commit label '$LABEL' != HEAD $HEAD_SHA — stack untouched"; exit 1
fi
[ "$SKIP_BUILD" -eq 1 ] && log "skip-build: deploying image ${NEW_ID:7:12} (label: ${LABEL:-none})"
if [ -f scripts/check-kernel-skills.ts ]; then
  if ! timeout 600 npx tsx scripts/check-kernel-skills.ts --image "$IMAGE" --quiet >>"$RUN_LOG" 2>&1; then
    log "IMAGE VERIFY FAILED: kernel-skills probe (silent-prune class) — stack untouched"; exit 1
  fi
  log "image verified: commit label + kernel-skills probe"
fi

# ── Classify services by their compose-declared image (NEVER by name) ───────
"${DC[@]}" config --format json >"$STATE_DIR/compose.json" 2>>"$RUN_LOG" || { log "compose config failed"; exit 1; }
# JSON via stdin — a path arg would hit MSYS→Windows path-conversion roulette.
mapfile -t APP_SERVICES < <(node -e '
  let raw = ""; process.stdin.on("data", d => raw += d).on("end", () => {
    const c = JSON.parse(raw);
    for (const [name, svc] of Object.entries(c.services || {}))
      if (svc.image === "oshal-bot:latest") console.log(name);
  });
' < "$STATE_DIR/compose.json")
[ "${#APP_SERVICES[@]}" -gt 0 ] || { log "no services declare $IMAGE — wrong compose file?"; exit 1; }
BOT_SERVICES=(); for s in "${APP_SERVICES[@]}"; do [ "$s" != "$API_SERVICE" ] && BOT_SERVICES+=("$s"); done
log "app services: 1 api + ${#BOT_SERVICES[@]} bots (infra untouched by construction)"
if [ "$DRY_RUN" -eq 1 ]; then
  log "DRY RUN — would recreate: $API_SERVICE (first, wait fully-up), then: ${BOT_SERVICES[*]}"
  log "DRY RUN — rollback anchor would be ${PREV_ID:7:12}; nothing touched"; exit 0
fi

# ── Recreate: api first, FULLY up, then bots. Output to log, NEVER piped. ───

# Recreate the bot tier in BATCHES (same knobs + rationale as oshal-up.sh step 3): a single
# `up -d --force-recreate` of every bot cold-starts ~34 harness processes at once, the exact
# memory spike that OOM-crashed the 6 GB engine twice on 2026-07-23. Infra stays warm during a
# deploy so the peak is lower than a cold bring-up, but on small engines it is still the same
# cliff. OSHAL_UP_BATCH_SIZE=0 restores the single-shot recreate for 10-12 GB+ hosts.
# --remove-orphans rides only the FIRST batch: it is a compose-project-level sweep, and once is
# enough. Returns non-zero on the first failed batch so callers can roll back.
recreate_bots() {
  local batch_size="${OSHAL_UP_BATCH_SIZE:-5}" settle="${OSHAL_UP_BATCH_SETTLE:-18}"
  local -a batch=() flags=(--remove-orphans)
  local started=0
  if [ "$batch_size" = "0" ]; then
    "${DC[@]}" up -d --force-recreate --no-deps --remove-orphans "${BOT_SERVICES[@]}" >>"$RUN_LOG" 2>&1
    return $?
  fi
  for svc in "${BOT_SERVICES[@]}"; do
    batch+=("$svc")
    if [ "${#batch[@]}" -ge "$batch_size" ]; then
      "${DC[@]}" up -d --force-recreate --no-deps "${flags[@]}" "${batch[@]}" >>"$RUN_LOG" 2>&1 || return 1
      started=$((started + ${#batch[@]})); log "  recreated ${started}/${#BOT_SERVICES[@]} bots"
      batch=(); flags=()
      [ "$started" -lt "${#BOT_SERVICES[@]}" ] && sleep "$settle"
    fi
  done
  if [ "${#batch[@]}" -gt 0 ]; then
    "${DC[@]}" up -d --force-recreate --no-deps "${flags[@]}" "${batch[@]}" >>"$RUN_LOG" 2>&1 || return 1
    started=$((started + ${#batch[@]})); log "  recreated ${started}/${#BOT_SERVICES[@]} bots"
  fi
  return 0
}

rollback() {
  [ "$NO_ROLLBACK" -eq 1 ] && { log "FAILED — rollback disabled, stack left as-is. See $RUN_LOG"; exit 1; }
  log "ROLLING BACK to ${PREV_ID:7:12}"
  docker tag "$ROLLBACK_TAG" "$IMAGE"
  "${DC[@]}" up -d --force-recreate --no-deps "$API_SERVICE" >>"$RUN_LOG" 2>&1
  wait_api || log "rollback: api still not fully up — run scripts/oshal-up.sh"
  recreate_bots
  bash scripts/deploy-parity-check.sh --quiet && log "ROLLED BACK clean (parity ok)" || log "ROLLED BACK with parity drift — investigate"
  exit 1
}

wait_api() {
  local i s
  for i in $(seq 1 40); do
    s=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$API_CONTAINER" 2>/dev/null || echo missing)
    [ "$s" = healthy ] && break; sleep 3
  done
  [ "$s" = healthy ] || { log "api never went healthy (last: $s)"; return 1; }
  for i in $(seq 1 50); do
    docker logs "$API_CONTAINER" 2>&1 | grep -q "Swarm app auto-load complete" && { log "api fully up (healthy + auto-load)"; return 0; }
    sleep 3
  done
  log "api healthy but auto-load never completed"; return 1
}

log "recreating api"
"${DC[@]}" up -d --force-recreate --no-deps "$API_SERVICE" >>"$RUN_LOG" 2>&1 || rollback
wait_api || rollback

log "recreating ${#BOT_SERVICES[@]} bots (batched)"
recreate_bots || rollback

# ── Verify the DEPLOY ───────────────────────────────────────────────────────
RUN_ID=$(docker inspect --format '{{.Image}}' "$API_CONTAINER")
[ "$RUN_ID" = "$NEW_ID" ] || { log "api is NOT on the new image"; rollback; }
bash scripts/deploy-parity-check.sh --quiet >>"$RUN_LOG" 2>&1 || { log "parity drift after recreate"; rollback; }
# Host-port probe with a RETRY WINDOW: after a mass recreate, Docker Desktop's Windows
# port proxy re-plumbs lazily — the container is healthy while the host port lags for
# tens of seconds. A single-shot probe here rolled back a good deploy on 2026-07-19
# (the rolled-back stack answered 200 moments later). A truly wedged forward still
# fails every attempt and rolls back; api-bounce.sh is the recovery for that case.
HOST_OK=0
for i in $(seq 1 12); do
  if curl -sf -m 5 "$API_HEALTH" >/dev/null; then HOST_OK=1; break; fi
  sleep 5
done
[ "$HOST_OK" -eq 1 ] || { log "host /health not answering after 60s retry window (if docker shows healthy: scripts/api-bounce.sh)"; rollback; }

# Bots take a healthcheck interval to settle — bounded grace window. Classified by
# image ancestry, same as everywhere else in this script — never by name.
UNHEALTHY=""
for i in $(seq 1 40); do
  UNHEALTHY=$(docker ps --filter health=unhealthy --filter "ancestor=$IMAGE" --format '{{.Names}}')
  [ -z "$UNHEALTHY" ] && break; sleep 3
done
[ -z "$UNHEALTHY" ] || { log "unhealthy after grace window: $UNHEALTHY"; rollback; }
log "census: $(docker ps --filter "ancestor=$IMAGE" --format '{{.Status}}' | grep -c healthy) healthy / $(docker ps --filter "ancestor=$IMAGE" --format '{{.Names}}' | wc -l) app containers"

log "DEPLOYED ${HEAD_SHA:0:12} on image ${NEW_ID:7:12} — api + ${#BOT_SERVICES[@]} bots, parity clean, 0 unhealthy"
log "advisory error scan (api, this boot):"
docker logs "$API_CONTAINER" 2>&1 | grep -c '"level":50' | xargs -I{} echo "  error-level lines: {}" | tee -a "$RUN_LOG"
exit 0
