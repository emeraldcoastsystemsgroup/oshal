# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — outputs state the tenant's effective auth posture in plain terms so an operator can read `terraform output` and know whether this deployment is multi-user-real-OIDC or a dev/mock instance, plus the exact command to reach the cockpit when no ingress is enabled.

output "namespace" {
  description = "Tenant namespace this release landed in."
  value       = kubernetes_namespace_v1.tenant.metadata[0].name
}

output "kube_context" {
  description = "Cluster context the tenant was deployed to."
  value       = var.kube_context
}

output "auth_posture" {
  description = "Effective multi-user posture of this tenant."
  value = {
    multi_user_oidc  = !var.mock_oidc
    mock_oidc        = var.mock_oidc
    guest_mode       = var.enable_guest_mode
    rls_bootstrap    = true # OSHAL_APP_ROLE_BOOTSTRAP is always on (ADR-076)
    app_url          = var.app_url
  }
}

output "cockpit_access" {
  description = "How to reach the cockpit for this tenant."
  value = var.ingress_enabled ? "https://${var.ingress_host}/cockpit/" : (
    var.nodeport > 0 ? "NodePort ${var.nodeport} on every node (Windows kind: bridge via the socat container in ingress.tf → http://localhost:15000/cockpit/)" :
    "kubectl --context ${var.kube_context} -n ${var.namespace} port-forward svc/oshal-api 15000:5000  →  http://localhost:15000/cockpit/"
  )
}
