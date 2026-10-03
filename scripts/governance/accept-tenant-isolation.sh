#!/usr/bin/env bash
#
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — the automated cluster acceptance for provision-tenant.sh's namespace half. The disposable-PostgreSQL proof covers the database half; nothing applied a RENDERED namespace to a cluster, and verify-tenant-isolation.sh could only judge the hand-applied tenant-a/tenant-b. This renders two run-unique tenants, applies them, starts one web pod in each, waits for both to be Ready, runs verify-tenant-isolation.sh against the two rendered namespaces (same-namespace traffic flows, cross-namespace traffic refused both ways, both policies and the dependency grants present), then deletes exactly the two namespaces it created and confirms both are gone. An incomplete cleanup is red even when isolation passed. It refuses, creating nothing, without a named context, a reachable API server, or when a namespace it would create already exists or its absence cannot be confirmed. Logic proven by tests/unit/accept-tenant-isolation.spec.ts over a stateful kubectl stand-in; it has not run against a live cluster.
#
# Usage:
#   bash scripts/governance/accept-tenant-isolation.sh --context <kube-context> \
#     --apiserver-cidr <a.b.c.d/n> --db-host <host> --image <image> [--timeout <seconds>]
#
# Every kubectl call carries --context; nothing reaches any other cluster. What it does:
#   1. Refuses (exit 2, nothing created) unless kubectl is present, an API server answers at the
#      context, and both namespaces it is about to create are confirmed absent (NotFound).
#   2. Renders tenants acc-<run>-a and acc-<run>-b with provision-tenant.sh (<run> is 8 random hex
#      digits), into a temporary directory that is removed on exit.
#   3. Applies each namespace.yaml and starts pod `web` (label app=web, --image, port 80) in each.
#   4. Waits for both pods to be Ready, then runs verify-tenant-isolation.sh --namespaces on the two.
#   5. Deletes exactly the two namespaces it created (their pods and objects go with them) and
#      confirms each is NotFound.
# --image must serve HTTP on port 80 and carry `timeout` and `wget`, which verify-tenant-isolation.sh
# probes with (nginx:alpine does). --timeout bounds each pod wait and each namespace deletion
# (default 180).
#
# Exit: 0 = isolation proven AND both namespaces deleted.
#       1 = isolation not proven, a pod never became Ready, or cleanup incomplete (a namespace it
#           created is still present) - incomplete cleanup is red even when isolation passed.
#       2 = refused before anything was created.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTEXT=''; CIDR=''; DB_HOST=''; IMAGE=''; WAIT_SECONDS='180'
TENANT_A=''; TENANT_B=''; NS_A=''; NS_B=''; WORK=''
CREATED=()

note() { echo "[tenant-acceptance] $*"; }
refuse() { echo "[tenant-acceptance] refused: $*" >&2; exit 2; }

# @description Read the command line, refusing anything unrecognised or missing.
# @param $@ The script's arguments.
# @returns Nothing; exits 2 on a malformed command line.
parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --context|--apiserver-cidr|--db-host|--image|--timeout)
        [ -n "${2:-}" ] || refuse "$1 needs a value"
        case "$1" in
          --context) CONTEXT="$2" ;;
          --apiserver-cidr) CIDR="$2" ;;
          --db-host) DB_HOST="$2" ;;
          --image) IMAGE="$2" ;;
          --timeout) WAIT_SECONDS="$2" ;;
        esac
        shift 2 ;;
      *) refuse "unknown argument: $1" ;;
    esac
  done
  [ -n "$CONTEXT" ] || refuse "--context is required (the kube context of the cluster to accept on)"
  [ -n "$CIDR" ] || refuse "--apiserver-cidr is required (kubectl get endpoints kubernetes)"
  [ -n "$DB_HOST" ] || refuse "--db-host is required (written into each tenant's ConfigMap)"
  [ -n "$IMAGE" ] || refuse "--image is required (serves HTTP on port 80, carries timeout and wget)"
  [[ "$WAIT_SECONDS" =~ ^[0-9]{1,4}$ ]] && [ "$WAIT_SECONDS" -ge 1 ] || refuse "invalid --timeout '$WAIT_SECONDS'"
}

# @description Confirm one namespace does not exist: only a NotFound answer counts as absent.
# @param $1 The namespace.
# @returns Nothing; exits 2 when it exists or its absence cannot be confirmed.
require_absent() {
  local out rc
  out="$(kubectl get namespace "$1" 2>&1)"; rc=$?
  [ "$rc" -ne 0 ] || refuse "namespace $1 already exists; nothing was created"
  [[ "$out" == *NotFound* ]] || refuse "could not confirm namespace $1 is absent: $out"
}

# @description kubectl present, an API server at the context, two run-unique tenants whose
# namespaces are confirmed absent.
# @returns Nothing; exits 2 on any refusal.
preflight() {
  command -v kubectl >/dev/null 2>&1 || refuse "kubectl not found"
  kubectl cluster-info >/dev/null 2>&1 || refuse "no API server answered at context '$CONTEXT'"
  local run
  run="$(printf '%04x%04x' "$RANDOM" "$RANDOM")"
  TENANT_A="acc-$run-a"; TENANT_B="acc-$run-b"
  NS_A="oshal-tenant-$TENANT_A"; NS_B="oshal-tenant-$TENANT_B"
  require_absent "$NS_A"
  require_absent "$NS_B"
}

# @description Render both tenants into a temporary directory with the shipped provision-tenant.sh.
# @returns Nothing; exits 2 when a rendering fails (nothing has been created yet).
render_tenants() {
  WORK="$(mktemp -d)"
  local tenant
  for tenant in "$TENANT_A" "$TENANT_B"; do
    bash "$HERE/provision-tenant.sh" "$tenant" --tenancy=isolated --db-host="$DB_HOST" \
      --apiserver-cidr="$CIDR" --out="$WORK/$tenant" >/dev/null || refuse "rendering tenant $tenant failed"
  done
}

# @description Apply one rendered tenant and start its web pod. The namespace is recorded BEFORE
# the apply, so even a half-applied tenant is cleaned up.
# @param $1 The tenant slug.
# @param $2 Its namespace.
# @returns 0 when both the apply and the pod start were accepted, 1 otherwise.
create_tenant() {
  CREATED+=("$2")
  kubectl apply -f "$WORK/$1/namespace.yaml" >/dev/null || { note "FAIL: the cluster refused the rendering of $2"; return 1; }
  kubectl run web --image="$IMAGE" --labels=app=web --port=80 --restart=Never -n "$2" >/dev/null \
    || { note "FAIL: could not start pod web in $2"; return 1; }
  note "applied $2 and started pod web"
}

# @description Create both tenants, wait for both pods, then run the isolation check on the two.
# @returns 0 when isolation is proven, 1 otherwise.
accept() {
  create_tenant "$TENANT_A" "$NS_A" || return 1
  create_tenant "$TENANT_B" "$NS_B" || return 1
  local ns
  for ns in "$NS_A" "$NS_B"; do
    kubectl wait --for=condition=Ready pod/web -n "$ns" --timeout="${WAIT_SECONDS}s" >/dev/null \
      || { note "FAIL: pod web in $ns never became Ready"; return 1; }
  done
  bash "$HERE/verify-tenant-isolation.sh" --context "$CONTEXT" --namespaces "$NS_A,$NS_B"
}

# @description Delete exactly the namespaces this run created and confirm each answers NotFound.
# @returns 0 when every one is gone, 1 when any is still present.
delete_created() {
  local ns out rc left=()
  for ns in ${CREATED[@]+"${CREATED[@]}"}; do
    kubectl delete namespace "$ns" --ignore-not-found --wait=true --timeout="${WAIT_SECONDS}s" >/dev/null 2>&1
    out="$(kubectl get namespace "$ns" 2>&1)"; rc=$?
    if [ "$rc" -ne 0 ] && [[ "$out" == *NotFound* ]]; then note "deleted namespace $ns"; else left+=("$ns"); fi
  done
  [ "${#left[@]}" -eq 0 ] && return 0
  note "CLEANUP INCOMPLETE: still present: ${left[*]}"
  return 1
}

# @description EXIT handler: clean up, remove the rendering, and settle the exit status. An
# incomplete cleanup turns any status into 1.
# @param $1 The status the script was exiting with.
# @returns Never; exits.
finish() {
  local status="$1"
  trap - EXIT
  delete_created || status=1
  [ -z "$WORK" ] || rm -rf "$WORK"
  exit "$status"
}

parse_args "$@"
command -v kubectl >/dev/null 2>&1 || refuse "kubectl not found"
kubectl() { command kubectl --context "$CONTEXT" "$@"; }
preflight
trap 'finish $?' EXIT
trap 'exit 130' INT TERM
render_tenants
if accept; then
  note "TENANT ISOLATION ACCEPTED on context '$CONTEXT' ($NS_A, $NS_B); deleting what this run created"
  exit 0
fi
note "TENANT ISOLATION NOT ACCEPTED on context '$CONTEXT'; deleting what this run created"
exit 1
