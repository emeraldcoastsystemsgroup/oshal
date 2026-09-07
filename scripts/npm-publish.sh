#!/usr/bin/env bash
# =============================================================================
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — the publish half of npm parity. DRY RUN BY DEFAULT: an npm publish is irreversible (unpublish is restricted to 72h and breaks every installer that already resolved the version), so going live takes an explicit --publish. Refuses a version already on the registry with the bump instruction rather than letting npm answer E403. Closes a real gap while it is here: publish-gate.sh scans TRACKED files (what a git push sends), but an npm tarball ships the package.json `files` allowlist INCLUDING built dist/** — so anything packed that git does not track has never been through the gate. That set is listed and refused.
# =============================================================================
#
# Usage:  bash scripts/npm-publish.sh [--publish] [--package <name>]
#   (no flags)        DRY RUN — preflight every publishable package, ship nothing
#   --publish         actually publish. Irreversible. Requires npm auth.
#   --package <name>  limit to one package (npm name or directory name)
#
# EXIT: 0 ok (dry run clean, or published)   1 refused — action needed
#       2 preflight error (no npm, no auth, not a repo)
# =============================================================================

set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 2

DO_PUBLISH=0; ONLY=""
while [ $# -gt 0 ]; do case "$1" in
  --publish) DO_PUBLISH=1 ;;
  --package) shift; ONLY="${1:-}" ;;
  *) echo "unknown flag: $1" >&2; exit 2 ;;
esac; shift; done

command -v npm >/dev/null 2>&1 || { echo "npm not on PATH" >&2; exit 2; }
git rev-parse --git-dir >/dev/null 2>&1 || { echo "not a git repository" >&2; exit 2; }

say() { printf '%s\n' "$*"; }
refused=0; published=0; considered=0

# Auth is only required to actually ship. A dry run must work on a box with no token
# so the preflight is usable before anyone goes hunting for credentials.
if [ "$DO_PUBLISH" -eq 1 ]; then
  who=$(npm whoami 2>/dev/null)
  if [ -z "$who" ]; then
    say "REFUSED: npm is not authenticated (npm whoami failed)."
    say "  Renew the token, then either 'npm login' or set NPM_TOKEN and write .npmrc:"
    say "    //registry.npmjs.org/:_authToken=\${NPM_TOKEN}"
    exit 2
  fi
  say "npm authenticated as: $who"
else
  say "DRY RUN — nothing will be published. Add --publish to ship."
fi
say ""

for pkg_json in packages/*/package.json; do
  pkg_dir="$(dirname "$pkg_json")"
  name=$(node -p "try{require('./$pkg_json').name||''}catch(e){''}" 2>/dev/null)
  version=$(node -p "try{require('./$pkg_json').version||''}catch(e){''}" 2>/dev/null)
  private=$(node -p "try{require('./$pkg_json').private?1:0}catch(e){0}" 2>/dev/null)

  [ -z "$name" ] && continue
  [ "$private" = "1" ] && continue
  if [ -n "$ONLY" ] && [ "$name" != "$ONLY" ] && [ "$(basename "$pkg_dir")" != "$ONLY" ]; then continue; fi
  considered=$((considered + 1))

  say "=== $name@$version  ($pkg_dir)"

  # 1. Never try to overwrite a published version — say why, do not let npm answer E403.
  on_registry=$(npm view "$name" versions --json 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const v=JSON.parse(s);process.stdout.write((Array.isArray(v)?v:[v]).includes(process.argv[1])?'yes':'no')}catch(e){process.stdout.write('unknown')}})" "$version")
  if [ "$on_registry" = "yes" ]; then
    say "  REFUSED: $version is already on the registry — the registry never overwrites."
    say "  Bump the version first:  (cd $pkg_dir && npm version patch --no-git-tag-version)"
    refused=1; say ""; continue
  fi
  if [ "$on_registry" = "unknown" ]; then
    say "  NOTE: could not read published versions (registry unreachable?) — treating as unknown."
  fi

  # 2. What will actually ship. `files` in package.json can include BUILT output that git
  #    never tracked, and publish-gate.sh only ever scanned tracked files.
  packed=$(cd "$pkg_dir" && npm pack --dry-run --json 2>/dev/null \
    | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);(j[0].files||[]).forEach(f=>console.log(f.path))}catch(e){}})")
  if [ -z "$packed" ]; then
    say "  REFUSED: npm pack produced no file list — cannot audit what would ship."
    refused=1; say ""; continue
  fi
  file_count=$(printf '%s\n' "$packed" | wc -l | tr -d ' ')
  say "  would ship $file_count file(s)"

  # 3. Anything packed that git does not track has never been through the publish gate.
  untracked=""
  while IFS= read -r rel; do
    [ -z "$rel" ] && continue
    full="$pkg_dir/$rel"
    if ! git ls-files --error-unmatch "$full" >/dev/null 2>&1; then
      untracked="$untracked$rel"$'\n'
    fi
  done <<< "$packed"

  if [ -n "$untracked" ]; then
    # Built output is expected and fine; a stray credential file is not. Report the set and
    # refuse anything that is credential-shaped by NAME, which is the cheap high-value catch.
    risky=$(printf '%s' "$untracked" | grep -iE '(^|/)\.env|credential|secret|token|\.pem$|\.key$|id_rsa' || true)
    ut_count=$(printf '%s' "$untracked" | grep -c . || true)
    say "  $ut_count packed file(s) are NOT tracked by git (never scanned by publish-gate.sh)"
    if [ -n "$risky" ]; then
      say "  REFUSED: credential-shaped untracked files would ship:"
      printf '%s\n' "$risky" | sed 's/^/      /'
      refused=1; say ""; continue
    fi
    say "  (all build output by name — no credential-shaped paths)"
  fi

  if [ "$DO_PUBLISH" -eq 0 ]; then
    say "  DRY RUN: ready to publish."
    say ""
    continue
  fi

  say "  publishing..."
  if (cd "$pkg_dir" && npm publish --access public); then
    say "  PUBLISHED $name@$version"
    published=$((published + 1))
  else
    say "  FAILED to publish $name@$version"
    refused=1
  fi
  say ""
done

say "----"
if [ "$considered" -eq 0 ]; then
  say "No publishable packages matched (every package may be private:true)."
fi
[ "$DO_PUBLISH" -eq 1 ] && say "published: $published"
[ "$refused" -eq 1 ] && { say "One or more packages were REFUSED — see above."; exit 1; }
exit 0
