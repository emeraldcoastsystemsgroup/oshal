#!/bin/bash
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block

# OSHAL Harbor release helper - build a tagged image, push it to Harbor, render
# a deploy manifest pinned to that tag, then apply it to the workload cluster.
#
# Why tags:
#   - the workload cluster typically uses imagePullPolicy: IfNotPresent in most bot pods
#   - a new immutable tag changes the deployment spec, so Kubernetes pulls it
#     without relying on :latest cache behavior
#
# Windows note:
#   - Some checked-in scripts/migrations in this workspace can carry placeholder
#     or reparse attributes that Docker BuildKit rejects during context sync.
#   - To make the Gardener release path deterministic, this script stages a
#     clean build context under .codex-tmp/oshal-build-context/ before build.
#
# Pre-req:
#   - Docker Desktop running
#   - network access to $REGISTRY and the workload cluster API
#   - Harbor robot account password exported as HARBOR_PASSWORD
#     (set HARBOR_USER + HARBOR_PASSWORD for your registry robot account)
#
# Usage:
#   _PASSWORD='<pw>' bash scripts/oshal-harbor-build-push.sh
#   HARBOR_PASSWORD='<pw>' bash scripts/oshal-harbor-build-push.sh --tag 20260413-a825fde
#   bash scripts/oshal-harbor-build-push.sh --tag 20260413-a825fde --render-only
#   HARBOR_PASSWORD='<pw>' bash scripts/oshal-harbor-build-push.sh --tag 20260413-a825fde --skip-build

set -euo pipefail

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'
ok()   { echo -e "${GREEN}[OK ]${NC} $*"; }
warn() { echo -e "${YELLOW}[!! ]${NC} $*"; }
fail() { echo -e "${RED}[ERR]${NC} $*"; exit 1; }

REGISTRY="${REGISTRY:?set REGISTRY, e.g. registry.example.com}"
IMAGE_REPO="${IMAGE_REPO:-$REGISTRY/oshal/oshal-bot}"
HARBOR_USER="${HARBOR_USER:?set HARBOR_USER}"
WORKLOAD_CONTEXT="${WORKLOAD_CONTEXT:?set WORKLOAD_CONTEXT}"
WORKLOAD_NAMESPACE="${WORKLOAD_NAMESPACE:-oshal}"
SOURCE_MANIFEST="${SOURCE_MANIFEST:-ops/deployment/kubernetes/oshal-namespace.yaml}"
OUTPUT_DIR="${OUTPUT_DIR:-output/k8/oshal}"
DOCKERFILE_PATH="${DOCKERFILE_PATH:-Dockerfile.oshal}"
BUILD_CONTEXT_DIR="${BUILD_CONTEXT_DIR:-.codex-tmp/oshal-build-context}"
SKIP_BUILD=0
SKIP_PUSH=0
SKIP_APPLY=0
RENDER_ONLY=0
ALSO_TAG_LATEST=0
IMAGE_TAG="${IMAGE_TAG:-}"
CLEAN_DOCKERFILE_PATH=""

usage() {
    cat <<EOF
Usage:
  HARBOR_PASSWORD='<pw>' bash scripts/oshal-harbor-build-push.sh [options]

Options:
  --tag <tag>         Use an explicit Docker image tag.
  --skip-build        Reuse an existing local image for the selected tag.
  --skip-push         Skip Harbor login/push. Useful with --render-only.
  --skip-apply        Render the deploy manifest but do not kubectl apply it.
  --skip-rollout      Alias for --skip-apply.
  --render-only       Only render the pinned manifest under output/k8/oshal/.
  --also-tag-latest   Push the same build as :latest in addition to the release tag.
  DOCKERFILE_PATH     Optional env override for the image build file.
  -h, --help          Show this help text.

Defaults:
  tag: YYYYMMDD-HHMMSS-<gitsha>[-dirty]
  workload context: ${WORKLOAD_CONTEXT}
  workload namespace: ${WORKLOAD_NAMESPACE}
  build context: ${BUILD_CONTEXT_DIR}
EOF
}

default_image_tag() {
    local timestamp git_sha dirty_suffix
    timestamp="$(date +%Y%m%d-%H%M%S)"
    git_sha="manual"
    dirty_suffix=""

    if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        git_sha="$(git rev-parse --short HEAD 2>/dev/null || echo manual)"
        if ! git diff --quiet --ignore-submodules HEAD -- 2>/dev/null; then
            dirty_suffix="-dirty"
        fi
    fi

    echo "${timestamp}-${git_sha}${dirty_suffix}"
}

validate_tag() {
    [[ "$1" =~ ^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$ ]] \
        || fail "invalid image tag '$1' - use Docker-safe characters only"
}

prepare_build_context() {
    local dockerfile_name
    dockerfile_name="$(basename "$DOCKERFILE_PATH")"

    [ -f "$DOCKERFILE_PATH" ] || fail "dockerfile missing: $DOCKERFILE_PATH"

    rm -rf "$BUILD_CONTEXT_DIR"
    mkdir -p \
        "$BUILD_CONTEXT_DIR/scripts/migrations" \
        "$BUILD_CONTEXT_DIR/ai-lab" \
        "$BUILD_CONTEXT_DIR/any-bot" \
        || fail "failed to create build context dirs under $BUILD_CONTEXT_DIR"

    cp "$DOCKERFILE_PATH" "$BUILD_CONTEXT_DIR/$dockerfile_name" \
        || fail "failed to stage dockerfile into build context"
    cp package.json package-lock.json vite.config.js vite.config.ts tsconfig.server.json "$BUILD_CONTEXT_DIR/" \
        || fail "failed to stage package manifests and build config"
    [ -f .npmrc ] && cp .npmrc "$BUILD_CONTEXT_DIR/" || true

    cp -R src "$BUILD_CONTEXT_DIR/" \
        || fail "failed to stage src/ into build context"
    cp -R ai-lab/bot-personas "$BUILD_CONTEXT_DIR/ai-lab/" \
        || fail "failed to stage ai-lab/bot-personas into build context"
    cp -R any-bot/ui-cockpit "$BUILD_CONTEXT_DIR/any-bot/" \
        || fail "failed to stage any-bot/ui-cockpit into build context"

    cp scripts/container-start.sh scripts/bot-entrypoint.sh scripts/setup-cline-auth.sh scripts/swarm-bot-lifecycle.sh "$BUILD_CONTEXT_DIR/scripts/" \
        || fail "failed to stage runtime shell scripts into build context"
    cp scripts/migrations/*.sql "$BUILD_CONTEXT_DIR/scripts/migrations/" \
        || fail "failed to stage SQL migrations into build context"

    CLEAN_DOCKERFILE_PATH="$BUILD_CONTEXT_DIR/$dockerfile_name"
    ok "prepared clean build context at $BUILD_CONTEXT_DIR"
}

for ((i=1; i<=$#; i++)); do
    arg="${!i}"
    case "$arg" in
        --tag)
            i=$((i + 1))
            [ "$i" -le "$#" ] || fail "--tag requires a value"
            IMAGE_TAG="${!i}"
            ;;
        --skip-build)   SKIP_BUILD=1 ;;
        --skip-push)    SKIP_PUSH=1 ;;
        --skip-apply|--skip-rollout) SKIP_APPLY=1 ;;
        --render-only)
            RENDER_ONLY=1
            SKIP_BUILD=1
            SKIP_PUSH=1
            SKIP_APPLY=1
            ;;
        --also-tag-latest) ALSO_TAG_LATEST=1 ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            fail "unknown argument: $arg"
            ;;
    esac
done

cd "$(dirname "$0")/.." || fail "cannot cd to oshal root"

IMAGE_TAG="${IMAGE_TAG:-$(default_image_tag)}"
validate_tag "$IMAGE_TAG"

IMAGE="${IMAGE_REPO}:${IMAGE_TAG}"
LATEST_IMAGE="${IMAGE_REPO}:latest"
RENDERED_MANIFEST="${OUTPUT_DIR}/oshal-deploy-${IMAGE_TAG}.yaml"

render_manifest() {
    local baseline_count rendered_count

    [ -f "$SOURCE_MANIFEST" ] || fail "source manifest missing: $SOURCE_MANIFEST"
    mkdir -p "$OUTPUT_DIR" || fail "cannot create output dir: $OUTPUT_DIR"

    baseline_count="$(grep -F -c "${IMAGE_REPO}:latest" "$SOURCE_MANIFEST" || true)"
    [ "$baseline_count" -gt 0 ] || fail "baseline manifest no longer contains ${IMAGE_REPO}:latest markers"

    sed "s|${IMAGE_REPO}:latest|${IMAGE}|g" "$SOURCE_MANIFEST" > "$RENDERED_MANIFEST" \
        || fail "failed to render tagged manifest"

    rendered_count="$(grep -F -c "${IMAGE}" "$RENDERED_MANIFEST" || true)"
    [ "$rendered_count" -gt 0 ] || fail "rendered manifest does not contain ${IMAGE}"

    ok "rendered $RENDERED_MANIFEST"
}

if [ $SKIP_BUILD -eq 0 ] || [ $SKIP_PUSH -eq 0 ]; then
    docker info >/dev/null 2>&1 \
        && ok "docker daemon responsive" \
        || fail "docker daemon not running"
fi

if [ $SKIP_PUSH -eq 0 ]; then
    echo "=== checking harbor reach ==="
    curl -sI --max-time 10 "https://$REGISTRY/" >/dev/null 2>&1 \
        && ok "harbor reachable" \
        || fail "harbor unreachable - connect VPN first"

    [ -z "${HARBOR_PASSWORD:-}" ] && fail "set HARBOR_PASSWORD env var before pushing"

    echo
    echo "=== harbor login as $HARBOR_USER ==="
    echo "$HARBOR_PASSWORD" | docker login "$REGISTRY" -u "$HARBOR_USER" --password-stdin \
        && ok "logged in" \
        || fail "docker login failed - check HARBOR_USER / HARBOR_PASSWORD"
fi

if [ $SKIP_BUILD -eq 0 ]; then
    echo
    echo "=== preparing clean build context ==="
    prepare_build_context

    echo
    echo "=== building $IMAGE from $CLEAN_DOCKERFILE_PATH ==="
    docker build --no-cache -f "$CLEAN_DOCKERFILE_PATH" -t "$IMAGE" "$BUILD_CONTEXT_DIR" \
        && ok "build complete" \
        || fail "docker build failed"
else
    warn "skipping build (--skip-build)"
fi

if [ $ALSO_TAG_LATEST -eq 1 ]; then
    echo
    echo "=== tagging latest alias ==="
    docker tag "$IMAGE" "$LATEST_IMAGE" \
        && ok "tagged $LATEST_IMAGE" \
        || fail "failed to tag latest alias"
fi

if [ $SKIP_PUSH -eq 0 ]; then
    echo
    echo "=== pushing $IMAGE ==="
    docker push "$IMAGE" \
        && ok "push complete" \
        || fail "docker push failed"

    if [ $ALSO_TAG_LATEST -eq 1 ]; then
        echo
        echo "=== pushing $LATEST_IMAGE ==="
        docker push "$LATEST_IMAGE" \
            && ok "latest alias push complete" \
            || fail "docker push for latest alias failed"
    fi
else
    warn "skipping push (--skip-push)"
fi

echo
echo "=== rendering pinned deploy manifest ==="
render_manifest

if [ $SKIP_APPLY -eq 0 ]; then
    echo
    echo "=== applying $RENDERED_MANIFEST to ${WORKLOAD_CONTEXT}/${WORKLOAD_NAMESPACE} ==="
    kubectl --context "$WORKLOAD_CONTEXT" apply -f "$RENDERED_MANIFEST" \
        && ok "manifest applied" \
        || fail "kubectl apply failed"

    DEPLOYS="$(kubectl --context "$WORKLOAD_CONTEXT" -n "$WORKLOAD_NAMESPACE" get deploy -o name 2>/dev/null || true)"
    if [ -z "$DEPLOYS" ]; then
        warn "no deployments found in ${WORKLOAD_NAMESPACE} after apply"
    else
        echo
        echo "=== waiting for rollouts ==="
        echo "$DEPLOYS" | while read -r deploy_name; do
            kubectl --context "$WORKLOAD_CONTEXT" -n "$WORKLOAD_NAMESPACE" rollout status "$deploy_name" --timeout=180s
        done
    fi

    echo
    echo "=== final pod state ==="
    kubectl --context "$WORKLOAD_CONTEXT" -n "$WORKLOAD_NAMESPACE" get pods 2>&1 | head -20
else
    warn "skipping apply (--skip-apply); manifest is ready at $RENDERED_MANIFEST"
fi

echo
ok "oshal release prepared for image $IMAGE"
if [ $SKIP_BUILD -eq 0 ]; then
    echo "Build context: $BUILD_CONTEXT_DIR"
fi
