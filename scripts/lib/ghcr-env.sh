#!/usr/bin/env bash
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | New. The image-publish credential lives in .env with every other secret on the box, and nothing on the scheduled path sources that file - so a token the operator added there was inert and the gate refused as if none existed. Reads OSHAL_GHCR_TOKEN and OSHAL_GHCR_USER from .env only when the environment does not already carry them (an explicit value still wins), tolerates the quoting a .env actually uses and a CRLF checkout, EXPORTS both (the consumer is a child process), and never prints a value.
#
# Sourced by scripts/ci/publish-image.sh. Callable on its own:
#   REPO_DIR=/path/to/repo . scripts/lib/ghcr-env.sh && oshal_ghcr_load_env

# Load one name from the .env file when the environment does not already carry it.
# $1 = variable name. The value never reaches stdout or stderr.
oshal_ghcr_load_one() {
  local name="$1" env_file line
  [ -n "${!name:-}" ] && return 0
  env_file="${OSHAL_GHCR_ENV_FILE:-${REPO_DIR:-.}/.env}"
  [ -f "$env_file" ] || return 0
  line=$(grep -m1 "^[[:space:]]*${name}=" "$env_file" 2>/dev/null) || return 0
  line=${line#*=}
  line=${line%$'\r'}
  case "$line" in
    \"*\") line=${line#\"}; line=${line%\"} ;;
    "'"*"'") line=${line#\'}; line=${line%\'} ;;
  esac
  [ -n "$line" ] || return 0
  export "$name"="$line"
}

# Load both names the publisher needs. Safe to call when neither exists: it is then a no-op and
# publish-image.sh's own refusal still fires.
oshal_ghcr_load_env() {
  oshal_ghcr_load_one OSHAL_GHCR_TOKEN
  oshal_ghcr_load_one OSHAL_GHCR_USER
}
