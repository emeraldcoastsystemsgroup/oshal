#!/usr/bin/env bash
#
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — live cross-tenant network-isolation assertion for ADR-078 Phase 3. Proves BOTH directions are denied and that same-namespace traffic still flows (the control that distinguishes "isolated" from "nothing is listening"). Sibling to verify-rls-isolation.mjs, which asserts the DATA boundary; this asserts the NETWORK boundary.
#
# Usage: bash scripts/governance/verify-tenant-isolation.sh
# Exit 0 = isolation proven. Non-zero = a real failure (the assertion that failed is printed).
#
# Requires: a reachable cluster with tenant-a/tenant-b namespaces each running a pod
# labelled app=web that serves HTTP on :80, and a NetworkPolicy-enforcing CNI.
# Apply the policies first: kubectl apply -f ops/deployment/argo/tenant-network-policies.yaml

set -uo pipefail

pass=0; fail=0
note() { echo "[tenant-isolation] $*"; }
ok()   { echo "  PASS  $*"; pass=$((pass + 1)); }
bad()  { echo "  FAIL  $*"; fail=$((fail + 1)); }

command -v kubectl >/dev/null || { echo "kubectl not found"; exit 2; }
kubectl cluster-info >/dev/null 2>&1 || { echo "no reachable cluster"; exit 2; }

pod_in()  { kubectl get pod -n "$1" -l app=web -o jsonpath='{.items[0].metadata.name}' 2>/dev/null; }
ip_of()   { kubectl get pod -n "$1" -l app=web -o jsonpath='{.items[0].status.podIP}' 2>/dev/null; }

A_POD="$(pod_in tenant-a)"; A_IP="$(ip_of tenant-a)"
B_POD="$(pod_in tenant-b)"; B_IP="$(ip_of tenant-b)"
[ -n "$A_POD" ] && [ -n "$B_POD" ] || { echo "missing app=web pods in tenant-a/tenant-b"; exit 2; }
note "tenant-a: $A_POD ($A_IP)   tenant-b: $B_POD ($B_IP)"

# Returns 0 when the HTTP GET SUCCEEDS, non-zero when it is blocked/times out.
reach() { # <ns> <pod> <target-ip>
  kubectl exec -n "$1" "$2" -- timeout 6 wget -q -O- --timeout=5 "http://$3/" >/dev/null 2>&1
}

# ── CONTROL first. Without this, a "blocked" result is indistinguishable from
#    "nothing is listening on :80" — the failure mode that makes isolation tests lie.
note "control: same-namespace traffic must still flow"
if reach tenant-a "$A_POD" "$A_IP"; then ok "tenant-a -> tenant-a (self, same namespace) reachable"
else bad "tenant-a cannot reach its OWN pod — the web pod isn't serving, so deny results below are meaningless"; fi

# ── The actual isolation assertions: BOTH directions must be denied.
note "asserting cross-tenant deny in both directions"
if reach tenant-a "$A_POD" "$B_IP"; then bad "tenant-a REACHED tenant-b — cross-tenant traffic is NOT isolated"
else ok "tenant-a -> tenant-b blocked"; fi

if reach tenant-b "$B_POD" "$A_IP"; then bad "tenant-b REACHED tenant-a — cross-tenant traffic is NOT isolated"
else ok "tenant-b -> tenant-a blocked"; fi

# ── Policies must actually exist in both namespaces (a deleted policy would still
#    "pass" the deny checks if the pod simply died).
note "asserting the policies are present in both namespaces"
for ns in tenant-a tenant-b; do
  for np in default-deny-all allow-same-tenant; do
    if kubectl get networkpolicy "$np" -n "$ns" >/dev/null 2>&1; then ok "$ns has NetworkPolicy/$np"
    else bad "$ns is MISSING NetworkPolicy/$np"; fi
  done
done

# ── Dependency grants must be present (double-check 2026-07-08). The first rendering
#    granted only same-tenant + DNS: cross-tenant deny passed while the tenant's OWN
#    workload (bot-node-batch pods) would hang reaching Postgres / the model endpoint /
#    the apiserver. "Isolation proven" must not be able to coexist with "workload
#    starved", so assert the load-bearing egress grants exist in the applied policy.
#    (A live reachability control is not possible yet: the oshal / oshal-model
#    namespaces don't exist on this cluster until the control plane moves in.)
note "asserting the workload's dependency egress grants are present"
for ns in tenant-a tenant-b; do
  # Strip whitespace before matching: kubectl -o json pretty-prints ("key": "value"),
  # so a fixed no-space pattern silently misses every grant (false FAIL, seen live).
  spec="$(kubectl get networkpolicy allow-same-tenant -n "$ns" -o json 2>/dev/null | tr -d ' \n\t' || true)"
  for dep in oshal oshal-model; do
    case "$spec" in
      *"\"kubernetes.io/metadata.name\":\"$dep\""*) ok "$ns egress grants the $dep namespace" ;;
      *) bad "$ns egress is MISSING the $dep namespace grant — the tenant's own workload would be starved" ;;
    esac
  done
  case "$spec" in
    *'"ipBlock"'*) ok "$ns egress has the apiserver ipBlock (Argo wait sidecar)" ;;
    *) bad "$ns egress is MISSING the apiserver ipBlock — Workflows error after the work succeeds on a conformant CNI" ;;
  esac
done

echo
note "$pass passed, $fail failed"
[ "$fail" -eq 0 ] || { note "CROSS-TENANT ISOLATION NOT PROVEN"; exit 1; }
note "CROSS-TENANT ISOLATION PROVEN (both directions denied; same-namespace still flows)"
