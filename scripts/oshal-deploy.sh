#!/usr/bin/env bash
# =============================================================================
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Pass --build-arg GIT_SHA=$HEAD_SHA so the image carries its commit INSIDE the container (ENV, read by /api/version + the update-check daemon), not only in the docker label the runtime can't see. Also populates the OCI image.revision label that stayed "unknown".
# 2 | maintainer@emeraldcoastsystemsgroup.com   | Bot tier recreates in BATCHES (recreate_bots; same OSHAL_UP_BATCH_SIZE/SETTLE knobs as oshal-up.sh, 0=single-shot): the one-shot force-recreate of ~34 bots is the same concurrent cold-start spike that OOM-crashed the 6 GB engine twice on 2026-07-23; rollback path batches too.
# 3 | maintainer@emeraldcoastsystemsgroup.com   | Initial — THE one verified deploy command, born from the 2026-07-19 deploy incident. Encodes every lesson: build from COMMITTED HEAD (git archive) and stamp the image with the commit; classify app services by their compose-declared image (oshal-bot:latest) so infra can never be swept into a recreate (the incident: a hand-typed name filter missed the oshal- prefix and force-recreated the DB); NEVER pipe `docker compose up` (SIGPIPE killed a recreate mid-flight); --remove-orphans (stale name conflict); api first + FULLY up (healthy + auto-load, the oshal-up.sh contract) then bots; deploy-parity-check is a HARD gate here (advisory in oshal-up); auto-rollback to the pre-deploy image on any post-recreate failure.
# 4 | maintainer@emeraldcoastsystemsgroup.com   | The rollback path never checked ITSELF. `docker tag`, the api recreate and `recreate_bots` inside rollback() were fire-and-forget, and wait_api's failure was only LOGGED — so a rollback that left no serving api exited 1, the SAME code as a deploy that failed safely. That is not hypothetical: on 2026-07-29 the docker engine answered 500 on the network step, the forward deploy rolled back, the rollback's own api never came up, and the run ended `ROLLED BACK with parity drift — investigate` + exit 1 while the box sat with no api container — the operator found out from `docker ps`, not from the tool. Every rollback step is now checked and any failure yields a distinct **exit 3** with a named recovery order (oshal-up.sh, then api-bounce.sh, then parity). Exit 1 now MEANS "the previous image is serving". Guard: tests/unit/deploy-rollback-outcome.spec.ts. (Note for the record: the script was never the source of an exit-0 false green — it does exit non-zero; a piped invocation masks it, which is why CLAUDE.md says never pipe these.)
# 5 | maintainer@emeraldcoastsystemsgroup.com   | npm publish parity is REPORTED in preflight (scripts/npm-parity-check.sh). The client packages ship to the world on a different rail than this stack, so npm staleness must never block a container deploy - but it went unnoticed for three weeks: @oshal/chat sat at 0.2.0 on npm while #300 (node print service) and #302 (satellite login push) landed IN that package and package.json was never bumped, so the version numbers MATCHED while the code differed and nothing could notice. The deploy is where that now gets said out loud. Publishing stays an explicit, irreversible act: bash scripts/npm-publish.sh --publish.
# 6 | maintainer@emeraldcoastsystemsgroup.com | Add explicit authorized feature-branch previews with fresh published-tip checks and strict image labels even when skipping build; archive the captured commit rather than mutable HEAD.
# 7 | maintainer@emeraldcoastsystemsgroup.com | Drain startup logs when matching auto-load readiness so an early grep exit cannot turn a found marker into a Docker pipe failure; retain refusal on actual log-read errors.
# 8 | maintainer@emeraldcoastsystemsgroup.com | A deploy is not finished until Jarvis answers and a ticket moves. Every gate this script already had measures the STACK — containers healthy, image parity clean, /health 200, zero unhealthy — and on 2026-09-15 all of them were green while Jarvis answered nothing and an operator ticket raised at 00:51Z escalated on manifest_worker_dispatch_failed instead of being worked. The run said DEPLOYED. Post-deploy live verification (scripts/lib/deploy-verify.sh) now runs after those gates and before the DEPLOYED line: the bot role can still SELECT the table its own ADR-149 posture guard reads, Jarvis answers a fixed question as the operator, and one synthetic ticket leaves the queue without parking in a failed state. A failure carries its own exit code (4) and deliberately does NOT roll back — the new image is already live and serving, and swapping it for the previous one would add a version surprise to a product outage. OSHAL_DEPLOY_SKIP_LIVE_VERIFY=1 is the one documented skip, for a box with no operator identity. Guard: tests/unit/deploy-live-verification.spec.ts.
# 9 | maintainer@emeraldcoastsystemsgroup.com   | wait_api waits on a DEADLINE (OSHAL_DEPLOY_API_HEALTH_SECONDS, default 900) and fails fast only on unhealthy/exited/dead/restarting. A fixed 40x3s window rolled back a healthy deploy on 2026-09-16 because this box loads 83 swarm apps at boot and took about eight minutes under load; the rollback's api needed more than 120 s for the same reason, so the script then reported a DEGRADED stack that was serving fine minutes later. A slow boot is not a failed boot, and the elapsed time is now logged so the difference is visible.
# 10 | maintainer@emeraldcoastsystemsgroup.com   | Image verify also asks whether the Cline FALLBACK can start (scripts/check-cline-entrypoint.mjs --image). The 2026-09-17 image passed the commit label and the kernel-skills probe, every container was healthy, and every ticket that failed over from Codex died on `spawnSync .../cline/bin/.cline ENOENT` - a glibc executable on a musl base with no loader. That is an artifact defect only the artifact can show, so it is gated here, before any container is touched, alongside the other two image probes.
# 11 | maintainer@emeraldcoastsystemsgroup.com   | The api must live THROUGH the bot recreate, and the run now says whether it did. On 2026-09-05 the storm starved the api's event loop, a transaction idled past Postgres's idle_in_transaction_session_timeout, the termination reached a checked-out pg client nothing owned, the crash guards exited the process, Docker restarted it, and this script printed DEPLOYED over about a minute of api downtime that only the container's RestartCount recorded. scripts/api-storm-probe.sh snapshots RestartCount + the clock before the recreate and, after the census gate, counts restarts and `idle-in-transaction` api-log lines inside that window; a non-zero verdict is exit 6 (deployed and SERVING - the downtime already happened, so nothing is rolled back - but the api did not survive its own deploy). The recreate pacing is unchanged and now printed with the RestartCount, so the log states which of pacing or the connection-error fix the run relied on. The fix itself is src/shared/services/database/pool-connection-errors.ts; the probe's own proof is tests/unit/api-storm-probe.spec.ts.
# =============================================================================
#
# Usage:  bash scripts/oshal-deploy.sh [--preview] [--skip-build] [--no-rollback] [--allow-unpushed] [--dry-run]
#   --preview         authorized feature preview: requires the same tracked origin
#                     branch at freshly fetched HEAD; never --allow-unpushed
#   --dry-run         preflight + image verify (with --skip-build: no build) + print
#                     the exact recreate plan, touch nothing
#   --skip-build      deploy the existing oshal-bot:latest (skips archive+build; the
#                     commit-label check downgrades to a report line ONLY in default
#                     release mode; --preview always requires the pinned SHA)
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
#     parity clean + /health 200 + zero unhealthy app containers + the post-deploy
#     live verification passing (bot-role grant, a Jarvis answer, a ticket that moves).
#   - Any post-recreate failure triggers rollback to the pre-deploy image
#     (tagged oshal-bot:deploy-rollback at start) unless --no-rollback.
# EXIT:   0 deployed+verified   1 failed, rollback restored a SERVING stack   2 preflight error
#         3 failed AND the rollback did not restore a serving stack — the box needs hands
#         4 deployed and SERVING, but the post-deploy live verification failed — the product
#           is down on a healthy stack. Deliberately NOT rolled back; fix the named check.
#         5 deployed and SERVING, but the product could NOT BE PROVED to work for more
#           consecutive runs than the gate tolerates. Nothing is known to be broken and
#           nothing is known to work: supply OSHAL_VERIFY_OPERATOR_PAT. Not rolled back.
#           4 and 5 are different facts — proved broken vs never proved — and a caller that
#           collapses them loses the only distinction that says which one to go fix.
#
# Env:    OSHAL_DEPLOY_SKIP_LIVE_VERIFY=1  skip the post-deploy live verification entirely.
#         The ONLY switch that skips it, and it exists for a deployment that carries no
#         operator identity (empty OSHAL_OPERATOR_SUBS) to ask Jarvis a question as.
#         OSHAL_VERIFY_OPERATOR_PAT=<session-minted PAT>  the identity the two product
#         checks need to be answerable at all under delegation signing. With it set they
#         are binary, pass or fail; without it they can only report UNVERIFIED, which is
#         tolerated for a bounded number of consecutive runs and then exits 5.
#         OSHAL_VERIFY_REQUIRE_PROOF=1  exits 5 on the FIRST unproven run — the intended
#         steady state once a PAT exists. See docs/runbooks/deploy-parity.md.

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

SKIP_BUILD=0; NO_ROLLBACK=0; ALLOW_UNPUSHED=0; DRY_RUN=0; PREVIEW=0
for a in "$@"; do case "$a" in
  --preview) PREVIEW=1 ;;
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
SCRIPT_LIB="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib"
SOURCE_HELPER="$SCRIPT_LIB/deploy-source.sh"
source "$SOURCE_HELPER" || fail2 "deployment source helper unavailable"
# Fail CLOSED at preflight if the post-deploy verification helper is missing: a deploy that
# cannot verify the product must refuse before it touches a container, never quietly skip.
VERIFY_HELPER="$SCRIPT_LIB/deploy-verify.sh"
source "$VERIFY_HELPER" || fail2 "post-deploy verification helper unavailable ($VERIFY_HELPER)"
oshal_deploy_source_preflight "$PREVIEW" "$ALLOW_UNPUSHED" || fail2 "$DEPLOY_SOURCE_ERROR"
[ "$PREVIEW" -eq 1 ] && log "authorized preview source: ${HEAD_SHA:0:12} (fresh origin branch tip)"
docker info >/dev/null 2>&1 || fail2 "docker daemon not reachable"

# npm publish parity - a REPORT, never a gate. The client packages ship to the world on a
# different rail than this stack, so npm staleness must not block a container deploy; but it
# went unnoticed for three weeks once (@oshal/chat sat at 0.2.0 while #300 and #302 landed in
# it), so the deploy is where it gets said out loud. Publishing stays an explicit act:
# bash scripts/npm-publish.sh --publish
if [ -x scripts/npm-parity-check.sh ] || [ -f scripts/npm-parity-check.sh ]; then
  npm_parity_out=$(bash scripts/npm-parity-check.sh 2>&1); npm_parity_rc=$?
  case "$npm_parity_rc" in
    0) log "npm parity: every publishable package matches the registry" ;;
    1) log "npm parity: DRIFTED - the npm client is behind this repo (deploy continues)"
       echo "$npm_parity_out" | sed 's/^/    /' | tee -a "$RUN_LOG" ;;
    *) log "npm parity: UNKNOWN (registry unreachable or npm missing) - not treated as in-sync" ;;
  esac
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
  if ! oshal_deploy_archive | timeout 3600 docker build \
      --label "oshal.git.commit=$HEAD_SHA" --build-arg "GIT_SHA=$HEAD_SHA" \
      -t "$IMAGE" -f Dockerfile.oshal - >>"$RUN_LOG" 2>&1; then
    log "BUILD FAILED — nothing was recreated, stack untouched. See $RUN_LOG"; exit 1
  fi
fi

# ── Verify the IMAGE before touching any container ──────────────────────────
NEW_ID=$(docker image inspect --format '{{.Id}}' "$IMAGE")
LABEL=$(docker image inspect --format '{{index .Config.Labels "oshal.git.commit"}}' "$IMAGE" 2>/dev/null || true)
if ! oshal_deploy_image_label_matches "$PREVIEW" "$SKIP_BUILD" "$LABEL"; then
  log "IMAGE VERIFY FAILED: commit label '$LABEL' != HEAD $HEAD_SHA — stack untouched"; exit 1
fi
[ "$SKIP_BUILD" -eq 1 ] && log "skip-build: deploying image ${NEW_ID:7:12} (label: ${LABEL:-none})"
if [ -f scripts/check-kernel-skills.ts ]; then
  if ! timeout 600 npx tsx scripts/check-kernel-skills.ts --image "$IMAGE" --quiet >>"$RUN_LOG" 2>&1; then
    log "IMAGE VERIFY FAILED: kernel-skills probe (silent-prune class) — stack untouched"; exit 1
  fi
  log "image verified: commit label + kernel-skills probe"
fi
# The Cline fallback brain must START in the image that ships. cline 3.x is a glibc executable;
# on this musl base it needs the confined gcompat loader Dockerfile.oshal installs, and the only
# thing that proves it is running the real launcher inside the artifact (2026-09-17: every gate
# here was green while every failed-over ticket died on ENOENT). Exit 2 = the probe could not run,
# which is not a verdict and is refused just the same - a gate that cannot verify does not skip.
if [ -f scripts/check-cline-entrypoint.mjs ]; then
  if ! timeout 300 node scripts/check-cline-entrypoint.mjs --image "$IMAGE" --quiet >>"$RUN_LOG" 2>&1; then
    log "IMAGE VERIFY FAILED: cline fallback entrypoint cannot start in $IMAGE (see $RUN_LOG) — stack untouched"; exit 1
  fi
  log "image verified: cline fallback entrypoint starts"
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
  # Every step of the rollback is CHECKED. Previously the api recreate and the bot recreate
  # here were fire-and-forget, so a rollback that itself failed reported the same `exit 1` as a
  # deploy that failed safely — and on 2026-07-29 that is exactly what happened: the docker
  # engine returned 500 on the network step, the rollback's own api recreate never came up
  # ("rollback: api still not fully up" was the ONLY signal), and the stack sat with no api
  # container while the exit code said nothing more than "deploy failed".
  local degraded=0
  docker tag "$ROLLBACK_TAG" "$IMAGE" || { log "rollback: could not retag $ROLLBACK_TAG -> $IMAGE"; degraded=1; }
  "${DC[@]}" up -d --force-recreate --no-deps "$API_SERVICE" >>"$RUN_LOG" 2>&1 \
    || { log "rollback: api recreate FAILED (docker engine error?) — see $RUN_LOG"; degraded=1; }
  wait_api || { log "rollback: api still not fully up — run scripts/oshal-up.sh"; degraded=1; }
  recreate_bots || { log "rollback: bot recreate FAILED — see $RUN_LOG"; degraded=1; }
  if bash scripts/deploy-parity-check.sh --quiet; then
    log "ROLLED BACK clean (parity ok)"
  else
    log "ROLLED BACK with parity drift — investigate"; degraded=1
  fi

  if [ "$degraded" -eq 1 ]; then
    log ""
    log "✗✗ ROLLBACK DEGRADED — THE STACK IS NOT SERVING. This is NOT a safe failure."
    log "   The deploy failed AND the rollback did not restore a working stack."
    log "   Recover, in order:  bash scripts/oshal-up.sh   (ordered bring-up)"
    log "                       bash scripts/api-bounce.sh (if the api is up but the host port is wedged)"
    log "   Then confirm:       bash scripts/deploy-parity-check.sh"
    log "   Full log: $RUN_LOG"
    exit 3
  fi
  log "deploy failed, but the rollback restored the previous image cleanly — stack is serving."
  exit 1
}

# How long the api may take to become healthy and finish loading its apps. A box that loads 80+
# swarm apps at boot, or is busy, takes minutes - and a deploy that rolls back a HEALTHY image
# because it was impatient is worse than one that waits: it recreates the whole bot tier twice and
# ends up reporting a degraded stack that was never degraded (2026-09-16).
API_HEALTH_SECONDS=${OSHAL_DEPLOY_API_HEALTH_SECONDS:-900}

wait_api() {
  local deadline s waited
  deadline=$(( $(date +%s) + API_HEALTH_SECONDS ))
  while :; do
    s=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$API_CONTAINER" 2>/dev/null || echo missing)
    [ "$s" = healthy ] && break
    # These mean a real failure. 'starting' and a missing container mid-recreate do not, so they
    # only ever run the clock down.
    case "$s" in
      unhealthy|exited|dead|restarting)
        log "api reported '$s' — that is a failed boot, not a slow one"; return 1 ;;
    esac
    [ "$(date +%s)" -lt "$deadline" ] || { log "api never went healthy within ${API_HEALTH_SECONDS}s (last: $s)"; return 1; }
    sleep 3
  done
  waited=$(( API_HEALTH_SECONDS - (deadline - $(date +%s)) ))
  log "api healthy after ${waited}s"
  while :; do
    docker logs "$API_CONTAINER" 2>&1 | grep -F "Swarm app auto-load complete" >/dev/null && {
      log "api fully up (healthy + auto-load) after $(( API_HEALTH_SECONDS - (deadline - $(date +%s)) ))s"; return 0; }
    [ "$(date +%s)" -lt "$deadline" ] || { log "api healthy but auto-load never completed within ${API_HEALTH_SECONDS}s"; return 1; }
    sleep 3
  done
}

log "recreating api"
"${DC[@]}" up -d --force-recreate --no-deps "$API_SERVICE" >>"$RUN_LOG" 2>&1 || rollback
wait_api || rollback

# The api must LIVE THROUGH the bot recreate. On 2026-09-05 it did not: the storm starved its event
# loop, a transaction idled past the server's idle_in_transaction_session_timeout, the termination
# reached a checked-out pg client nothing owned, and the crash guards exited the process. Docker
# restarted it, it was healthy 40 s later, and this script printed DEPLOYED over about a minute of
# api downtime that only RestartCount recorded. The snapshot here and the verdict after the census
# gate make that a named outcome (exit 6). A snapshot that cannot be taken is refused like any other
# gate that cannot verify - the bots are untouched at this point, so the rollback is cheap.
STORM_SNAPSHOT=$(bash scripts/api-storm-probe.sh begin "$API_CONTAINER") || { log "api-storm-probe cannot snapshot $API_CONTAINER"; rollback; }
STORM_RESTARTS=${STORM_SNAPSHOT#restarts=}; STORM_RESTARTS=${STORM_RESTARTS%% *}; STORM_SINCE=${STORM_SNAPSHOT##*since=}
log "recreating ${#BOT_SERVICES[@]} bots (batches of ${OSHAL_UP_BATCH_SIZE:-5}, ${OSHAL_UP_BATCH_SETTLE:-18}s settle - pacing unchanged; api RestartCount=$STORM_RESTARTS before)"
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

# Did the api live through the recreate? RestartCount unchanged and no idle-in-transaction
# termination in its log since the snapshot. Measured here, decided after the product checks, so a
# restart never hides their verdict and they never hide a restart.
STORM_VERDICT=$(bash scripts/api-storm-probe.sh verify "$STORM_RESTARTS" "$STORM_SINCE" "$API_CONTAINER" 2>&1); STORM_RC=$?
while IFS= read -r line; do log "  $line"; done <<<"$STORM_VERDICT"

# ── Verify the PRODUCT, not just the stack ──────────────────────────────────
# Everything above measures containers. On 2026-09-15 every line above was green while
# Jarvis answered nothing and a ticket escalated on manifest_worker_dispatch_failed, and
# the run still printed DEPLOYED. These three checks run LAST, after the health/parity/
# census gates, and their verdict decides whether DEPLOYED is printed at all.
# A failure NEVER rolls back: the new image is already live and serving, and returning to
# the previous one would add a version surprise to a product outage.
# Three outcomes, not two: 1 is "the product is proved broken" and 3 is "the product was never
# proved at all, for longer than the gate tolerates". They demand different actions from whoever
# reads this log, so they get different exit codes rather than one shared "the deploy failed".
oshal_deploy_post_verify; VERIFY_RC=$?
if [ "$VERIFY_RC" -eq 1 ]; then
  log ""
  log "✗ deployed ${HEAD_SHA:0:12} on image ${NEW_ID:7:12} — api + ${#BOT_SERVICES[@]} bots healthy, parity clean,"
  log "  but the POST-DEPLOY LIVE VERIFICATION above FAILED. The stack is up; the product is not."
  log "  The new image IS live and serving and was deliberately NOT rolled back."
  log "  Fix the named check, then re-verify without redeploying:"
  log "    bash -c 'source scripts/lib/deploy-verify.sh && oshal_deploy_post_verify'"
  log "  Runbook: docs/runbooks/deploy-parity.md   Full log: $RUN_LOG"
  exit 4
fi

# The product was not proved to be broken. It was never proved to WORK, on more consecutive runs
# than the gate tolerates — which between 2026-09-15 and 2026-09-16 was every run for two days,
# printed in the same words each time, over a Jarvis that was answering 503 to everything. The one
# thing that clears it cannot be done by any process on this box: only a signed-in operator session
# can mint an identity that carries a verified principal issuer.
if [ "$VERIFY_RC" -eq 3 ]; then
  log ""
  log "✗ deployed ${HEAD_SHA:0:12} on image ${NEW_ID:7:12} — api + ${#BOT_SERVICES[@]} bots healthy, parity clean,"
  log "  but the product was NEVER PROVED to work, on ${OSHAL_VERIFY_UNPROVEN_STREAK:-?} consecutive run(s). Nothing above says"
  log "  Jarvis answers or that a ticket moves. This is the ABSENCE of proof, not a proven failure"
  log "  (which has its own code, above), and the grace for going unproven is spent."
  log "  The new image IS live and serving and was deliberately NOT rolled back."
  log "  One operator action clears it (no process on this box can do it):"
  log "    1. in a SIGNED-IN cockpit browser session: POST /api/cli-tokens"
  log "    2. export OSHAL_VERIFY_OPERATOR_PAT='<that token>'   (export — it is forwarded by NAME)"
  log "    3. bash -c 'source scripts/lib/deploy-verify.sh && oshal_deploy_post_verify'"
  log "  Runbook: docs/runbooks/deploy-parity.md   Full log: $RUN_LOG"
  exit 5
fi

# The verification can now end in a third state, and this line is what an operator reads. Saying
# "live verification passed" over a run where the two product checks proved NOTHING is the exact
# dishonesty the third state exists to remove, so the tail follows the tally.
if [ "${OSHAL_VERIFY_UNVERIFIED:-0}" -eq 0 ]; then
  VERIFY_TAIL="live verification passed"
else
  VERIFY_TAIL="${OSHAL_VERIFY_UNVERIFIED} check(s) UNVERIFIED — UNPROVEN as a product on ${OSHAL_VERIFY_UNPROVEN_STREAK:-1} consecutive run(s) (see above)"
fi
# The api restarted (or lost a transaction to the server) INSIDE the bot recreate. The new image is
# live and serving and the downtime already happened, so a rollback would only recreate the storm;
# but a run that carried a mid-deploy api outage does not get to say DEPLOYED.
if [ "$STORM_RC" -ne 0 ]; then
  log ""
  log "✗ deployed ${HEAD_SHA:0:12} on image ${NEW_ID:7:12} — api + ${#BOT_SERVICES[@]} bots healthy, parity clean, ${VERIFY_TAIL},"
  log "  but the API DID NOT LIVE THROUGH THE BOT RECREATE (api-storm-probe lines above)."
  log "  The new image IS live and serving and was deliberately NOT rolled back."
  log "  Read the restart: docker logs --since $STORM_SINCE $API_CONTAINER 2>&1 | grep -i -E 'UNCAUGHT|idle-in-transaction'"
  log "  Runbook: docs/runbooks/deploy-parity.md   Full log: $RUN_LOG"
  exit 6
fi

log "DEPLOYED ${HEAD_SHA:0:12} on image ${NEW_ID:7:12} — api + ${#BOT_SERVICES[@]} bots, parity clean, 0 unhealthy, ${VERIFY_TAIL}, api lived through the recreate (RestartCount $STORM_RESTARTS unchanged)"
log "advisory error scan (api, this boot):"
docker logs "$API_CONTAINER" 2>&1 | grep -c '"level":50' | xargs -I{} echo "  error-level lines: {}" | tee -a "$RUN_LOG"
exit 0
