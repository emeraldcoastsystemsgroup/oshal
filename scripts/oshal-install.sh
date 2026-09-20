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
# 9 | maintainer@emeraldcoastsystemsgroup.com   | Lockstep with the ps1: --allow-stale-image plus the post-pull freshness gate, and the Windows WSL2 guidance on both docker preflight failures. Git Bash on Windows hits the same dead end as the ps1 path - 'docker daemon not running' with no hint that WSL2 is the engine that is missing. The sh path only ADVISES (it cannot elevate); the ps1 can actually enable it.
# 10 | maintainer@emeraldcoastsystemsgroup.com  | The install ends with a USER who owns the swarm, not an allowlist entry. --auth-mode (basic|mock, default basic) picks the sign-in stack. basic writes LOCAL_AUTH=true/MOCK_OIDC=false, creates the administrator through the ADR-117 bootstrap (one-use proof from scripts/oshal-setup-root.mjs, swarm root claimed per ADR-148) with a random password nobody sees, then opens scripts/oshal-admin-link.mjs's one-time set-password link instead of /welcome: choosing the password signs that browser in and continues to the wizard, so the operator arrives authenticated and there is no generated credential to print and lose (the first cut printed one, and a hung closing step lost it). OSHAL_ADMIN_PASSWORD remains for headless automation. mock keeps the no-login demo posture but still claims root. Both write OSHAL_INSTALL_OWNER_SUB — the sha256-of-lowercased-email the local-auth store derives — so packages staged before any login belong to the operator. Unattended runs without --admin-email get admin@localhost. The Windows browser-open no longer hangs (cmd `start` read a lone quoted URL as a window title), and closing output gives the reissue command.
# 11 | maintainer@emeraldcoastsystemsgroup.com  | The operator's first cockpit shows their applications. UI_PROFILE is written as oshal-framework (OSHAL_UI_PROFILE overrides): compose defaults to the 7-item starter cockpit, whose rail lists no installed application at all. Paired with the loader granting the install owner an explicit admin tier on each application it adopts — without one, the rail hid all 58 ADR-149 protected applications from the person who installed them.
# 12 | maintainer@emeraldcoastsystemsgroup.com  | The store-source check fails OPEN and no longer breaks the offline install. store_is_public treated every non-200 as private, so a box with no curl, no network, a proxy, or a transient GitHub blip was told to supply a read token for the PUBLIC default store; only 401/403/404 now asks, and anything else proceeds. --from-archive skips the probe entirely - it is the documented zero-network path, it resolves to MODE=1, and this function runs before the mode dispatch, so the offline install was exiting 2 on a box that was working correctly. And the advertised "Enter to skip" no longer kills the run: under set -euo pipefail the skip path ended on a [ -n ] test returning 1, which terminated the installer with no message.
# 13 | maintainer@emeraldcoastsystemsgroup.com  | Two review findings. valid_email constrained only the LOCAL part, so `me@example.com&whoami` passed; harmless in this script, which hands argv to docker exec, but oshal-install.ps1 interpolates the same value into a `cmd /c` string and lockstep is why both validators exist. The character is rejected anywhere now, and a second @ with it. And the one-time set-password link - swarm root for an hour - is no longer printed when stdout is not a terminal, because an unattended run is one whose output something is capturing. The reissue command is how it is obtained deliberately.
# 14 | maintainer@emeraldcoastsystemsgroup.com  | --from-archive uses the image the archive ACTUALLY contains. IMAGE was still the registry default when that branch ran, so an archive built with any other tag loaded fine and then every later step pointed at something that was never pulled: docker create to extract compose.dist.yml, and OSHAL_BOT_IMAGE in the generated .env. Offline there is no pull to paper over it. The tag is read from docker load output, preferring the oshal-bot image when an archive carries several, and an untagged load says so instead of proceeding silently.
# 15 | maintainer@emeraldcoastsystemsgroup.com  | A re-run reuses the administrator email the existing .env already names. oshal-install.ps1 gates its whole env-generation block on the file being absent, so it never re-asks; this script asked unconditionally, which is not the lockstep both Change Logs claim - and it is a question whose answer is already written down. --admin-email still wins, and an unattended run is unchanged.
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
ALLOW_STALE_IMAGE=0
SELF_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd)"
K8S_NAMESPACE="oshal"; K8S_CONTEXT=""; K8S_NODEPORT="30500"; K8S_CHART=""; BUNDLE_EXPLICIT=0
REPO_URL="https://github.com/emeraldcoastsystemsgroup/oshal"
COCKPIT_PORT="${OSHAL_API_PORT:-35457}"
AUTH_MODE="${OSHAL_AUTH_MODE:-basic}"     # basic = real login (ADR-117); mock = trust every caller
ADMIN_PASSWORD="${OSHAL_ADMIN_PASSWORD:-}"
DEFAULT_ADMIN_EMAIL="admin@localhost"
STORE_REPO_DEFAULT="https://github.com/emeraldcoastsystemsgroup/oshal-apps"
STORE_REPO="${OSHAL_STORE_REPO:-$STORE_REPO_DEFAULT}"
STORE_REPO_NAMED=0; [ -n "${OSHAL_STORE_REPO:-}" ] && STORE_REPO_NAMED=1

while [ $# -gt 0 ]; do case "$1" in
  --mode) MODE="$2"; shift 2 ;;
  --bundle) BUNDLE="$2"; BUNDLE_EXPLICIT=1; shift 2 ;;
  --apps) APPS="$2"; shift 2 ;;
  --audit-mode) PACKAGE_AUDIT_MODE="$2"; shift 2 ;;
  --dir) DIR="$2"; shift 2 ;;
  --tag) TAG="$2"; shift 2 ;;
  --registry) REGISTRY="$2"; shift 2 ;;
  --admin-email) ADMIN_EMAIL="$2"; shift 2 ;;
  --store-repo) STORE_REPO="$2"; STORE_REPO_NAMED=1; shift 2 ;;
  --auth-mode) AUTH_MODE="$2"; shift 2 ;;
  --control-plane) CONTROL_PLANE="$2"; shift 2 ;;
  --join-code) JOIN_CODE="$2"; shift 2 ;;
  --enrollment-token) ENROLL_TOKEN="$2"; shift 2 ;;
  --namespace) K8S_NAMESPACE="$2"; shift 2 ;;
  --k8s-context) K8S_CONTEXT="$2"; shift 2 ;;
  --nodeport) K8S_NODEPORT="$2"; shift 2 ;;
  --chart) K8S_CHART="$2"; shift 2 ;;
  --from-archive) FROM_ARCHIVE="$2"; shift 2 ;;
  --allow-stale-image) ALLOW_STALE_IMAGE=1; shift ;;
  --no-ai) NO_AI=1; shift ;;
  --yes|-y) ASSUME_YES=1; shift ;;
  --dry-run) DRY=1; shift ;;
  *) echo "unknown flag: $1" >&2; exit 2 ;;
esac; done

case "$PACKAGE_AUDIT_MODE" in compatible|enforce) ;; *) echo "--audit-mode must be compatible or enforce" >&2; exit 2 ;; esac
case "$AUTH_MODE" in basic|mock) ;; *) echo "--auth-mode must be basic or mock" >&2; exit 2 ;; esac

say()  { printf '\n== %s\n' "$*"; }
note() { printf '   %s\n' "$*"; }

# -- Windows: WSL2 is Docker Desktop's engine, and nothing here used to check it -----
# `winget install Docker.DockerDesktop` succeeds on a box whose WSL2 features are off;
# Docker Desktop then never starts and this installer reported only "daemon not running",
# which sends the operator looking at Docker rather than at Windows. Exit codes only --
# wsl.exe writes UTF-16LE and parsing its text is how that check breaks silently.
wsl_ready() { command -v wsl.exe >/dev/null 2>&1 && wsl.exe --status >/dev/null 2>&1; }
is_windows_host() { case "$(uname -s 2>/dev/null)" in MINGW*|MSYS*|CYGWIN*|Windows*) return 0 ;; *) return 1 ;; esac; }
wsl_guidance() {
  is_windows_host || return 0
  wsl_ready && return 0
  note ""
  note "WSL2 does not look enabled on this machine, and Docker Desktop runs ON WSL2."
  note "That is almost certainly why the engine is not up. In an ADMINISTRATOR PowerShell:"
  note "    wsl --install --no-distribution"
  note "    # then REBOOT, start Docker Desktop once, and re-run this installer"
  note "This enables the Virtual Machine Platform and WSL features and installs the kernel."
}

# -- The published image can be far behind this repository --------------------------
# Publishing to GHCR happens only in the manual-only CI workflow, so `latest` can and does
# go stale. A stale image does not look stale: features added since the build are simply
# ABSENT, which reads as a broken install rather than an old one. Refuses past the
# threshold unless --allow-stale-image. Fails OPEN whenever it cannot check.
check_image_freshness() {
  img="$1"; rc=0
  created="$(docker image inspect -f '{{.Created}}' "$img" 2>/dev/null || true)"
  sha="$(docker image inspect -f '{{index .Config.Labels "oshal.git.commit"}}' "$img" 2>/dev/null || true)"
  [ "$sha" = "<no value>" ] && sha=""
  [ -n "$created" ] || { note "image freshness: no build date on the image - skipping the check"; return 0; }
  if command -v node >/dev/null 2>&1 && [ -f "$SELF_DIR/image-freshness.js" ]; then
    node "$SELF_DIR/image-freshness.js" --image-created "$created" --image-commit "$sha" || rc=$?
  else
    docker run --rm --entrypoint node "$img" /app/scripts/image-freshness.js \
      --image-created "$created" --image-commit "$sha" || rc=$?
  fi
  if [ "$rc" = "3" ] && [ "$ALLOW_STALE_IMAGE" -ne 1 ]; then
    echo "refusing to install a stale image - see above (or pass --allow-stale-image)" >&2
    exit 1
  fi
  return 0
}

# ── Bundles: kernel + curated sets with dependencies BOUND ───────────────────
# A bundle names (a) store packages and (b) the bot-node services those packages
# need beyond the kernel. Dependencies ride along explicitly — little-monsters
# includes the office/presentations surface AND the deck-builder bot because its
# lessons render decks. The resolved package set is deduplicated, so overlapping
# bundles/--apps never stage a package or register a bot/surface twice.
# security-analyst and workflow-assistant are KERNEL bots (KERNEL_BOT_AGENT_IDS) and now carry
# requiresOwnNode, so a kernel install that does not START them leaves the Security Center
# assessment and Workflow Studio talk-to-build resolving to a container that never came up.
KERNEL_SERVICES=(oshal-api general-bot jarvis-bot oshal-developer security-analyst workflow-assistant)
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
      # lands here is who the swarm thinks you are. require_admin_email below enforces it.
      printf '   portal administrator email — your local login AND the superadmin: '; read -r ADMIN_EMAIL || true
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

# ── The portal administrator is REQUIRED, not optional ───────────────────────
# MOCK_OIDC has no sign-in page: whatever lands here IS the identity the swarm
# serves every request as. Left blank, the swarm silently runs as the fabricated
# demo user, the operator who installed it is NOT its superadmin, and connector
# tokens bind to a shared demo sub. So: prompt until it is answered, and on a
# non-interactive host REFUSE rather than install a swarm nobody owns.
valid_email() {
  # The DOMAIN is constrained as well as the local part. It was not, so an address like
  # `me@example.com&whoami` passed. Harmless here - this script hands argv to docker exec and
  # never builds a shell string - but oshal-install.ps1 interpolates the same value into a
  # `cmd /c "..."`, and lockstep is the whole reason these two validators exist. Reject the
  # character anywhere rather than relying on every consumer to quote it correctly.
  case "$1" in
    *[!a-zA-Z0-9._%+@-]* | @* | *@ | *@*@* | *' '* ) return 1 ;;
    *@*.* ) return 0 ;;
    * ) return 1 ;;
  esac
}
# An email this box already answered. oshal-install.ps1 gates its whole .env block on the file
# existing, so a re-run there never re-asks; this script asked every time, which is not lockstep
# and is a question with a right answer already written down two lines from where it is asked.
existing_admin_email() {
  for _envf in "$DIR/.env" "$DIR/src/.env"; do
    [ -f "$_envf" ] || continue
    _prev=$(sed -n 's/^OSHAL_OPERATOR_EMAILS=//p' "$_envf" | head -1)
    [ -z "$_prev" ] && _prev=$(sed -n 's/^MOCK_OIDC_EMAIL=//p' "$_envf" | head -1)
    if [ -n "$_prev" ]; then printf '%s' "$_prev"; return 0; fi
  done
  return 1
}

require_admin_email() {
  [ "$MODE" = "3" ] && return 0                      # a leaf node joins an existing swarm's identity
  # A previous install on this box already answered. Reuse it rather than asking again - and
  # only when the operator did not name one on this run, which still wins.
  if [ -z "$ADMIN_EMAIL" ]; then
    _prev_email=$(existing_admin_email || true)
    if [ -n "$_prev_email" ] && valid_email "$_prev_email"; then
      ADMIN_EMAIL="$_prev_email"
      note "administrator $ADMIN_EMAIL (from the existing .env; pass --admin-email to change it)"
    fi
  fi
  while [ -z "$ADMIN_EMAIL" ] || ! valid_email "$ADMIN_EMAIL"; do
    if [ -n "$ADMIN_EMAIL" ]; then echo "   not an email address: $ADMIN_EMAIL" >&2; ADMIN_EMAIL=""; fi
    if [ ! -t 0 ]; then
      # Unattended installs still get an owner: an unowned swarm is the failure mode this
      # whole ceremony exists to prevent. The password is random per install, never a shipped
      # constant, and nobody sees it - the operator sets one through the one-time link instead.
      # It is NOT printed and there is no forced change at first login; an earlier version of
      # this comment claimed both.
      ADMIN_EMAIL="$DEFAULT_ADMIN_EMAIL"
      note "no --admin-email given; the administrator is $ADMIN_EMAIL"
      break
    fi
    printf '   portal administrator email — your local login AND the superadmin: '
    read -r ADMIN_EMAIL || true
  done
}
require_admin_email

# ── How do people sign in? ───────────────────────────────────────────────────
# MOCK_OIDC has no login page: it treats EVERY caller as the operator, and the api
# publishes on 0.0.0.0, so anyone who can reach the port owns the swarm. That is a demo
# posture, not a default. basic = LOCAL_AUTH (ADR-117): a real account, a real password,
# and the first-admin bootstrap claims swarm root (ADR-148) so the operator-gated pages
# answer instead of 403ing. The two modes are mutually exclusive by design — the server
# throws at boot if both are set — so this is a choice, never a layer.
require_auth_mode() {
  [ "$MODE" = "3" ] && return 0
  if [ -z "${OSHAL_AUTH_MODE:-}" ] && [ -t 0 ] && [ "$ASSUME_YES" -ne 1 ]; then
    echo "   how should people sign in?"
    echo "     1) basic  — a real login: you choose your password in the browser   [recommended]"
    echo "     2) mock   — NO login page; every caller is treated as the operator (demo only)"
    printf '   choose [1]: '; read -r _am || true
    case "${_am:-1}" in 2|mock) AUTH_MODE=mock ;; *) AUTH_MODE=basic ;; esac
  fi
  # No password question. The administrator chooses it in the browser through a one-time
  # set-password link, which also signs that browser in — so there is no generated password to
  # print and lose, and the welcome screen opens already authenticated. OSHAL_ADMIN_PASSWORD
  # remains for fully headless automation that must know the credential up front.
}
require_auth_mode

# ── Where do the applications come from, and can this box read it? ───────────
# The store was environment-only (OSHAL_STORE_REPO / OSHAL_STORE_TOKEN), so a private
# store was undiscoverable: an operator had to already know the variable existed. It is
# asked for here, and a credential is requested ONLY when the store does not answer
# anonymously — read silently, so it is never echoed or left in shell history.
# Returns the HTTP status, or 000 when the probe could not be taken at all. The distinction is
# load-bearing: a box with no curl, no network, or a proxy in the way is NOT a box with a private
# store, and demanding a read token for the PUBLIC default store because a probe failed is a
# wrong answer that stops the install dead.
store_probe_status() {
  command -v curl >/dev/null 2>&1 || { echo 000; return 0; }
  curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$1" 2>/dev/null || echo 000
  return 0
}
require_store_source() {
  [ "$MODE" = "3" ] && return 0                      # a leaf node stages nothing
  # --from-archive is the documented ZERO-NETWORK install. It must not be gated on a network
  # probe it cannot satisfy; it resolves to MODE=1 and this function runs before the mode
  # dispatch, so without this line the offline path exits 2 on a box that is working correctly.
  [ -n "$FROM_ARCHIVE" ] && return 0
  if [ "$STORE_REPO_NAMED" -eq 0 ] && [ -t 0 ]; then
    printf '   application store [%s]: ' "$STORE_REPO_DEFAULT"
    read -r _sr || true
    [ -n "$_sr" ] && STORE_REPO="$_sr"
  fi
  case "$STORE_REPO" in https://*) ;; *) echo "--store-repo must be an https URL: $STORE_REPO" >&2; exit 2 ;; esac
  [ -n "${OSHAL_STORE_TOKEN:-}" ] && return 0
  _code=$(store_probe_status "$STORE_REPO")
  [ "$_code" = "200" ] && return 0
  # Only a DEFINITE refusal asks for a credential. Anything else — 000 (no curl, offline, DNS,
  # proxy, timeout) or a server-side 5xx — means the probe could not tell, so the install
  # proceeds and the store step surfaces a real error later if there genuinely is one.
  case "$_code" in
    401|403|404) ;;
    *) return 0 ;;
  esac
  if [ ! -t 0 ]; then
    echo "$STORE_REPO refused an anonymous read (HTTP $_code) and no credential was supplied." >&2
    echo "Export OSHAL_STORE_TOKEN=<token with read access> and re-run." >&2
    exit 2
  fi
  echo "   $STORE_REPO refused an anonymous read (HTTP $_code) — it needs a read token."
  printf '   store access token (input hidden, Enter to skip): '
  stty -echo 2>/dev/null; read -r _st || true; stty echo 2>/dev/null; echo
  [ -n "$_st" ] && export OSHAL_STORE_TOKEN="$_st"
  # `set -euo pipefail` is on. Without this the skip path's last command is the `[ -n ]` test,
  # which returns 1, and the function invoked as a bare top-level command kills the installer
  # with no message — on the prompt that literally says "Enter to skip".
  return 0
}
require_store_source

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
    # cmd's `start` reads a lone quoted argument as the WINDOW TITLE, not a URL: the fallback
    # opened an interactive cmd.exe that sat at a prompt and blocked the installer forever —
    # the closing instructions, including the generated password, never printed. Empty title
    # first, and detach stdin so nothing can wait on a console that has no operator.
    MINGW*|MSYS*|CYGWIN*|Windows*) start "" "$WELCOME" 2>/dev/null \
      || cmd.exe /c start "" "$WELCOME" </dev/null >/dev/null 2>&1 || true ;;
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
  [ -n "$ENROLL_TOKEN" ] || { printf '   enrollment token (binds this computer to YOUR login; REQUIRED - the node installer refuses without it): '; read -r ENROLL_TOKEN || true; }
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
command -v docker >/dev/null 2>&1 || { echo "docker is required (Docker Desktop / Engine 24+)"; wsl_guidance; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "docker compose v2 is required"; exit 1; }
docker info >/dev/null 2>&1 || { echo "docker daemon not running"; wsl_guidance; exit 1; }

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
  # Use what the archive ACTUALLY contains. IMAGE was still $REGISTRY/oshal-bot:$TAG from the
  # registry default, so an archive built with any other tag loaded fine and then every later
  # step — `docker create "$IMAGE"` to extract compose.dist.yml, and OSHAL_BOT_IMAGE in .env —
  # pointed at something that was never there. Offline, there is no pull to paper over it.
  _load_out=$(docker load -i "$FROM_ARCHIVE")
  printf '%s
' "$_load_out"
  _loaded=$(printf '%s
' "$_load_out" | sed -n 's/^Loaded image: //p')
  # An archive can carry several images; prefer the swarm image over whatever else rode along.
  _pick=$(printf '%s
' "$_loaded" | grep -m1 'oshal-bot' || true)
  [ -z "$_pick" ] && _pick=$(printf '%s
' "$_loaded" | head -1)
  if [ -n "$_pick" ]; then
    IMAGE="$_pick"
    say "archive provides $IMAGE"
  else
    # `Loaded image ID: sha256:…` (no tag) reaches here. Say so rather than proceeding silently
    # against a tag the archive may not contain.
    echo "warning: docker load reported no tagged image; continuing with $IMAGE" >&2
  fi
  COMPOSE_SRC=""
else
  say "pulling $IMAGE (first pull is a few GB — one-time)"
  if [ -n "${GHCR_TOKEN:-}" ]; then
    printf '%s' "$GHCR_TOKEN" | docker login ghcr.io -u "${GHCR_USER:-emeraldcoastsystemsgroup}" --password-stdin
  fi
  docker pull "$IMAGE"
  check_image_freshness "$IMAGE"
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
  say "generating $ENV_FILE (fresh secrets; sign-in stack from --auth-mode, default basic)"
  {
    echo "# Generated by oshal-install.sh $(date -u +%Y-%m-%dT%H:%M:%SZ) — operator-local, never commit."
    echo "OSHAL_REGISTRY=$REGISTRY"
    echo "OSHAL_IMAGE_TAG=$TAG"
    # Compose defaults OSHAL_BOT_IMAGE to oshal-bot:latest, which exists only after a SOURCE
    # build. Name the image actually resolved so registry installs pull what they just pulled.
    echo "OSHAL_BOT_IMAGE=$IMAGE"
    echo "OSHAL_PACKAGE_AUDIT_MODE=$PACKAGE_AUDIT_MODE"
    # Record the store these packages actually came from: the api seeds its built-in registry
    # from this at first boot. Left unset it seeds the PUBLIC default, and a swarm staged from
    # the private trunk would be offered that store's copies as "updates" to what it has.
    echo "OSHAL_STORE_REPO=$STORE_REPO"
    echo "OSHAL_STORE_REF=main"
    if [ -n "${OSHAL_STORE_TOKEN:-}" ]; then
      echo "# Private-store credential, operator-local. Remove it and the cockpit simply"
      echo "# reports the store unreadable; staged packages keep working either way."
      echo "OSHAL_STORE_TOKEN=$OSHAL_STORE_TOKEN"
    fi
    echo "POSTGRES_PASSWORD=$(rand)"
    echo "SWARM_SERVICE_SECRET=$(rand)"
    echo "SESSION_SECRET=$(rand)"
    echo "REMOTE_CLIENT_SHARED_SECRET=$(rand)"
    if [ "$AUTH_MODE" = "mock" ]; then echo "MOCK_OIDC=true"; fi
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
    # localSubForEmail() in the local-auth store derives the SAME sha256-of-lowercased-email,
    # so the owner is knowable before the api ever boots — packages staged now can belong to
    # the operator created later, instead of landing unowned and invisible to everyone.
    if [ -n "$ADMIN_EMAIL" ]; then echo "OSHAL_INSTALL_OWNER_SUB=$(local_sub "$ADMIN_EMAIL")"; fi
    # An app access assignment is keyed by (subject, ISSUER) since migration 145, so the grant
    # must name the issuer this owner signs in under or it resolves for nobody.
    if [ "$AUTH_MODE" = "mock" ]; then echo "OSHAL_INSTALL_OWNER_ISSUER=urn:oshal:mock-oidc"; else echo "OSHAL_INSTALL_OWNER_ISSUER=urn:oshal:local-auth"; fi
    # Compose defaults UI_PROFILE to the 7-item starter cockpit, whose rail lists NO installed
    # application — after staging dozens of them, the operator's first cockpit looked empty.
    # The full operator cockpit (every app surface grouped) is oshal-framework; the starter
    # view stays one ?profile=oshal-starter away. OSHAL_UI_PROFILE overrides.
    echo "UI_PROFILE=${OSHAL_UI_PROFILE:-oshal-framework}"
    if [ "$AUTH_MODE" = "basic" ]; then
      echo "# ADR-117 local login: real accounts, real passwords. MOCK_OIDC must stay false —"
      echo "# the server throws at boot if both are enabled rather than degrade to open auth."
      echo "LOCAL_AUTH=true"
      echo "MOCK_OIDC=false"
    fi
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

# ── The first account: a swarm with nobody in it is a swarm nobody owns ──────
# Staging happens before any user can exist, so without this the roster is empty, swarm
# root is UNCLAIMED, and every operator-gated page 403s at the person who just installed
# the thing (ADR-148 names this exact failure). Both modes end with a real identity.
seed_first_admin() {
  [ "$MODE" = "3" ] && return 0
  [ -n "$ADMIN_EMAIL" ] || return 0
  _origin="http://localhost:$COCKPIT_PORT"
  if [ "$AUTH_MODE" = "mock" ]; then
    # No login page to bootstrap through: the mock principal IS the operator, so it only
    # needs the root role that makes the access pages answer.
    say "claiming swarm root for $ADMIN_EMAIL"
    if curl -fsS -X POST "$_origin/api/swarm/roles/claim-root" -H 'content-type: application/json' \
        -H "origin: $_origin" -d '{}' >/dev/null 2>&1; then
      note "swarm root claimed"
    else
      note "root claim skipped (already held, or the route declined)"
    fi
    return 0
  fi
  say "creating the administrator account"
  # Unless automation supplied one, the bootstrap password is random and NEVER shown: the
  # operator replaces it through the set-password link below, which is also what signs their
  # browser in. rand() is in scope here; the prompt block deliberately did not reach for it.
  if [ -n "$ADMIN_PASSWORD" ]; then PASSWORD_SUPPLIED=1; else ADMIN_PASSWORD="$(rand)"; fi
  # set -euo pipefail: a failing docker exec makes a pipeline non-zero and an unassignable
  # substitution aborts the install. A swarm that is already up must not be torn down by a
  # ceremony that could not start — every step below degrades to a printed manual path.
  _proof="$( { docker exec oshal-local-api node scripts/oshal-setup-root.mjs --origin "$_origin" 2>/dev/null || true; } \
    | sed -n 's/^Installer setup code: //p' | tr -d '\r' || true)"
  if [ -z "$_proof" ]; then
    note "could not issue the installer setup code — finish setup in the browser at $_origin/login"
    return 0
  fi
  # The proof is one-use, origin-bound and expires in 15 minutes; it never reaches a log.
  # An automation-supplied password may hold quotes or backslashes: escape before it meets JSON.
  _pw_json=$(printf '%s' "$ADMIN_PASSWORD" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')
  _body=$(printf '{"email":"%s","name":"%s","password":"%s","setupToken":"%s"}' \
    "$ADMIN_EMAIL" "${ADMIN_EMAIL%%@*}" "$_pw_json" "$_proof")
  if ! printf '%s' "$_body" | curl -fsS -X POST "$_origin/api/local-auth/bootstrap" \
      -H 'content-type: application/json' -H "origin: $_origin" --data-binary @- >/dev/null 2>&1; then
    note "account bootstrap declined — open $_origin/login and use setup code: $_proof"
    return 0
  fi
  ADMIN_ACCOUNT_CREATED=1
  note "administrator $ADMIN_EMAIL created; swarm root claimed"
  [ "$PASSWORD_SUPPLIED" -eq 1 ] && return 0
  _link="$( { docker exec oshal-local-api node scripts/oshal-admin-link.mjs --origin "$_origin" \
    --email "$ADMIN_EMAIL" 2>/dev/null || true; } | tr -d '\r' || true)"
  SET_PASSWORD_LINK="$(printf '%s\n' "$_link" | sed -n 's/^Set your password: //p' || true)"
  SET_PASSWORD_EXPIRES="$(printf '%s\n' "$_link" | sed -n 's/^Expires: //p' || true)"
}
ADMIN_ACCOUNT_CREATED=0
PASSWORD_SUPPLIED=0
SET_PASSWORD_LINK=""
SET_PASSWORD_EXPIRES=""
seed_first_admin

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
# Basic auth opens the one-time SET-PASSWORD link instead of /welcome: choosing the password
# there signs this browser in, and the page then continues to / — which is the welcome wizard
# while setup is incomplete. The operator arrives authenticated, never at a login form.
WELCOME="http://localhost:$COCKPIT_PORT/welcome"
[ "$NO_AI" -eq 1 ] && WELCOME="http://localhost:$COCKPIT_PORT/cockpit/"
[ -n "$SET_PASSWORD_LINK" ] && WELCOME="$SET_PASSWORD_LINK"
say "installed — opening your swarm"
docker ps --format '{{.Names}}' | grep -c oshal | xargs -I{} echo "   containers up: {}"
note "cockpit: http://localhost:$COCKPIT_PORT/cockpit/"
case "$(uname -s 2>/dev/null)" in
  # cmd's `start` reads a lone quoted argument as the WINDOW TITLE, not a URL: that opened an
  # interactive cmd.exe which blocked the installer forever. Empty title first, stdin detached.
  MINGW*|MSYS*|CYGWIN*|Windows*) start "" "$WELCOME" 2>/dev/null \
    || cmd.exe /c start "" "$WELCOME" </dev/null >/dev/null 2>&1 || true ;;
  Darwin*) open "$WELCOME" 2>/dev/null || true ;;
  *) xdg-open "$WELCOME" 2>/dev/null || true ;;
esac

say "how you sign in"
if [ "$AUTH_MODE" = "basic" ]; then
  note "Local login (ADR-117). Your account: $ADMIN_EMAIL"
  if [ "$ADMIN_ACCOUNT_CREATED" -eq 1 ]; then
    note "It exists, holds swarm root, and owns every package this install staged."
  fi
  if [ -n "$SET_PASSWORD_LINK" ] && [ -t 1 ]; then
    note "Your browser is opening a one-time page to choose your password; doing so signs you in."
    note "If it did not open, use this link (expires $SET_PASSWORD_EXPIRES):"
    note "  $SET_PASSWORD_LINK"
  elif [ -n "$SET_PASSWORD_LINK" ]; then
    # Unattended: stdout is being captured by something. That link confers swarm root for an
    # hour, so it is not printed - the reissue command below is how it is obtained deliberately.
    note "A one-time set-password link was issued. It is NOT printed on an unattended run;"
    note "reissue it below when you are at a terminal."
  elif [ "$PASSWORD_SUPPLIED" -eq 1 ]; then
    note "Sign in at http://localhost:$COCKPIT_PORT/login with the password this install was given."
  fi
  note "Link expired or lost? Issue a new one — no password is ever lost for good:"
  note "  docker exec oshal-local-api node scripts/oshal-admin-link.mjs \\"
  note "    --origin http://localhost:$COCKPIT_PORT --email $ADMIN_EMAIL"
  note "Invite other people from the cockpit (Users -> invite); each gets their own login."
  note "Real identity provider instead (Google, Microsoft/Entra, any OIDC)? Set LOCAL_AUTH=false and"
  note "MOCK_OIDC=false plus OIDC_ISSUER_URL / OIDC_CLIENT_ID / OIDC_CLIENT_SECRET / APP_URL in"
  note "$ENV_FILE, then restart the api. See INSTALL.md and docs/adr/117-local-auth-invited-users.md."
else
  note "MOCK auth: there is NO sign-in page. Every request to this api is treated as"
  note "$ADMIN_EMAIL — and the api publishes on 0.0.0.0, so anyone who can reach port"
  note "$COCKPIT_PORT on this machine is that operator. Use it for a demo box, not a shared one."
  note "To switch to a real login: set LOCAL_AUTH=true and MOCK_OIDC=false in $ENV_FILE, restart"
  note "the api, then visit /login (the first account claims swarm root)."
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
