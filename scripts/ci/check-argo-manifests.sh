#!/usr/bin/env bash
# =============================================================================
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Cluster-free schema gate for ops/deployment/argo/*.yaml. The five tenant/Argo manifests had no validator of any kind - not kubeconform, not a dry-run, not a spec - so a typo'd field shipped silently until somebody applied it to a cluster. Every manifest in the directory is validated by kubeconform in -strict mode (unknown fields and duplicate keys are errors): the core kinds against the Kubernetes OpenAPI schemas for a pinned version, and the Argo WorkflowTemplate against a commit-pinned CRD schema, so no kind is merely parsed. Fail-closed: a missing kubeconform, an empty directory or a schema that could not be fetched never reports PASS.
# =============================================================================
#
# Usage:  bash scripts/ci/check-argo-manifests.sh [root]
#   root  tree to judge (default: the repo this script lives in; ci-local.sh passes GATE_SRC)
#
# What is schema-checked, and against what:
#   Namespace, ResourceQuota, LimitRange, NetworkPolicy, ServiceAccount, Role, RoleBinding, Secret,
#   PersistentVolumeClaim - the Kubernetes OpenAPI schemas published at
#   github.com/yannh/kubernetes-json-schema, `<version>-standalone-strict`, version pinned below.
#   WorkflowTemplate (argoproj.io/v1alpha1) - the full-CRD schema in github.com/datreeio/CRDs-catalog
#   at a pinned commit (generated there from the argo-workflows v3.7.7 CRDs). A field added to
#   Argo after v3.7.7 would be reported as unknown; the fix is to move the pin, not to relax -strict.
#   Nothing is only parsed: -ignore-missing-schemas is deliberately NOT passed, so a kind with no
#   schema (a new CRD, or a typo'd kind or apiVersion) is an error, never a skip.
# What this does NOT prove: that a cluster admits the objects (admission, quota, RBAC escalation
#   checks, the apiserver ipBlock or the placeholder DATABASE_URL being right). That is item 13 of
#   docs/k8/remote-cluster-work-package.md and needs a cluster.
#
# Schemas are fetched over HTTPS at first use and cached (OSHAL_KUBECONFORM_CACHE). Both schema
# locations are pinned - a version directory and a commit SHA - so a cached copy never goes stale.
# No network and no cache means kubeconform cannot find a schema, and that FAILS this gate.
#
# Environment (all optional):
#   OSHAL_KUBECONFORM              kubeconform binary (default: `kubeconform` on PATH)
#   OSHAL_KUBECONFORM_CACHE        schema cache directory (default: $TMPDIR/oshal-kubeconform-cache)
#   OSHAL_KUBECONFORM_K8S_VERSION  Kubernetes schema version (default below)
#
# Exit: 0 = every manifest valid; 1 = a manifest failed validation (or a schema was unavailable);
#       2 = UNCHECKED (kubeconform is not installed, or there was nothing to judge).
set -uo pipefail

ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$ROOT" 2>/dev/null || { echo "argo-manifests: UNCHECKED - cannot enter '$ROOT'"; exit 2; }

# v1.36.0: the Kubernetes minor the chart has actually been installed on (Docker Desktop, 2026-09-21).
K8S_VERSION="${OSHAL_KUBECONFORM_K8S_VERSION:-1.36.0}"
# datreeio/CRDs-catalog commit 522267593c56 (2026-06-02, "regenerate argo-workflows schemas from
# v3.7.7 CRDs"). A commit SHA, not `main`: the schema this gate judges by cannot move underneath it.
CRD_SCHEMA_LOCATION='https://raw.githubusercontent.com/datreeio/CRDs-catalog/522267593c567f301ce7852e00463309fe62fa10/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json'
KUBECONFORM="${OSHAL_KUBECONFORM:-kubeconform}"

if ! command -v "$KUBECONFORM" >/dev/null 2>&1; then
  echo "argo-manifests: UNCHECKED - kubeconform not found ('$KUBECONFORM')."
  echo "argo-manifests: install it from https://github.com/yannh/kubeconform/releases (verify the"
  echo "argo-manifests: archive against that release's CHECKSUMS file) and put it on PATH, or set"
  echo "argo-manifests: OSHAL_KUBECONFORM to the binary. This gate does not skip without it."
  exit 2
fi

shopt -s nullglob
MANIFESTS=(ops/deployment/argo/*.yaml)
shopt -u nullglob
if [ "${#MANIFESTS[@]}" -eq 0 ]; then
  echo "argo-manifests: UNCHECKED - no ops/deployment/argo/*.yaml under $ROOT; nothing was judged."
  exit 2
fi

CACHE="${OSHAL_KUBECONFORM_CACHE:-${TMPDIR:-/tmp}/oshal-kubeconform-cache}"
mkdir -p "$CACHE" || { echo "argo-manifests: UNCHECKED - cannot create schema cache $CACHE"; exit 2; }
# kubeconform is a native binary on Windows: hand it a mixed-form path, not an MSYS one.
command -v cygpath >/dev/null 2>&1 && CACHE="$(cygpath -m "$CACHE")"

echo "argo-manifests: kubeconform $("$KUBECONFORM" -v 2>/dev/null) -strict, Kubernetes $K8S_VERSION schemas + pinned Argo CRD schema, ${#MANIFESTS[@]} files"
OUT="$("$KUBECONFORM" -strict -summary -verbose \
  -kubernetes-version "$K8S_VERSION" \
  -schema-location default \
  -schema-location "$CRD_SCHEMA_LOCATION" \
  -cache "$CACHE" \
  "${MANIFESTS[@]}" 2>&1)"
RC=$?
printf '%s\n' "$OUT"

# A summary that validated nothing is not a pass, whatever the exit code says.
if ! printf '%s\n' "$OUT" | grep -Eq '^Summary: [1-9][0-9]* resources? found'; then
  echo "argo-manifests: UNCHECKED - kubeconform reported no resources; nothing was judged."
  exit 2
fi
if [ "$RC" -ne 0 ]; then
  echo "argo-manifests: FAIL - a manifest above is invalid, or its schema could not be fetched (exit $RC)."
  exit 1
fi
# Nothing is passed that would skip a resource; a skip appearing anyway was never validated.
if ! printf '%s\n' "$OUT" | grep -Eq '^Summary: .*Skipped: 0$'; then
  echo "argo-manifests: FAIL - kubeconform skipped a resource, so it was not validated."
  exit 1
fi
echo "argo-manifests: PASS - every resource in ${#MANIFESTS[@]} files is schema-valid (-strict)."
exit 0
