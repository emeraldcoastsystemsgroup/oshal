#!/usr/bin/env bash
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-167 on-box release transaction for a managed CRM box, the root-side sibling of managed-postgres-compose.sh. Replaces the manual customer-box core update (back up by hand, tag :rollback, reset --hard, build on the box, recreate) with one command that takes the image the pipeline cut and verified: it refuses unless the loaded image IS that artifact (ID + labels), the box's declared channel matches, the release dir is clean and the commit and its release tag are published; then takes a pre-deploy pg_dump, writes the history line BEFORE touching anything, checks out, repoints OSHAL_BOT_IMAGE atomically, runs the guarded launcher and proves the result on /api/version. A failure after the capture restores the prior checkout and pin and proves THAT. Rollback is one command against the recorded history.
# 2 | maintainer@emeraldcoastsystemsgroup.com   | The prior image's release is recorded as a core-YYYY.MM.DD[.N] name or '-', never as an off-scheme label. The Dockerfile's `unreleased` default (any hand, on-box or oshal-deploy.sh build) had been recorded as a release name; /api/version reports null for it, so the restore after a failed promote and a rollback to that image could never verify - exit 3, a 'degraded' line, and every later promote refused. Both capture points (promote and rollback) go through mcr_recorded_release.
# -----------------------------------------------------------------------------
#
# Usage (as root, from the root-owned release directory; promote.sh drives it over ssh):
#   scripts/managed-core-release.sh <crm-env-file> promote <commit> <image-id> <release> <channel>
#   scripts/managed-core-release.sh <crm-env-file> rollback
#   scripts/managed-core-release.sh <crm-env-file> status
#
# promote   refuses unless oshal-bot:sha-<commit> is loaded as exactly <image-id> with matching
#           commit and release labels, the env file declares OSHAL_RELEASE_CHANNEL=<channel>, the
#           release dir is clean and agrees with the pinned image, and <commit> is on origin/main
#           with tag <release> published on it. Then: pg_dump (custom format) -> history 'begin' ->
#           checkout -> atomic OSHAL_BOT_IMAGE repoint -> managed-postgres-compose.sh up -> verify
#           the running api image ID and /api/version commit + release.
# rollback  returns to the state before the most recent promote still in effect, or finishes an
#           unfinished transaction. The DATABASE IS NOT ROLLED BACK: the promote's pre-deploy dump
#           is the restore (pg_restore) when a migration has to be undone.
# status    core-drift-check.sh over this box's legs plus the image the history says is live.
#
# EXIT (promote, rollback): 0 done and verified
#     1 promote failed; the prior release dir and pin were restored and verified serving
#     2 refused before anything was changed
#     3 failed and the restore did not verify - the box needs hands (the history names the txn)
# EXIT (status): the drift-check contract - 0 in sync, 1 drift, 2 unverifiable
#
# State, root-only: ${OSHAL_RELEASE_STATE_DIR:-/var/lib/oshal/core-release}/<deployment-id>/
#   history.tsv (append-only)   dumps/pre-<txn>.dump (pg_dump --format=custom)
# Runbook: docs/runbooks/core-release-promotion.md

set -uo pipefail

MCR_SELF=''; MCR_SELF_DIR=''; MCR_REPO_ROOT=''; MCR_LAUNCHER=''
MCR_ENV_FILE=''; MCR_DEPLOYMENT_ID=''; MCR_CHANNEL=''; MCR_STATE=''; MCR_HISTORY=''
MCR_VERSION_URL="${OSHAL_RELEASE_VERSION_URL:-http://127.0.0.1:35457/api/version}"
MCR_VERIFY_SECONDS="${OSHAL_RELEASE_VERIFY_SECONDS:-180}"
TXN=''; DUMP='-'; REVERTS='-'; CURRENT_COMMIT_LABEL=''
TO_RELEASE=''; TO_SHA=''; TO_REF=''; TO_ID=''; FROM_RELEASE=''; FROM_SHA=''; FROM_REF=''; FROM_ID=''

mcr_say() { printf '[managed-core-release] %s\n' "$*"; }
mcr_refuse() { printf '[managed-core-release] REFUSED - %s\n' "$*" >&2; exit 2; }
mcr_usage() {
  echo "Usage: $0 <crm-env-file> {promote <commit> <image-id> <release> <channel>|rollback|status}" >&2
  exit 2
}

# Path trust, the managed-postgres-compose.sh rule: absolute, normalized, no symlinked component,
# every component owned by root and not group/world writable.
mcr_trusted_path() {
  local target="$1" label="$2" component='' part owner mode
  local -a parts=()
  [[ "$target" = /* ]] || mcr_refuse "$label must be an absolute path: $target"
  [ "$(realpath -- "$target" 2>/dev/null)" = "$target" ] || mcr_refuse "$label must be normalized and symlink-free: $target"
  IFS='/' read -r -a parts <<<"${target#/}"
  for part in "${parts[@]}"; do
    [ -n "$part" ] || continue
    component="$component/$part"
    { [ -e "$component" ] && [ ! -L "$component" ]; } || mcr_refuse "$label has a missing or symlinked component: $component"
    owner=$(stat -c '%u' -- "$component"); mode=$(stat -c '%a' -- "$component")
    [ "$owner" = 0 ] || mcr_refuse "$label component must be owned by root: $component"
    { [[ "$mode" =~ ^[0-7]{3,4}$ ]] && (( (8#$mode & 8#022) == 0 )); } || mcr_refuse "$label component must not be group/world writable: $component"
  done
}

# One non-secret value from the env file: defined exactly once, unquoted, no whitespace/comment.
mcr_env_value() {
  local key="$1" value
  [ "$(grep -cE "^${key}=" -- "$MCR_ENV_FILE")" = 1 ] || return 1
  value=$(grep -E "^${key}=" -- "$MCR_ENV_FILE"); value="${value#*=}"
  [[ -n "$value" && "$value" != *[[:space:]\"\'#]* ]] || return 1
  printf '%s' "$value"
}

mcr_locate() {
  local input="$1" candidate resolved
  if [[ "$input" = /* ]]; then candidate="$input"; else candidate="$(pwd -P)/$input"; fi
  resolved=$(realpath -- "$candidate") || mcr_refuse "cannot resolve the helper path $candidate"
  { [ "$candidate" = "$resolved" ] && [ ! -L "$candidate" ]; } || mcr_refuse "the helper path must not contain symlinks"
  MCR_SELF="$resolved"; MCR_SELF_DIR=$(dirname -- "$resolved"); MCR_REPO_ROOT=$(dirname -- "$MCR_SELF_DIR")
  mcr_trusted_path "$MCR_REPO_ROOT" "release directory"
  mcr_trusted_path "$MCR_SELF" "release helper"
  mcr_trusted_path "$MCR_SELF_DIR/lib/core-image-verify.sh" "image identity library"
  # shellcheck source=lib/core-image-verify.sh
  source "$MCR_SELF_DIR/lib/core-image-verify.sh" || mcr_refuse "the image identity library did not load"
}

mcr_init() {
  MCR_ENV_FILE="$1"
  mcr_trusted_path "$MCR_ENV_FILE" "CRM env file"
  { [ -f "$MCR_ENV_FILE" ] && [ ! -L "$MCR_ENV_FILE" ]; } || mcr_refuse "the CRM env file must be a regular file"
  [ "$(stat -c '%a' -- "$MCR_ENV_FILE")" = 600 ] || mcr_refuse "the CRM env file must have mode 0600"
  MCR_DEPLOYMENT_ID=$(mcr_env_value OSHAL_MANAGED_DEPLOYMENT_ID) && [[ "$MCR_DEPLOYMENT_ID" =~ ^[a-z0-9][a-z0-9-]{2,62}$ ]] \
    || mcr_refuse "OSHAL_MANAGED_DEPLOYMENT_ID must be defined once as a lowercase slug"
  MCR_CHANNEL=$(mcr_env_value OSHAL_RELEASE_CHANNEL) || MCR_CHANNEL=''
  local root="${OSHAL_RELEASE_STATE_DIR:-/var/lib/oshal/core-release}"
  MCR_STATE="$root/$MCR_DEPLOYMENT_ID"
  { ( umask 077; mkdir -p -- "$MCR_STATE/dumps" ) && chmod 700 -- "$MCR_STATE" "$MCR_STATE/dumps"; } \
    || mcr_refuse "cannot create the release state under $root"
  mcr_trusted_path "$MCR_STATE" "release state directory"
  MCR_HISTORY="$MCR_STATE/history.tsv"
  MCR_LAUNCHER="$MCR_REPO_ROOT/scripts/managed-postgres-compose.sh"
}

mcr_lock() {
  mkdir -- "$MCR_STATE/lock" 2>/dev/null \
    || mcr_refuse "another release transaction holds $MCR_STATE/lock (remove it only when no promote or rollback is running)"
  trap 'rmdir -- "$MCR_STATE/lock" 2>/dev/null' EXIT
  TXN="$(date -u +%Y%m%dT%H%M%SZ)-$$"
}

# History: one tab-separated line per step; '-' marks an empty field so no field is ever blank.
# ts txn event outcome to_release to_sha to_ref to_id from_release from_sha from_ref from_id dump reverts
mcr_history_add() {
  ( umask 077
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$TXN" "$1" "$2" \
      "${TO_RELEASE:--}" "$TO_SHA" "$TO_REF" "$TO_ID" "${FROM_RELEASE:--}" "$FROM_SHA" "$FROM_REF" "$FROM_ID" "${DUMP:--}" "${REVERTS:--}" \
      >>"$MCR_HISTORY" )
}

# The promote currently in effect: promotes stack up, a completed rollback pops the one it reverted.
mcr_in_effect() {
  [ -f "$MCR_HISTORY" ] || return 0
  awk -F'\t' '
    $4 == "ok" && $3 == "promote" { n++; line[n] = $0; txn[n] = $2; next }
    $4 == "ok" && $3 == "rollback" { if (n > 0 && txn[n] == $14) n--; next }
    END { if (n > 0) print line[n] }' "$MCR_HISTORY"
}

# The last transaction's final line when it never completed (begin) or its restore failed (degraded).
mcr_dangling() {
  [ -f "$MCR_HISTORY" ] || return 0
  awk -F'\t' '{ last = $0; outcome = $4 } END { if (NR > 0 && (outcome == "begin" || outcome == "degraded")) print last }' "$MCR_HISTORY"
}

mcr_load_line() {
  IFS=$'\t' read -r H_TS H_TXN H_EVENT H_OUTCOME H_TO_RELEASE H_TO_SHA H_TO_REF H_TO_ID \
    H_FROM_RELEASE H_FROM_SHA H_FROM_REF H_FROM_ID H_DUMP H_REVERTS <<<"$1"
}

# The release a just-read image (oshal_core_image_identity) is recorded and verified as: its
# core-YYYY.MM.DD[.N] name, or '-' for anything else - no label, or the Dockerfile's `unreleased`
# default - because /api/version reports every off-scheme value as null.
mcr_recorded_release() {
  if oshal_core_release_name_ok "$CORE_IMAGE_RELEASE"; then printf '%s' "$CORE_IMAGE_RELEASE"; else printf '%s' -; fi
}

# What the box pins and has checked out now: the state a failed promote returns to.
mcr_capture_current() {
  FROM_REF=$(mcr_env_value OSHAL_BOT_IMAGE) || mcr_refuse "OSHAL_BOT_IMAGE must be defined once in the env file"
  oshal_core_image_identity "$FROM_REF" || mcr_refuse "the pinned image $FROM_REF is not on this engine - there would be nothing to return to"
  FROM_ID="$CORE_IMAGE_ID"; FROM_RELEASE=$(mcr_recorded_release)
  FROM_SHA=$(git -C "$MCR_REPO_ROOT" rev-parse --verify --quiet 'HEAD^{commit}') || mcr_refuse "the release dir HEAD is unreadable"
  CURRENT_COMMIT_LABEL="$CORE_IMAGE_COMMIT"
}

mcr_check_artifact() {
  TO_REF="oshal-bot:sha-$TO_SHA"
  oshal_core_image_identity "$TO_REF" || mcr_refuse "$TO_REF is not loaded on this engine - transfer the release artifact first (promote.sh does)"
  [ "$CORE_IMAGE_ID" = "$TO_ID" ] || mcr_refuse "$TO_REF is image ${CORE_IMAGE_ID:7:12}, not the release artifact ${TO_ID:7:12} - a different build under the same tag"
  [ "$CORE_IMAGE_COMMIT" = "$TO_SHA" ] || mcr_refuse "$TO_REF commit label is '${CORE_IMAGE_COMMIT:-none}', not $TO_SHA"
  [ "$CORE_IMAGE_RELEASE" = "$TO_RELEASE" ] || mcr_refuse "$TO_REF release label is '${CORE_IMAGE_RELEASE:-none}', not $TO_RELEASE"
}

mcr_check_source() {
  [ -z "$(git -C "$MCR_REPO_ROOT" status --porcelain --untracked-files=no)" ] \
    || mcr_refuse "the release dir has modified tracked files; it must stay a clean mirror of a release"
  [ "$CURRENT_COMMIT_LABEL" = "$FROM_SHA" ] \
    || mcr_refuse "the release dir (${FROM_SHA:0:12}) and the pinned image (${CURRENT_COMMIT_LABEL:-unlabelled}) disagree - run status and resolve the drift first"
  git -C "$MCR_REPO_ROOT" fetch --quiet --no-tags origin '+refs/heads/main:refs/remotes/origin/main' \
    "+refs/tags/$TO_RELEASE:refs/tags/$TO_RELEASE" \
    || mcr_refuse "fetching origin main and tag $TO_RELEASE failed - is the tag published? (cut-release.sh --push-tag)"
  git -C "$MCR_REPO_ROOT" merge-base --is-ancestor "$TO_SHA" refs/remotes/origin/main || mcr_refuse "$TO_SHA is not on origin/main"
  [ "$(git -C "$MCR_REPO_ROOT" rev-parse --verify --quiet "refs/tags/$TO_RELEASE^{commit}")" = "$TO_SHA" ] \
    || mcr_refuse "tag $TO_RELEASE does not name $TO_SHA"
}

mcr_check_channel() {
  [ -n "$MCR_CHANNEL" ] || mcr_refuse "the env file declares no OSHAL_RELEASE_CHANNEL (staging|production); declare it once per box"
  [ "$MCR_CHANNEL" = "$1" ] || mcr_refuse "this box is the $MCR_CHANNEL channel, not $1 - wrong target"
}

# The PostgreSQL client image the managed override already pins (one digest, never a floating tag).
mcr_pg_image() {
  local found
  found=$(grep -Eo 'postgres:[0-9]+-alpine@sha256:[0-9a-f]{64}' -- "$MCR_REPO_ROOT/docker-compose.managed-postgres.yml" 2>/dev/null | sort -u)
  { [ -n "$found" ] && [ "$(printf '%s\n' "$found" | wc -l | tr -d ' ')" = 1 ]; } || return 1
  printf '%s' "$found"
}

# Pre-deploy capture. Only BOOTSTRAP_DATABASE_URL reaches the dump container, through a root-only
# file removed straight after; the value never enters a shell variable or an argv.
mcr_dump() {
  local pg ca="$MCR_REPO_ROOT/config-seed/do-postgres-ca.pem" keyfile out rc
  pg=$(mcr_pg_image) || mcr_refuse "cannot read the pinned PostgreSQL image from docker-compose.managed-postgres.yml"
  [ -s "$ca" ] || mcr_refuse "the PostgreSQL CA $ca is missing"
  [ "$(grep -cE '^BOOTSTRAP_DATABASE_URL=' -- "$MCR_ENV_FILE")" = 1 ] || mcr_refuse "BOOTSTRAP_DATABASE_URL must be defined once"
  keyfile="$MCR_STATE/dump-env.$TXN"; out="$MCR_STATE/dumps/pre-$TXN.dump"
  ( umask 077; grep -E '^BOOTSTRAP_DATABASE_URL=' -- "$MCR_ENV_FILE" >"$keyfile" ) || mcr_refuse "cannot stage the dump credential"
  ( umask 077
    docker run --rm --env-file "$keyfile" --mount "type=bind,source=$ca,target=/app/config-seed/do-postgres-ca.pem,readonly" \
      --entrypoint sh "$pg" -ec 'exec pg_dump --format=custom --no-password --dbname="$BOOTSTRAP_DATABASE_URL"' \
      >"$out.partial" 2>"$out.err" )
  rc=$?
  rm -f -- "$keyfile"
  if [ "$rc" -ne 0 ] || [ "$(head -c 5 -- "$out.partial" 2>/dev/null)" != PGDMP ]; then
    rm -f -- "$out.partial"
    mcr_refuse "the pre-deploy database dump failed (exit $rc, see $out.err) - nothing was changed"
  fi
  mv -f -- "$out.partial" "$out" || mcr_refuse "cannot keep the dump at $out"
  DUMP="$out"
  mcr_say "pre-deploy dump: $out ($(wc -c <"$out" | tr -d ' ') bytes)"
}

mcr_checkout() {
  ( umask 022; git -C "$MCR_REPO_ROOT" -c advice.detachedHead=false checkout --quiet --detach "$1" ) \
    || { mcr_say "checkout of ${1:0:12} failed"; return 1; }
}

# Atomic repoint: rewrite beside the original (same directory, root-only), then rename over it.
mcr_set_pin() {
  local ref="$1" tmp="$MCR_ENV_FILE.release-$TXN"
  ( umask 077
    awk -v ref="$ref" '/^OSHAL_BOT_IMAGE=/ { print "OSHAL_BOT_IMAGE=" ref; n++; next } { print } END { exit (n == 1 ? 0 : 3) }' \
      "$MCR_ENV_FILE" >"$tmp" ) || { rm -f -- "$tmp"; mcr_say "rewriting OSHAL_BOT_IMAGE failed"; return 1; }
  { chmod 600 -- "$tmp" && mv -f -- "$tmp" "$MCR_ENV_FILE"; } || { rm -f -- "$tmp"; mcr_say "replacing the env file failed"; return 1; }
  [ "$(mcr_env_value OSHAL_BOT_IMAGE)" = "$ref" ] || { mcr_say "the env file does not pin $ref after the rewrite"; return 1; }
}

mcr_api_container() {
  docker ps --filter "label=com.docker.compose.project=$MCR_DEPLOYMENT_ID" \
    --filter 'label=com.docker.compose.service=oshal-api' --format '{{.ID}}' 2>/dev/null | tr -d '\r'
}

# The box is AT (sha, image, release) only when the running api runs that image and /api/version
# says that commit and release ('-' = a prior image that was not a release cut, whose release is
# not checked; see mcr_recorded_release).
mcr_verify_live() {
  local sha="$1" id="$2" release="$3" deadline cid='' running='' body commit='' rel=''
  deadline=$((SECONDS + MCR_VERIFY_SECONDS))
  while :; do
    cid=$(mcr_api_container)
    if [ -n "$cid" ] && [ "$(printf '%s\n' "$cid" | wc -l | tr -d ' ')" = 1 ]; then
      running=$(docker inspect --format '{{.Image}}' "$cid" 2>/dev/null | tr -d '\r')
      body=$(curl -fsS -m 5 "$MCR_VERSION_URL" 2>/dev/null || true)
      commit=$(printf '%s' "$body" | sed -n 's/.*"commit":"\([0-9a-f]*\)".*/\1/p')
      rel=$(printf '%s' "$body" | sed -n 's/.*"release":"\([^"]*\)".*/\1/p')
      if [ "$running" = "$id" ] && [ "$commit" = "$sha" ] && { [ "$release" = - ] || [ "$rel" = "$release" ]; }; then
        mcr_say "verified: api on image ${id:7:12}, /api/version commit ${sha:0:12} release ${rel:-null}"
        return 0
      fi
    fi
    [ "$SECONDS" -lt "$deadline" ] || break
    sleep 3
  done
  mcr_say "live verification failed: api image ${running:7:12} commit ${commit:0:12} release ${rel:-null} (wanted ${id:7:12} ${sha:0:12} $release)"
  return 1
}

# Move the box to (sha, ref) and prove it.
mcr_apply() {
  local sha="$1" ref="$2" id="$3" release="$4"
  mcr_checkout "$sha" || return 1
  mcr_set_pin "$ref" || return 1
  mcr_say "managed launcher: up (pin $ref)"
  bash "$MCR_LAUNCHER" "$MCR_ENV_FILE" up || { mcr_say "the managed launcher failed"; return 1; }
  mcr_verify_live "$sha" "$id" "$release"
}

mcr_promote_preflight() {
  TO_SHA="$1"; TO_ID="$2"; TO_RELEASE="$3"
  [[ "$TO_SHA" =~ ^[0-9a-f]{40}$ ]] || mcr_refuse "commit must be a full 40-hex sha"
  [[ "$TO_ID" =~ ^sha256:[0-9a-f]{64}$ ]] || mcr_refuse "image id must be sha256:<64 hex>"
  oshal_core_release_name_ok "$TO_RELEASE" || mcr_refuse "'$TO_RELEASE' is not a core-YYYY.MM.DD[.N] release name"
  [[ "$4" =~ ^(staging|production)$ ]] || mcr_refuse "channel must be staging or production"
  mcr_check_channel "$4"
  local dangling
  dangling=$(mcr_dangling)
  [ -z "$dangling" ] || mcr_refuse "transaction $(printf '%s' "$dangling" | cut -f2) did not finish ($(printf '%s' "$dangling" | cut -f3,4 | tr '\t' ' ')); run rollback first"
  mcr_check_artifact
  mcr_capture_current
  [ "$FROM_ID" != "$TO_ID" ] || mcr_refuse "the box already pins $TO_RELEASE (image ${TO_ID:7:12})"
  mcr_check_source
}

mcr_promote() {
  mcr_promote_preflight "$@"
  mcr_dump
  mcr_history_add promote begin || mcr_refuse "cannot write $MCR_HISTORY - nothing was changed"
  mcr_say "promoting ${FROM_RELEASE} ${FROM_SHA:0:12} -> $TO_RELEASE ${TO_SHA:0:12} (txn $TXN)"
  if mcr_apply "$TO_SHA" "$TO_REF" "$TO_ID" "$TO_RELEASE"; then
    mcr_history_add promote ok || { mcr_say "PROMOTED and verified, but the history line could not be written (txn $TXN)"; exit 3; }
    mcr_say "PROMOTED $TO_RELEASE (${TO_SHA:0:12}, image ${TO_ID:7:12}); pre-deploy dump $DUMP"
    exit 0
  fi
  mcr_say "promote failed - restoring ${FROM_SHA:0:12} and $FROM_REF"
  if mcr_apply "$FROM_SHA" "$FROM_REF" "$FROM_ID" "$FROM_RELEASE"; then
    mcr_history_add promote restored
    mcr_say "promote FAILED; the prior release was restored and verified serving (txn $TXN, dump $DUMP)"
    exit 1
  fi
  mcr_history_add promote degraded
  mcr_say "promote FAILED and the restore did NOT verify - the box needs hands (txn $TXN)."
  mcr_say "Inspect: bash $MCR_LAUNCHER $MCR_ENV_FILE ps; then retry: $MCR_SELF $MCR_ENV_FILE rollback"
  exit 3
}

# Target of a rollback: the state before the promote in effect, or the end state of an
# unfinished transaction (undo a dangling promote; retry a dangling rollback).
mcr_rollback_target() {
  local line
  line=$(mcr_dangling)
  if [ -n "$line" ]; then
    mcr_load_line "$line"
    if [ "$H_EVENT" = rollback ]; then
      # Retry the unfinished rollback toward its own target; on success it pops what it reverted.
      TO_RELEASE="$H_TO_RELEASE"; TO_SHA="$H_TO_SHA"; TO_REF="$H_TO_REF"; TO_ID="$H_TO_ID"; REVERTS="$H_REVERTS"
    else
      # Undo the unfinished promote. It never reached 'ok', so it is not on the stack to pop.
      TO_RELEASE="$H_FROM_RELEASE"; TO_SHA="$H_FROM_SHA"; TO_REF="$H_FROM_REF"; TO_ID="$H_FROM_ID"; REVERTS='-'
    fi
    return 0
  fi
  line=$(mcr_in_effect)
  [ -n "$line" ] || mcr_refuse "no recorded promote is in effect - nothing to roll back"
  mcr_load_line "$line"
  TO_RELEASE="$H_FROM_RELEASE"; TO_SHA="$H_FROM_SHA"; TO_REF="$H_FROM_REF"; TO_ID="$H_FROM_ID"; REVERTS="$H_TXN"
}

mcr_rollback() {
  mcr_rollback_target
  oshal_core_image_identity "$TO_REF" && [ "$CORE_IMAGE_ID" = "$TO_ID" ] \
    || mcr_refuse "the rollback image $TO_REF is not on this engine as ${TO_ID:7:12} - it may have been pruned"
  git -C "$MCR_REPO_ROOT" cat-file -e "$TO_SHA^{commit}" 2>/dev/null || mcr_refuse "commit ${TO_SHA:0:12} is not in the release dir"
  [ -z "$(git -C "$MCR_REPO_ROOT" status --porcelain --untracked-files=no)" ] || mcr_refuse "the release dir has modified tracked files"
  FROM_REF=$(mcr_env_value OSHAL_BOT_IMAGE) || FROM_REF='-'
  FROM_SHA=$(git -C "$MCR_REPO_ROOT" rev-parse --verify --quiet 'HEAD^{commit}') || FROM_SHA='-'
  FROM_ID='-'; FROM_RELEASE='-'
  if oshal_core_image_identity "$FROM_REF"; then FROM_ID="$CORE_IMAGE_ID"; FROM_RELEASE=$(mcr_recorded_release); fi
  mcr_history_add rollback begin || mcr_refuse "cannot write $MCR_HISTORY - nothing was changed"
  mcr_say "rolling back to ${TO_RELEASE} ${TO_SHA:0:12} ($TO_REF) (txn $TXN). The database is not rolled back."
  if mcr_apply "$TO_SHA" "$TO_REF" "$TO_ID" "$TO_RELEASE"; then
    mcr_history_add rollback ok || { mcr_say "ROLLED BACK and verified, but the history line could not be written"; exit 3; }
    mcr_say "ROLLED BACK to ${TO_RELEASE} (${TO_SHA:0:12}, image ${TO_ID:7:12})"
    exit 0
  fi
  mcr_history_add rollback degraded
  mcr_say "rollback did NOT verify - the box needs hands (txn $TXN). Inspect: $MCR_LAUNCHER $MCR_ENV_FILE ps"
  exit 3
}

mcr_status() {
  local line dangling rc
  local -a expect=()
  mcr_say "box $MCR_DEPLOYMENT_ID, channel ${MCR_CHANNEL:-undeclared}"
  line=$(mcr_in_effect)
  if [ -n "$line" ]; then
    mcr_load_line "$line"
    expect=(--expect-image-id "$H_TO_ID")
    [ "$H_TO_RELEASE" = - ] || expect+=(--expect-release "$H_TO_RELEASE")
    mcr_say "in effect: $H_TO_RELEASE ${H_TO_SHA:0:12} image ${H_TO_ID:7:12} (txn $H_TXN, $H_TS; dump $H_DUMP)"
  else
    mcr_say "in effect: no promote recorded"
  fi
  dangling=$(mcr_dangling)
  [ -z "$dangling" ] || mcr_say "UNFINISHED: $(printf '%s' "$dangling" | cut -f2,3,4 | tr '\t' ' ') - run rollback"
  bash "$MCR_SELF_DIR/core-promote/core-drift-check.sh" --release-dir "$MCR_REPO_ROOT" --env-file "$MCR_ENV_FILE" \
    --compose-project "$MCR_DEPLOYMENT_ID" "${expect[@]}"
  rc=$?
  { [ -n "$dangling" ] && [ "$rc" -eq 0 ]; } && rc=1
  exit "$rc"
}

mcr_dispatch() {
  [ $# -ge 2 ] || mcr_usage
  local env_file="$1" action="$2"
  shift 2
  mcr_init "$env_file"
  case "$action" in
    promote) [ $# -eq 4 ] || mcr_usage; mcr_lock; mcr_promote "$@" ;;
    rollback) [ $# -eq 0 ] || mcr_usage; mcr_lock; mcr_rollback ;;
    status) [ $# -eq 0 ] || mcr_usage; mcr_status ;;
    *) mcr_usage ;;
  esac
}

main() {
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  umask 077
  [ "$(id -u)" = 0 ] || mcr_refuse "must run as root (the env file, dumps and history are root-only)"
  mcr_locate "${BASH_SOURCE[0]}"
  mcr_dispatch "$@"
}

# One compound command, read whole before it runs: the checkout inside a promote replaces this
# file, and bash must not read another line of it afterwards. Sourcing defines functions only.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; exit $?; fi
