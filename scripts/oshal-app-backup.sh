#!/usr/bin/env bash
# =============================================================================
# oshal-app-backup.sh — VERIFIED per-app data backup (ADR-085 wave migrations)
# -----------------------------------------------------------------------------
# CHANGE LOG
# 1 | maintainer@emeraldcoastsystemsgroup.com
#   Created after the little-monsters data loss: the 2026-07-10 pre-carve-out
#   backup was taken as an RLS-subject role — pg_dump hit FORCE ROW LEVEL
#   SECURITY on lm_classes, wrote its error INTO the dump file, and kept the
#   exit path quiet enough that the file looked plausible. The carve-out then
#   dropped the tables trusting it. This script makes that failure mode
#   impossible: dump as the in-container superuser (never subject to RLS) and
#   verify LOUDLY — any embedded pg_dump error fails; any per-table row-count
#   mismatch between the live DB and the dump fails. A backup that does not
#   end with "VERIFIED" must never precede a DROP.
# -----------------------------------------------------------------------------
# Usage:
#   bash scripts/oshal-app-backup.sh <table-prefix> <outfile.sql> [db-container]
# Example (little-monsters, before any destructive migration step):
#   bash scripts/oshal-app-backup.sh lm_ ../oshal-lm-backup-$(date +%F).sql
# =============================================================================
set -euo pipefail

PREFIX="${1:?usage: oshal-app-backup.sh <table-prefix> <outfile.sql> [db-container]}"
OUT="${2:?outfile required}"
DB="${3:-oshal-local-db}"

# Enumerate the app's tables (superuser sees everything; RLS cannot hide rows from it).
TABLES=$(docker exec "$DB" psql -U oshal -d oshal -tAc \
  "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE '${PREFIX}%' ORDER BY tablename")
if [ -z "$TABLES" ]; then
  echo "FATAL: no public tables match prefix '${PREFIX}'" >&2
  exit 1
fi
echo "Backing up $(echo "$TABLES" | wc -l) table(s) with prefix '${PREFIX}':"
echo "$TABLES" | sed 's/^/  - /'

DUMP_ARGS=()
while IFS= read -r t; do
  [ -n "$t" ] && DUMP_ARGS+=( -t "public.${t}" )
done <<< "$TABLES"

# Dump as the in-container superuser role (oshal) — NEVER as oshal_app: FORCE RLS
# applies to table owners too, and that is exactly how the 07-10 backup truncated.
docker exec "$DB" pg_dump -U oshal -d oshal --no-owner "${DUMP_ARGS[@]}" > "$OUT"

# ── Verification 1: the dump must not contain embedded pg_dump errors ──
if grep -q "pg_dump: error" "$OUT"; then
  echo "FATAL: the dump file contains embedded pg_dump errors — BACKUP IS UNSAFE:" >&2
  grep -n "pg_dump: error" "$OUT" | head -5 >&2
  exit 1
fi

# ── Verification 2: per-table row parity (live count == dumped COPY rows) ──
FAIL=0
while IFS= read -r t; do
  [ -n "$t" ] || continue
  live=$(docker exec "$DB" psql -U oshal -d oshal -tAc "SELECT count(*) FROM public.\"${t}\"")
  dumped=$(awk -v tbl="COPY public.${t} " 'index($0, tbl)==1 {f=1; next} f && $0=="\\." {f=0} f' "$OUT" | wc -l)
  if [ "$live" != "$dumped" ]; then
    echo "FATAL: ${t}: live=${live} rows but dump holds ${dumped} — BACKUP IS UNSAFE" >&2
    FAIL=1
  else
    echo "  OK ${t}: ${live} rows"
  fi
done <<< "$TABLES"

if [ "$FAIL" != 0 ]; then
  echo "DO NOT DROP ANYTHING against this backup." >&2
  exit 1
fi

echo "VERIFIED backup: ${OUT} ($(wc -c < "$OUT") bytes)"
