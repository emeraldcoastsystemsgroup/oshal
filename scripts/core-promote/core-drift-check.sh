#!/usr/bin/env bash
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-167 drift check: one report of the four things that decide what a box actually runs - the release directory's HEAD, the image the env file pins, the image and commit the running api is on, and origin/main - plus the image the on-box release history says should be live. Before this only one leg existed (the update-check daemon's running-commit vs main boolean): nothing read the release dir or the pin, so a merged-but-never-deployed change and a hand-retagged image were both invisible. Same exit contract as deploy-parity-check.sh.
# -----------------------------------------------------------------------------
#
# Usage:  bash scripts/core-promote/core-drift-check.sh [--release-dir DIR] [--env-file FILE]
#           [--api-container NAME | --compose-project NAME]
#           [--expect-image-id sha256:<64hex>] [--expect-release <core-...>] [--no-fetch] [--quiet]
#   --release-dir      checkout the stack was deployed from (default: this script's repository)
#   --env-file         managed env file whose OSHAL_BOT_IMAGE is the pin (managed boxes)
#   --api-container    api container name (default oshal-local-api)
#   --compose-project  find the api by compose project + service label instead of by name
#   --expect-image-id / --expect-release   what the release history says is live (managed-core-release.sh status)
#   --no-fetch         compare against the last-fetched origin/main
#
# EXIT:   0 in sync   1 drift (named)   2 unverifiable - a leg could not be read, and no drift was proven
# Being behind main is REPORTED with a commit count; it is not drift. Runbook: docs/runbooks/core-release-promotion.md

set -uo pipefail

SELF_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/core-image-verify.sh
source "$SELF_DIR/../lib/core-image-verify.sh" || { echo "core-drift-check: image identity library unavailable" >&2; exit 2; }

RELEASE_DIR="$(cd -- "$SELF_DIR/../.." && pwd)"
ENV_FILE=''; API_CONTAINER='oshal-local-api'; COMPOSE_PROJECT=''
EXPECT_ID=''; EXPECT_RELEASE=''; NO_FETCH=0; QUIET=0
DRIFT=(); UNVERIFIED=(); REPORT=()
DIR_SHA=''; DIR_TAG=''; PIN_REF=''; PIN_ID=''; PIN_COMMIT=''; PIN_RELEASE=''
API=''; RUN_ID=''; RUN_SHA=''; RUN_RELEASE=''; MAIN_SHA=''; MAIN_NOTE=''

usage() { echo "core-drift-check: $1" >&2; exit 2; }
drift() { DRIFT+=("$*"); }
unverified() { UNVERIFIED+=("$*"); }
line() { REPORT+=("$(printf '  %-12s %s' "$1" "$2")"); }
short() { [ -n "$1" ] && printf '%s' "${1:0:12}" || printf '%s' '-'; }
short_id() { [ -n "$1" ] && printf '%s' "${1:7:12}" || printf '%s' '-'; }

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --release-dir) [ $# -ge 2 ] || usage "--release-dir needs a value"; RELEASE_DIR="$2"; shift 2 ;;
      --env-file) [ $# -ge 2 ] || usage "--env-file needs a value"; ENV_FILE="$2"; shift 2 ;;
      --api-container) [ $# -ge 2 ] || usage "--api-container needs a value"; API_CONTAINER="$2"; shift 2 ;;
      --compose-project) [ $# -ge 2 ] || usage "--compose-project needs a value"; COMPOSE_PROJECT="$2"; shift 2 ;;
      --expect-image-id) [ $# -ge 2 ] || usage "--expect-image-id needs a value"; EXPECT_ID="$2"; shift 2 ;;
      --expect-release) [ $# -ge 2 ] || usage "--expect-release needs a value"; EXPECT_RELEASE="$2"; shift 2 ;;
      --no-fetch) NO_FETCH=1; shift ;;
      --quiet) QUIET=1; shift ;;
      *) usage "unknown argument '$1'" ;;
    esac
  done
  [ -z "$EXPECT_ID" ] || [[ "$EXPECT_ID" =~ ^sha256:[0-9a-f]{64}$ ]] || usage "--expect-image-id must be sha256:<64 hex>"
  [ -z "$EXPECT_RELEASE" ] || oshal_core_release_name_ok "$EXPECT_RELEASE" || usage "--expect-release is not a release name"
}

read_release_dir() {
  DIR_SHA=$(git -C "$RELEASE_DIR" rev-parse --verify --quiet 'HEAD^{commit}' 2>/dev/null) \
    || { unverified "release dir $RELEASE_DIR has no readable HEAD"; line 'release dir' 'UNREADABLE'; return; }
  DIR_TAG=$(git -C "$RELEASE_DIR" describe --tags --exact-match --match 'core-*' HEAD 2>/dev/null || true)
  line 'release dir' "$(short "$DIR_SHA")${DIR_TAG:+ ($DIR_TAG)}  $RELEASE_DIR"
}

read_env_pin() {
  [ -n "$ENV_FILE" ] || return 0
  local pins
  pins=$(grep -E '^OSHAL_BOT_IMAGE=' "$ENV_FILE" 2>/dev/null) || { unverified "env file $ENV_FILE has no readable OSHAL_BOT_IMAGE"; line 'env pin' 'UNREADABLE'; return; }
  [ "$(printf '%s\n' "$pins" | wc -l | tr -d ' ')" = 1 ] || { unverified "env file pins OSHAL_BOT_IMAGE more than once"; line 'env pin' 'AMBIGUOUS'; return; }
  PIN_REF="${pins#OSHAL_BOT_IMAGE=}"; PIN_REF="${PIN_REF%$'\r'}"
  if ! oshal_core_image_identity "$PIN_REF"; then
    unverified "pinned image $PIN_REF is not present on this engine"
    line 'env pin' "$PIN_REF -> NOT PRESENT"; return
  fi
  PIN_ID="$CORE_IMAGE_ID"; PIN_COMMIT="$CORE_IMAGE_COMMIT"; PIN_RELEASE="$CORE_IMAGE_RELEASE"
  line 'env pin' "$PIN_REF -> image $(short_id "$PIN_ID"), commit $(short "$PIN_COMMIT"), release ${PIN_RELEASE:--}"
}

find_api() {
  if [ -z "$COMPOSE_PROJECT" ]; then API="$API_CONTAINER"; return 0; fi
  local ids
  ids=$(docker ps --filter "label=com.docker.compose.project=$COMPOSE_PROJECT" \
    --filter 'label=com.docker.compose.service=oshal-api' --format '{{.ID}}' 2>/dev/null) || ids=''
  ids=${ids//$'\r'/}
  [ -n "$ids" ] && [ "$(printf '%s\n' "$ids" | wc -l | tr -d ' ')" = 1 ] || return 1
  API="$ids"
}

read_running() {
  local env_lines
  if ! docker info >/dev/null 2>&1; then unverified "docker is not reachable"; line 'running api' 'UNREADABLE (docker)'; return; fi
  find_api || { unverified "no single running api container in project $COMPOSE_PROJECT"; line 'running api' 'NOT FOUND'; return; }
  RUN_ID=$(docker inspect --format '{{.Image}}' "$API" 2>/dev/null); RUN_ID=${RUN_ID//$'\r'/}
  [[ "$RUN_ID" =~ ^sha256:[0-9a-f]{64}$ ]] || { RUN_ID=''; unverified "api container $API is not running or unreadable"; line 'running api' "$API NOT FOUND"; return; }
  env_lines=$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$API" 2>/dev/null); env_lines=${env_lines//$'\r'/}
  RUN_SHA=$(printf '%s\n' "$env_lines" | sed -n 's/^GIT_SHA=//p' | head -n 1)
  RUN_RELEASE=$(printf '%s\n' "$env_lines" | sed -n 's/^OSHAL_RELEASE=//p' | head -n 1)
  oshal_core_release_name_ok "$RUN_RELEASE" || RUN_RELEASE=''
  [[ "$RUN_SHA" =~ ^[0-9a-f]{7,40}$ ]] || { RUN_SHA=''; unverified "the running api image carries no GIT_SHA (built outside the pipeline)"; }
  line 'running api' "$API image $(short_id "$RUN_ID"), GIT_SHA $(short "$RUN_SHA"), release ${RUN_RELEASE:--}"
}

read_main() {
  if [ "$NO_FETCH" -eq 0 ] && ! git -C "$RELEASE_DIR" fetch --quiet --no-tags origin '+refs/heads/main:refs/remotes/origin/main' 2>/dev/null; then
    MAIN_NOTE=' (fetch failed - last-known origin/main)'
  fi
  MAIN_SHA=$(git -C "$RELEASE_DIR" rev-parse --verify --quiet 'refs/remotes/origin/main^{commit}' 2>/dev/null) \
    || { unverified "origin/main is unknown in $RELEASE_DIR"; line 'main' 'UNKNOWN'; return; }
  local behind='?'
  if [ -n "$RUN_SHA" ] && git -C "$RELEASE_DIR" cat-file -e "$RUN_SHA^{commit}" 2>/dev/null; then
    behind=$(git -C "$RELEASE_DIR" rev-list --count "$RUN_SHA..$MAIN_SHA")
    line 'main' "origin/main $(short "$MAIN_SHA"); the running commit is $behind commit(s) behind main$MAIN_NOTE"
  else
    [ -z "$RUN_SHA" ] || unverified "running commit $(short "$RUN_SHA") is not in $RELEASE_DIR"
    line 'main' "origin/main $(short "$MAIN_SHA"); commits behind: unknown$MAIN_NOTE"
  fi
}

compare_legs() {
  if [ -n "$DIR_SHA" ] && [ -n "$RUN_SHA" ] && [[ "$DIR_SHA" != "$RUN_SHA"* ]]; then
    drift "the release dir is at $(short "$DIR_SHA") but the running api was built from $(short "$RUN_SHA")"
  fi
  if [ -n "$PIN_ID" ] && [ -n "$RUN_ID" ] && [ "$PIN_ID" != "$RUN_ID" ]; then
    drift "the env file pins image $(short_id "$PIN_ID") but the api runs $(short_id "$RUN_ID") - the next launcher up changes the running image"
  fi
  if [ -n "$PIN_COMMIT" ] && [ -n "$DIR_SHA" ] && [ "$PIN_COMMIT" != "$DIR_SHA" ]; then
    drift "the pinned image was built from $(short "$PIN_COMMIT") but the release dir is at $(short "$DIR_SHA")"
  fi
  if [ -n "$EXPECT_ID" ]; then
    line 'recorded' "image $(short_id "$EXPECT_ID"), release ${EXPECT_RELEASE:--} (release history)"
    [ -z "$RUN_ID" ] || [ "$EXPECT_ID" = "$RUN_ID" ] \
      || drift "the release history records image $(short_id "$EXPECT_ID") but the api runs $(short_id "$RUN_ID")"
  fi
  if [ -n "$EXPECT_RELEASE" ] && [ -n "$RUN_ID" ] && [ "$EXPECT_RELEASE" != "$RUN_RELEASE" ]; then
    drift "the release history records $EXPECT_RELEASE but the api reports ${RUN_RELEASE:-no release}"
  fi
}

main() {
  parse_args "$@"
  read_release_dir
  read_env_pin
  read_running
  read_main
  compare_legs
  local verdict code item
  if [ "${#DRIFT[@]}" -gt 0 ]; then verdict='DRIFT'; code=1
  elif [ "${#UNVERIFIED[@]}" -gt 0 ]; then verdict='UNVERIFIED'; code=2
  else verdict='IN SYNC'; code=0; fi
  if [ "$QUIET" -eq 0 ] || [ "$code" -ne 0 ]; then
    printf 'core drift check\n'
    printf '%s\n' "${REPORT[@]}"
    printf '%s\n' "$verdict"
    for item in "${DRIFT[@]}"; do printf '  drift: %s\n' "$item"; done
    for item in "${UNVERIFIED[@]}"; do printf '  unverified: %s\n' "$item"; done
  fi
  exit "$code"
}

main "$@"
