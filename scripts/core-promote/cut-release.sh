#!/usr/bin/env bash
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-167: cut a named core release - build ONE image from a published main commit, prove it with the dev-box deploy's own probes, record its image ID, and tag the commit. Before this, every box built its own bytes from a checkout and production was "at" a commit, never a release; nothing recorded which artifact staging had validated. The record is written only after every probe passes and the tag only after the record, so a failed cut leaves neither behind.
# -----------------------------------------------------------------------------
#
# Usage:  bash scripts/core-promote/cut-release.sh [--sha <commit>] [--name <release>] [--push-tag] [--dry-run]
#   --sha       commit to release (default: the freshly fetched origin/main tip); must be on origin/main
#   --name      release name core-YYYY.MM.DD[.N] (default: core-<UTC date>, then .2, .3 ... for a
#               later cut the same day)
#   --push-tag  push the annotated tag to origin once the cut is recorded; a box's promote
#               requires the tag to be published
#   --dry-run   preflight + print the plan; builds, records and tags nothing
#
# EXIT:   0 cut: image built and verified, record written, tag created (and pushed with --push-tag)
#         1 build or image verification failed - no record, no tag
#         2 preflight refusal - nothing built
#         4 cut and recorded, but the tag push failed - the command to push it is printed
#
# Records: ${OSHAL_CORE_RELEASE_HOME:-$HOME/.oshal-core-release}/records/<release>.json
# The dev stack's oshal-bot:latest is never touched: the artifact is tagged oshal-bot:sha-<commit>
# and oshal-bot:<release>. Runbook: docs/runbooks/core-release-promotion.md

set -uo pipefail

SELF_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SELF_DIR/../.." && pwd)"
# shellcheck source=../lib/core-image-verify.sh
source "$REPO_ROOT/scripts/lib/core-image-verify.sh" || { echo "cut-release: image verification library unavailable" >&2; exit 2; }

RELEASE_HOME="${OSHAL_CORE_RELEASE_HOME:-$HOME/.oshal-core-release}"
RECORDS_DIR="$RELEASE_HOME/records"
SHA_ARG=''; NAME=''; PUSH_TAG=0; DRY_RUN=0
SHA=''; RECORD=''; LOG=''

say() { printf '[cut-release] %s\n' "$*"; [ -n "$LOG" ] && printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*" >>"$LOG"; return 0; }
refuse() { printf '[cut-release] REFUSED - %s\n' "$*" >&2; exit 2; }

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --sha) [ $# -ge 2 ] || refuse "--sha needs a value"; SHA_ARG="$2"; shift 2 ;;
      --name) [ $# -ge 2 ] || refuse "--name needs a value"; NAME="$2"; shift 2 ;;
      --push-tag) PUSH_TAG=1; shift ;;
      --dry-run) DRY_RUN=1; shift ;;
      *) refuse "unknown argument '$1'" ;;
    esac
  done
}

# The release commit: on origin/main, from committed bytes, and not already released.
resolve_source() {
  git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1 || refuse "not a git repository: $REPO_ROOT"
  [ -z "$(git -C "$REPO_ROOT" status --porcelain --untracked-files=no)" ] \
    || refuse "tracked files are modified; cut from a clean checkout (the probes run from this tree)"
  git -C "$REPO_ROOT" fetch --quiet --no-tags origin '+refs/heads/main:refs/remotes/origin/main' \
    '+refs/tags/core-*:refs/tags/core-*' 2>/dev/null \
    || refuse "fetching origin failed; a release is cut against a fresh origin/main"
  SHA=$(git -C "$REPO_ROOT" rev-parse --verify --quiet "${SHA_ARG:-refs/remotes/origin/main}^{commit}") \
    || refuse "'${SHA_ARG:-origin/main}' is not a commit"
  git -C "$REPO_ROOT" merge-base --is-ancestor "$SHA" refs/remotes/origin/main \
    || refuse "${SHA:0:12} is not on origin/main; only a published main commit can be released"
  local prior
  prior=$(git -C "$REPO_ROOT" tag --list 'core-*' --points-at "$SHA" | head -n 1)
  [ -z "$prior" ] || refuse "${SHA:0:12} is already released as $prior"
}

# Every release name that exists here or on origin (a name is never reused).
taken_names() {
  local remote
  remote=$(git -C "$REPO_ROOT" ls-remote --tags --refs origin 'refs/tags/core-*') \
    || refuse "listing origin's release tags failed; cannot prove the name is free"
  { git -C "$REPO_ROOT" tag --list 'core-*'; printf '%s\n' "$remote" | sed -n 's#.*refs/tags/##p'; } | sort -u
}

choose_name() {
  local taken base n
  taken=$(taken_names) || exit 2
  if [ -n "$NAME" ]; then
    oshal_core_release_name_ok "$NAME" || refuse "'$NAME' is not a core-YYYY.MM.DD[.N] release name"
    ! grep -qxF -- "$NAME" <<<"$taken" || refuse "release name $NAME is already taken"
    return 0
  fi
  base="core-$(date -u +%Y.%m.%d)"
  NAME="$base"; n=2
  while grep -qxF -- "$NAME" <<<"$taken"; do
    NAME="$base.$n"; n=$((n + 1))
    [ "$n" -le 99 ] || refuse "no free release name for $base"
  done
}

build_image() {
  say "building oshal-bot:sha-$SHA from committed ${SHA:0:12} as $NAME (log: $LOG)"
  git -C "$REPO_ROOT" -c core.autocrlf=false archive "$SHA" \
    | timeout "${OSHAL_CUT_BUILD_TIMEOUT:-3600}" docker build \
        --label "oshal.git.commit=$SHA" --build-arg "GIT_SHA=$SHA" --build-arg "OSHAL_RELEASE=$NAME" \
        -t "oshal-bot:sha-$SHA" -t "oshal-bot:$NAME" -f Dockerfile.oshal - >>"$LOG" 2>&1
  local rc=("${PIPESTATUS[@]}")
  if [ "${rc[0]}" -ne 0 ] || [ "${rc[1]}" -ne 0 ]; then
    say "BUILD FAILED (archive ${rc[0]}, build ${rc[1]}) - nothing recorded, no tag. See $LOG"
    exit 1
  fi
}

# The probes run from the repository root (main cd's there), the same scripts oshal-deploy.sh runs.
verify_image() {
  if ! oshal_core_image_verify "oshal-bot:sha-$SHA" "$SHA" "$NAME" "$LOG"; then
    say "IMAGE VERIFY FAILED at probe '$CORE_VERIFY_FAILED' - nothing recorded, no tag. See $LOG"
    exit 1
  fi
  CUT_IMAGE_ID="$CORE_IMAGE_ID"
}

write_record() {
  local image_id="$CUT_IMAGE_ID" tmp
  tmp="$RECORD.tmp.$$"
  cat >"$tmp" <<EOF
{
  "release": "$NAME",
  "commit": "$SHA",
  "imageId": "$image_id",
  "imageTag": "oshal-bot:sha-$SHA",
  "releaseTag": "oshal-bot:$NAME",
  "gitTag": "$NAME",
  "probes": ["commit-label", "release-label", "kernel-skills", "cline-entrypoint"],
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
  mv -f "$tmp" "$RECORD" || { rm -f "$tmp"; say "writing $RECORD failed - nothing recorded, no tag"; exit 1; }
}

tag_release() {
  git -C "$REPO_ROOT" tag -a "$NAME" "$SHA" -m "oshal core release $NAME" -m "image $CUT_IMAGE_ID" \
    || { say "record written but creating tag $NAME failed - create it: git tag -a $NAME $SHA"; exit 4; }
  [ "$PUSH_TAG" -eq 1 ] || { say "tag $NAME created locally; publish it before promoting: git push origin refs/tags/$NAME"; return 0; }
  if ! git -C "$REPO_ROOT" push --quiet origin "refs/tags/$NAME" >>"$LOG" 2>&1; then
    say "cut and recorded, but pushing tag $NAME failed - push it: git push origin refs/tags/$NAME (see $LOG)"
    exit 4
  fi
  say "tag $NAME pushed to origin"
}

acquire_lock() {
  mkdir -p "$RECORDS_DIR" "$RELEASE_HOME/logs" || refuse "cannot create $RELEASE_HOME"
  mkdir "$RELEASE_HOME/lock" 2>/dev/null || refuse "another cut is in progress ($RELEASE_HOME/lock)"
  trap 'rm -rf "$RELEASE_HOME/lock"' EXIT
}

main() {
  parse_args "$@"
  cd "$REPO_ROOT" || refuse "cannot enter $REPO_ROOT"
  acquire_lock
  resolve_source
  choose_name
  RECORD="$RECORDS_DIR/$NAME.json"
  [ ! -e "$RECORD" ] || refuse "a record for $NAME already exists: $RECORD"
  if [ "$DRY_RUN" -eq 1 ]; then
    say "DRY RUN - would build oshal-bot:sha-$SHA and oshal-bot:$NAME from ${SHA:0:12}, verify it,"
    say "DRY RUN - record $RECORD and tag $NAME. Nothing was built, recorded or tagged."
    exit 0
  fi
  docker info >/dev/null 2>&1 || refuse "docker daemon not reachable"
  LOG="$RELEASE_HOME/logs/cut-$NAME.log"
  : >"$LOG"
  build_image
  verify_image
  write_record
  tag_release
  say "CUT $NAME = ${SHA:0:12} image ${CUT_IMAGE_ID:7:12} (probes: commit-label release-label kernel-skills cline-entrypoint)"
  say "record: $RECORD"
  say "next:   bash scripts/core-promote/promote.sh --target <staging-target> --release $NAME"
  exit 0
}

main "$@"
