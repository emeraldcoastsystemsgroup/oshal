#!/usr/bin/env bash
# =============================================================================
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | The caller the two live-cluster governance checks never had. scripts/validate-dynamic-bot-manifest.mjs (the k8s launcher's cited live-boundary closure) and scripts/governance/verify-tenant-isolation.sh (the NetworkPolicy isolation assertion) had no automated caller at all, and the first one exited 0 with no cluster. This runs either one against an EXPLICITLY named kube context and fails closed: no context, no kubectl, no API server answering, or a check that did not finish is UNCHECKED (exit 2), never PASS. It is reached only through the opt-in `scripts/ci-local.sh --cluster-gates`, so a box with no cluster never runs it by default and never reports it green.
# =============================================================================
#
# Usage:  OSHAL_CLUSTER_CONTEXT=<ctx> bash scripts/ci/check-cluster-gates.sh <bot-manifest|tenant-isolation> [root]
#   bot-manifest      npx tsx scripts/validate-dynamic-bot-manifest.mjs --require-server
#                     (server-side dry-run of the launcher's manifest + deployments/scale discovery;
#                     creates nothing)
#   tenant-isolation  bash scripts/governance/verify-tenant-isolation.sh
#                     (kubectl exec into the tenant-a/tenant-b app=web pods; reads only)
#   root              tree to run from (default: the repo this script lives in)
#
# Environment:
#   OSHAL_CLUSTER_CONTEXT    REQUIRED. The kube context to judge. There is deliberately no default:
#                            "whatever kubectl last pointed at" is how a check lands on the wrong
#                            cluster (deploy/terraform/providers.tf refuses the same thing).
#   OSHAL_CLUSTER_NAMESPACE  namespace for the bot-manifest server dry-run (default: oshal)
#   OSHAL_CLUSTER_TIMEOUT    seconds allowed per kubectl probe and per check (default: 300)
#
# Exit: 0 = the check passed against a reachable API server; 1 = it ran and failed;
#       2 = UNCHECKED (no context, no kubectl, no reachable API server, a refusal by the check
#           itself, or a timeout) - the check did not get to look, so nothing here is evidence.
set -uo pipefail

WHICH="${1:-}"
case "$WHICH" in
  bot-manifest|tenant-isolation) ;;
  *) echo "usage: check-cluster-gates.sh <bot-manifest|tenant-isolation> [root]"; exit 2 ;;
esac
TAG="cluster-$WHICH"
ROOT="${2:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$ROOT" 2>/dev/null || { echo "$TAG: UNCHECKED - cannot enter '$ROOT'"; exit 2; }

CONTEXT="${OSHAL_CLUSTER_CONTEXT:-}"
NAMESPACE="${OSHAL_CLUSTER_NAMESPACE:-oshal}"
LIMIT="${OSHAL_CLUSTER_TIMEOUT:-300}"

unchecked() { echo "$TAG: UNCHECKED - $1"; echo "$TAG: the check did not get to look, so this is not evidence of anything."; exit 2; }

[ -n "$CONTEXT" ] || unchecked "OSHAL_CLUSTER_CONTEXT is not set. Name the kube context to judge; there is no default."
command -v kubectl >/dev/null 2>&1 || unchecked "kubectl is not on PATH."
timeout "$LIMIT" kubectl --context "$CONTEXT" cluster-info >/dev/null 2>&1 \
  || unchecked "no API server answered at context '$CONTEXT' (kubectl cluster-info failed or timed out after ${LIMIT}s)."

echo "$TAG: API server reachable at context '$CONTEXT'"
case "$WHICH" in
  bot-manifest)
    timeout "$LIMIT" npx tsx scripts/validate-dynamic-bot-manifest.mjs \
      --require-server --context "$CONTEXT" --namespace "$NAMESPACE" ;;
  tenant-isolation)
    timeout "$LIMIT" bash scripts/governance/verify-tenant-isolation.sh --context "$CONTEXT" ;;
esac
rc=$?

case "$rc" in
  0) echo "$TAG: PASS (context '$CONTEXT')"; exit 0 ;;
  1) echo "$TAG: FAIL (context '$CONTEXT')"; exit 1 ;;
  124) unchecked "the check did not finish within ${LIMIT}s." ;;
  2) unchecked "the check refused to run (exit 2) - see its output above." ;;
  *) echo "$TAG: FAIL - the check exited $rc (context '$CONTEXT')"; exit 1 ;;
esac
