#!/usr/bin/env bash
#
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — app-store drift check: warn when a deployed-apps package in the oshal_workspace volume is a different version than the local oshal-applications store checkout. Root cause it exists: little-monsters ran stale v1.0.6 in the volume (pre-D10 build reading OSHAL_APP_PACKAGE_DIR at request time) while the store had v1.0.7 with the fix — every /api/education asset 404'd out of ANOTHER app's package dir and nothing flagged it.
#
# WHY: deployed-apps/ packages inside the oshal_workspace volume are COPIES of store packages
# (the oshal-applications repo). A fix committed to the store does NOT reach the running swarm
# until the package is re-staged into the volume, and the failure mode is silent (assets 404,
# routes run old code). This check compares each deployed package's manifest version against
# the store checkout and names the stale ones. Version-equal-but-bytes-differ is NOT caught —
# the store bumps `version:` on every publish, so version is the drift contract.
#
# USAGE:  bash scripts/app-store-drift-check.sh            # human report
#         bash scripts/app-store-drift-check.sh --quiet    # only print on drift (for oshal-up.sh)
# ENV:    OSHAL_STORE_DIR      store checkout (default: ../oshal-applications sibling, then C:/Projects/oshal-applications)
#         OSHAL_API_CONTAINER  api container name (default: oshal-local-api)
# EXIT:   0 = in sync (or no store checkout — advisory skip)   1 = drift   2 = env error

set -uo pipefail

QUIET=0
[ "${1:-}" = "--quiet" ] && QUIET=1

say() { [ "$QUIET" -eq 1 ] || printf '%s\n' "$*"; }

API_CONTAINER="${OSHAL_API_CONTAINER:-oshal-local-api}"
DEPLOYED_DIR="/app/workspace-shared/deployed-apps"

# Resolve the store checkout: env override, sibling of this repo, then the known dev-host path.
resolve_store_dir() {
  if [ -n "${OSHAL_STORE_DIR:-}" ]; then printf '%s' "$OSHAL_STORE_DIR"; return; fi
  local sibling
  sibling="$(cd "$(dirname "$0")/../.." 2>/dev/null && pwd)/oshal-applications"
  if [ -f "$sibling/marketplace.json" ]; then printf '%s' "$sibling"; return; fi
  if [ -f "/c/Projects/oshal-applications/marketplace.json" ]; then printf '%s' "/c/Projects/oshal-applications"; return; fi
  printf ''
}

STORE_DIR="$(resolve_store_dir)"
if [ -z "$STORE_DIR" ] || [ ! -d "$STORE_DIR" ]; then
  say "app-store-drift-check: no oshal-applications checkout found (set OSHAL_STORE_DIR) — skipping."
  exit 0
fi

command -v docker >/dev/null 2>&1 || { echo "app-store-drift-check: docker CLI not found" >&2; exit 2; }
docker inspect "$API_CONTAINER" >/dev/null 2>&1 || { echo "app-store-drift-check: api container '$API_CONTAINER' not found" >&2; exit 2; }

# One exec: every deployed package's "<name> <version>" (skips loose .yaml workflow files).
# tr -d '\r' both here and store-side: manifests staged on Windows can carry CRLF endings,
# and "1.0.0\r" vs "1.0.0" reads as drift when it isn't.
deployed=$(docker exec "$API_CONTAINER" sh -c '
  for d in '"$DEPLOYED_DIR"'/*/; do
    [ -f "$d/oshal-app.yaml" ] || continue
    n=$(basename "$d")
    v=$(grep -m1 "^version:" "$d/oshal-app.yaml" | awk "{print \$2}" | tr -d "\r")
    echo "$n ${v:-unknown}"
  done' 2>/dev/null | tr -d '\r')

[ -z "$deployed" ] && { say "app-store-drift-check: no packages in $DEPLOYED_DIR — nothing to check."; exit 0; }

say ""
say "OSHAL app-store drift check (store: $STORE_DIR)"

drift_lines=""
checked=0
while read -r name dep_ver; do
  [ -z "$name" ] && continue
  store_manifest="$STORE_DIR/$name/oshal-app.yaml"
  # Not every deployed package comes from the store (Forge-emitted apps, published workflows).
  [ -f "$store_manifest" ] || continue
  checked=$((checked + 1))
  store_ver=$(grep -m1 '^version:' "$store_manifest" | awk '{print $2}' | tr -d '\r')
  if [ "$dep_ver" = "${store_ver:-}" ]; then
    say "  ok    $name  $dep_ver"
  else
    drift_lines="${drift_lines}     ${name}: deployed ${dep_ver} vs store ${store_ver:-unknown}
"
  fi
done <<EOF
$deployed
EOF

if [ -z "$drift_lines" ]; then
  say "  OK — all ${checked} store-tracked packages match the store checkout."
  exit 0
fi

# Drift: name the stale packages loudly (printed even in --quiet mode).
printf '\n'
printf '  !! APP-STORE DRIFT — deployed package(s) do NOT match the store checkout:\n'
printf '%s' "$drift_lines"
printf '\n'
printf '  A stale volume copy runs OLD code/assets no matter what the store repo says\n'
printf '  (little-monsters 2026-07-17: stale build 404d every education asset from another\n'
printf "  app's package dir). Re-stage the package into the volume and reload it:\n"
printf '     docker run --rm -v oshal-local_oshal_workspace:/ws -v <store>/<name>:/src:ro alpine \\\n'
printf '       sh -c "rm -rf /ws/deployed-apps/<name>.stg && cp -r /src /ws/deployed-apps/<name>.stg && \\\n'
printf '              cp /ws/deployed-apps/<name>/.oshal-install.json /ws/deployed-apps/<name>.stg/ && \\\n'
printf '              rm -rf /ws/deployed-apps/<name> && mv /ws/deployed-apps/<name>.stg /ws/deployed-apps/<name>"\n'
printf '     then: POST /api/swarm/apps/load {"path":"%s/<name>/oshal-app.yaml"}  (PAT auth)\n' "$DEPLOYED_DIR"
printf '     (leave INACTIVE apps staged-only — the next boot auto-load picks them up)\n\n'
exit 1
