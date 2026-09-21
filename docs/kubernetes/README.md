# Kubernetes

Work that is tagged for a **separate machine with a real Kubernetes cluster**. The operator's
development box runs the full oshal swarm in docker compose and has no headroom for a cluster, so
nothing in this folder is attempted there.

For *operating* documentation on the current install path — the codeless `oshal-install.sh --mode 4`
flow and the [deploy/helm/oshal](../../deploy/helm/oshal) chart — see [docs/k8](../k8/README.md)
instead. This folder holds the work package, not the install guide.

## Available documents

- [remote-cluster-work-package.md](./remote-cluster-work-package.md) — the scope, the ordered work,
  the live proofs and the explicit out-of-scope list for every Kubernetes-dependent backlog clause:
  what exists today in the chart, Terraform, Argo manifests, the `src/` Kubernetes surfaces, the
  legacy generation and the guards (and which of it is an example or a placeholder), what can be
  done anywhere versus what needs a live cluster, and what the operator has parked or decided
  against. It also names which Kubernetes questions the tree already records as **answered**, so a
  cluster box does not spend a day re-proving them.
