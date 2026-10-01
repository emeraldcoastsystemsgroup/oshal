#!/usr/bin/env bash
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ | AUTHOR | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com | New. The nightly's operator settings - which workers it may stop for the run, the free-memory floor below which a gate's result is not evidence about the code - are configuration chosen by NAME, never literals in the script. The scheduled task launches through wscript with no environment of its own, so a value that lives only in the shell profile never reaches the run; this reads each named key from the environment first and from the checkout's .env second, the same precedence scripts/lib/ghcr-env.sh uses for the publish credential. It never sources .env (that would pull every live credential into the gate's environment, which ci-local.sh blanks on purpose) and never prints a value.
#
# Sourced by scripts/ci/ci-resource.sh and scripts/ci/ci-quiesce.sh (and by the specs that run them).

# Load one named setting into the shell when the environment does not already carry it.
# A SET name wins even when it is set to empty: an explicit empty value is a decision (for
# example "pause nothing tonight"), and back-filling it from the file would overrule it.
# Unquoted values lose a trailing " # comment", as docker compose reads the same file.
# $1 = variable name. Reads ${OSHAL_CI_ENV_FILE:-$REPO_DIR/.env}. Prints nothing; the value is
# assigned to the shell variable of that name and is not exported to the gates.
ci_config_load() {
  local name="$1" env_file line
  [ -n "${!name+x}" ] && return 0
  env_file="${OSHAL_CI_ENV_FILE:-${REPO_DIR:-.}/.env}"
  [ -f "$env_file" ] || return 0
  line=$(grep -m1 "^[[:space:]]*${name}=" "$env_file" 2>/dev/null) || return 0
  line=${line#*=}
  line=${line%$'\r'}
  case "$line" in
    \"*\") line=${line#\"}; line=${line%\"} ;;
    "'"*"'") line=${line#\'}; line=${line%\'} ;;
    *) line=${line%%[[:space:]]#*}; line=${line%"${line##*[![:space:]]}"} ;;
  esac
  printf -v "$name" '%s' "$line"
}

# A setting that must be a whole number of seconds or megabytes. Empty means "not configured".
# $1 = variable name (already loaded). Returns 0 when it is empty or a non-negative integer;
# otherwise logs which name is malformed (never its value's meaning) and returns 1.
ci_config_whole_number() {
  local name="$1" value="${!1-}"
  [ -z "$value" ] && return 0
  case "$value" in
    *[!0-9]*) log "config: $name must be a whole number; '$value' ignored"; return 1 ;;
  esac
  return 0
}
