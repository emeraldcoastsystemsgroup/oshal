#!/usr/bin/env bash
# =============================================================================
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — the codebase-free installer: Docker + registry reachability are the ONLY prerequisites. Pulls the OSHAL image, extracts the baked compose.dist.yml + non-secret config seeds, generates operator-local .env secrets, then brings the swarm up ORDERED AND BATCHED (infra healthy -> api fully up -> bots 5-at-a-time). The batching is load-bearing: a mass cold-start of every bot OOM-crashes small Docker engines (~6 GB, proven twice 2026-07-23); this script embeds the bring-up rather than assuming any repo script exists on the host.
# 2 | maintainer@emeraldcoastsystemsgroup.com   | v2 — the ONE-CLICK installer. Four modes: (1) swarm from registry, no source; (2) swarm from source (clone + build); (3) leaf-node bot joining an existing swarm; (4) k8s pointer (deploy/terraform). Bundles install the KERNEL plus curated app sets with dependencies BOUND (little-monsters pulls the office tools + deck-builder bot; gaming = dnd + game-show; jobs = career-hunter + job-apply), --apps adds individual store packages, and the resolved set is DEDUPED — a package stages once and a bot/surface registers once no matter how many bundles/flags name it (idempotent re-runs skip already-staged packages). Ends with the cockpit opening, superadmin instructions, and the operator email wired into .env when provided.
# 3 | maintainer@emeraldcoastsystemsgroup.com   | First-run fix (lockstep with oshal-install.ps1) — the closing instructions were false and the identity was never the user's. MOCK_OIDC has NO sign-in page; it fabricates alex@demo.local / mock-user-001 and treats every request as authenticated, so "sign in at the cockpit with your email" could never happen: the user was silently someone else, not the superadmin, with every connector token binding to the shared demo sub. The email prompt now writes MOCK_OIDC_EMAIL/NAME/SUB alongside OSHAL_OPERATOR_EMAILS, the sub being a stable sha256-of-lowercased-email (local_sub(), byte-identical to the ps1's LocalSub) so a reinstall against the same workspace volume keeps its sub-keyed data. Also opens /welcome instead of /cockpit/ — linking an AI model is mandatory and browser-only, and /cockpit just 302s to the wizard anyway — and says plainly what the wizard will ask for.
# =============================================================================
#
# One-click:
#   curl -fsSLO https://raw.githubusercontent.com/emeraldcoastsystemsgroup/oshal/main/scripts/oshal-install.sh
#   bash oshal-install.sh
#
# Flags (no flags = interactive):
#   --mode 1|2|3|4      1 swarm from registry (default) · 2 swarm from source ·
#                       3 leaf-node bot (join an existing swarm) · 4 kubernetes (pointer)
#   --bundle NAME       kernel | full | little-monsters | gaming | jobs   (default: full)
#   --apps a,b,c        individual store packages to add (deduped against the bundle)
#   --dir DIR           install directory (default ./oshal)
#   --tag TAG           image tag (default latest)      --registry REG   (default ghcr.io/emeraldcoastsystemsgroup)
#   --admin-email E     wire E as the swarm operator/superadmin in .env
#   --control-plane URL --join-code CODE [--enrollment-token T]   (mode 3)
#   --dry-run           print the plan, touch nothing
#
# Hosting environments: DOCKER (modes 1-2, automated here) and KUBERNETES
# (mode 4 — deploy/terraform in the source repo drives kind/k8s with the same
# GHCR images; see deploy/terraform/README.md).

set -euo pipefail

MODE=""; BUNDLE="full"; APPS=""; DIR="./oshal"; TAG="latest"
REGISTRY="ghcr.io/emeraldcoastsystemsgroup"; ADMIN_EMAIL=""; DRY=0; FROM_ARCHIVE=""
CONTROL_PLANE=""; JOIN_CODE=""; ENROLL_TOKEN=""
REPO_URL="https://github.com/emeraldcoastsystemsgroup/oshal"
STORE_TARBALL="https://codeload.github.com/emeraldcoastsystemsgroup/oshal-apps/tar.gz/refs/heads/main"

while [ $# -gt 0 ]; do case "$1" in
  --mode) MODE="$2"; shift 2 ;;
  --bundle) BUNDLE="$2"; shift 2 ;;
  --apps) APPS="$2"; shift 2 ;;
  --dir) DIR="$2"; shift 2 ;;
  --tag) TAG="$2"; shift 2 ;;
  --registry) REGISTRY="$2"; shift 2 ;;
  --admin-email) ADMIN_EMAIL="$2"; shift 2 ;;
  --control-plane) CONTROL_PLANE="$2"; shift 2 ;;
  --join-code) JOIN_CODE="$2"; shift 2 ;;
  --enrollment-token) ENROLL_TOKEN="$2"; shift 2 ;;
  --from-archive) FROM_ARCHIVE="$2"; shift 2 ;;
  --dry-run) DRY=1; shift ;;
  *) echo "unknown flag: $1" >&2; exit 2 ;;
esac; done

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
    echo "   4) Kubernetes hosting (Terraform path — prints instructions)"
    printf '   choose [1]: '; read -r MODE; MODE="${MODE:-1}"
    if [ "$MODE" = "1" ] || [ "$MODE" = "2" ]; then
      printf '   bundle (kernel/full/little-monsters/gaming/jobs) [%s]: ' "$BUNDLE"; read -r b; BUNDLE="${b:-$BUNDLE}"
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
PLAN="mode=$MODE bundle=$BUNDLE packages=[${pkg_list:-none}] dir=$DIR tag=$TAG"
if [ "$DRY" -eq 1 ]; then say "DRY RUN — $PLAN"; exit 0; fi

# ── Mode 4: Kubernetes pointer ───────────────────────────────────────────────
if [ "$MODE" = "4" ]; then
  say "Kubernetes hosting"
  note "The k8s path is Terraform-driven from the source repo (same GHCR images):"
  note "  git clone $REPO_URL && cd oshal/deploy/terraform"
  note "  # read README.md — envs/local-kind.tfvars is the local-cluster starter"
  note "  terraform init && terraform apply -var-file=envs/local-kind.tfvars"
  note "NEVER run a kind cluster and the docker-compose swarm on the same machine."
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
  docker rm -f "$CID" >/dev/null 2>&1; trap - EXIT
else
  COMPOSE_FILE="$COMPOSE_SRC"
  [ -d "$DIR/src/config-seed" ] || true
fi

# ── .env: generated once, never overwritten ──────────────────────────────────
rand() { head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }

# Stable local identity derived from the email, so a reinstall against the same workspace volume
# keeps the same user sub (connector tokens and tickets are sub-keyed — a fresh random sub would
# orphan them). Must stay byte-identical to LocalSub() in oshal-install.ps1: sha256 of the
# lowercased email, first 16 hex chars.
local_sub() {
  _lsl=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
  _lsh=$(printf '%s' "$_lsl" | { sha256sum 2>/dev/null || shasum -a 256 2>/dev/null; } | awk '{print $1}')
  printf 'local-%s' "$(printf '%s' "$_lsh" | cut -c1-16)"
}

ENV_FILE="$DIR/.env"; [ "$MODE" = "2" ] && ENV_FILE="$DIR/src/.env"
if [ ! -f "$ENV_FILE" ]; then
  say "generating $ENV_FILE (fresh secrets; MOCK_OIDC=true for local login)"
  {
    echo "# Generated by oshal-install.sh $(date -u +%Y-%m-%dT%H:%M:%SZ) — operator-local, never commit."
    echo "OSHAL_REGISTRY=$REGISTRY"
    echo "OSHAL_IMAGE_TAG=$TAG"
    echo "POSTGRES_PASSWORD=$(rand)"
    echo "SWARM_SERVICE_SECRET=$(rand)"
    echo "SESSION_SECRET=$(rand)"
    echo "REMOTE_CLIENT_SHARED_SECRET=$(rand)"
    echo "MOCK_OIDC=true"
    echo "REJECT_LOOP_TICKETS=true"
    [ -n "${BUNDLE_PROFILES[$BUNDLE]}" ] && echo "COMPOSE_PROFILES=${BUNDLE_PROFILES[$BUNDLE]}"
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
  STORE_TMP=$(mktemp -d)
  curl -fsSL ${GITHUB_TOKEN:+-H "Authorization: token $GITHUB_TOKEN"} "$STORE_TARBALL" | tar -xz -C "$STORE_TMP"
  STORE_DIR=$(find "$STORE_TMP" -maxdepth 1 -type d -name "oshal-apps-*" | head -1)
  for p in "${!PKG_SET[@]}"; do
    if [ ! -d "$STORE_DIR/$p" ]; then note "SKIP $p — not in the public store"; continue; fi
    if MSYS_NO_PATHCONV=1 docker run --rm -v oshal-local_oshal_workspace:/ws alpine:3 sh -c "[ -d /ws/deployed-apps/$p ]" 2>/dev/null; then
      note "SKIP $p — already installed (never register a bot/surface twice)"
      continue
    fi
    MSYS_NO_PATHCONV=1 docker run --rm -v oshal-local_oshal_workspace:/ws -v "$STORE_DIR/$p":/src:ro alpine:3 \
      sh -c "mkdir -p /ws/deployed-apps && cp -r /src /ws/deployed-apps/$p"
    note "staged $p"
  done
  rm -rf "$STORE_TMP"
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

# ── Show the swarm ───────────────────────────────────────────────────────────
# Open the WIZARD, not the cockpit. Connecting an AI model is mandatory and is a browser OAuth /
# paste-a-key flow, so it cannot happen out here in the shell — the wizard is where linking
# actually lives. (/cockpit would 302 here anyway while onboarding is incomplete; landing on the
# wizard directly is the honest version of the same redirect.)
WELCOME="http://localhost:35457/welcome"
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
note "1. Connect an AI model — REQUIRED, and the wizard will not let you past it. Free shared"
note "   model is one click; an API key or a Claude/Codex login also work."
note "2. Connect your accounts (optional) — Gmail, social, storage. Each one is its own consent."
note "Already logged into a vendor CLI on this machine? ~/.claude, ~/.codex and ~/.gemini mount"
note "read-only into the bots, so that login is reused as-is (BYOK). See INSTALL.md."
note "Add more apps any time: cockpit -> Explore Apps, or re-run with --apps name1,name2"
