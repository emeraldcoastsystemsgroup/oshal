#!/bin/bash
# =============================================================================
# LEGACY — DO NOT DEPLOY
# Part of the quarantined pre-chart Kubernetes generation. It packs the legacy
# any-bot installer (ops/any-bot-k8s, image oshal-api-server:latest, built by nothing
# in this repo) into an npm tarball. The current Kubernetes path is the Helm chart at
# deploy/helm/oshal: read docs/k8/README.md and
# docs/adr/129-codeless-k8s-install-path.md. The script refuses to run unless
# OSHAL_ALLOW_LEGACY_K8S=1 is set, so nothing is lost while delete-vs-quarantine is
# still open (docs/k8/remote-cluster-work-package.md, item 9).
# =============================================================================
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Added local npm tarball pack helper for distributing the any-bot Kubernetes installer without publishing to a registry
# 2 | maintainer@emeraldcoastsystemsgroup.com   | Switched local packaging to a curated installer tarball that excludes unrelated repository artifacts and sensitive runtime files
# 3 | maintainer@emeraldcoastsystemsgroup.com   | Repointed the local installer package to the converted OSHAL root runtime build context
# 4 | maintainer@emeraldcoastsystemsgroup.com   | Merged the installer metadata into the staged root-runtime manifests so npm pack emits the expected installer package name
# 5 | maintainer@emeraldcoastsystemsgroup.com   | Quarantined as legacy (remote-cluster work package item 9): a LEGACY banner, and a refusal that runs before any node, npm or file-staging step unless OSHAL_ALLOW_LEGACY_K8S=1. The packed README now says the CLI needs the same override. Guard: tests/unit/k8s-legacy-quarantine.spec.ts.
# =============================================================================

set -euo pipefail

# Quarantine gate. It runs first, so nothing is staged or packed before it.
if [ "${OSHAL_ALLOW_LEGACY_K8S:-}" != "1" ]; then
  printf '%s\n' \
    "REFUSED: scripts/build-any-bot-k8s-local-package.sh is part of the quarantined legacy Kubernetes generation." \
    "It packs the legacy any-bot installer (ops/any-bot-k8s, image oshal-api-server:latest, which nothing in this repo builds)." \
    "" \
    "The current Kubernetes path is the Helm chart at deploy/helm/oshal:" \
    "  bash scripts/oshal-install.sh --mode 4 --admin-email you@example.com" \
    "Read docs/k8/README.md and docs/adr/129-codeless-k8s-install-path.md." \
    "" \
    "To run this legacy script anyway, set OSHAL_ALLOW_LEGACY_K8S=1." >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
OUTPUT_DIR="${REPO_ROOT}/output/npm"
STAGING_DIR="${OUTPUT_DIR}/oshal-any-bot-k8s-installer"
PACKAGE_VERSION="$(node -p "require('${REPO_ROOT}/package.json').version")"

mkdir -p "${OUTPUT_DIR}"
rm -rf "${STAGING_DIR}"
mkdir -p \
  "${STAGING_DIR}/scripts" \
  "${STAGING_DIR}/any-bot-k8s" \
  "${STAGING_DIR}/docs/k8" \
  "${STAGING_DIR}/src/pages/chat" \
  "${STAGING_DIR}/any-bot"

cat > "${STAGING_DIR}/README.md" <<'EOF_README'
# oshal-any-bot-k8s-installer

Local-only installer package for the OSHAL any-bot Kubernetes deployment workflow.

LEGACY — DO NOT DEPLOY. This is the quarantined pre-chart Kubernetes generation. The
current path is the Helm chart at deploy/helm/oshal (docs/k8/README.md). The CLI below
refuses to run unless OSHAL_ALLOW_LEGACY_K8S=1 is set.

This tarball includes the Kubernetes workspace plus the converted root-runtime Docker build context required to build `oshal-api-server:latest` locally.

## Usage

```bash
OSHAL_ALLOW_LEGACY_K8S=1 oshal-any-bot-k8s-setup --help
```

This package is intended to be installed from a local `.tgz` file and is not meant for registry publication.
EOF_README

cp "${REPO_ROOT}/Dockerfile" "${STAGING_DIR}/"
cp "${REPO_ROOT}/package.json" "${STAGING_DIR}/"
cp "${REPO_ROOT}/package-lock.json" "${STAGING_DIR}/"
cp "${REPO_ROOT}/vite.config.js" "${STAGING_DIR}/"
cp "${REPO_ROOT}/vite.config.ts" "${STAGING_DIR}/"
cp "${REPO_ROOT}/tsconfig.server.json" "${STAGING_DIR}/"

node -e "const fs=require('fs'); const pkgPath='${STAGING_DIR}/package.json'; const lockPath='${STAGING_DIR}/package-lock.json'; const pkg=JSON.parse(fs.readFileSync(pkgPath,'utf8')); pkg.name='oshal-any-bot-k8s-installer'; pkg.description='Local-only installer package for the OSHAL any-bot Kubernetes deployment workspace'; pkg.bin={'oshal-any-bot-k8s-setup':'./scripts/setup-any-bot-k8s-cli.js'}; fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2)+'\n'); const lock=JSON.parse(fs.readFileSync(lockPath,'utf8')); lock.name='oshal-any-bot-k8s-installer'; if (lock.packages && lock.packages['']) { lock.packages[''].name='oshal-any-bot-k8s-installer'; lock.packages[''].bin={'oshal-any-bot-k8s-setup':'./scripts/setup-any-bot-k8s-cli.js'}; lock.packages[''].description='Local-only installer package for the OSHAL any-bot Kubernetes deployment workspace'; } fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2)+'\n');"

cp -R "${REPO_ROOT}/scripts/." "${STAGING_DIR}/scripts/"
cp -R "${REPO_ROOT}/ops/any-bot-k8s/." "${STAGING_DIR}/any-bot-k8s/"
cp -R "${REPO_ROOT}/docs/k8/." "${STAGING_DIR}/docs/k8/"

cp -R "${REPO_ROOT}/src/api" "${STAGING_DIR}/src/"
cp -R "${REPO_ROOT}/src/features" "${STAGING_DIR}/src/"
cp -R "${REPO_ROOT}/src/shared" "${STAGING_DIR}/src/"
cp -R "${REPO_ROOT}/src/entities" "${STAGING_DIR}/src/"
cp -R "${REPO_ROOT}/src/app" "${STAGING_DIR}/src/"
cp -R "${REPO_ROOT}/src/pages/chat/ui" "${STAGING_DIR}/src/pages/chat/"

cp -R "${REPO_ROOT}/any-bot/ui-cockpit" "${STAGING_DIR}/any-bot/"
cp -R "${REPO_ROOT}/any-bot/ui-enhanced" "${STAGING_DIR}/any-bot/"

echo "[any-bot-k8s] Packing local npm tarball into ${OUTPUT_DIR}"
PACKAGE_FILE="$(cd "${STAGING_DIR}" && npm pack --pack-destination "${OUTPUT_DIR}")"

echo "[any-bot-k8s] Created: ${OUTPUT_DIR}/${PACKAGE_FILE}"
echo "[any-bot-k8s] Install on another computer without any npm registry:"
echo "  npm install -g ${OUTPUT_DIR}/${PACKAGE_FILE}"
echo "[any-bot-k8s] Then run:"
echo "  OSHAL_ALLOW_LEGACY_K8S=1 oshal-any-bot-k8s-setup --help"