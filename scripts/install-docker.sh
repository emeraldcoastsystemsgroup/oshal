#!/usr/bin/env bash
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Clarified that setup:docker boots the standalone/core convenience stack rather than the historical/default 3456 runtime

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

echo "Booting OSHAL standalone/core convenience Docker stack on the non-canonical operator port path..."
exec bash "${REPO_ROOT}/scripts/run-docker.sh" up "$@"
