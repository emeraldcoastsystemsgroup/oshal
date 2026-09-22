#!/usr/bin/env bash
# =============================================================================
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Kubernetes gates for scripts/ci-local.sh, which had none (docs/k8/remote-cluster-work-package.md section 2f: a grep for kube/helm/k8s/terraform over it returned nothing). Two cluster-free gates run on every full run - `argo-manifests` (kubeconform over all of ops/deployment/argo/*.yaml) and `terraform` (fmt -check + validate of deploy/terraform) - and two live-cluster gates run only when asked for with --cluster-gates: `cluster-bot-manifest` and `cluster-tenant-isolation`. `--k8s-only` runs just these, before the full runner's lock, logs and Docker cleanup, so a cluster box with no compose stack can run them and this box can run them without touching Docker.
# =============================================================================
#
# Sourced by scripts/ci-local.sh (like ci-purge.sh); defines functions only. Expects REPO_DIR and
# STATE_DIR from the caller; GATE_SRC, when the caller has set it, names the tree to judge.
#
# Tool posture: kubeconform and terraform are REQUIRED by these gates. Absent, the check scripts
# report UNCHECKED (exit 2) with the install instructions, and the gate is red - the same fail-closed
# convention as check-spec-database-default.sh and check-alert-residue.sh. Nothing is skipped quietly.

# Git for Windows ships coreutils timeout; ci-local.sh defines the same fallback, but --k8s-only
# runs before that line.
if ! command -v timeout >/dev/null 2>&1; then timeout() { shift; "$@"; }; fi

# Every ops/deployment/argo/*.yaml through kubeconform -strict. Schemas are cached under the gate's
# state directory so a nightly run fetches them once; both schema locations are pinned.
gate_argo_manifests() {
  (cd "${GATE_SRC:-$REPO_DIR}" && \
    OSHAL_KUBECONFORM_CACHE="${OSHAL_KUBECONFORM_CACHE:-$STATE_DIR/kubeconform-cache}" \
    timeout 600 bash scripts/ci/check-argo-manifests.sh)
}

# deploy/terraform: fmt -check -recursive, then init -backend=false -lockfile=readonly + validate.
# Providers install only at the hashes the committed lock file names and are cached here.
gate_terraform() {
  (cd "${GATE_SRC:-$REPO_DIR}" && \
    OSHAL_TF_PLUGIN_CACHE="${OSHAL_TF_PLUGIN_CACHE:-$STATE_DIR/terraform-plugin-cache}" \
    timeout 900 bash scripts/ci/check-terraform.sh)
}

# OPT-IN ONLY (--cluster-gates). Both need a reachable API server at OSHAL_CLUSTER_CONTEXT and fail
# closed without one; neither creates anything. See scripts/ci/check-cluster-gates.sh.
gate_cluster_bot_manifest() {
  (cd "${GATE_SRC:-$REPO_DIR}" && timeout 900 bash scripts/ci/check-cluster-gates.sh bot-manifest)
}
gate_cluster_tenant_isolation() {
  (cd "${GATE_SRC:-$REPO_DIR}" && timeout 900 bash scripts/ci/check-cluster-gates.sh tenant-isolation)
}

# The line a run prints when the cluster gates were not asked for. Not a failure: on a box with no
# cluster they must not run, and must not be reported as having passed either.
K8S_CLUSTER_GATES_NOT_REQUESTED='GATES cluster-bot-manifest + cluster-tenant-isolation: NOT RUN (opt-in: --cluster-gates with OSHAL_CLUSTER_CONTEXT set; they need a reachable cluster)'

# `ci-local.sh --k8s-only [--cluster-gates]`: the Kubernetes gates alone, against the working tree,
# with one PASS/FAIL line each. Returns 0 only when every gate that ran passed.
# $1 = 1 when --cluster-gates was given.
run_k8s_gates_standalone() {
  local want_cluster="${1:-0}" failed=() entry name fn
  local gates=("argo-manifests:gate_argo_manifests" "terraform:gate_terraform")
  if [ "$want_cluster" = "1" ]; then
    gates+=("cluster-bot-manifest:gate_cluster_bot_manifest" "cluster-tenant-isolation:gate_cluster_tenant_isolation")
  fi
  for entry in "${gates[@]}"; do
    name="${entry%%:*}"; fn="${entry#*:}"
    echo "GATE $name: start"
    if "$fn"; then echo "GATE $name: PASS"; else echo "GATE $name: FAIL"; failed+=("$name"); fi
  done
  [ "$want_cluster" = "1" ] || echo "$K8S_CLUSTER_GATES_NOT_REQUESTED"
  if [ "${#failed[@]}" -eq 0 ]; then echo "=== K8S GATES: ALL GREEN ==="; return 0; fi
  echo "=== K8S GATES: FAILED: ${failed[*]} ==="
  return 1
}
