#!/bin/sh
# =============================================================================
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — the record-cost hook invoked by ops/deployment/argo/incident-rca-workflowtemplate.yaml (ADR-078 §1). Thin wrapper: exec the compiled entrypoint and let its exit status decide the DAG task's fate.
# =============================================================================
#
# @description Argo DAG hook — see src/app/record-cost.ts for the contract.
# =============================================================================
set -e
exec node dist/app/record-cost.js "$@"
