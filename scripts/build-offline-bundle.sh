#!/usr/bin/env bash
# =============================================================================
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — build the SWARM SNAPSHOT: one offline-installable archive holding the three OSHAL images (docker save) plus the installers. The compose + config seeds are already BAKED IN the oshal-bot image, so images + installer IS the whole swarm; the installers' --from-archive / -FromArchive mode docker-loads it with zero registry or network dependency. Too big for a GitHub release asset (2 GB cap) — host on R2 or any file host.
# =============================================================================
#
# Usage:  bash scripts/build-offline-bundle.sh [output-dir]
# Output: <out>/oshal-swarm-offline-<version>/
#           oshal-images.tar          (docker save of the images)
#           Install-OSHAL.bat         (double-click; runs the ps1 beside it)
#           scripts/oshal-install.ps1 (Windows)
#           scripts/oshal-install.sh  (macOS/Linux)
#           README.txt
#         and <out>/oshal-swarm-offline-<version>.tar.gz of the same.

set -euo pipefail

VER=$(node -e "console.log(require('./package.json').version)")
ORG="${OSHAL_REGISTRY:-ghcr.io/emeraldcoastsystemsgroup}"
OUT="${1:-./dist-bundle}/oshal-swarm-offline-$VER"
IMAGES=("$ORG/oshal-bot:latest" "$ORG/oshal-speaker-diarization:latest")

say() { printf '[bundle] %s\n' "$*"; }

for img in "${IMAGES[@]}"; do
  docker image inspect "$img" >/dev/null 2>&1 || { echo "missing local image: $img — pull or build first"; exit 1; }
done

rm -rf "$OUT"; mkdir -p "$OUT/scripts"

say "docker save (${#IMAGES[@]} images) — this is the big step"
docker save "${IMAGES[@]}" -o "$OUT/oshal-images.tar"

cp Install-OSHAL.bat "$OUT/"
cp scripts/oshal-install.ps1 scripts/oshal-install.sh "$OUT/scripts/"

# ── Version-match the snapshot to its CODE (operator ask 2026-07-23) ─────────
# The oshal-bot image is stamped with oshal.git.commit at build; that label is the
# source of truth for WHICH code these bytes are. Embed the matching source archive
# and a VERSION manifest so the bundle is self-describing offline — and the same
# commit is tagged in git (v<version>) and on GHCR (:sha-<12>), one identity across
# git, registry, and download.
COMMIT=$(docker image inspect --format '{{index .Config.Labels "oshal.git.commit"}}' "${IMAGES[0]}")
if [ -n "$COMMIT" ] && git cat-file -e "$COMMIT" 2>/dev/null; then
  say "embedding source snapshot @ ${COMMIT:0:12}"
  git archive --format=tar.gz -o "$OUT/oshal-src-${COMMIT:0:12}.tar.gz" "$COMMIT"
else
  say "WARN: image carries no oshal.git.commit label (or commit absent locally) — no source embedded"
fi
{
  echo "version: $VER"
  echo "commit:  ${COMMIT:-unknown}"
  echo "built:   $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "source:  https://github.com/emeraldcoastsystemsgroup/oshal/tree/${COMMIT:-main}"
  echo "images:"
  for img in "${IMAGES[@]}"; do echo "  - $img ($(docker image inspect --format '{{.Id}}' "$img" | cut -c8-19))"; done
} > "$OUT/VERSION"

cat > "$OUT/README.txt" <<EOF
OSHAL swarm snapshot $VER — offline install
===========================================
Prerequisite: Docker Desktop (or Docker Engine 24+ with compose v2).

Windows : double-click Install-OSHAL.bat
          (it detects oshal-images.tar beside it and installs offline)
macOS/  : bash scripts/oshal-install.sh --from-archive ./oshal-images.tar
Linux

Everything else — compose topology, config seeds — is baked inside the
images; the installer extracts what it needs. No registry, no internet
required after this download. License: AGPL-3.0-or-later.

VERSION lists the exact git commit these images were built from, and
oshal-src-<commit>.tar.gz IS that code — the snapshot carries its own
matching source. Same commit is tagged in git and on GHCR.
https://github.com/emeraldcoastsystemsgroup/oshal
EOF

say "compressing"
tar -C "$(dirname "$OUT")" -czf "$OUT.tar.gz" "$(basename "$OUT")"

say "done:"
du -sh "$OUT/oshal-images.tar" "$OUT.tar.gz"
say "NOTE: exceeds GitHub's 2 GB release-asset cap — host on R2 (wrangler r2 object put) or similar."
