#!/usr/bin/env bash
#
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                                        | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-111 box-side recon service entrypoint — start the stdlib HTTP server. exec so signals reach python (clean container stop). Honours RECON_PORT/RECON_HOST/RECON_WORK_DIR/RECON_STUB from the env.
#
set -euo pipefail
cd "$(dirname "$0")"
exec python server.py
