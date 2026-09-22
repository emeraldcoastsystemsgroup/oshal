#!/usr/bin/env bash
# =============================================================================
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | The caller the two live-cluster governance checks never had. scripts/validate-dynamic-bot-manifest.mjs (the k8s launcher's cited live-boundary closure) and scripts/governance/verify-tenant-isolation.sh (the NetworkPolicy isolation assertion) had no automated caller at all, and the first one exited 0 with no cluster. This runs either one against an EXPLICITLY named kube context and fails closed: no context, no kubectl, no API server answering, or a check that did not finish is UNCHECKED (exit 2), never PASS. It is reached only through the opt-in `scripts/ci-local.sh --cluster-gates`, so a box with no cluster never runs it by default and never reports it green.
# 2 | maintainer@emeraldcoastsystemsgroup.com   | bot-manifest: the validator's exit 0 is no longer the pass on its own. docs/k8/remote-cluster-work-package.md 4.3 names the pass signal as the two server-side lines (`dry-run mode: server (validated by the real API server...` and `OK: the API server exposes deployments/scale ...`), "not the exit code alone", but the wrapper read only the exit code - so a validator that ran client-side, printed `WARNING: client-side only - NOT A PROOF` and exited 0 (which the default mode still does, and --require-server exists to prevent) was reported PASS. The validator's output is now captured, and an exit 0 without both lines, or with anything labelled NOT A PROOF or client-side, is FAIL. Its exit code is still read from the check itself, not from the tee that captures its output.
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
# Exit: 0 = the check passed against a reachable API server (for bot-manifest: exit 0 AND both
#           server-side lines in its output); 1 = it ran and failed, or exited 0 without that proof;
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

# The validator's pass signal (work package 4.3): BOTH server-side lines, and nothing it labelled
# NOT A PROOF. Its default mode exits 0 on a client-side dry-run, so an exit code alone cannot
# tell a server-side proof from a shape check.
server_proof() {
  grep -q '^dry-run mode: server (validated by the real API server' "$1" \
    && grep -q '^OK: the API server exposes deployments/scale with verbs ' "$1" \
    && ! grep -Eq 'NOT A PROOF|client-side only|^dry-run mode: client' "$1"
}

echo "$TAG: API server reachable at context '$CONTEXT'"
OUTPUT="$(mktemp "${TMPDIR:-/tmp}/oshal-$TAG.XXXXXX")" || unchecked "cannot create a temp file for the check's output."
trap 'rm -f "$OUTPUT"' EXIT
case "$WHICH" in
  bot-manifest)
    timeout "$LIMIT" npx tsx scripts/validate-dynamic-bot-manifest.mjs \
      --require-server --context "$CONTEXT" --namespace "$NAMESPACE" 2>&1 | tee "$OUTPUT"
    rc=${PIPESTATUS[0]} ;;
  tenant-isolation)
    timeout "$LIMIT" bash scripts/governance/verify-tenant-isolation.sh --context "$CONTEXT"
    rc=$? ;;
esac

if [ "$rc" -eq 0 ] && [ "$WHICH" = bot-manifest ] && ! server_proof "$OUTPUT"; then
  echo "$TAG: FAIL - the check exited 0 without the server-side proof (both 'dry-run mode: server' and"
  echo "$TAG: 'OK: the API server exposes deployments/scale', nothing labelled NOT A PROOF) (context '$CONTEXT')"
  exit 1
fi
case "$rc" in
  0) echo "$TAG: PASS (context '$CONTEXT')"; exit 0 ;;
  1) echo "$TAG: FAIL (context '$CONTEXT')"; exit 1 ;;
  124) unchecked "the check did not finish within ${LIMIT}s." ;;
  2) unchecked "the check refused to run (exit 2) - see its output above." ;;
  *) echo "$TAG: FAIL - the check exited $rc (context '$CONTEXT')"; exit 1 ;;
esac
