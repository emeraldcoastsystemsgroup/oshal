#!/usr/bin/env bash
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | One-command OSHAL installer: preflight → build → up → wait → SELF-VERIFY → print URLs. Defaults to the zero-keys (noop + MOCK_OIDC) path so it installs with no API keys or IdP.
# -----------------------------------------------------------------------------
#
# scripts/install.sh — install and verify an OSHAL stack in one command.
#
#   bash scripts/install.sh                # zero-keys install: build → up → verify
#   bash scripts/install.sh --with-keys    # use real providers from .env instead of the noop stub harness
#   bash scripts/install.sh --skip-build   # reuse the image you already built
#   bash scripts/install.sh --minimal      # controller + infra only (no worker bots)
#   bash scripts/install.sh --no-verify    # skip the post-install verification pass
#   bash scripts/install.sh --down         # stop and remove the stack
#
# What it does
# ------------
#   1. Preflight: docker, docker compose v2, repo root, cockpit port free.
#   2. Build the OSHAL image (Dockerfile.oshal → oshal-bot:latest) unless --skip-build.
#   3. Bring up docker-compose.oshal-local.yml.
#   4. Poll /api/health until the controller answers (or time out).
#   5. SELF-VERIFY: containers healthy, API + cockpit reachable, Postgres + Redis live,
#      — and PRINT A PASS/FAIL REPORT.
#   6. Print the cockpit URLs and next steps.
#
# Exit code is the number of failed verification checks (0 = all good).
set -uo pipefail

# ── Knobs ────────────────────────────────────────────────────────────────────
COMPOSE_FILE="docker-compose.oshal-local.yml"
IMAGE_NAME="oshal-bot:latest"          # MUST match the compose image (OSHAL_BOT_IMAGE default)
COCKPIT_PORT="${OSHAL_API_PORT:-35457}"
BASE_URL="http://localhost:${COCKPIT_PORT}"
HEALTH_TIMEOUT_SECS=300
HEALTH_POLL_INTERVAL_SECS=5
DB_CONTAINER="oshal-local-db"
REDIS_CONTAINER="oshal-local-redis"

WITH_KEYS=0; SKIP_BUILD=0; MINIMAL=0; NO_VERIFY=0; TEAR_DOWN=0
for arg in "$@"; do
  case "$arg" in
    --with-keys)  WITH_KEYS=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    --minimal)    MINIMAL=1 ;;
    --no-verify)  NO_VERIFY=1 ;;
    --down)       TEAR_DOWN=1 ;;
    -h|--help)    sed -n '10,30p' "$0"; exit 0 ;;
    *) echo "Unknown flag: $arg — run: bash scripts/install.sh --help"; exit 64 ;;
  esac
done

# ── Output helpers (color only on a TTY) ─────────────────────────────────────
if [ -t 1 ]; then
  C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'; C_RESET=$'\033[0m'
else
  C_BOLD=""; C_DIM=""; C_GREEN=""; C_YELLOW=""; C_RED=""; C_RESET=""
fi
step() { printf '\n%s━━ %s%s\n' "$C_BOLD" "$1" "$C_RESET"; }
ok()   { printf '  %s✔%s %s\n' "$C_GREEN" "$C_RESET" "$1"; }
warn() { printf '  %s!%s %s\n' "$C_YELLOW" "$C_RESET" "$1"; }
bad()  { printf '  %s✖%s %s\n' "$C_RED" "$C_RESET" "$1" >&2; }
info() { printf '  %s%s%s\n' "$C_DIM" "$1" "$C_RESET"; }
die()  { bad "$1"; [ $# -gt 1 ] && printf '    %s\n' "$2"; exit 1; }

# ── Compose invocation (profile + provider env) ──────────────────────────────
# (the little-monsters profile left with the LM carve-out, ADR-085 — apps install
#  from the oshal-applications store, not compose profiles)
PROFILE_ARGS=()
compose() { docker compose -f "$COMPOSE_FILE" "${PROFILE_ARGS[@]}" "$@"; }

if [ "$TEAR_DOWN" -eq 1 ]; then
  step "Tearing down the OSHAL stack"
  docker compose -f "$COMPOSE_FILE" --profile build --profile incident down --remove-orphans
  ok "Stopped and removed."
  exit 0
fi

# ── 1. Preflight ─────────────────────────────────────────────────────────────
step "Preflight"
[ -f "$COMPOSE_FILE" ] || die "Cannot find $COMPOSE_FILE in $(pwd)" "Run from the repo root: bash scripts/install.sh"
command -v docker >/dev/null 2>&1 || die "docker is not installed" "Install Docker Desktop: https://docs.docker.com/get-docker/"
docker info >/dev/null 2>&1 || die "docker daemon is not responding" "Start Docker Desktop and re-run."
ok "docker daemon reachable"
docker compose version >/dev/null 2>&1 || die "docker compose v2 required" "Update Docker Desktop or install the compose v2 plugin."
ok "docker compose v2 present"
if [ "$WITH_KEYS" -eq 0 ]; then
  export FORCE_LLM_PROVIDER=noop
  ok "Provider: noop (zero-keys mode — no API keys or IdP needed)"
else
  info "Provider: real (from .env). Make sure a key is set or sign in via the cockpit."
fi

# ── 2. Build ─────────────────────────────────────────────────────────────────
if [ "$SKIP_BUILD" -eq 1 ]; then
  step "Build (skipped)"
  docker image inspect "$IMAGE_NAME" >/dev/null 2>&1 || die "--skip-build set but $IMAGE_NAME not found" "Run once without --skip-build."
  ok "Reusing $IMAGE_NAME"
else
  step "Building $IMAGE_NAME (first build ~2-3 min)"
  docker build -f Dockerfile.oshal -t "$IMAGE_NAME" . || die "Image build failed" "Scroll up for the compiler/build error."
  ok "Image built"
fi

# ── 3. Up ────────────────────────────────────────────────────────────────────
step "Starting the stack"
MOCK_OIDC=true compose up -d || die "docker compose up failed" "Check 'docker compose -f $COMPOSE_FILE logs'."
ok "Containers started"

# ── 4. Wait for health ───────────────────────────────────────────────────────
step "Waiting for the controller to become healthy (up to $((HEALTH_TIMEOUT_SECS/60)) min)"
deadline=$(( $(date +%s) + HEALTH_TIMEOUT_SECS ))
healthy=0
while [ "$(date +%s)" -lt "$deadline" ]; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 "$BASE_URL/api/health" 2>/dev/null || true)
  if [ "$code" = "200" ]; then healthy=1; break; fi
  printf '.'; sleep "$HEALTH_POLL_INTERVAL_SECS"
done
printf '\n'
[ "$healthy" -eq 1 ] || die "Controller did not become healthy in time" "Check 'docker compose -f $COMPOSE_FILE logs oshal-api'."
ok "Controller is healthy ($BASE_URL/api/health → 200)"

# ── 5. Self-verify ───────────────────────────────────────────────────────────
PASS=0; FAILN=0
chk() { if [ "${2:-0}" = "1" ]; then ok "$1"; PASS=$((PASS+1)); else bad "$1 — $3"; FAILN=$((FAILN+1)); fi; }
if [ "$NO_VERIFY" -eq 1 ]; then
  step "Verification (skipped)"
else
  step "Verifying the install"
  # Containers healthy
  n=$(docker ps --format '{{.Names}} {{.Status}}' 2>/dev/null | grep -c 'oshal-local.*healthy' || true)
  chk "containers healthy ($n)" "$([ "${n:-0}" -ge 3 ] && echo 1 || echo 0)" "fewer than 3 healthy oshal containers"
  # Cockpit served
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "$BASE_URL/cockpit/" 2>/dev/null || true)
  chk "cockpit UI served" "$([ "$code" = "200" ] && echo 1 || echo 0)" "GET /cockpit/ returned ${code:-none}"
  # Postgres reachable
  dbok=$(docker exec "$DB_CONTAINER" pg_isready -U oshal -d oshal >/dev/null 2>&1 && echo 1 || echo 0)
  chk "postgres reachable" "$dbok" "pg_isready failed in $DB_CONTAINER"
  # Redis reachable
  rok=$(docker exec "$REDIS_CONTAINER" redis-cli ping 2>/dev/null | grep -q PONG && echo 1 || echo 0)
  chk "redis reachable" "$rok" "redis-cli ping failed in $REDIS_CONTAINER"
  # Branding endpoint
  bok=$(curl -s --max-time 8 "$BASE_URL/api/branding" 2>/dev/null | grep -q displayName && echo 1 || echo 0)
  chk "branding/API responding" "$bok" "GET /api/branding has no displayName"
  # (LM verify removed — apps are installed from the oshal-applications store, ADR-085)
  printf '\n  %s%d passed, %d failed%s\n' "$C_BOLD" "$PASS" "$FAILN" "$C_RESET"
fi

# ── 6. Done ──────────────────────────────────────────────────────────────────
step "OSHAL is installed"
printf '  %sCockpit:%s        %s/cockpit/\n' "$C_BOLD" "$C_RESET" "$BASE_URL"
printf '  %sHealth:%s         %s/api/health\n' "$C_BOLD" "$C_RESET" "$BASE_URL"
echo
info "Next steps:"
info "  • Real bots: set ANTHROPIC_API_KEY/OPENAI_API_KEY in .env (or Settings → Provider), then re-run with --with-keys"
info "  • Full check suite (needs a real provider): OSHAL_BASE=$BASE_URL bash scripts/oshal-local-checks.sh"
info "  • Build your own app: docs/build-your-own-swarm-app.md"
info "  • Tear down: bash scripts/install.sh --down"
[ "$NO_VERIFY" -eq 1 ] && exit 0 || exit "$FAILN"
