# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — plain-k8s cockpit exposure: the ingress routes everything and the app enforces its own OIDC per route (authRequired:false + requiresAuth wrapping) — no auth at the edge.
# 2 | maintainer@emeraldcoastsystemsgroup.com   | Added optional NodePort exposure (var.nodeport) — the durable local-cluster access path for kind/dev clusters; a session-bound kubectl port-forward dies with its shell, which fails the human-testability gate.

# NodePort exposure for local/dev clusters (kind has no ingress controller by
# default). On Windows Docker Desktop the node ports aren't host-reachable
# directly — bridge with a small socat container on the kind network, e.g.:
#   docker run -d --restart unless-stopped --name oshal-tf-gateway --network kind \
#     -p 127.0.0.1:15000:5000 alpine/socat \
#     tcp-listen:5000,fork,reuseaddr tcp-connect:oshal-tf-worker:30500
resource "kubernetes_service_v1" "cockpit_nodeport" {
  count = var.nodeport > 0 ? 1 : 0

  metadata {
    name      = "oshal-api-nodeport"
    namespace = kubernetes_namespace_v1.tenant.metadata[0].name
    labels = {
      "app.kubernetes.io/part-of" = "oshal"
    }
  }

  spec {
    type = "NodePort"
    selector = {
      "app.kubernetes.io/name" = "oshal-api"
    }
    port {
      name        = "http"
      port        = 5000
      target_port = 5000
      node_port   = var.nodeport
    }
  }

  depends_on = [helm_release.oshal]
}

resource "kubernetes_ingress_v1" "cockpit" {
  count = var.ingress_enabled ? 1 : 0

  metadata {
    name      = "oshal-cockpit"
    namespace = kubernetes_namespace_v1.tenant.metadata[0].name
    labels = {
      "app.kubernetes.io/part-of" = "oshal"
    }
  }

  spec {
    ingress_class_name = var.ingress_class_name

    rule {
      host = var.ingress_host
      http {
        path {
          path      = "/"
          path_type = "Prefix"
          backend {
            service {
              name = "oshal-api"
              port {
                number = 5000
              }
            }
          }
        }
      }
    }

    dynamic "tls" {
      for_each = var.ingress_tls_secret != "" ? [1] : []
      content {
        hosts       = [var.ingress_host]
        secret_name = var.ingress_tls_secret
      }
    }
  }

  lifecycle {
    precondition {
      condition     = var.ingress_host != ""
      error_message = "ingress_enabled=true requires ingress_host."
    }
  }

  depends_on = [helm_release.oshal]
}
