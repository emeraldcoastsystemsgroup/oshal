# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — both providers target one cluster selected by kubeconfig + explicit context. kube_context is REQUIRED (no default) so an apply can never silently land on whatever cluster kubectl last pointed at — the same wrong-cluster hazard as the deploy-parity runbook, prevented at plan time.

provider "kubernetes" {
  config_path    = pathexpand(var.kubeconfig_path)
  config_context = var.kube_context
}

provider "helm" {
  kubernetes {
    config_path    = pathexpand(var.kubeconfig_path)
    config_context = var.kube_context
  }
}
