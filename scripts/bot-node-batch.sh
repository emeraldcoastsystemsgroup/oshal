#!/bin/sh
# =============================================================================
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — the one-shot bot-node batch entrypoint referenced by ops/deployment/argo/incident-rca-workflowtemplate.yaml (ADR-078 §1). Seeds the shared provider config the same way bot-entrypoint.sh does, then runs ONE phase via dist/app/bot-node-batch.js and exits with its status so Argo can mark the DAG task passed/failed.
# =============================================================================
#
# @description Runs a SINGLE swarm phase, then exits. The Kubernetes/Argo counterpart to the
# long-lived bot-node-server. Both share one construction path (src/app/bot-node-runtime.ts).
#
# Usage (as Argo invokes it):
#   /app/scripts/bot-node-batch.sh --ticket-id=T --agent-id=A --phase=investigate
#
# Environment (set by the WorkflowTemplate):
#   BOT_RUNTIME=bot-node-batch   TICKET_ID   AGENT_ID   OSHAL_TENANT
#   DATABASE_URL (per-tenant role → ADR-076 RLS applies under the namespace boundary)
#   LLM_BASE_URL (in-cluster model endpoint)
#
# Exit codes: 0 = phase completed. 1 = phase failed (Argo fails the DAG task).
# =============================================================================

set -e

echo "=========================================="
echo " OSHAL Bot Node — BATCH (one phase, then exit)"
echo "=========================================="
echo "TICKET_ID:  ${TICKET_ID:-<from --ticket-id>}"
echo "AGENT_ID:   ${AGENT_ID:-<from --agent-id>}"
echo "TENANT:     ${OSHAL_TENANT:-<not set>}"
echo "=========================================="

CONFIG_DIR="${CONFIG_OUTPUT_DIR:-/app/output}"
mkdir -p "$CONFIG_DIR"

# Seed the shared provider config exactly as bot-entrypoint.sh does — a batch pod gets the
# same global-config.json / secrets.json the long-lived nodes run with.
SEED_DIR="/app/config-seed"
if [ -d "$SEED_DIR" ]; then
  for f in global-config.json secrets.json llm-config.json; do
    if [ -f "$SEED_DIR/$f" ] && [ ! -f "$CONFIG_DIR/$f" ]; then
      cp "$SEED_DIR/$f" "$CONFIG_DIR/$f"
      echo "[bot-node-batch] Seeded $f from shared config-seed"
    fi
  done
fi

# Cline CLI auth (no-op when the provider isn't cline).
if [ -f /app/scripts/setup-cline-auth.sh ]; then
  bash /app/scripts/setup-cline-auth.sh >/dev/null 2>&1 || \
    echo "[bot-node-batch] setup-cline-auth.sh completed with warnings (non-fatal)"
fi

echo "[bot-node-batch] Running one phase ..."
exec node dist/app/bot-node-batch.js "$@"
