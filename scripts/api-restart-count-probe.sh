#!/usr/bin/env bash
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | New. The deploy-window restart probe the embedding-abort BACKLOG entry asks for: prints the api container's RestartCount, StartedAt, deployed commit and how many bare Emscripten `Aborted(` markers its current log holds. `--record FILE` writes a baseline; `--baseline FILE` exits 1 when RestartCount OR StartedAt moved since (Docker resets RestartCount on a recreate, so StartedAt is compared too). Read-only against the daemon.
#
# Usage: scripts/api-restart-count-probe.sh [--record FILE] [--baseline FILE] [CONTAINER]
set -euo pipefail
export MSYS_NO_PATHCONV=1

name=oshal-local-api
record=""
baseline=""
while [ $# -gt 0 ]; do
  case "$1" in
    --record)   record="$2";   shift 2 ;;
    --baseline) baseline="$2"; shift 2 ;;
    -h|--help)  sed -n '8p' "$0"; exit 0 ;;
    *)          name="$1";     shift ;;
  esac
done

inspect=$(docker inspect "$name" --format '{{.RestartCount}} {{.State.StartedAt}} {{.State.Status}} {{index .Config.Labels "oshal.git.commit"}}')
read -r restarts started status commit <<<"$inspect"
aborts=$(docker logs "$name" 2>&1 | grep -c '^Aborted(' || true)
now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
echo "container=$name status=$status restartCount=$restarts startedAt=$started commit=${commit:0:12} abortMarkers=$aborts observedAt=$now"

if [ -n "$record" ]; then
  echo "$restarts $started $commit $now" > "$record"
  echo "baseline recorded in $record"
fi

if [ -n "$baseline" ]; then
  read -r b_restarts b_started b_commit b_now < "$baseline"
  if [ "$restarts" != "$b_restarts" ] || [ "$started" != "$b_started" ]; then
    echo "RESTARTED since baseline ($b_now): restartCount $b_restarts -> $restarts, startedAt $b_started -> $started"
    exit 1
  fi
  echo "unchanged since baseline ($b_now): restartCount=$restarts, same StartedAt, commit ${b_commit:0:12}"
fi
