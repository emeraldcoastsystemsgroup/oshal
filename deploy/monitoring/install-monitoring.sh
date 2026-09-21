#!/usr/bin/env bash
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — k8s monitoring for an OSHAL helm release (the cluster form of scripts/monitoring-up.sh). Installs kube-prometheus-stack with deploy/monitoring/kube-prometheus-stack.values.yaml, loads ops/monitoring/alert-rules.yml VERBATIM as a PrometheusRule (one rule source for compose and k8s), and wires the fail-closed alert webhook: one ALERT_WEBHOOK_TOKEN held by the api (oshal-api-env) and by Alertmanager (oshal-alert-webhook). Idempotent; secrets are generated once and never printed.
#
# Usage: deploy/monitoring/install-monitoring.sh
#   env: OSHAL_NS (default oshal)  MON_NS (default monitoring)  KUBE_CONTEXT (default current)
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
OSHAL_NS=${OSHAL_NS:-oshal}
MON_NS=${MON_NS:-monitoring}
KC=(kubectl); HC=(helm)
if [ -n "${KUBE_CONTEXT:-}" ]; then KC+=(--context "$KUBE_CONTEXT"); HC+=(--kube-context "$KUBE_CONTEXT"); fi

log() { printf '== %s\n' "$*"; }
rand_hex() { head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }

"${KC[@]}" get namespace "$OSHAL_NS" >/dev/null 2>&1 \
  || { echo "namespace $OSHAL_NS not found — install the oshal chart first"; exit 1; }

log "helm repo prometheus-community"
"${HC[@]}" repo add prometheus-community https://prometheus-community.github.io/helm-charts >/dev/null 2>&1 || true
"${HC[@]}" repo update prometheus-community >/dev/null

"${KC[@]}" create namespace "$MON_NS" --dry-run=client -o yaml | "${KC[@]}" apply -f - >/dev/null

# ── Alert webhook token: the api's receiver is FAIL-CLOSED without it ─────────
RESTART_API=0
TOKEN=$("${KC[@]}" -n "$OSHAL_NS" get secret oshal-api-env -o jsonpath='{.data.ALERT_WEBHOOK_TOKEN}' 2>/dev/null | base64 -d 2>/dev/null || true)
if [ -z "$TOKEN" ]; then
  TOKEN=$(rand_hex)
  if "${KC[@]}" -n "$OSHAL_NS" get secret oshal-api-env >/dev/null 2>&1; then
    "${KC[@]}" -n "$OSHAL_NS" patch secret oshal-api-env --type merge \
      -p "{\"stringData\":{\"ALERT_WEBHOOK_TOKEN\":\"$TOKEN\"}}" >/dev/null
  else
    "${KC[@]}" -n "$OSHAL_NS" create secret generic oshal-api-env --from-literal="ALERT_WEBHOOK_TOKEN=$TOKEN" >/dev/null
  fi
  RESTART_API=1
  log "generated ALERT_WEBHOOK_TOKEN (api secret oshal-api-env)"
fi
"${KC[@]}" -n "$MON_NS" create secret generic oshal-alert-webhook --from-literal="token=$TOKEN" \
  --dry-run=client -o yaml | "${KC[@]}" apply -f - >/dev/null

# ── Grafana admin: random once, never the chart's well-known default ──────────
if ! "${KC[@]}" -n "$MON_NS" get secret grafana-admin >/dev/null 2>&1; then
  "${KC[@]}" -n "$MON_NS" create secret generic grafana-admin \
    --from-literal=admin-user=admin --from-literal="admin-password=$(rand_hex | cut -c1-24)" >/dev/null
  log "generated Grafana admin password (secret $MON_NS/grafana-admin)"
fi

log "kube-prometheus-stack"
# Pinned: the values file leans on chart keys (reloaderWebPort, extraManifests) that
# move between majors. Bump deliberately.
"${HC[@]}" upgrade --install kps prometheus-community/kube-prometheus-stack --version "${KPS_VERSION:-91.4.1}" -n "$MON_NS" \
  -f "$ROOT/deploy/monitoring/kube-prometheus-stack.values.yaml" --wait --timeout 15m

# ── The swarm rules, verbatim from the compose monitoring stack ───────────────
# Applied after the chart so the PrometheusRule CRD exists.
log "PrometheusRule oshal-swarm-rules <- ops/monitoring/alert-rules.yml"
{
  printf 'apiVersion: monitoring.coreos.com/v1\nkind: PrometheusRule\nmetadata:\n  name: oshal-swarm-rules\n  namespace: %s\nspec:\n' "$MON_NS"
  sed -n '/^groups:/,$p' "$ROOT/ops/monitoring/alert-rules.yml" | sed 's/^/  /'
} | "${KC[@]}" apply -f - >/dev/null

if [ "$RESTART_API" -eq 1 ]; then
  log "restarting oshal-api to load ALERT_WEBHOOK_TOKEN"
  "${KC[@]}" -n "$OSHAL_NS" rollout restart deploy/oshal-api >/dev/null
fi

cat <<EOF

Monitoring is up (Docker Desktop maps these LoadBalancers to localhost):
  Grafana       http://localhost:3000   user admin
                password: kubectl -n $MON_NS get secret grafana-admin -o jsonpath='{.data.admin-password}' | base64 -d
  Prometheus    http://localhost:9090   (targets: jobs oshal-core, oshal-swarm-bots)
  Alertmanager  http://localhost:9093   (Swarm* alerts -> oshal-api /api/alerts/alertmanager)
EOF
