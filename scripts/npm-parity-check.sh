#!/usr/bin/env bash
# =============================================================================
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — npm publish parity. Born from a three-week silent drift: @oshal/chat sat at 0.2.0 on npm (published 2026-08-15) while TWO features landed in the package (#300 node print service, #302 satellite login push) and package.json was never touched. Version numbers MATCHED while the code differed, so nothing could notice — and a publish would have failed E403 anyway. Comparing versions alone is therefore not a check; this compares the published version AND the commits that landed after it was published.
# =============================================================================
#
# Usage:  bash scripts/npm-parity-check.sh [--json]
#
# Answers one question per publishable package: is what the world can `npm install`
# the same code as this repo? Read-only — never publishes, never writes.
#
# EXIT: 0 every package in sync   1 at least one DRIFTED or is PENDING publish
#       2 could not determine (npm unreachable / not a git repo) — never a false pass
# =============================================================================

set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 2

JSON=0
for a in "$@"; do case "$a" in
  --json) JSON=1 ;;
  *) echo "unknown flag: $a" >&2; exit 2 ;;
esac; done

command -v npm >/dev/null 2>&1 || { echo "npm not on PATH" >&2; exit 2; }
git rev-parse --git-dir >/dev/null 2>&1 || { echo "not a git repository" >&2; exit 2; }

# npm's registry timeout is unbounded by default; a hung registry must not hang a deploy.
NPM_VIEW_TIMEOUT="${OSHAL_NPM_VIEW_TIMEOUT:-20}"
if command -v timeout >/dev/null 2>&1; then TIMEOUT=(timeout "$NPM_VIEW_TIMEOUT"); else TIMEOUT=(); fi

drift=0; unknown=0; rows=()

for pkg_json in packages/*/package.json; do
  pkg_dir="$(dirname "$pkg_json")"
  name=$(node -p "try{require('./$pkg_json').name||''}catch(e){''}" 2>/dev/null)
  version=$(node -p "try{require('./$pkg_json').version||''}catch(e){''}" 2>/dev/null)
  private=$(node -p "try{require('./$pkg_json').private?1:0}catch(e){0}" 2>/dev/null)

  [ -z "$name" ] && continue
  if [ "$private" = "1" ]; then
    rows+=("$name|$version|-|PRIVATE|never published (private:true)")
    continue
  fi

  published=$("${TIMEOUT[@]}" npm view "$name" version 2>/dev/null | tr -d "'\" \r\n")
  if [ -z "$published" ]; then
    # Distinguish "never published" from "registry unreachable" — a false pass here is the
    # whole failure mode this script exists to prevent.
    if "${TIMEOUT[@]}" npm view "$name" name >/dev/null 2>&1; then
      rows+=("$name|$version|?|UNKNOWN|registry answered but no version")
    else
      rows+=("$name|$version|-|UNPUBLISHED?|not on the registry, or registry unreachable")
    fi
    unknown=1
    continue
  fi

  if [ "$version" != "$published" ]; then
    rows+=("$name|$version|$published|PENDING|local is bumped; publish has not run")
    drift=1
    continue
  fi

  # Same version on both sides. The only way to know whether the CODE differs is to ask
  # git what landed after the publish timestamp.
  # `npm view <pkg> time.<version>` does NOT work: npm parses the dots in a semver as a
  # field path (time -> 0 -> 2 -> 0) and silently returns nothing. Fetch the whole time
  # map and index it by the exact version key.
  time_json=$("${TIMEOUT[@]}" npm view "$name" time --json 2>/dev/null)
  pub_time=$(printf '%s' "$time_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s)[process.argv[1]]||""))}catch(e){}})' "$published")
  if [ -z "$pub_time" ]; then
    rows+=("$name|$version|$published|UNKNOWN|no publish timestamp from the registry")
    unknown=1
    continue
  fi

  since=$(git log --oneline --since="$pub_time" -- "$pkg_dir" 2>/dev/null | wc -l | tr -d ' ')
  if [ "${since:-0}" -gt 0 ]; then
    rows+=("$name|$version|$published|DRIFTED|$since commit(s) since publish, version NOT bumped")
    drift=1
  else
    rows+=("$name|$version|$published|IN SYNC|")
  fi
done

if [ "$JSON" -eq 1 ]; then
  printf '['
  first=1
  for r in "${rows[@]}"; do
    IFS='|' read -r n lv pv st note <<< "$r"
    [ $first -eq 0 ] && printf ','
    printf '{"name":"%s","local":"%s","published":"%s","status":"%s","note":"%s"}' "$n" "$lv" "$pv" "$st" "$note"
    first=0
  done
  printf ']\n'
else
  echo "npm publish parity"
  printf '  %-22s %-10s %-10s %-12s %s\n' PACKAGE LOCAL NPM STATUS NOTE
  for r in "${rows[@]}"; do
    IFS='|' read -r n lv pv st note <<< "$r"
    printf '  %-22s %-10s %-10s %-12s %s\n' "$n" "$lv" "$pv" "$st" "$note"
  done
  echo
  if [ "$drift" -eq 1 ]; then
    echo "  ACTION: a DRIFTED package needs its version bumped, then bash scripts/npm-publish.sh"
    echo "          (publishing without a bump fails E403 - the registry refuses to overwrite)"
  elif [ "$unknown" -eq 1 ]; then
    echo "  Could not determine parity for every package - treat as UNKNOWN, not as in-sync."
  else
    echo "  OK - every publishable package matches the registry."
  fi
fi

[ "$drift" -eq 1 ] && exit 1
[ "$unknown" -eq 1 ] && exit 2
exit 0
