#!/usr/bin/env bash
# =============================================================================
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Refuse a test file that can reach the operator's LIVE Postgres by DEFAULT. 23 DB-backed specs ended their DSN expression in a loopback fallback on the stack's published port, which is the real trading database: a bare `npx vitest run tests/unit/trading-*.spec.ts` created and dropped schema and wrote order rows in production. It fired twice on 2026-09-14 from two lanes that had each been told in writing not to touch it — a written brief is not a guard, so this is the guard.
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
PORT_KNOB='process\.env\.(OSHAL_PG_PORT|OSHAL_TSDB_PORT)'

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

FILE_COUNT="$(printf '%s\n' "$TEST_FILES" | sed '/^$/d' | wc -l | tr -d ' ')"

if [ -z "${HITS//[$'\n']/}" ]; then
  echo "spec-database-default: OK — $FILE_COUNT test files, none can reach the live stack's published Postgres by default."
  exit 0
fi

echo "spec-database-default: FAIL — a test file can reach the operator's LIVE database by default."
echo ""
printf '%s' "$HITS" | sed '/^$/d' | sort -u -t: -k1,1 -k2,2n | sed 's/^/  /'
echo ""
echo "  127.0.0.1:55433 is oshal-local-db — the operator's REAL trading Postgres. A spec that"
echo "  defaults there creates and destroys production data, and nothing warns; that is exactly"
echo "  what happened on 2026-09-14."
echo ""
echo "  Fix: resolve the DSN through tests/helpers/spec-database-url.ts —"
echo "    import { specDatabaseUrl } from '../helpers/spec-database-url';"
echo "    const DSN = specDatabaseUrl(['MY_SPEC_TEST_DSN']);"
echo "  It refuses an unpointed run and names the variable to set. Point that variable at a"
echo "  DISPOSABLE PostgreSQL (tests/helpers/disposable-alert-postgres.ts is the fixture pattern)."
exit 1
