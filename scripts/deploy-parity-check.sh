#!/usr/bin/env bash
#
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — deploy parity check: warn loudly when the api and bot-node containers run different image builds (the split-image drift that ships two-half features broken). BACKLOG "Deploy parity check".
#
# WHY: api and every bot-node run the SAME image (any-bot:latest); which process starts is decided at
# container boot by BOT_RUNTIME. When concurrent sessions retag :latest at different times and recreate
# only some containers, the api and bots end up on DIFFERENT builds — a two-half feature (writer in a
# bot, reader in the api) then ships split and every delayed job silently shows fallback output. This
# check compares the running api's image id against every running bot-node's and names the stragglers.
#
# USAGE:  bash scripts/deploy-parity-check.sh            # human report
#         bash scripts/deploy-parity-check.sh --quiet    # only print on mismatch (for oshal-up.sh)
# EXIT:   0 = all in parity   1 = drift detected   2 = env error (docker down, no api container)

set -uo pipefail

QUIET=0
[ "${1:-}" = "--quiet" ] && QUIET=1

say() { [ "$QUIET" -eq 1 ] || printf '%s\n' "$*"; }

command -v docker >/dev/null 2>&1 || { echo "deploy-parity-check: docker CLI not found" >&2; exit 2; }
docker info >/dev/null 2>&1 || { echo "deploy-parity-check: docker daemon not reachable" >&2; exit 2; }

# Collect OSHAL app containers (those with BOT_RUNTIME set — this excludes infra: postgres/redis/chroma/arango).
# Row shape: name<TAB>runtime<TAB>image-id(12)<TAB>image-created
rows=""
for c in $(docker ps --format '{{.Names}}'); do
  rt=$(docker inspect "$c" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null \
        | grep -E '^BOT_RUNTIME=' | head -1 | cut -d= -f2 | tr -d '\r')
  [ -z "$rt" ] && continue
  img=$(docker inspect "$c" --format '{{.Image}}' 2>/dev/null | sed 's/^sha256://' | cut -c1-12)
  created=$(docker inspect "$(docker inspect "$c" --format '{{.Image}}' 2>/dev/null)" --format '{{.Created}}' 2>/dev/null)
  rows="${rows}${c}	${rt}	${img}	${created}
"
done

[ -z "$rows" ] && { echo "deploy-parity-check: no OSHAL app containers running (nothing with BOT_RUNTIME)" >&2; exit 2; }

# The api is the BOT_RUNTIME=swarm container; it is the reference build.
api_line=$(printf '%s' "$rows" | awk -F'\t' '$2=="swarm"{print; exit}')
[ -z "$api_line" ] && { echo "deploy-parity-check: no api container (BOT_RUNTIME=swarm) is running" >&2; exit 2; }
api_name=$(printf '%s' "$api_line" | cut -f1)
api_img=$(printf '%s'  "$api_line" | cut -f3)
api_created=$(printf '%s' "$api_line" | cut -f4)

say ""
say "OSHAL deploy parity check"
say "  reference (api / swarm): ${api_name}  image ${api_img}  built ${api_created}"

# Compare every bot-node against the api image.
bots=$(printf '%s' "$rows" | awk -F'\t' '$2=="bot-node"{print}')
bot_total=$(printf '%s' "$bots" | grep -c . || true)
drift=$(printf '%s' "$bots" | awk -F'\t' -v ref="$api_img" '$3!=ref{print}')
drift_n=$(printf '%s' "$drift" | grep -c . || true)
match_n=$(( bot_total - drift_n ))

say "  bot-node containers: ${bot_total}  (${match_n} in parity, ${drift_n} drifted)"

# Distinct builds present across the whole app tier (api + bots).
say ""
say "  distinct image builds in play:"
printf '%s' "$rows" | awk -F'\t' '{print $3"\t"$4}' | sort -u | while IFS=$'\t' read -r img created; do
  mark=""; [ "$img" = "$api_img" ] && mark="  <- api"
  say "    ${img}  built ${created}${mark}"
done

if [ "$drift_n" -eq 0 ]; then
  say ""
  say "  OK — api and all ${bot_total} bot-node containers run the same build (${api_img})."
  exit 0
fi

# Drift: name the stragglers loudly (printed even in --quiet mode).
printf '\n'
printf '  !! DEPLOY DRIFT — %d bot-node container(s) are NOT on the api build (%s):\n' "$drift_n" "$api_img"
printf '%s\n' "$drift" | while IFS=$'\t' read -r name rt img created; do
  [ -z "$name" ] && continue
  printf '     %-34s image %s  built %s\n' "$name" "$img" "$created"
done
printf '\n'
printf '  A two-half feature (writer in a bot, reader in the api, or vice versa) will ship SPLIT.\n'
printf '  Fix: recreate the stale containers from the SAME build the api runs, e.g.\n'
printf '     docker compose -f docker-compose.oshal-local.yml up -d --force-recreate --no-deps <names above>\n'
printf '  or bring the whole stack up in order with:  bash scripts/oshal-up.sh\n\n'
exit 1
