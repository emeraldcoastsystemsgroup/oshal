#!/usr/bin/env bash
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial one-command OSHAL demo with fail-fast preflight
# 2 | maintainer@emeraldcoastsystemsgroup.com   | Scrubbed retired legacy product references (provider name is noop; narration removed)
# -----------------------------------------------------------------------------
#
# scripts/demo.sh — single-command OSHAL demo for evaluators.
#
#   bash scripts/demo.sh                 # full path: preflight → build → up → wait → print URLs
#   bash scripts/demo.sh --skip-build    # use the image you already have
#   bash scripts/demo.sh --down          # stop and remove the local stack
#
# What it does
# ------------
#   1. Verifies prerequisites (docker, docker compose v2, free ports) and exits
#      with a *clear, fixable* message if anything is missing.
#   2. Optionally builds the OSHAL image (Dockerfile.oshal).
#   3. Brings up docker-compose.oshal-local.yml.
#   4. Polls /health on the cockpit until it answers (or times out at 5 min).
#   5. Prints the cockpit URL, an example incident description to paste,
#      and where the RCA artifacts will land.
#
# What it does NOT do
# -------------------
#   * Submit a ticket on your behalf — you do that from the cockpit so that
#     you see the streaming output and the persona-driven RCA tab populate
#     in real time. That is the demo.
#   * Pretend cost when credits are missing. If a provider's key is unset we
#     warn up front; LLM calls will fail visibly rather than silently.

set -euo pipefail

# ── Knobs ────────────────────────────────────────────────────────────────────

COMPOSE_FILE="docker-compose.oshal-local.yml"
IMAGE_NAME="oshal-bot:latest"
COCKPIT_PORT="${OSHAL_API_PORT:-35457}"
COCKPIT_URL="http://localhost:${COCKPIT_PORT}"
HEALTH_TIMEOUT_SECS=300
HEALTH_POLL_INTERVAL_SECS=5

SKIP_BUILD=0
TEAR_DOWN=0

for arg in "$@"; do
  case "$arg" in
    --skip-build)  SKIP_BUILD=1 ;;
    --down)        TEAR_DOWN=1 ;;
    -h|--help)
      sed -n '10,30p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown flag: $arg"
      echo "Run: bash scripts/demo.sh --help"
      exit 64
      ;;
  esac
done

# ── Output helpers ──────────────────────────────────────────────────────────
# Color only when stdout is a TTY; otherwise plain text so logs stay clean.

if [ -t 1 ]; then
  C_BOLD=$'\033[1m'
  C_DIM=$'\033[2m'
  C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'
  C_RED=$'\033[31m'
  C_BLUE=$'\033[34m'
  C_RESET=$'\033[0m'
else
  C_BOLD=""; C_DIM=""; C_GREEN=""; C_YELLOW=""; C_RED=""; C_BLUE=""; C_RESET=""
fi

step()    { printf '\n%s━━ %s %s\n' "$C_BOLD" "$1" "$C_RESET"; }
ok()      { printf '%s✔%s %s\n' "$C_GREEN" "$C_RESET" "$1"; }
warn()    { printf '%s!%s %s\n' "$C_YELLOW" "$C_RESET" "$1"; }
fail()    { printf '%s✖%s %s\n' "$C_RED" "$C_RESET" "$1" >&2; }
info()    { printf '%s%s%s\n' "$C_DIM" "$1" "$C_RESET"; }

die() {
  fail "$1"
  if [ $# -gt 1 ]; then
    printf '  %s\n' "$2"
  fi
  exit 1
}

# ── --down handler ──────────────────────────────────────────────────────────

if [ "$TEAR_DOWN" -eq 1 ]; then
  step "Tearing down OSHAL local stack"
  docker compose -f "$COMPOSE_FILE" down --remove-orphans
  ok "Stopped"
  exit 0
fi

# ── Preflight: working directory ────────────────────────────────────────────

step "Preflight"

if [ ! -f "$COMPOSE_FILE" ]; then
  die "Cannot find $COMPOSE_FILE in $(pwd)" \
      "Run this script from the repository root: bash scripts/demo.sh"
fi

# ── Preflight: docker ───────────────────────────────────────────────────────

if ! command -v docker >/dev/null 2>&1; then
  die "docker is not installed or not on PATH" \
      "Install Docker Desktop: https://docs.docker.com/get-docker/"
fi

if ! docker info >/dev/null 2>&1; then
  die "docker daemon is not responding" \
      "Start Docker Desktop (or 'sudo systemctl start docker' on Linux) and re-run."
fi
ok "docker daemon reachable"

# ── Preflight: docker compose v2 ────────────────────────────────────────────

if ! docker compose version >/dev/null 2>&1; then
  die "docker compose v2 is required ('docker compose', not 'docker-compose')" \
      "Update to a recent Docker Desktop or install the compose v2 plugin."
fi
ok "docker compose v2 present"

# ── Preflight: cockpit port free ────────────────────────────────────────────

# We only check the cockpit port — the bot ports are internal-only on most
# Windows/macOS Docker Desktops, and conflict-checking them is unreliable.
port_in_use() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:"$1" -sTCP:LISTEN -P -n >/dev/null 2>&1
  elif command -v ss >/dev/null 2>&1; then
    ss -lnt "sport = :$1" 2>/dev/null | grep -q LISTEN
  elif command -v netstat >/dev/null 2>&1; then
    netstat -an 2>/dev/null | grep -E "[\.:]$1[[:space:]]+.*LISTEN" >/dev/null
  else
    return 1
  fi
}

if port_in_use "$COCKPIT_PORT"; then
  # Allow when an existing oshal-local stack already owns it.
  if docker compose -f "$COMPOSE_FILE" ps --status running --quiet | grep -q .; then
    warn "Cockpit port $COCKPIT_PORT in use by an existing oshal-local stack — will reuse it"
  else
    die "Port $COCKPIT_PORT is already in use by another process" \
        "Free it, or set OSHAL_API_PORT to a different value and re-run."
  fi
else
  ok "Cockpit port $COCKPIT_PORT is free"
fi

# ── Preflight: provider credentials (warn-only) ─────────────────────────────

# Demo works without a real key only in noop mode — but the incident RCA worth
# showing requires Codex (default) or Claude Code. Warn loudly so the user
# isn't surprised when LLM calls fail.
have_any_provider=0
have_provider_msg=""

if [ -n "${OPENAI_API_KEY:-}" ]; then
  have_any_provider=1
  have_provider_msg+="  OPENAI_API_KEY  (codex-cli + openai-codex bots)\n"
fi
if [ -n "${ANTHROPIC_API_KEY:-}" ] || [ -d "$HOME/.claude" ]; then
  have_any_provider=1
  have_provider_msg+="  Claude Code auth ($([ -n "${ANTHROPIC_API_KEY:-}" ] && echo "ANTHROPIC_API_KEY" || echo "~/.claude OAuth"))\n"
fi
if [ -n "${GEMINI_API_KEY:-}" ] || [ -n "${GOOGLE_API_KEY:-}" ] || [ -d "$HOME/.gemini" ]; then
  have_any_provider=1
  have_provider_msg+="  Gemini auth (research-bot)\n"
fi

if [ "$have_any_provider" -eq 1 ]; then
  ok "LLM credentials detected:"
  printf "%b" "$have_provider_msg" | sed 's/^/  /'
else
  warn "No LLM credentials detected. The stack will start, but bots cannot run real tickets."
  cat <<'EOF'
  Set at least one of these in your shell or .env before running real tickets:
    OPENAI_API_KEY=sk-…           (default codex-cli bots)
    ANTHROPIC_API_KEY=sk-ant-…    (or run "claude /login" to use OAuth ~/.claude)
    GEMINI_API_KEY=…              (research-bot)
EOF
fi

# ── Build image ─────────────────────────────────────────────────────────────

if [ "$SKIP_BUILD" -eq 0 ]; then
  step "Building OSHAL image"
  if docker image inspect "$IMAGE_NAME" >/dev/null 2>&1; then
    info "Image $IMAGE_NAME already present — rebuilding to pick up local changes"
  fi
  docker build -f Dockerfile.oshal -t "$IMAGE_NAME" .
  ok "Built $IMAGE_NAME"
else
  step "Skipping build (--skip-build)"
  if ! docker image inspect "$IMAGE_NAME" >/dev/null 2>&1; then
    die "Image $IMAGE_NAME not present and --skip-build was passed" \
        "Drop --skip-build, or run: docker build -f Dockerfile.oshal -t $IMAGE_NAME ."
  fi
  ok "Found existing image $IMAGE_NAME"
fi

# ── Bring stack up ──────────────────────────────────────────────────────────

step "Starting OSHAL stack"
docker compose -f "$COMPOSE_FILE" up -d
ok "Compose up issued"

# ── Wait for health ─────────────────────────────────────────────────────────

step "Waiting for cockpit /health (timeout ${HEALTH_TIMEOUT_SECS}s)"

deadline=$(( $(date +%s) + HEALTH_TIMEOUT_SECS ))
while :; do
  if curl -fsS "$COCKPIT_URL/health" >/dev/null 2>&1; then
    ok "Cockpit healthy at $COCKPIT_URL"
    break
  fi
  now=$(date +%s)
  if [ "$now" -ge "$deadline" ]; then
    fail "Cockpit did not become healthy within ${HEALTH_TIMEOUT_SECS}s"
    info "Recent controller logs:"
    docker compose -f "$COMPOSE_FILE" logs --tail=40 oshal-api 2>/dev/null || true
    die "Health check failed" \
        "Inspect: docker compose -f $COMPOSE_FILE logs oshal-api"
  fi
  printf '.'
  sleep "$HEALTH_POLL_INTERVAL_SECS"
done

# ── Closing instructions ────────────────────────────────────────────────────

step "Demo ready"

cat <<EOF
${C_BOLD}Cockpit:${C_RESET}    ${C_BLUE}${COCKPIT_URL}${C_RESET}
${C_BOLD}RCA tab:${C_RESET}    ${C_BLUE}${COCKPIT_URL}/?app=incident-rca${C_RESET}  ${C_DIM}(populates after an incident ticket completes)${C_RESET}

${C_BOLD}Try it — paste this into the intake on the home page:${C_RESET}

  ${C_DIM}postgres on prod-db01 hit OOM at 09:14 UTC. Memory used 248 GB of
  256 GB. work_mem is unbounded for the reporting role. The nightly batch
  job started at 09:00 UTC. dmesg shows oom-killer reaped pid 14123
  (postgres). Need RCA + remediation script + escalation packet for the
  on-call DBA.${C_RESET}

${C_BOLD}What to watch for:${C_RESET}
  • Ticket creation flips to 'approved' immediately (single-bot pipeline)
  • The rca-specialist bot picks it up; you'll see Mode A/B/C marker
    on RCA-REPORT line 1
  • RCA tab populates with: 4-row failure-mode taxonomy, 5-section
    HANDOVER (Verdict / Revisions / Summary / Escalation / Open items)
  • Workspace artifacts in ./workspace-shared/<ticketId>/:
      RCA-REPORT.md, diagnose.sh, remediate.sh, rollback.sh, ESCALATION.md

${C_BOLD}Stop the stack when done:${C_RESET}
  bash scripts/demo.sh --down
EOF

if [ "$have_any_provider" -eq 0 ]; then
  printf '\n%s' "$C_YELLOW"
  echo "Reminder: no LLM credentials are configured. The cockpit will load,"
  echo "but ticket execution will fail until you set a provider key."
  printf '%s' "$C_RESET"
fi
