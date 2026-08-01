#!/usr/bin/env bash
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | INSTALLER-GAPS G1 — the postflight capability verifier. Governing rule: a deployment must not report success while a capability it advertises has no credential behind it. The G-Squared box passed every check it had (container counts, /api/health) while the engine, STT, TTS and a routing-critical bot were all dead. This script fails LOUDLY, naming the broken leg: kernel containers healthy -> GET /api/readiness (server-side, ACTIVE-registry-scoped legs: llm / bots / credentials / voice / db) -> when the bots leg fails and the repo's swarm-routability-check.sh is present, runs it as the host-side drill-down (that script stays THE heartbeat prober — this one consumes the same signal server-side via /api/readiness rather than duplicating it). Two postures: strict (default — any fail leg fails the run) and --pre-onboarding (install-time: llm/credentials/voice legs the browser wizard is about to satisfy report PENDING instead of failing). --no-ai (or OSHAL_NO_AI=true in --env-file) asserts the DECLARED model-less posture: llm must be 'off', and 'fail' means the declaration did not reach the container.
#
# Usage:
#   bash scripts/oshal-verify.sh                          # strict operational check
#   bash scripts/oshal-verify.sh --pre-onboarding         # install-time (wizard still pending)
#   bash scripts/oshal-verify.sh --no-ai --env-file .env  # declared model-less box
#   bash scripts/oshal-verify.sh --api http://127.0.0.1:35457 --wait 120
set -uo pipefail

# 127.0.0.1, NOT localhost: a stale wslrelay squatting [::1] makes localhost probes
# hang while the api is healthy (see docs/runbooks/localhost-wedge-wslrelay.md).
API="${API_URL:-http://127.0.0.1:35457}"
PRE=0; NO_AI=0; ENV_FILE=""; WAIT=90
while [ $# -gt 0 ]; do case "$1" in
  --pre-onboarding) PRE=1; shift ;;
  --no-ai) NO_AI=1; shift ;;
  --env-file) ENV_FILE="$2"; shift 2 ;;
  --api) API="$2"; shift 2 ;;
  --wait) WAIT="$2"; shift 2 ;;
  *) echo "unknown arg: $1" >&2; exit 2 ;;
esac; done

# The .env declaration counts even without the flag — verify against what the box RUNS.
if [ -n "$ENV_FILE" ] && [ -f "$ENV_FILE" ] && grep -q '^OSHAL_NO_AI=true' "$ENV_FILE"; then NO_AI=1; fi

FAILS=0; PENDING=0
ok()   { printf '  [ok]      %s\n' "$*"; }
off()  { printf '  [off]     %s\n' "$*"; }
pend() { printf '  [PENDING] %s\n' "$*"; PENDING=$((PENDING + 1)); }
bad()  { printf '  [FAIL]    %s\n' "$*"; FAILS=$((FAILS + 1)); }

echo "=== oshal postflight verification (INSTALLER-GAPS G1) ==="

# ── [1] kernel containers healthy ────────────────────────────────────────────
for c in oshal-local-db oshal-local-redis oshal-local-chromadb oshal-local-api; do
  state="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$c" 2>/dev/null || echo missing)"
  if [ "$state" = "healthy" ]; then ok "$c healthy"; else bad "$c is '$state' — kernel service not healthy (recover: bash scripts/oshal-up.sh)"; fi
done

# ── [2] /api/readiness — per-capability, active-registry-scoped ──────────────
BODY=""
deadline=$(( SECONDS + WAIT ))
while :; do
  BODY="$(curl -s -m 8 "$API/api/readiness" 2>/dev/null)" || BODY=""
  printf '%s' "$BODY" | grep -q '"ready":true' && break
  [ "$SECONDS" -ge "$deadline" ] && break
  sleep 5
done
if [ -z "$BODY" ]; then
  bad "GET $API/api/readiness unreachable — cannot verify a single capability (api down, or an image predating /api/readiness)"
else
  SUMMARY="$(printf '%s' "$BODY" | sed -n 's/.*"summary":"\([^"]*\)".*/\1/p')"
  leg() { printf '%s' "$SUMMARY" | tr ' ' '\n' | grep "^$1=" | head -1 | cut -d= -f2; }
  problem_for() { printf '%s' "$BODY" | sed -n 's/.*"problems":\[\([^]]*\)\].*/\1/p' | tr '",' '\n,' | grep -i "^$1:" | head -1; }

  # llm — the engine. --no-ai asserts the DECLARED posture end to end.
  LLM="$(leg llm)"
  if [ "$NO_AI" -eq 1 ]; then
    case "$LLM" in
      off) ok "llm: off — declared no-AI posture confirmed in the running container" ;;
      ok)  bad "llm: a model is ACTIVE but this box declares --no-ai — remove OSHAL_NO_AI=true or disconnect the model (contradictory posture)" ;;
      *)   bad "llm: state '$LLM' on a declared no-AI box — OSHAL_NO_AI=true did not reach the api container (check the compose env passthrough)" ;;
    esac
  else
    case "$LLM" in
      ok)  ok "llm: $(printf '%s' "$BODY" | sed -n 's/.*"llm":{"state":"ok","detail":"\([^"]*\)".*/\1/p')" ;;
      *)   if [ "$PRE" -eq 1 ]; then pend "llm: no model yet — the wizard connects one next (REQUIRED; the install is not done until it does)"; else bad "llm: $(problem_for llm)"; fi ;;
    esac
  fi

  # bots — routing-critical heartbeats (server-side, same signal the call-out uses).
  BOTS="$(leg bots)"
  case "$BOTS" in
    ok)  ok "bots: routing-critical heartbeats live" ;;
    off) off "bots: $(printf '%s' "$BODY" | sed -n 's/.*"bots":{"state":"off","detail":"\([^"]*\)".*/\1/p')" ;;
    *)   bad "bots: $(problem_for bots)"
         # Host-side drill-down: the repo's routability prober names what breaks per bot.
         HERE="$(cd "$(dirname "$0")" && pwd)"
         if [ -f "$HERE/swarm-routability-check.sh" ]; then
           echo "  --- host-side heartbeat drill-down (swarm-routability-check.sh) ---"
           bash "$HERE/swarm-routability-check.sh" || true
         fi ;;
  esac

  # credentials — G7: a started bot's provider must have a credential behind it.
  CRED="$(leg credentials)"
  case "$CRED" in
    ok)  ok "credentials: every routing-critical harness has a credential" ;;
    off) off "credentials: $(printf '%s' "$BODY" | sed -n 's/.*"credentials":{"state":"off","detail":"\([^"]*\)".*/\1/p')" ;;
    *)   if [ "$PRE" -eq 1 ]; then pend "credentials: $(problem_for credentials) — sign in via the wizard/host CLI"; else bad "credentials: $(problem_for credentials)"; fi ;;
  esac

  # voice — configured:true, or explicitly not declared.
  for side in voice.tts voice.stt; do
    V="$(leg $side)"
    key="$( [ "$side" = voice.tts ] && echo voiceTts || echo voiceStt )"
    case "$V" in
      ok)  ok "$side: configured" ;;
      off) off "$side: $(printf '%s' "$BODY" | sed -n 's/.*"'"$key"'":{"state":"off","detail":"\([^"]*\)".*/\1/p')" ;;
      *)   if [ "$PRE" -eq 1 ]; then pend "$side: declared but unconfigured — finish voice setup or remove the declaration"; else bad "$side: $(problem_for "$key")"; fi ;;
    esac
  done

  # db — never waivable.
  DB="$(leg db)"
  [ "$DB" = "ok" ] && ok "db: postgres reachable" || bad "db: $(problem_for db)"
fi

echo
if [ "$FAILS" -gt 0 ]; then
  echo "RESULT: FAIL — $FAILS broken leg(s) named above. This deployment advertises capabilities it cannot serve."
  echo "Fix the named leg, then re-run: bash scripts/oshal-verify.sh"
  exit 1
fi
if [ "$PENDING" -gt 0 ]; then
  echo "RESULT: PASS (pre-onboarding) — $PENDING leg(s) pending the browser wizard. The install is NOT finished until the wizard completes."
  exit 0
fi
echo "RESULT: PASS — every advertised capability has something real behind it."
exit 0
