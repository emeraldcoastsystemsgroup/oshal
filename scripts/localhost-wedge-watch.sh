#!/usr/bin/env bash
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — passive auto-recovery for the localhost wedge. The root cause (a stale wslrelay.exe squatting the IPv6 loopback [::1] for every Docker-published port) has been documented since 2026-06-12 and the fix is one command, but NOTHING detected it: the stack watchdog and swarm-routability-check both probe 127.0.0.1 precisely to DODGE the squatter, so a box can serve every check green while every browser hitting http://localhost hangs. This watches the signal that actually distinguishes it — IPv4 loopback answers, `localhost` does not — and clears the squatter itself, with a cooldown so it can never thrash.
#
# WHAT IT DETECTS (and nothing else). Browsers resolve `localhost` to ::1 first. A stale
# wslrelay holds ::1:<port>, accepts the connection and never services it — no refusal, so
# no IPv4 fallback, so the tab hangs while `docker ps` shows everything healthy. The unique
# fingerprint is: 127.0.0.1:<port> ANSWERS and localhost:<port> DOES NOT. Anything else
# (both dead, both fine) is NOT this failure and this script will not touch it — a wedged
# engine belongs to scripts/oshal-stack-watchdog.ps1, and killing wslrelay would not help.
#
# RECOVERY: `Stop-Process -Name wslrelay -Force` via PowerShell. wslrelay respawns on demand
# and Docker is unaffected. Container bounces (api-bounce.sh) and even full Docker Desktop
# restarts do NOT clear it — the process belongs to WSL, not Docker. Runbook:
# docs/runbooks/localhost-wedge-wslrelay.md
#
# USAGE
#   bash scripts/localhost-wedge-watch.sh                 # one-shot check + recover
#   bash scripts/localhost-wedge-watch.sh --watch         # stay resident, check every 60s
#   bash scripts/localhost-wedge-watch.sh --watch --interval 30
#   bash scripts/localhost-wedge-watch.sh --install       # register the Windows scheduled task
#   bash scripts/localhost-wedge-watch.sh --install --dry-run   # print the command, change nothing
#   bash scripts/localhost-wedge-watch.sh --uninstall
#
# ENV
#   WEDGE_PORTS      space/comma-separated published ports to probe (default "35457")
#   WEDGE_PATH       health path on those ports (default "/api/health")
#   WEDGE_COOLDOWN   seconds between recoveries (default 300) — a kill loop is worse than a wedge
#   WEDGE_STATE_DIR  where the last-recovery marker + log live (default $LOCALAPPDATA/oshal)
#   POWERSHELL       powershell executable (default powershell.exe)
#
# EXIT
#   0  nothing wrong, or the wedge was cleared and localhost answers again
#   1  the ::1 wedge is present and recovery did NOT restore it (or was suppressed by cooldown)
#   2  usage error
#   3  neither loopback answers — a different failure; hand off to oshal-up.sh / the stack watchdog
set -uo pipefail

PORTS="${WEDGE_PORTS:-35457}"
HEALTH_PATH="${WEDGE_PATH:-/api/health}"
COOLDOWN="${WEDGE_COOLDOWN:-300}"
POWERSHELL="${POWERSHELL:-powershell.exe}"
STATE_DIR="${WEDGE_STATE_DIR:-${LOCALAPPDATA:-$HOME}/oshal}"
STATE_FILE="$STATE_DIR/localhost-wedge-last-recovery"
LOG_FILE="$STATE_DIR/localhost-wedge-watch.log"
TASK_NAME="OSHAL Localhost Wedge Watcher"
MODE=once
INTERVAL=60
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --once) MODE=once; shift ;;
    --watch) MODE=watch; shift ;;
    --install) MODE=install; shift ;;
    --uninstall) MODE=uninstall; shift ;;
    --interval) INTERVAL="${2:-60}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

mkdir -p "$STATE_DIR" 2>/dev/null || true
log() { printf '[%s] %s\n' "$(date '+%Y-%m-%dT%H:%M:%S')" "$1" | tee -a "$LOG_FILE"; }

# One HTTP probe. Returns 0 when the host answers on that port at all — any HTTP status counts,
# because the question is "is this loopback address being SERVICED", not "is the app 200".
probe() {
  local host="$1" port="$2"
  curl -s -o /dev/null --max-time 4 "http://${host}:${port}${HEALTH_PATH}" 2>/dev/null
}

# Classify the box: ok | wedged | down.
#   wedged  -> at least one port answers on 127.0.0.1 but not on localhost  (the ::1 squatter)
#   down    -> no port answers on either address                            (not our failure)
#   ok      -> every probed port answers on localhost
classify() {
  local ipv4_up=0 localhost_up=0 port
  for port in $(printf '%s' "$PORTS" | tr ',' ' '); do
    [ -z "$port" ] && continue
    if probe 127.0.0.1 "$port"; then
      ipv4_up=1
      if probe localhost "$port"; then localhost_up=1; else echo wedged; return; fi
    fi
  done
  if [ "$ipv4_up" -eq 1 ] || [ "$localhost_up" -eq 1 ]; then echo ok; else echo down; fi
}

# Cooldown: at most one kill per WEDGE_COOLDOWN seconds. wslrelay respawns on demand, so a bug in
# the detector must not turn into a kill loop against a process the host legitimately needs.
in_cooldown() {
  [ -f "$STATE_FILE" ] || return 1
  local last now
  last="$(cat "$STATE_FILE" 2>/dev/null | tr -d '[:space:]')"
  case "$last" in ''|*[!0-9]*) return 1 ;; esac
  now="$(date +%s)"
  [ "$((now - last))" -lt "$COOLDOWN" ]
}

# Kill the squatter. Returns 0 when PowerShell reported success.
clear_squatter() {
  log "clearing the ::1 squatter: Stop-Process -Name wslrelay -Force"
  "$POWERSHELL" -NoProfile -NonInteractive -Command \
    "Get-Process -Name wslrelay -ErrorAction SilentlyContinue | Stop-Process -Force; exit 0" >>"$LOG_FILE" 2>&1
}

# One full detect -> recover -> verify cycle. Echoes the resulting exit code.
run_once() {
  local state
  state="$(classify)"
  case "$state" in
    ok) return 0 ;;
    down)
      log "neither loopback answers on ports [$PORTS] — NOT the ::1 wedge (engine/api down)."
      log "  -> recover with: bash scripts/oshal-up.sh   (engine wedge: scripts/oshal-stack-watchdog.ps1 -Force)"
      return 3 ;;
  esac

  log "DETECTED: 127.0.0.1 answers but localhost does not — stale wslrelay squatting [::1] on [$PORTS]"
  if in_cooldown; then
    log "in cooldown (<${COOLDOWN}s since the last recovery) — not killing wslrelay again this run"
    return 1
  fi

  clear_squatter
  date +%s > "$STATE_FILE"
  sleep 2

  if [ "$(classify)" = "ok" ]; then
    log "RECOVERED: localhost answers again on [$PORTS]"
    return 0
  fi
  log "RECOVERY FAILED: localhost still not answering. Check by hand:"
  log "  Get-NetTCPConnection -LocalPort ${PORTS%% *} -State Listen | ForEach-Object { \$_.LocalAddress }"
  return 1
}

# The scheduled-task command. Built once so --install and the guard see the same string.
task_command() {
  local bash_exe repo
  bash_exe="$(command -v bash)"
  case "$bash_exe" in /*) bash_exe="C:\\Program Files\\Git\\bin\\bash.exe" ;; esac
  repo="$(cd "$(dirname "$0")/.." && pwd)"
  printf '"%s" -lc "cd \\"%s\\" && bash scripts/localhost-wedge-watch.sh --once"' "$bash_exe" "$repo"
}

case "$MODE" in
  install)
    cmd="$(task_command)"
    if [ "$DRY_RUN" -eq 1 ]; then
      echo "schtasks /create /tn \"$TASK_NAME\" /sc minute /mo 5 /f /tr $cmd"
      exit 0
    fi
    schtasks //create //tn "$TASK_NAME" //sc minute //mo 5 //f //tr "$cmd" || {
      echo "schtasks refused — register by hand (see the header) or run --watch instead." >&2; exit 1; }
    schtasks //query //tn "$TASK_NAME" >/dev/null 2>&1 || {
      echo "schtasks reported success but the task is not queryable — it did NOT register." >&2; exit 1; }
    echo "registered '$TASK_NAME' (every 5 minutes)."
    exit 0 ;;
  uninstall)
    schtasks //delete //tn "$TASK_NAME" //f && echo "removed '$TASK_NAME'."
    exit 0 ;;
  watch)
    log "localhost wedge watcher started (ports [$PORTS], every ${INTERVAL}s)"
    while :; do
      run_once || true
      sleep "$INTERVAL"
    done ;;
  once)
    run_once
    exit $? ;;
esac
