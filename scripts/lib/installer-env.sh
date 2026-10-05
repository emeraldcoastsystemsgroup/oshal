#!/usr/bin/env bash
# =============================================================================
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Installer .env + host-preparation helpers, split out of oshal-install.sh (800-line rule). Adds env insertion (--env-file: bring an existing .env to a clean install, BOM/CRLF-safe, never overwriting a different one), mints JWT_SECRET/ENCRYPTION_KEY like the ps1 (without them the Codex login fails with ENCRYPTION_KEY_REQUIRED), writes the real OSHAL_DOCKER_PROJECT_ROOT on Linux/macOS, keeps every .env owner-only, and pre-creates bind-mount sources so Docker never makes a root-owned ~/.claude.json DIRECTORY.
# =============================================================================
#
# Sourced by scripts/oshal-install.sh (from beside it, or fetched from the repo when the installer
# was downloaded on its own), so it shares the installer's globals and its note()/say()/local_sub().
# Everything but check_image_arch is pure file work, so tests/unit/installer-env-insertion.spec.ts
# runs each function in real bash against a temp dir.

# rand: 32 random bytes as hex — the same shape every installer secret already uses.
installer_rand() { head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }

# env_get KEY FILE — the value of the LAST KEY= line (dotenv last-wins), CR and quotes stripped.
env_get() {
  [ -f "$2" ] || return 0
  sed -n "s/^$1=//p" "$2" | tail -n 1 | tr -d '\r' | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}

# env_set KEY VALUE FILE — exactly one KEY= line afterwards, holding VALUE; other lines untouched.
env_set() {
  local tmp; tmp="$(mktemp "$3.XXXXXX")"
  grep -v "^$1=" "$3" > "$tmp" || true
  printf '%s=%s\n' "$1" "$2" >> "$tmp"
  chmod 600 "$tmp"; mv "$tmp" "$3"
}

# insert_env_file SRC DEST — copy an operator-supplied .env (e.g. from another machine) as DEST.
# Strips a UTF-8 BOM and CRLF (Windows editors write both; a BOM silently renames the first key).
# Never overwrites a DIFFERENT existing DEST: the installer's ".env is never overwritten" promise.
insert_env_file() {
  [ -f "$1" ] && [ -r "$1" ] || { echo "env file not found or unreadable: $1" >&2; return 1; }
  local clean; clean="$(mktemp)"
  sed -e '1s/^\xEF\xBB\xBF//' -e 's/\r$//' "$1" > "$clean"
  if [ -f "$2" ] && ! cmp -s "$clean" "$2"; then
    rm -f "$clean"
    echo "$2 already exists and differs from $1 — move it aside first; it is never overwritten" >&2
    return 1
  fi
  ( umask 077; cat "$clean" > "$2" ); rm -f "$clean"; chmod 600 "$2"
}

# docker_project_root COMPOSE_FILE — the host path the api must hand to compose through the docker
# socket. Linux/macOS daemons see real paths; Windows Docker Desktop is handled by the ps1, so the
# compose default (a Docker Desktop path) is left alone there.
docker_project_root() {
  case "$(uname -s 2>/dev/null)" in MINGW*|MSYS*|CYGWIN*|Windows*) return 0 ;; esac
  (cd "$(dirname "$1")" && pwd -P)
}

# finalize_install_env FILE COMPOSE_FILE — fill what a working box needs and is missing, never
# rotate what is present (an existing ENCRYPTION_KEY protects data already stored with it).
finalize_install_env() {
  local k root cur
  for k in SWARM_SERVICE_SECRET SESSION_SECRET REMOTE_CLIENT_SHARED_SECRET JWT_SECRET ENCRYPTION_KEY; do
    # Placeholders (.env.example / compose stand-ins) are public, so they count as missing (ps1 parity).
    case "$(env_get "$k" "$1")" in ''|replace-with-*|dev-only-*|*change-me*) env_set "$k" "$(installer_rand)" "$1" ;; esac
  done
  root="$(docker_project_root "$2")"; cur="$(env_get OSHAL_DOCKER_PROJECT_ROOT "$1")"
  if [ -n "$root" ] && { [ -z "$cur" ] || [ "${cur#/run/desktop/}" != "$cur" ]; }; then
    env_set OSHAL_DOCKER_PROJECT_ROOT "$root" "$1"
  fi
  chmod 600 "$1"
}

# apply_auth_mode FILE MODE — an explicit --auth-mode wins over an inserted file's sign-in keys.
# The two local modes are mutually exclusive by design (the server refuses both at boot).
apply_auth_mode() {
  case "$2" in
    basic) env_set LOCAL_AUTH true "$1"; env_set MOCK_OIDC false "$1" ;;
    mock)  env_set MOCK_OIDC true "$1"; env_set LOCAL_AUTH false "$1" ;;
  esac
}

# env_auth_mode FILE — the sign-in posture a file already declares: basic | mock | idp.
env_auth_mode() {
  case "$(env_get LOCAL_AUTH "$1" | tr 'A-Z' 'a-z')" in true|1|yes) echo basic; return ;; esac
  case "$(env_get MOCK_OIDC "$1" | tr 'A-Z' 'a-z')" in true|1|yes) echo mock; return ;; esac
  echo idp
}

# prepare_bind_sources ROOT ENV_FILE — create every host bind-mount source as THIS user before the
# first `compose up`. Docker creates a missing source as a root-owned DIRECTORY: for ~/.claude.json
# that is a directory where Claude Code needs a file, and root-owned ~/.codex etc. break later logins.
prepare_bind_sources() {
  local v; v() { local x; x="${!1:-$(env_get "$1" "$2")}"; printf '%s' "${x:-$3}"; }
  mkdir -p "$(v CODEX_CONFIG_HOST_PATH "$2" "$HOME/.codex")" "$(v CLAUDE_CONFIG_HOST_PATH "$2" "$HOME/.claude")" \
    "$(v GEMINI_CONFIG_HOST_PATH "$2" "$HOME/.gemini")" "$1/output/connectors/imported-openapi"
  mkdir -p -m 700 "$(v GOOGLE_WORKSPACE_HOST_PATH "$2" "$HOME/.oshal-google-workspace")"
  local cj; cj="$(v CLAUDE_CONFIG_HOST_JSON "$2" "$HOME/.claude.json")"
  [ -e "$cj" ] || { printf '{}\n' > "$cj"; chmod 600 "$cj"; }
}

# install_inserted_env SRC DEST — env insertion: the operator's own .env (e.g. from another machine)
# IS the configuration. Only install-derived facts are written: the image this run built or pulled,
# the operator list if absent, and the package owner. Sets the global AUTH_MODE from the file
# (an explicit --auth-mode is applied to the file first). Uses IMAGE, ADMIN_EMAIL, AUTH_MODE_EXPLICIT.
install_inserted_env() {
  insert_env_file "$1" "$2" || return 1
  [ "${AUTH_MODE_EXPLICIT:-0}" -eq 1 ] && apply_auth_mode "$2" "$AUTH_MODE"
  AUTH_MODE="$(env_auth_mode "$2")"; note "sign-in from your .env: $AUTH_MODE"
  env_set OSHAL_BOT_IMAGE "$IMAGE" "$2"
  [ -n "$(env_get OSHAL_OPERATOR_EMAILS "$2")" ] || env_set OSHAL_OPERATOR_EMAILS "$ADMIN_EMAIL" "$2"
  if [ "$AUTH_MODE" != idp ] && [ -z "$(env_get OSHAL_INSTALL_OWNER_SUB "$2")" ]; then
    env_set OSHAL_INSTALL_OWNER_SUB "$(local_sub "$ADMIN_EMAIL")" "$2"
    local iss=urn:oshal:local-auth; [ "$AUTH_MODE" = mock ] && iss=urn:oshal:mock-oidc
    env_set OSHAL_INSTALL_OWNER_ISSUER "$iss" "$2"
  fi
}

# save_first_signin_link FILE LINK EXPIRES — unattended runs do not print the one-hour root link;
# it goes to an owner-only file instead (the protection .env already gives SESSION_SECRET), so a
# box installed by automation is never left with no way in.
save_first_signin_link() {
  ( umask 077; printf 'Set your password (one use, expires %s):\n%s\n' "$3" "$2" > "$1" )
  chmod 600 "$1"
  note "Your one-time set-password link is in $1 (owner-only; not printed on an unattended run)."
  note "Open it in a browser on this machine."
}

# idp_signin_note ENV_FILE PORT EMAIL — an inserted .env that signs in through its own identity
# provider returns people to its APP_URL, which may not reach this machine yet (a migration).
idp_signin_note() {
  note "Sign-in uses the identity provider your .env names: $(env_get OIDC_ISSUER_URL "$1")."
  note "It returns people to APP_URL=$(env_get APP_URL "$1"). Until that address reaches this machine,"
  note "sign in locally instead: set LOCAL_AUTH=true and MOCK_OIDC=false in $1, restart the api,"
  note "then issue your set-password link:"
  note "  docker exec oshal-local-api node scripts/oshal-admin-link.mjs --origin http://localhost:$2 --email $3"
}

# check_image_arch IMAGE — an image built for another CPU (the published image is linux/amd64 today)
# starts containers that die with "exec format error", which reads as a broken swarm. Stop with the fix.
check_image_arch() {
  local want have; want="$(docker version -f '{{.Server.Arch}}' 2>/dev/null || true)"
  have="$(docker image inspect -f '{{.Architecture}}' "$1" 2>/dev/null || true)"
  if [ -n "$want" ] && [ -n "$have" ] && [ "$want" != "$have" ]; then
    echo "$1 is built for $have, but this machine is $want. Install from source instead: --mode 2" >&2
    exit 1
  fi
}
