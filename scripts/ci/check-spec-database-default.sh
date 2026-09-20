#!/usr/bin/env bash
# =============================================================================
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Refuse a test file that can reach the operator's LIVE Postgres by DEFAULT. 23 DB-backed specs ended their DSN expression in a loopback fallback on the stack's published port, which is the real trading database: a bare `npx vitest run tests/unit/trading-*.spec.ts` created and dropped schema and wrote order rows in production. It fired twice on 2026-09-14 from two lanes that had each been told in writing not to touch it — a written brief is not a guard, so this is the guard.
# 2 | maintainer@emeraldcoastsystemsgroup.com   | Close the half the port rules could not see: the live database named as a HOST or as a fallback CONTAINER rather than addressed by published port. Rules 1 and 2 judge `127.0.0.1:<published>`, so `@oshal-local-db:5432` in a DSN and `process.env.OSHAL_TEST_DB_CONTAINER || 'oshal-local-db'` both passed clean — and the second was live in the tree, sending a spec's `docker exec psql` into the deployment while the DSN beside it pointed at a throwaway. The new rule judges the name only where it IS a database target (DSN host, a `host:`/`host=` field, or an environment fallback), so the alert and topology fixtures that name the same container as a monitoring subject stay green on the rule as written rather than on an allowlist.
# 3 | maintainer@emeraldcoastsystemsgroup.com  | The vocabulary covers REDIS. It named only the Postgres knobs and containers, so a spec defaulting to `redis://127.0.0.1:${process.env.OSHAL_REDIS_PORT ?? 16379}` passed this gate clean - and on the box it was found on, OSHAL_REDIS_PORT=16379 with that port open and the compose default closed, so the default WAS the operator's live swarm queue. Same defect shape as the Postgres incident this script exists for; only the datastore was different, and a guard that lists its targets by name shrinks every time a new one appears.
# =============================================================================
#
# WHAT IS REFUSED, and the line it draws:
#
#   1. A live PUBLISHED Postgres port written as a literal in a test file. The local stack
#      publishes 127.0.0.1:55433 (oshal-local-db, the trading database) and 127.0.0.1:55434
#      (oshal-local-tsdb) — see docker-compose.oshal-local.yml. A *.spec.ts / *.test.ts file
#      creates and destroys rows and schema, so it may never name either address.
#   2. Any test-tree module reaching for the published-port knob through `process.env`. That is
#      the silent-default shape itself (`process.env.OSHAL_PG_PORT ?? '<published>'`), and it is
#      refused even when the literal has been changed, so the defect cannot come back renamed.
#
#   3. The live databases named rather than addressed. `oshal-local-db` and `oshal-local-tsdb`
#      are the container names of the same two servers rule 1 judges by port, and a DSN of
#      `@oshal-local-db:5432` or a `process.env.X || 'oshal-local-db'` container default reaches
#      exactly the same data. The name is refused only where it is a database TARGET — the host
#      half of a connection string (`@` or `//` before it), a `host:` / `host=` field, or an
#      environment fallback — because the alert and topology fixtures name that container as a
#      monitoring SUBJECT dozens of times over and those are not connections. The distinction is
#      a property of the shape, not a path on a list.
#
#      Not covered, deliberately: `docker exec <container> psql` written as positional argv in a
#      live-stack e2e. Those files exist to drive the running deployment. What rule 3 catches is
#      the container-name DEFAULT that fed one of them on a run that had pointed everything else
#      at a throwaway.
#
#   tests/helpers/host-database-url.ts is NOT an exception and is not allowlisted — it passes on
#   the rules as written. It rewrites a compose-internal DSN onto the published port so a HOST-side
#   Playwright run can reach compose Postgres, which is a deliberate, read-mostly use of the live
#   stack and is correct. It survives because it is not a test file (rule 1 judges *.spec.ts /
#   *.test.ts) and because it reads an INJECTED env parameter rather than `process.env` (rule 2).
#   Both are structural properties of the code, not a path on a list — a new helper that reached
#   for `process.env` and handed the result to a spec would be caught.
#
# Usage:  bash scripts/ci/check-spec-database-default.sh [root]
#   root  tree to judge (default: the repo this script lives in; ci-local.sh passes the HEAD export)
#
# Exit: 0 = clean, 1 = a violation was found, 2 = UNCHECKED (the tree has no test files, so this
#       gate looked at nothing — it says so rather than reporting clean, because a guard that
#       passes without looking is the false-green this repo has already recorded twice).
set -uo pipefail

ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$ROOT" 2>/dev/null || { echo "spec-database-default: UNCHECKED — cannot enter '$ROOT'"; exit 2; }

# The live stack's published Postgres ports, as a word-bounded number so 155433 or 554330 are not
# hits. Kept here, once: this script is the only place the forbidden literal is written down.
LIVE_PORTS='(^|[^0-9])5543[34]([^0-9]|$)'
# The silent-default shape: a test-tree module reading the published-port knob off the environment.
# OSHAL_REDIS_PORT belongs here for the same reason the Postgres knobs do, and was missing: a spec
# read it, fell back to a loopback literal that WAS the live port on the operator's box, and this
# gate reported OK throughout because its vocabulary named only Postgres. The datastore changes;
# the shape does not. Add the knob when a new published service appears.
PORT_KNOB='process\.env\.(OSHAL_PG_PORT|OSHAL_TSDB_PORT|OSHAL_REDIS_PORT)'
# The live databases named in the host position of a connection string, or in a `host:` / `host=`
# field. The trailing class stops `oshal-local-db` matching a longer name that merely starts with it.
LIVE_DB_HOST='(@|//|host[[:space:]]*[:=][[:space:]]*.?)oshal-local-(db|tsdb|redis)([^A-Za-z0-9-]|$)'
# The silent-default shape wearing a container name: `process.env.X || 'oshal-local-db'`.
LIVE_DB_FALLBACK='process\.env\.[A-Za-z_][A-Za-z0-9_]*[[:space:]]*(\|\||\?\?)[[:space:]]*.?oshal-local-(db|tsdb|redis)([^A-Za-z0-9-]|$)'

TEST_FILES="$(find tests src -type f \( -name '*.spec.ts' -o -name '*.test.ts' \) 2>/dev/null | sort)"
TREE_FILES="$(find tests -type f -name '*.ts' 2>/dev/null; find src -type f -name '*.test.ts' 2>/dev/null)"
TREE_FILES="$(printf '%s\n' "$TREE_FILES" | sort -u | sed '/^$/d')"

if [ -z "$TEST_FILES" ]; then
  echo "spec-database-default: UNCHECKED — no *.spec.ts / *.test.ts under tests/ or src/ in '$ROOT'."
  echo "  Nothing here says the tree is clean; it says this gate had nothing to read."
  exit 2
fi

HITS=""
LITERAL_HITS="$(printf '%s\n' "$TEST_FILES" | xargs grep -nHE "$LIVE_PORTS" 2>/dev/null)"
[ -n "$LITERAL_HITS" ] && HITS="$HITS$LITERAL_HITS"$'\n'
KNOB_HITS="$(printf '%s\n' "$TREE_FILES" | xargs grep -nHE "$PORT_KNOB" 2>/dev/null)"
[ -n "$KNOB_HITS" ] && HITS="$HITS$KNOB_HITS"$'\n'
HOST_HITS="$(printf '%s\n' "$TREE_FILES" | xargs grep -nHE "$LIVE_DB_HOST" 2>/dev/null)"
[ -n "$HOST_HITS" ] && HITS="$HITS$HOST_HITS"$'\n'
FALLBACK_HITS="$(printf '%s\n' "$TREE_FILES" | xargs grep -nHE "$LIVE_DB_FALLBACK" 2>/dev/null)"
[ -n "$FALLBACK_HITS" ] && HITS="$HITS$FALLBACK_HITS"$'\n'

FILE_COUNT="$(printf '%s\n' "$TEST_FILES" | sed '/^$/d' | wc -l | tr -d ' ')"

if [ -z "${HITS//[$'\n']/}" ]; then
  echo "spec-database-default: OK — $FILE_COUNT test files, none can reach the live stack's published Postgres or Redis by default."
  exit 0
fi

echo "spec-database-default: FAIL — a test file can reach the operator's LIVE datastore by default."
echo ""
printf '%s' "$HITS" | sed '/^$/d' | sort -u -t: -k1,1 -k2,2n | sed 's/^/  /'
echo ""
echo "  127.0.0.1:55433 is oshal-local-db — the operator's REAL trading Postgres. A spec that"
echo "  defaults there creates and destroys production data, and nothing warns; that is exactly"
echo "  what happened on 2026-09-14."
echo ""
echo "  Fix: give the spec its own DISPOSABLE server instead of an address —"
echo "    import { DisposablePostgres } from '../helpers/disposable-postgres';"
echo "    const database = new DisposablePostgres({ purpose: 'my-spec' });"
echo "    beforeAll(async () => { pool = await database.start(); });"
echo "    afterAll(async () => { await database.stop(); });"
echo "  A spec that starts its own PostgreSQL has nothing a caller could point at a deployment."
echo "  For a spec that genuinely must take an address or a container, resolve it through"
echo "  tests/helpers/spec-database-url.ts (specDatabaseUrl / specContainerName): neither has a"
echo "  default, both name the variable to set, and both refuse the live stack."
exit 1
