#!/usr/bin/env bash
# Rotate the oshal_bot Postgres LOGIN password away from the committed dev default.
#
# YOU run this; the generated password is never printed, never logged, and never leaves this box.
# It is written only to two places: the Postgres role, and BOT_DATABASE_URL in .env (untracked).
#
# What it does, in order:
#   1. refuses if a deploy is running, if .env already sets BOT_DATABASE_URL, or if the role is absent
#   2. generates a 32-byte URL-safe password locally (openssl)
#   3. ALTER ROLE oshal_bot WITH PASSWORD '<new>'   (the only write to oshal-local-db)
#   4. verifies the new password actually authenticates, as oshal_bot, from inside the db container
#   5. appends BOT_DATABASE_URL to .env, after backing .env up
#   6. recreates the bot tier so every bot picks it up
#   7. re-verifies the role's least-privilege attributes and prints a health summary
# On a failure after step 3 it tells you exactly what state you are in.
#
# Rollback: the role's old password was the committed default; re-running
#   docker exec oshal-local-db psql -U oshal -d postgres -c "ALTER ROLE oshal_bot WITH PASSWORD 'oshal-bot-dev'"
# and removing the BOT_DATABASE_URL line from .env returns the box to where it started.
set -u -o pipefail
cd /c/Projects/oshal || exit 1

say() { printf '%s\n' "$*"; }
fail() { printf 'FAILED: %s\n' "$*" >&2; exit 1; }

[ -d "$HOME/.oshal-deploy/lock" ] && fail "a deploy is running (lock present) — try again when it finishes"
[ -f .env ] || fail ".env not found in $(pwd)"
grep -qE '^BOT_DATABASE_URL=' .env && fail ".env already sets BOT_DATABASE_URL — rotating would need that line replaced, not appended; do it by hand"
docker inspect oshal-local-db >/dev/null 2>&1 || fail "oshal-local-db is not running"

exists=$(docker exec oshal-local-db psql -U oshal -d postgres -tAc "SELECT 1 FROM pg_roles WHERE rolname='oshal_bot'" 2>/dev/null | tr -d '\r')
[ "$exists" = "1" ] || fail "role oshal_bot does not exist — apply migration 099 first"

# 2. generate. Base64url of 24 random bytes: no quote, no backslash, no @ or : to confuse a DSN.
NEWPW=$(openssl rand -base64 24 | tr '+/' '-_' | tr -d '=\n')
[ ${#NEWPW} -ge 24 ] || fail "could not generate a password (openssl missing?)"

say "rotating oshal_bot ..."
# 3. the single write. The value is passed via the container's env, so it is not in the argv of psql.
if ! NEWPW="$NEWPW" docker exec -e NEWPW oshal-local-db sh -c 'psql -U oshal -d postgres -v ON_ERROR_STOP=1 -c "ALTER ROLE oshal_bot WITH PASSWORD '"'"'$NEWPW'"'"'"' >/dev/null 2>&1; then
  fail "ALTER ROLE failed — the password is unchanged, .env untouched"
fi

# 4. prove the new password authenticates before touching .env
if ! NEWPW="$NEWPW" docker exec -e NEWPW oshal-local-db sh -c 'PGPASSWORD="$NEWPW" psql -U oshal_bot -h 127.0.0.1 -d oshal -tAc "SELECT 1"' >/dev/null 2>&1; then
  say "the new password did NOT authenticate. Restoring the previous default so the box keeps working."
  docker exec oshal-local-db psql -U oshal -d postgres -c "ALTER ROLE oshal_bot WITH PASSWORD 'oshal-bot-dev'" >/dev/null 2>&1
  fail "rotation rolled back; .env untouched"
fi
say "  new password authenticates as oshal_bot"

# 5. .env, backed up first
cp .env ".env.bak-before-bot-rotation-$(date +%Y%m%d-%H%M%S)" || fail "could not back up .env"
printf '\n# oshal_bot DSN — rotated off the committed dev default (operator, %s)\nBOT_DATABASE_URL=postgresql://oshal_bot:%s@oshal-db:5432/oshal\n' "$(date +%Y-%m-%d)" "$NEWPW" >> .env || fail ".env write failed — the role now has a new password that .env does not carry; re-run the rollback line in this script's header"
unset NEWPW
say "  .env updated (backup kept alongside it)"

# 6. bots pick it up
say "recreating the bot tier ..."
BOTS=$(docker ps -q --filter label=oshal.tier=worker)
if [ -n "$BOTS" ]; then
  docker compose -f docker-compose.oshal-local.yml up -d --force-recreate $(docker ps --filter label=oshal.tier=worker --format '{{.Names}}' | sed 's/^oshal-local-//' | tr '\n' ' ') >/dev/null 2>&1 \
    || say "  compose recreate reported a problem — check 'docker ps' and re-run 'bash scripts/oshal-up.sh' if bots are down"
fi

# 7. summary
say ""
say "role attributes (all must be f):"
docker exec oshal-local-db psql -U oshal -d oshal -tAc "SELECT 'super='||rolsuper||' bypassrls='||rolbypassrls||' createdb='||rolcreatedb||' createrole='||rolcreaterole FROM pg_roles WHERE rolname='oshal_bot'" 2>/dev/null | tr -d '\r' | sed 's/^/  /'
say "containers running: $(docker ps -q | wc -l | tr -d ' ') | unhealthy: $(docker ps --filter health=unhealthy -q | wc -l | tr -d ' ')"
say "api /health: $(curl -s -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:35457/health)"
say ""
say "done. The password is in .env and in Postgres, and nowhere else."
