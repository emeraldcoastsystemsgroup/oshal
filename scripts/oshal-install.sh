#!/usr/bin/env bash
# =============================================================================
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — the codebase-free installer: Docker + registry reachability are the ONLY prerequisites. Pulls the OSHAL image, extracts the baked compose.dist.yml + non-secret config seeds, generates operator-local .env secrets, then brings the swarm up ORDERED AND BATCHED (infra healthy -> api fully up -> bots 5-at-a-time). The batching is load-bearing: a mass cold-start of every bot OOM-crashes small Docker engines (~6 GB, proven twice 2026-07-23); this script embeds the bring-up rather than assuming any repo script exists on the host.
# 2 | maintainer@emeraldcoastsystemsgroup.com   | v2 — the ONE-CLICK installer. Four modes: (1) swarm from registry, no source; (2) swarm from source (clone + build); (3) leaf-node bot joining an existing swarm; (4) k8s pointer (deploy/terraform). Bundles install the KERNEL plus curated app sets with dependencies BOUND (little-monsters pulls the office tools + deck-builder bot; gaming = dnd + game-show; jobs = career-hunter + job-apply), --apps adds individual store packages, and the resolved set is DEDUPED — a package stages once and a bot/surface registers once no matter how many bundles/flags name it (idempotent re-runs skip already-staged packages). Ends with the cockpit opening, superadmin instructions, and the operator email wired into .env when provided.
# 3 | maintainer@emeraldcoastsystemsgroup.com   | First-run fix (lockstep with oshal-install.ps1) — the closing instructions were false and the identity was never the user's. MOCK_OIDC has NO sign-in page; it fabricates alex@demo.local / mock-user-001 and treats every request as authenticated, so "sign in at the cockpit with your email" could never happen: the user was silently someone else, not the superadmin, with every connector token binding to the shared demo sub. The email prompt now writes MOCK_OIDC_EMAIL/NAME/SUB alongside OSHAL_OPERATOR_EMAILS, the sub being a stable sha256-of-lowercased-email (local_sub(), byte-identical to the ps1's LocalSub) so a reinstall against the same workspace volume keeps its sub-keyed data. Also opens /welcome instead of /cockpit/ — linking an AI model is mandatory and browser-only, and /cockpit just 302s to the wizard anyway — and says plainly what the wizard will ask for.
# 4 | maintainer@emeraldcoastsystemsgroup.com   | INSTALLER-GAPS G1/G2/G4 (the G-Squared incident): (G1) install now ENDS with scripts/oshal-verify.sh in --pre-onboarding posture — counting containers is no longer success; a broken leg (kernel service, heartbeat, db, contradictory no-AI posture) fails the install loudly by name. The verify trio (oshal-verify.sh, swarm-routability-check.sh, routability-critical-bots.txt) is extracted from the image in registry mode, with a raw.githubusercontent fallback for images predating it. (G2) new --no-ai flag: running without a connected model is now an EXPLICIT choice recorded in .env (OSHAL_NO_AI=true + FORCE_LLM_PROVIDER=noop + a comment saying what will not work) — never a silent default; with it, the installer opens the cockpit instead of a wizard that could never complete. (G4) preflight now owns the credential paths BEFORE first `up` (~/.claude, ~/.codex, ~/.gemini as directories; ~/.claude.json as a FILE, so Docker cannot auto-create a root-owned directory where a file belongs) and writes CLAUDE_AUTH_MOUNT_MODE=rw / GEMINI_AUTH_MOUNT_MODE=rw for server installs — a CLI that cannot write cannot refresh its token, and `claude auth login` reports success while saving nothing.
# 5 | maintainer@emeraldcoastsystemsgroup.com   | CORE-05: pass the exact deduplicated app set to the canonical postflight verifier so a staged package cannot report installed without executing its manifest smoke.
# 6 | maintainer@emeraldcoastsystemsgroup.com   | APP-02: assess every requested store package in the shipped core image, block invalid audit bindings, and stage verified packages only from their exact SHA archive.
# 7 | maintainer@emeraldcoastsystemsgroup.com   | ADR-129: mode 4 goes from a printed Terraform pointer to a REAL codeless k8s install — kubectl/helm preflight, cluster detection (offers a single-node kind cluster with the cockpit port mapped; REFUSES to create one beside a running compose swarm — that pairing OOM-wedged a 6GB engine twice), chart from the published OCI package with a repo-fetch fallback, fleet presets kernel|full (store bundles stay compose-only and say so), the same admin-email→MOCK_OIDC identity wiring as mode 1 (shared local_sub, hoisted above the mode dispatch), NodePort exposure with localhost/node-IP detection, /api/health postflight, and the /welcome open. New flags: --namespace, --k8s-context, --nodeport, --chart.
# 8 | maintainer@emeraldcoastsystemsgroup.com   | Mode 4 now INSTALLS its prerequisites instead of printing links and exiting 1 (operator: the installer should include the prereqs). kubectl and helm are fetched from their official sources into /usr/local/bin when writable, else ~/.local/bin (never a silent sudo); if no cluster is reachable it offers k3s on Linux (native, no Docker, survives reboot, NodePorts land on the host) and kind wherever Docker is present (fully scriptable — no GUI toggle), still refusing kind beside a running compose swarm. Every system-touching step asks first; --yes/-y accepts them for unattended installs, and a non-interactive shell DECLINES rather than surprise-installing.
# =============================================================================
#
# One-click:
#   curl -fsSLO https://raw.githubusercontent.com/emeraldcoastsystemsgroup/oshal/main/scripts/oshal-install.sh
#   bash oshal-install.sh
#
# Flags (no flags = interactive):
#   --mode 1|2|3|4      1 swarm from registry (default) · 2 swarm from source ·
#                       3 leaf-node bot (join an existing swarm) · 4 kubernetes (helm install)
#   --bundle NAME       kernel | full | little-monsters | gaming | jobs   (default: full)
#   --apps a,b,c        individual store packages to add (deduped against the bundle)
#   --audit-mode MODE   package audit posture: compatible (default) | enforce
#   --dir DIR           install directory (default ./oshal)
#   --tag TAG           image tag (default latest)      --registry REG   (default ghcr.io/emeraldcoastsystemsgroup)
#   --admin-email E     wire E as the swarm operator/superadmin (.env, or k8s api env)
#   --control-plane URL --join-code CODE [--enrollment-token T]   (mode 3)
#   --namespace NS      (mode 4) tenant namespace                (default oshal)
#   --k8s-context CTX   (mode 4) kubeconfig context              (default: current)
#   --nodeport N        (mode 4) cockpit NodePort 30000-32767    (default 30500)
#   --chart REF         (mode 4) chart dir/OCI ref override      (default: published OCI, repo fallback)
#   --no-ai             EXPLICITLY install without a connected model (recorded;
#                       AI features stay disabled until a model is connected)
#   --yes, -y           accept prerequisite installs (kubectl/helm/kind/k3s) without prompting
#   --dry-run           print the plan, touch nothing
#
# Hosting environments: DOCKER (modes 1-2) and KUBERNETES (mode 4) — both fully
# automated here, both pulling only from the registry. Multi-user public tenants
# on k8s should use deploy/terraform instead (OIDC/secret posture guards).

set -euo pipefail

MODE=""; BUNDLE="full"; APPS=""; DIR="./oshal"; TAG="latest"; NO_AI=0
PACKAGE_AUDIT_MODE="${OSHAL_PACKAGE_AUDIT_MODE:-compatible}"
REGISTRY="ghcr.io/emeraldcoastsystemsgroup"; ADMIN_EMAIL=""; DRY=0; FROM_ARCHIVE=""
CONTROL_PLANE=""; JOIN_CODE=""; ENROLL_TOKEN=""; ASSUME_YES=0
K8S_NAMESPACE="oshal"; K8S_CONTEXT=""; K8S_NODEPORT="30500"; K8S_CHART=""; BUNDLE_EXPLICIT=0
REPO_URL="https://github.com/emeraldcoastsystemsgroup/oshal"
STORE_REPO="https://github.com/emeraldcoastsystemsgroup/oshal-apps"

while [ $# -gt 0 ]; do case "$1" in
  --mode) MODE="$2"; shift 2 ;;
  --bundle) BUNDLE="$2"; BUNDLE_EXPLICIT=1; shift 2 ;;
  --apps) APPS="$2"; shift 2 ;;
  --audit-mode) PACKAGE_AUDIT_MODE="$2"; shift 2 ;;
  --dir) DIR="$2"; shift 2 ;;
  --tag) TAG="$2"; shift 2 ;;
  --registry) REGISTRY="$2"; shift 2 ;;
  --admin-email) ADMIN_EMAIL="$2"; shift 2 ;;
  --control-plane) CONTROL_PLANE="$2"; shift 2 ;;
  --join-code) JOIN_CODE="$2"; shift 2 ;;
  --enrollment-token) ENROLL_TOKEN="$2"; shift 2 ;;
  --namespace) K8S_NAMESPACE="$2"; shift 2 ;;
  --k8s-context) K8S_CONTEXT="$2"; shift 2 ;;
  --nodeport) K8S_NODEPORT="$2"; shift 2 ;;
  --chart) K8S_CHART="$2"; shift 2 ;;
  --from-archive) FROM_ARCHIVE="$2"; shift 2 ;;
  --no-ai) NO_AI=1; shift ;;
  --yes|-y) ASSUME_YES=1; shift ;;
  --dry-run) DRY=1; shift ;;
  *) echo "unknown flag: $1" >&2; exit 2 ;;
esac; done

case "$PACKAGE_AUDIT_MODE" in compatible|enforce) ;; *) echo "--audit-mode must be compatible or enforce" >&2; exit 2 ;; esac

say()  { printf '\n== %s\n' "$*"; }
note() { printf '   %s\n' "$*"; }

# ── Bundles: kernel + curated sets with dependencies BOUND ───────────────────
# A bundle names (a) store packages and (b) the bot-node services those packages
# need beyond the kernel. Dependencies ride along explicitly — little-monsters
# includes the office/presentations surface AND the deck-builder bot because its
# lessons render decks. The resolved package set is deduplicated, so overlapping
# bundles/--apps never stage a package or register a bot/surface twice.
KERNEL_SERVICES=(oshal-api general-bot jarvis-bot oshal-developer)
declare -A BUNDLE_PACKAGES=(
  [kernel]=""
  [full]=""
  [little-monsters]="little-monsters presentations"
  [gaming]="dnd game-show"
  [jobs]="career-hunter job-apply"
)
declare -A BUNDLE_SERVICES=(
  [kernel]=""
  [full]="__ALL__"
  [little-monsters]="deck-builder-bot"
  [gaming]=""
  [jobs]=""
)
# No bundle sets a compose profile. ADR-085 carved little-monsters to the store and its compose
# profile went with it — the declared profiles are build/extras/incident/local-llm/
# social-media/tunnel, so COMPOSE_PROFILES=little-monsters activated nothing. Kept as a map
# because bundles that DO need a profile are a live possibility.
declare -A BUNDLE_PROFILES=(
  [kernel]="" [full]="" [little-monsters]="" [gaming]="" [jobs]=""
)

[ -n "${BUNDLE_PACKAGES[$BUNDLE]+x}" ] || { echo "unknown bundle: $BUNDLE (kernel|full|little-monsters|gaming|jobs)"; exit 2; }

# Resolve the deduped package set (bundle ∪ --apps).
declare -A PKG_SET=()
for p in ${BUNDLE_PACKAGES[$BUNDLE]} ${APPS//,/ }; do [ -n "$p" ] && PKG_SET[$p]=1; done

# ── Interactive menu when no mode given ──────────────────────────────────────
if [ -z "$MODE" ]; then
  if [ -t 0 ]; then
    say "OSHAL installer"
    echo "   1) Install the swarm — no source code (registry images)   [recommended]"
    echo "   2) Install the swarm — from source (git clone + build)"
    echo "   3) Install a leaf-node bot (join an existing swarm from this computer)"
    echo "   4) Install the swarm on Kubernetes — no source code (helm + registry images)"
    printf '   choose [1]: '; read -r MODE; MODE="${MODE:-1}"
    # Same bundle vocabulary on every substrate — docker and k8s install the same
    # kernel + curated app sets; only the mechanism differs (compose services vs
    # chart fleet + staged packages).
    if [ "$MODE" != "3" ]; then
      printf '   bundle (kernel/full/little-monsters/gaming/jobs) [%s]: ' "$BUNDLE"; read -r b; BUNDLE="${b:-$BUNDLE}"
      [ -n "${BUNDLE_PACKAGES[$BUNDLE]+x}" ] || { echo "unknown bundle: $BUNDLE"; exit 2; }
      # This is the LOGIN, not just an admin flag: MOCK_OIDC has no sign-in page, so whatever
      # lands here is who the swarm thinks you are. Blank = the shared demo identity.
      printf '   your email — becomes your local login AND the superadmin (blank = decide later): '; read -r ADMIN_EMAIL || true
      for p in ${BUNDLE_PACKAGES[$BUNDLE]:-}; do PKG_SET[$p]=1; done
    fi
  else
    MODE=1
  fi
fi

# ${!arr[*]} lists keys, but ADDING :- flips bash into INDIRECTION on the joined VALUES
# ("1 1: invalid variable name") — caught live by the first stranger-path dry-run. Two steps.
pkg_list="${!PKG_SET[*]}"
PLAN="mode=$MODE bundle=$BUNDLE packages=[${pkg_list:-none}] audit=$PACKAGE_AUDIT_MODE dir=$DIR tag=$TAG"
[ "$MODE" = "4" ] && PLAN="mode=4 (kubernetes) bundle=$BUNDLE packages=[${pkg_list:-none}] namespace=$K8S_NAMESPACE context=${K8S_CONTEXT:-current} nodeport=$K8S_NODEPORT tag=$TAG chart=${K8S_CHART:-oci-then-repo}"
if [ "$DRY" -eq 1 ]; then say "DRY RUN — $PLAN"; exit 0; fi

# Stable local identity derived from the email, so a reinstall against the same workspace
# keeps the same user sub (connector tokens and tickets are sub-keyed — a fresh random sub
# would orphan them). Must stay byte-identical to LocalSub() in oshal-install.ps1: sha256 of
# the lowercased email, first 16 hex chars. Shared by the compose (.env) and k8s (helm
# values) paths — that is why it is defined ahead of the mode dispatch.
local_sub() {
  _lsl=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
  _lsh=$(printf '%s' "$_lsl" | { sha256sum 2>/dev/null || shasum -a 256 2>/dev/null; } | awk '{print $1}')
  printf 'local-%s' "$(printf '%s' "$_lsh" | cut -c1-16)"
}

# ── Mode 4: Kubernetes — codeless helm install (ADR-129) ─────────────────────
# Same contract as mode 1, different substrate: registry image + published chart,
# no source, no build. Multi-user public tenants belong on deploy/terraform (its
# OIDC/secret posture guards are the point); this is the single-box swarm.
if [ "$MODE" = "4" ]; then
  say "Kubernetes install (helm + registry images — no source, no build)"

  # ── Prerequisites: install them, don't just complain ───────────────────────
  # Every step that touches the system asks first (or takes --yes). Tools land in
  # /usr/local/bin when writable, else ~/.local/bin — never a silent sudo.
  OS_KIND=$(uname -s 2>/dev/null || echo unknown)
  case "$OS_KIND" in Linux*) OSK=linux ;; Darwin*) OSK=darwin ;; MINGW*|MSYS*|CYGWIN*|Windows*) OSK=windows ;; *) OSK=unknown ;; esac
  case "$(uname -m 2>/dev/null)" in x86_64|amd64) ARCH=amd64 ;; aarch64|arm64) ARCH=arm64 ;; *) ARCH=amd64 ;; esac

  confirm() { # $1 = prompt. --yes accepts; non-interactive declines (never surprise-install).
    [ "$ASSUME_YES" -eq 1 ] && return 0
    [ -t 0 ] || return 1
    printf '   %s [Y/n]: ' "$1"; read -r _a
    [ -z "$_a" ] || [ "${_a#[Yy]}" != "$_a" ]
  }

  BIN_DIR=""
  pick_bin_dir() {
    [ -n "$BIN_DIR" ] && return 0
    if [ -w /usr/local/bin ] 2>/dev/null; then BIN_DIR=/usr/local/bin
    elif command -v sudo >/dev/null 2>&1 && [ "$OSK" != "windows" ]; then BIN_DIR=/usr/local/bin; SUDO=sudo
    else BIN_DIR="$HOME/.local/bin"; mkdir -p "$BIN_DIR"; fi
    case ":$PATH:" in *":$BIN_DIR:"*) ;; *) export PATH="$BIN_DIR:$PATH"; PATH_NOTE="$BIN_DIR" ;; esac
  }

  install_kubectl() {
    say "kubectl is not installed"
    confirm "install kubectl now?" || { note "install it yourself: https://kubernetes.io/docs/tasks/tools/"; exit 1; }
    if [ "$OSK" = darwin ] && command -v brew >/dev/null 2>&1; then brew install kubectl; return; fi
    pick_bin_dir
    ver=$(curl -fsSL https://dl.k8s.io/release/stable.txt)
    curl -fsSL -o /tmp/kubectl "https://dl.k8s.io/release/${ver}/bin/${OSK}/${ARCH}/kubectl"
    chmod +x /tmp/kubectl; ${SUDO:-} mv /tmp/kubectl "$BIN_DIR/kubectl"
    note "kubectl ${ver} -> $BIN_DIR/kubectl"
  }

  install_helm() {
    say "helm is not installed"
    confirm "install helm now?" || { note "install it yourself: https://helm.sh/docs/intro/install/"; exit 1; }
    if [ "$OSK" = darwin ] && command -v brew >/dev/null 2>&1; then brew install helm; return; fi
    pick_bin_dir
    # Helm's official installer; keep it in the same bin dir we chose above.
    curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 \
      | HELM_INSTALL_DIR="$BIN_DIR" USE_SUDO="$([ -n "${SUDO:-}" ] && echo true || echo false)" bash
    note "helm -> $BIN_DIR/helm"
  }

  install_kind() {
    pick_bin_dir
    kver="${KIND_VERSION:-v0.30.0}"
    curl -fsSL -o /tmp/kind "https://kind.sigs.k8s.io/dl/${kver}/kind-${OSK}-${ARCH}"
    chmod +x /tmp/kind; ${SUDO:-} mv /tmp/kind "$BIN_DIR/kind"
    note "kind ${kver} -> $BIN_DIR/kind"
  }

  command -v kubectl >/dev/null 2>&1 || install_kubectl
  command -v helm >/dev/null 2>&1 || install_helm

  KC=(kubectl); HELM_CTX=()
  [ -n "$K8S_CONTEXT" ] && { KC+=(--context "$K8S_CONTEXT"); HELM_CTX=(--kube-context "$K8S_CONTEXT"); }

  # ── Cluster: use one, or stand one up ──────────────────────────────────────
  if ! "${KC[@]}" cluster-info >/dev/null 2>&1; then
    say "no reachable Kubernetes cluster${K8S_CONTEXT:+ (context $K8S_CONTEXT)}"
    if [ -n "$K8S_CONTEXT" ]; then
      echo "Context '$K8S_CONTEXT' does not reach a cluster. Fix the context, or drop --k8s-context"
      echo "to let the installer stand a local cluster up."
      exit 1
    fi

    # NEVER kind + the compose swarm on one machine — that pairing OOM-wedged a
    # 6GB Docker engine twice (2026-07-18). The check is the guard, not a vibe.
    SWARM_RUNNING=0
    docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^oshal-local-api$' && SWARM_RUNNING=1
    DOCKER_OK=0; docker info >/dev/null 2>&1 && DOCKER_OK=1

    CLUSTER_MADE=""
    # Linux: k3s is the native answer — no Docker in the path, survives reboot,
    # and NodePorts land straight on the host. Preferred on a server.
    if [ "$OSK" = linux ] && [ -z "$CLUSTER_MADE" ]; then
      note "k3s is the lightweight native Kubernetes for Linux (installs a system service, needs sudo)."
      if confirm "install k3s and use it?"; then
        curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC="--write-kubeconfig-mode 644" sh -
        export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
        note "k3s installed — KUBECONFIG=$KUBECONFIG"
        note "add that export to your shell profile to keep kubectl working in new terminals."
        # k3s serves NodePorts on the host directly; no port mapping needed.
        for i in $(seq 1 40); do "${KC[@]}" get nodes >/dev/null 2>&1 && break; sleep 3; done
        CLUSTER_MADE=k3s
      fi
    fi

    # Docker present (any OS): kind is fully scriptable and needs no GUI toggle.
    if [ -z "$CLUSTER_MADE" ] && [ "$DOCKER_OK" -eq 1 ]; then
      if [ "$SWARM_RUNNING" -eq 1 ]; then
        echo "The compose swarm is RUNNING on this machine. Refusing to create a kind cluster beside it —"
        echo "that pairing OOM-wedges the shared Docker engine. Use another computer, or stop the swarm first."
        exit 1
      fi
      command -v kind >/dev/null 2>&1 || { confirm "install kind (local Kubernetes on Docker)?" && install_kind; }
      if command -v kind >/dev/null 2>&1 && confirm "create a local kind cluster \"oshal\" (single node, cockpit port mapped)?"; then
        mkdir -p "$DIR"
        { echo 'kind: Cluster'
          echo 'apiVersion: kind.x-k8s.io/v1alpha4'
          echo 'nodes:'
          echo '  - role: control-plane'
          echo '    extraPortMappings:'
          echo "      - containerPort: $K8S_NODEPORT"
          echo "        hostPort: $K8S_NODEPORT"
        } > "$DIR/kind-oshal.yaml"
        kind create cluster --name oshal --config "$DIR/kind-oshal.yaml"
        KC=(kubectl --context kind-oshal); HELM_CTX=(--kube-context kind-oshal)
        CLUSTER_MADE=kind
      fi
    fi

    if [ -z "$CLUSTER_MADE" ]; then
      echo "No cluster, nothing installed. Your options:"
      [ "$OSK" = linux ] && echo "  - k3s:            curl -sfL https://get.k3s.io | sh -    (native, recommended on Linux)"
      [ "$DOCKER_OK" -eq 0 ] && echo "  - Docker Desktop: https://docs.docker.com/get-docker/  (then re-run; enables the kind path)"
      echo "  - Docker Desktop: Settings -> Kubernetes -> Enable Kubernetes, then re-run"
      echo "  - kind:           https://kind.sigs.k8s.io   (NEVER beside the compose swarm)"
      echo "  - any managed cluster: point kubectl at it and re-run"
      exit 1
    fi
  fi

  # Chart source: explicit --chart, else the published OCI chart, else the chart
  # files fetched from the repo (still no source build — the fallback exists so a
  # fresh box works even before the operator's first chart publish).
  OCI_REF="oci://${REGISTRY}/charts/oshal"
  if [ -n "$K8S_CHART" ]; then
    CHART_SRC="$K8S_CHART"
  elif helm show chart "$OCI_REF" >/dev/null 2>&1; then
    CHART_SRC="$OCI_REF"
  else
    note "OCI chart not published yet at $OCI_REF — fetching the chart from the repo"
    mkdir -p "$DIR/chart-src"
    # Download-then-extract, never curl|tar: tar stops reading after the matched
    # subtree, curl exits 23 on the closed pipe, and pipefail turns that success
    # into a false "could not fetch".
    curl -fsSL "https://codeload.github.com/emeraldcoastsystemsgroup/oshal/tar.gz/refs/heads/main" -o "$DIR/chart-src/repo.tgz" \
      && tar -xzf "$DIR/chart-src/repo.tgz" -C "$DIR/chart-src" --strip-components=4 "oshal-main/deploy/helm/oshal" 2>/dev/null \
      || { echo "could not fetch the chart (offline?) — pass --chart <dir> to use a local chart"; exit 1; }
    rm -f "$DIR/chart-src/repo.tgz"
    CHART_SRC="$DIR/chart-src"
  fi

  # kernel|full map to the chart's generated fleet presets. An app bundle keeps
  # its packages (staged by the chart's initContainer) and brings the fleet its
  # bots need — a bundle whose bots never start is an app that cannot run.
  FLEET="kernel"
  case "$BUNDLE" in
    kernel) FLEET="kernel" ;;
    full)   FLEET="full" ;;
    *)      FLEET="full"; note "bundle '$BUNDLE' needs bots beyond the kernel — installing the full fleet with its packages" ;;
  esac

  HELM_SET=(
    --set-string "image.repository=${REGISTRY}/oshal-bot"
    --set-string "image.tag=$TAG"
    --set "api.service.type=NodePort"
    --set "api.service.nodePort=$K8S_NODEPORT"
    --set-string "fleet=$FLEET"
    --set-string "store.auditMode=$PACKAGE_AUDIT_MODE"
  )
  # Store packages: the chart stages these into the workspace PVC before the api
  # boots (auto-load registers each package's bots and surfaces once, at boot).
  # Same deduped set as the compose path — helm list syntax, hence the braces.
  if [ "${#PKG_SET[@]}" -gt 0 ]; then
    k8s_pkgs=""
    for p in "${!PKG_SET[@]}"; do k8s_pkgs="${k8s_pkgs:+$k8s_pkgs,}$p"; done
    HELM_SET+=(--set "packages={$k8s_pkgs}")
    note "packages to stage: $k8s_pkgs"
    if [ -n "${OSHAL_STORE_TOKEN:-${GITHUB_TOKEN:-}}" ]; then
      # Private store repos only. Created/updated idempotently; the chart reads it
      # optionally, so a public-only install never needs it.
      "${KC[@]}" create namespace "$K8S_NAMESPACE" >/dev/null 2>&1 || true
      "${KC[@]}" -n "$K8S_NAMESPACE" create secret generic oshal-store \
        --from-literal="OSHAL_STORE_TOKEN=${OSHAL_STORE_TOKEN:-$GITHUB_TOKEN}" \
        --dry-run=client -o yaml | "${KC[@]}" apply -f - >/dev/null
      HELM_SET+=(--set-string "store.tokenSecret=oshal-store")
      note "private-store token wired (Secret oshal-store)"
    fi
  fi
  if [ -n "$ADMIN_EMAIL" ]; then
    HELM_SET+=(
      --set-string "api.extraEnv.MOCK_OIDC_EMAIL=$ADMIN_EMAIL"
      --set-string "api.extraEnv.MOCK_OIDC_NAME=${ADMIN_EMAIL%%@*}"
      --set-string "api.extraEnv.MOCK_OIDC_SUB=$(local_sub "$ADMIN_EMAIL")"
      --set-string "api.extraEnv.OSHAL_OPERATOR_EMAILS=$ADMIN_EMAIL"
    )
  fi
  if [ "$NO_AI" -eq 1 ]; then
    HELM_SET+=(--set-string "swarm.forceLlmProvider=noop" --set-string "swarm.forceLlmModel="
               --set-string "api.extraEnv.OSHAL_NO_AI=true")
  fi

  say "installing chart into namespace $K8S_NAMESPACE (first image pull is a few GB — one-time)"
  helm "${HELM_CTX[@]}" upgrade --install oshal "$CHART_SRC" \
    --namespace "$K8S_NAMESPACE" --create-namespace \
    --wait --timeout 20m "${HELM_SET[@]}" \
    || { echo "helm install failed — the messages above name the broken leg. Nothing to clean up beyond: helm ${HELM_CTX[*]} uninstall oshal -n $K8S_NAMESPACE"; exit 1; }

  # Where the cockpit lives: localhost for the desktop cluster shapes, the first
  # node's InternalIP otherwise (k3s/server installs).
  CTX_NAME="${K8S_CONTEXT:-$(kubectl config current-context 2>/dev/null)}"
  HOSTADDR="localhost"
  case "$CTX_NAME" in
    docker-desktop|kind-*|k3d-*|minikube) HOSTADDR="localhost" ;;
    *) HOSTADDR=$("${KC[@]}" get nodes -o jsonpath='{.items[0].status.addresses[?(@.type=="InternalIP")].address}' 2>/dev/null || true)
       [ -n "$HOSTADDR" ] || HOSTADDR="localhost" ;;
  esac
  BASE="http://$HOSTADDR:$K8S_NODEPORT"

  say "postflight: waiting for the api to answer"
  API_OK=""
  for i in $(seq 1 50); do curl -fsS "$BASE/api/health" >/dev/null 2>&1 && { API_OK=1; break; }; sleep 3; done
  if [ -z "$API_OK" ]; then
    note "WARNING: $BASE/api/health not answering. Pods:"
    "${KC[@]}" -n "$K8S_NAMESPACE" get pods 2>/dev/null || true
    note "A pre-existing kind cluster without a port mapping cannot expose NodePorts to this host —"
    note "durable access: kubectl -n $K8S_NAMESPACE port-forward svc/oshal-api $K8S_NODEPORT:5000"
  else
    BOTS_UP=$(curl -fsS "$BASE/api/agents" 2>/dev/null | grep -o '"agentId"' | wc -l | tr -d ' ')
    note "api healthy — $BASE   (fleet: $FLEET, agents visible: ${BOTS_UP:-?})"
  fi

  WELCOME="$BASE/welcome"; [ "$NO_AI" -eq 1 ] && WELCOME="$BASE/cockpit/"
  say "installed — opening your swarm"
  note "setup:   $WELCOME"
  note "cockpit: $BASE/cockpit/   (after setup)"
  case "$(uname -s 2>/dev/null)" in
    MINGW*|MSYS*|CYGWIN*|Windows*) start "" "$WELCOME" 2>/dev/null || cmd.exe /c start "$WELCOME" 2>/dev/null || true ;;
    Darwin*) open "$WELCOME" 2>/dev/null || true ;;
    *) xdg-open "$WELCOME" 2>/dev/null || true ;;
  esac
  say "what happens next, in the browser"
  if [ -n "$ADMIN_EMAIL" ]; then
    note "You are $ADMIN_EMAIL — your local login AND the swarm superadmin (MOCK_OIDC trusts this"
    note "cluster, and its env says that identity is you)."
  else
    note "You skipped the email prompt, so you are the shared demo identity (alex@demo.local). To"
    note "become yourself later, re-run this installer with --admin-email you@example.com — helm"
    note "upgrades in place and your workspace volume survives."
  fi
  if [ "$NO_AI" -eq 1 ]; then
    note "This cluster was installed --no-ai: AI features stay disabled until a model is connected."
  else
    note "1. Connect an AI model — REQUIRED. The wizard offers the free shared model, an API key,"
    note "   or a hosted login. (k8s has NO vendor-CLI OAuth mounts — the wizard IS the path; API"
    note "   keys for the whole fleet can also live in an oshal-bot-env Secret, see the chart README.)"
    note "2. Connect your accounts (optional) — each one is its own consent."
  fi
  note "More apps any time: cockpit -> Explore Apps, or re-run with --apps name1,name2"
  note "(helm upgrades in place; the chart stages new packages before the api restarts)."
  note "Uninstall: helm ${HELM_CTX[*]:-} uninstall oshal -n $K8S_NAMESPACE && kubectl delete ns $K8S_NAMESPACE"
  exit 0
fi

# ── Mode 3: leaf-node bot ────────────────────────────────────────────────────
if [ "$MODE" = "3" ]; then
  say "Leaf-node bot install (joins an existing swarm)"
  [ -n "$CONTROL_PLANE" ] || { printf '   swarm control-plane URL (e.g. http://192.0.2.10:35457): '; read -r CONTROL_PLANE; }
  [ -n "$JOIN_CODE" ] || { printf '   join code (operator: cockpit -> Add a computer -> join code): '; read -r JOIN_CODE; }
  [ -n "$ENROLL_TOKEN" ] || { printf '   enrollment token (binds this computer to YOUR login; blank = skip): '; read -r ENROLL_TOKEN || true; }
  mkdir -p "$DIR"; cd "$DIR"
  say "fetching the node app source ($REPO_URL)"
  if command -v git >/dev/null 2>&1; then
    [ -d oshal/.git ] || git clone --depth 1 "$REPO_URL" oshal
  else
    curl -fsSL "https://codeload.github.com/emeraldcoastsystemsgroup/oshal/tar.gz/refs/heads/main" | tar -xz
    mv oshal-main oshal 2>/dev/null || true
  fi
  cd oshal
  case "$(uname -s 2>/dev/null)" in
    MINGW*|MSYS*|CYGWIN*|Windows*)
      say "running the Windows node installer"
      powershell -ExecutionPolicy Bypass -File installer/install.ps1 -ControlPlaneUrl "$CONTROL_PLANE" -JoinCode "$JOIN_CODE" ${ENROLL_TOKEN:+-EnrollmentToken "$ENROLL_TOKEN"}
      ;;
    *)
      say "non-Windows leaf node — manual steps:"
      note "cd packages/oshal-chat && npm ci && OSHAL_CONTROL_PLANE_URL='$CONTROL_PLANE' \\"
      note "OSHAL_JOIN_CODE='$JOIN_CODE' ${ENROLL_TOKEN:+OSHAL_ENROLLMENT_TOKEN='$ENROLL_TOKEN' }npm run start"
      ;;
  esac
  exit 0
fi

# ── Modes 1-2: the swarm ─────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || { echo "docker is required (Docker Desktop / Engine 24+)"; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "docker compose v2 is required"; exit 1; }
docker info >/dev/null 2>&1 || { echo "docker daemon not running"; exit 1; }

# ── Preflight: own the credential paths BEFORE docker can (INSTALLER-GAPS G4) ─
# Compose bind-mounts these vendor-CLI homes into every bot. If a path is absent at
# first `up`, Docker auto-creates it as a ROOT-OWNED DIRECTORY — including
# ~/.claude.json, which must be a FILE (a directory there breaks the Claude CLI on
# every later login on this host). Create them as the invoking user, correct shapes.
CLAUDE_DIR="${CLAUDE_CONFIG_HOST_PATH:-$HOME/.claude}"
CODEX_DIR="${CODEX_CONFIG_HOST_PATH:-$HOME/.codex}"
GEMINI_DIR="${GEMINI_CONFIG_HOST_PATH:-$HOME/.gemini}"
CLAUDE_JSON="${CLAUDE_CONFIG_HOST_JSON:-$HOME/.claude.json}"
mkdir -p "$CLAUDE_DIR" "$CODEX_DIR" "$GEMINI_DIR"
[ -e "$CLAUDE_JSON" ] || printf '{}\n' > "$CLAUDE_JSON"
[ -f "$CLAUDE_JSON" ] || { echo "$CLAUDE_JSON exists but is NOT a file (a previous docker up auto-created a directory there) — remove it and re-run"; exit 1; }

IMAGE="$REGISTRY/oshal-bot:$TAG"
mkdir -p "$DIR"

if [ "$MODE" = "2" ]; then
  say "source install: cloning + building (this is the contributor path)"
  command -v git >/dev/null 2>&1 || { echo "git is required for a source install"; exit 1; }
  [ -d "$DIR/src/.git" ] || git clone "$REPO_URL" "$DIR/src"
  ( cd "$DIR/src" && docker build -f Dockerfile.oshal -t oshal-bot:latest . )
  IMAGE="oshal-bot:latest"; REGISTRY_EXPORT=""; TAG="latest"
  COMPOSE_SRC="$DIR/src/docker-compose.oshal-local.yml"
elif [ -n "$FROM_ARCHIVE" ]; then
  [ -f "$FROM_ARCHIVE" ] || { echo "archive not found: $FROM_ARCHIVE"; exit 1; }
  say "loading the offline swarm snapshot (docker load — no network needed)"
  docker load -i "$FROM_ARCHIVE"
  COMPOSE_SRC=""
else
  say "pulling $IMAGE (first pull is a few GB — one-time)"
  if [ -n "${GHCR_TOKEN:-}" ]; then
    printf '%s' "$GHCR_TOKEN" | docker login ghcr.io -u "${GHCR_USER:-emeraldcoastsystemsgroup}" --password-stdin
  fi
  docker pull "$IMAGE"
  COMPOSE_SRC=""
fi

# Extract baked artifacts (registry mode) — compose.dist.yml + non-secret seeds.
COMPOSE_FILE="$DIR/compose.dist.yml"
if [ "$MODE" = "1" ]; then
  CID=$(docker create "$IMAGE")
  trap 'docker rm -f "$CID" >/dev/null 2>&1 || true' EXIT
  docker cp "$CID:/app/compose.dist.yml" "$COMPOSE_FILE"
  [ -d "$DIR/config-seed" ] || docker cp "$CID:/app/config-seed.dist" "$DIR/config-seed"
  # Postflight verify trio (G1). Older images predate these — tolerated here, fetched later.
  for f in oshal-verify.sh swarm-routability-check.sh routability-critical-bots.txt; do
    docker cp "$CID:/app/scripts/$f" "$DIR/$f" >/dev/null 2>&1 || true
  done
  docker rm -f "$CID" >/dev/null 2>&1; trap - EXIT
else
  COMPOSE_FILE="$COMPOSE_SRC"
  [ -d "$DIR/src/config-seed" ] || true
fi

# ── .env: generated once, never overwritten ──────────────────────────────────
rand() { head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
# (local_sub — the stable email-derived identity — is defined above the mode dispatch,
# shared by this .env path and the k8s helm-values path.)

ENV_FILE="$DIR/.env"; [ "$MODE" = "2" ] && ENV_FILE="$DIR/src/.env"
if [ ! -f "$ENV_FILE" ]; then
  say "generating $ENV_FILE (fresh secrets; MOCK_OIDC=true for local login)"
  {
    echo "# Generated by oshal-install.sh $(date -u +%Y-%m-%dT%H:%M:%SZ) — operator-local, never commit."
    echo "OSHAL_REGISTRY=$REGISTRY"
    echo "OSHAL_IMAGE_TAG=$TAG"
    echo "OSHAL_PACKAGE_AUDIT_MODE=$PACKAGE_AUDIT_MODE"
    echo "POSTGRES_PASSWORD=$(rand)"
    echo "SWARM_SERVICE_SECRET=$(rand)"
    echo "SESSION_SECRET=$(rand)"
    echo "REMOTE_CLIENT_SHARED_SECRET=$(rand)"
    echo "MOCK_OIDC=true"
    echo "REJECT_LOOP_TICKETS=true"
    [ -n "${BUNDLE_PROFILES[$BUNDLE]}" ] && echo "COMPOSE_PROFILES=${BUNDLE_PROFILES[$BUNDLE]}"
    echo "#"
    echo "# ── AI ENGINE ──"
    if [ "$NO_AI" -eq 1 ]; then
      echo "# --no-ai was passed: this box DELIBERATELY runs without a connected model."
      echo "# Chat, Jarvis and every AI feature stay disabled until you remove these two lines"
      echo "# and connect a model (cockpit -> /welcome). The onboarding gate and"
      echo "# scripts/oshal-verify.sh honor this declaration instead of failing the box (G2/G3)."
      echo "OSHAL_NO_AI=true"
      echo "FORCE_LLM_PROVIDER=noop"
    else
      echo "# Vendor-CLI logins (~/.claude, ~/.gemini) mount READ-WRITE so the in-container CLI"
      echo "# can refresh its own OAuth token. On a server there is no host-side refresh, and a"
      echo "# CLI that cannot write reports a successful login while saving nothing (G4). On a"
      echo "# dev box with its own host-side refresh you may set these to ro."
      echo "CLAUDE_AUTH_MOUNT_MODE=rw"
      echo "GEMINI_AUTH_MOUNT_MODE=rw"
    fi
    echo "#"
    echo "# ── WHO YOU ARE ──"
    echo "# MOCK_OIDC=true has NO sign-in page: it treats every request as already logged in as"
    echo "# the identity below. Set these to yourself so your accounts, tickets and connector"
    echo "# tokens are keyed to YOU. Changing them later = a different user (a fresh, empty"
    echo "# workspace). For a real IdP instead: set OIDC_ISSUER/OIDC_CLIENT_ID/OIDC_CLIENT_SECRET"
    echo "# and remove MOCK_OIDC, then list your real login email below."
    if [ -n "$ADMIN_EMAIL" ]; then
      echo "MOCK_OIDC_EMAIL=$ADMIN_EMAIL"
      echo "MOCK_OIDC_NAME=${ADMIN_EMAIL%%@*}"
      echo "MOCK_OIDC_SUB=$(local_sub "$ADMIN_EMAIL")"
      echo "# ── SUPERADMIN ── this email is the swarm operator."
      echo "OSHAL_OPERATOR_EMAILS=$ADMIN_EMAIL"
    else
      echo "# You skipped the email prompt, so you are signed in as the shared demo identity"
      echo "# (alex@demo.local). Fill these in and restart the api to become yourself:"
      echo "#   docker compose -f $COMPOSE_FILE restart oshal-api"
      echo "#MOCK_OIDC_EMAIL=you@example.com"
      echo "#MOCK_OIDC_NAME=You"
      echo "#MOCK_OIDC_SUB=local-your-stable-id"
      echo "#OSHAL_OPERATOR_EMAILS=you@example.com"
    fi
    # A kernel install starts ONLY the kernel services, so it must not SEED the app-bot catalog
    # either — otherwise a core+one-app box lists ~50 bot identities it will never run, which is
    # exactly how the first customer deployment ended up looking like a fleet. Installed packages
    # still register their own bots, so an app is never scoped out of its own swarm.
    if [ "$BUNDLE" = "kernel" ]; then
      echo "# ── REGISTRY SCOPE ── kernel bundle: Tier-0 baselines + the kernel manifests' bots only."
      echo "# Set to 'local' for the full lean lineup, or 'full' for the canonical registry."
      echo "SWARM_REGISTRY=kernel"
    fi
  } > "$ENV_FILE"
else
  note ".env already exists — keeping yours"
fi

DC=(docker compose -f "$COMPOSE_FILE" --project-directory "$(dirname "$ENV_FILE")")

# ── Stage store packages BEFORE the api boots (auto-load registers each once) ─
# Dedup lives here: a package already in the volume is SKIPPED, so re-runs and
# overlapping bundle/--apps choices can never register the same bot or surface
# twice — the loader keys on the staged directory, and each stages at most once.
if [ "${#PKG_SET[@]}" -gt 0 ]; then
  say "staging ${#PKG_SET[@]} store package(s): ${!PKG_SET[*]}"
  STORE_TOKEN="${OSHAL_STORE_TOKEN:-${GITHUB_TOKEN:-}}"
  INSTALL_ENV=(-e "OSHAL_PACKAGE_AUDIT_MODE=$PACKAGE_AUDIT_MODE")
  if [ -n "$STORE_TOKEN" ]; then
    export OSHAL_STORE_TOKEN="$STORE_TOKEN"
    INSTALL_ENV+=(-e OSHAL_STORE_TOKEN)
  fi
  for p in "${!PKG_SET[@]}"; do
    if MSYS_NO_PATHCONV=1 docker run --rm -v oshal-local_oshal_workspace:/ws alpine:3 sh -c "[ -d /ws/deployed-apps/$p ]" 2>/dev/null; then
      if [ "$PACKAGE_AUDIT_MODE" = "compatible" ]; then
        note "SKIP $p — already installed (never register a bot/surface twice)"
        continue
      fi
      note "$p is already installed; enforce mode revalidates and replaces it from the audited SHA"
    fi
    MSYS_NO_PATHCONV=1 docker run --rm "${INSTALL_ENV[@]}" \
      -v oshal-local_oshal_workspace:/ws "$IMAGE" \
      node /app/scripts/oshal-app.js install "$p" \
      --repo "$STORE_REPO" \
      --ref main --dest /ws/deployed-apps --audit-mode "$PACKAGE_AUDIT_MODE"
    note "staged $p"
  done
fi

# ── Ordered, batched bring-up ────────────────────────────────────────────────
wait_healthy() { local i; for i in $(seq 1 $(( $2 / 3 ))); do
  [ "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$1" 2>/dev/null)" = healthy ] && return 0; sleep 3; done; return 1; }

say "[1/3] infra (db, redis, chroma)"
"${DC[@]}" up -d oshal-db oshal-redis oshal-chromadb
for c in oshal-local-db oshal-local-redis oshal-local-chromadb; do
  wait_healthy "$c" 180 || { echo "$c never went healthy"; exit 1; }
done

say "[2/3] api — must be FULLY up before bots (auto-loads the staged packages)"
"${DC[@]}" up -d --no-deps oshal-api
wait_healthy oshal-local-api 240 || { echo "api never went healthy"; exit 1; }
for i in $(seq 1 50); do
  docker logs oshal-local-api 2>&1 | grep -q "Swarm app auto-load complete" && break; sleep 3
done

say "[3/3] bots — batched (a mass cold-start OOMs small engines)"
if [ "${BUNDLE_SERVICES[$BUNDLE]}" = "__ALL__" ]; then
  remaining=$("${DC[@]}" config --services 2>/dev/null | grep -vxE 'oshal-db|oshal-redis|oshal-chromadb|oshal-api')
else
  remaining=$(printf '%s\n' "${KERNEL_SERVICES[@]}" ${BUNDLE_SERVICES[$BUNDLE]} | grep -vx 'oshal-api' | sort -u)
fi
BATCH="${OSHAL_UP_BATCH_SIZE:-5}"; SETTLE="${OSHAL_UP_BATCH_SETTLE:-18}"
total=$(echo "$remaining" | grep -c .); started=0; batch=()
for svc in $remaining; do
  batch+=("$svc")
  if [ "${#batch[@]}" -ge "$BATCH" ]; then
    "${DC[@]}" up -d --no-deps "${batch[@]}" >/dev/null
    started=$((started + ${#batch[@]})); note "started ${started}/${total}"
    batch=(); [ "$started" -lt "$total" ] && sleep "$SETTLE"
  fi
done
[ "${#batch[@]}" -gt 0 ] && { "${DC[@]}" up -d --no-deps "${batch[@]}" >/dev/null; started=$((started + ${#batch[@]})); note "started ${started}/${total}"; }

# ── Postflight: verify the box can do what it advertises (INSTALLER-GAPS G1) ─
# Counting containers is not success — the G-Squared box passed every count while
# the engine, voice and a routing-critical bot were dead. A failed leg FAILS the
# install, by name. --pre-onboarding: legs the browser wizard is about to satisfy
# (model, credentials, voice) report PENDING instead of failing a fresh box.
say "postflight verification"
VERIFY=""
if [ "$MODE" = "2" ] && [ -f "$DIR/src/scripts/oshal-verify.sh" ]; then VERIFY="$DIR/src/scripts/oshal-verify.sh"
elif [ -f "$DIR/oshal-verify.sh" ]; then VERIFY="$DIR/oshal-verify.sh"; fi
if [ -z "$VERIFY" ]; then
  note "verify script not in this image — fetching from the repo"
  for f in oshal-verify.sh swarm-routability-check.sh routability-critical-bots.txt; do
    curl -fsSL "https://raw.githubusercontent.com/emeraldcoastsystemsgroup/oshal/main/scripts/$f" -o "$DIR/$f" 2>/dev/null || true
  done
  [ -f "$DIR/oshal-verify.sh" ] && VERIFY="$DIR/oshal-verify.sh"
fi
if [ -n "$VERIFY" ]; then
  VERIFY_ARGS=(--pre-onboarding --env-file "$ENV_FILE")
  [ "$NO_AI" -eq 1 ] && VERIFY_ARGS+=(--no-ai)
  if [ "${#PKG_SET[@]}" -gt 0 ]; then
    VERIFY_APPS=""
    for p in "${!PKG_SET[@]}"; do VERIFY_APPS="${VERIFY_APPS:+$VERIFY_APPS,}$p"; done
    VERIFY_ARGS+=(--apps "$VERIFY_APPS")
  fi
  if ! bash "$VERIFY" "${VERIFY_ARGS[@]}"; then
    say "INSTALL FAILED postflight verification — the leg(s) named above are broken."
    note "Nothing hides behind a green container count. Fix the named leg, then re-check:"
    note "  bash $VERIFY --env-file $ENV_FILE"
    exit 1
  fi
else
  note "WARNING: could not obtain oshal-verify.sh (offline?) — this install is NOT verified."
fi

# ── Show the swarm ───────────────────────────────────────────────────────────
# Open the WIZARD, not the cockpit. Connecting an AI model is mandatory and is a browser OAuth /
# paste-a-key flow, so it cannot happen out here in the shell — the wizard is where linking
# actually lives. (/cockpit would 302 here anyway while onboarding is incomplete; landing on the
# wizard directly is the honest version of the same redirect.) EXCEPT --no-ai: the wizard exists
# to connect a model, which that posture explicitly declines — open the cockpit directly.
WELCOME="http://localhost:35457/welcome"
[ "$NO_AI" -eq 1 ] && WELCOME="http://localhost:35457/cockpit/"
say "installed — opening your swarm"
docker ps --format '{{.Names}}' | grep -c oshal | xargs -I{} echo "   containers up: {}"
note "setup:   $WELCOME"
note "cockpit: http://localhost:35457/cockpit/   (after setup)"
case "$(uname -s 2>/dev/null)" in
  MINGW*|MSYS*|CYGWIN*|Windows*) start "" "$WELCOME" 2>/dev/null || cmd.exe /c start "$WELCOME" 2>/dev/null || true ;;
  Darwin*) open "$WELCOME" 2>/dev/null || true ;;
  *) xdg-open "$WELCOME" 2>/dev/null || true ;;
esac

say "what happens next, in the browser"
if [ -n "$ADMIN_EMAIL" ]; then
  note "You are $ADMIN_EMAIL — your local login AND the swarm superadmin. No sign-in page will"
  note "appear: MOCK_OIDC trusts this machine, and .env says that machine is you."
else
  note "You skipped the email prompt, so you are the shared demo identity (alex@demo.local) and"
  note "NOT the superadmin. To become yourself, set MOCK_OIDC_EMAIL / MOCK_OIDC_NAME /"
  note "MOCK_OIDC_SUB / OSHAL_OPERATOR_EMAILS in $ENV_FILE, then:"
  note "  docker compose -f $COMPOSE_FILE restart oshal-api"
fi
if [ "$NO_AI" -eq 1 ]; then
  note "This box was installed --no-ai: AI features stay disabled until a model is connected."
  note "To enable later: remove OSHAL_NO_AI + FORCE_LLM_PROVIDER=noop from $ENV_FILE, restart"
  note "the api, then finish /welcome."
else
  note "1. Connect an AI model — REQUIRED, and the wizard will not let you past it. Free shared"
  note "   model is one click; an API key or a Claude/Codex login also work."
  note "2. Connect your accounts (optional) — Gmail, social, storage. Each one is its own consent."
  note "Already logged into a vendor CLI on this machine? ~/.claude, ~/.codex and ~/.gemini mount"
  note "into the bots read-write (so the in-container CLI can refresh its token — see .env to"
  note "change), and that login is reused as-is (BYOK). NEVER copy a credential file between"
  note "machines — one OAuth grant serves one machine; log in on this box instead (INSTALL.md)."
fi
note "Re-check the box any time: bash $DIR/oshal-verify.sh   (or GET /api/readiness)"
note "Add more apps any time: cockpit -> Explore Apps, or re-run with --apps name1,name2"
