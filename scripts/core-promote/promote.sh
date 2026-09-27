#!/usr/bin/env bash
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-167: the one documented command that moves a cut core release onto a managed box. It never builds on the box: it ships the SAME image the cut verified (docker save | ssh docker load, or a pull by registry digest), proves the box holds that exact image ID, and only then runs the box's own managed-core-release.sh transaction. Production refuses an image ID that has no staging receipt, and a staging receipt is written only by a verified staging promote of that image ID - so production can only receive bytes staging already ran. --rollback and --status drive the same box helper.
# -----------------------------------------------------------------------------
#
# Usage:  bash scripts/core-promote/promote.sh --target <name> --release <core-...> [--registry <repo>] [--dry-run]
#         bash scripts/core-promote/promote.sh --target <name> --rollback
#         bash scripts/core-promote/promote.sh --target <name> --status
#   --registry <repo>  pull <repo>@sha256:<digest> on the box instead of streaming the image; only
#                      when this machine's copy of the release image carries that repo digest
#   --dry-run          local checks + the plan; nothing is sent to the box
#
# Target file ${OSHAL_CORE_RELEASE_HOME:-$HOME/.oshal-core-release}/targets/<name>.conf -
# KEY=value lines, read (never sourced), each value checked against a strict pattern:
#   SSH_DEST=root@<host>  RELEASE_ROOT=/opt/<customer>/oshal  ENV_FILE=/opt/<customer>/crm-production.env
#   CHANNEL=staging|production  [SSH_KEY=<private key path>]  [SSH_PORT=<port>]
#
# EXIT (promote):  0 promoted and verified on the box (a staging promote writes the staging receipt)
#   1 the box's promote failed; it restored and verified its prior release
#   2 refused before the box's running state changed
#   3 the box did not verify after a failure, or the connection dropped mid-transaction - run --status
#   4 transport failure (ssh or the image transfer) before the box's running state changed
# EXIT (--rollback): the box helper's 0 / 2 / 3; 3 also when the connection drops mid-rollback
# EXIT (--status):   the drift-check contract 0 in sync / 1 drift / 2 unverifiable; 4 box unreachable
# Runbook: docs/runbooks/core-release-promotion.md

set -uo pipefail

SELF_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/core-image-verify.sh
source "$SELF_DIR/../lib/core-image-verify.sh" || { echo "promote: image identity library unavailable" >&2; exit 2; }

RELEASE_HOME="${OSHAL_CORE_RELEASE_HOME:-$HOME/.oshal-core-release}"
RECORDS_DIR="$RELEASE_HOME/records"
TARGET=''; RELEASE=''; REGISTRY=''; MODE=promote; DRY_RUN=0
SSH_DEST=''; RELEASE_ROOT=''; ENV_FILE=''; CHANNEL=''; SSH_KEY=''; SSH_PORT=''
COMMIT=''; IMAGE_ID=''; HELPER=''
declare -a SSH=()

say() { printf '[promote] %s\n' "$*"; }
refuse() { printf '[promote] REFUSED - %s\n' "$*" >&2; exit 2; }

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --target) [ $# -ge 2 ] || refuse "--target needs a value"; TARGET="$2"; shift 2 ;;
      --release) [ $# -ge 2 ] || refuse "--release needs a value"; RELEASE="$2"; shift 2 ;;
      --registry) [ $# -ge 2 ] || refuse "--registry needs a value"; REGISTRY="$2"; shift 2 ;;
      --rollback) MODE=rollback; shift ;;
      --status) MODE=status; shift ;;
      --dry-run) DRY_RUN=1; shift ;;
      *) refuse "unknown argument '$1'" ;;
    esac
  done
  [[ "$TARGET" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] || refuse "--target <name> is required (a lowercase slug)"
  if [ "$MODE" = promote ]; then
    oshal_core_release_name_ok "$RELEASE" || refuse "--release must name a cut release (core-YYYY.MM.DD[.N])"
  else
    [ -z "$RELEASE" ] && [ -z "$REGISTRY" ] || refuse "--$MODE takes only --target"
  fi
  [ -z "$REGISTRY" ] || [[ "$REGISTRY" =~ ^[a-z0-9][a-z0-9._/-]*[a-z0-9]$ ]] || refuse "--registry must be a repository like ghcr.io/<org>/oshal-bot"
}

# One KEY=value line of the target file; $2 = pattern the value must match; $3 = optional.
conf_value() {
  local key="$1" pattern="$2" optional="${3:-}" file="$RELEASE_HOME/targets/$TARGET.conf" count value
  count=$(grep -cE "^${key}=" -- "$file")
  if [ "$count" = 0 ] && [ -n "$optional" ]; then return 0; fi
  [ "$count" = 1 ] || refuse "$file must define $key exactly once"
  value=$(grep -E "^${key}=" -- "$file"); value="${value#*=}"; value="${value%$'\r'}"
  [[ "$value" =~ $pattern ]] || refuse "$file: $key is not a safe value"
  printf '%s' "$value"
}

load_target() {
  local file="$RELEASE_HOME/targets/$TARGET.conf"
  [ -f "$file" ] || refuse "no target file $file"
  SSH_DEST=$(conf_value SSH_DEST '^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+$') || exit 2
  RELEASE_ROOT=$(conf_value RELEASE_ROOT '^/[A-Za-z0-9._/-]+$') || exit 2
  ENV_FILE=$(conf_value ENV_FILE '^/[A-Za-z0-9._/-]+$') || exit 2
  CHANNEL=$(conf_value CHANNEL '^(staging|production)$') || exit 2
  SSH_KEY=$(conf_value SSH_KEY '^[A-Za-z0-9._/:~-]+$' optional) || exit 2
  SSH_PORT=$(conf_value SSH_PORT '^[0-9]{1,5}$' optional) || exit 2
  SSH=(ssh -o ConnectTimeout=20)
  [ -z "$SSH_KEY" ] || SSH+=(-i "$SSH_KEY" -o IdentitiesOnly=yes)
  [ -z "$SSH_PORT" ] || SSH+=(-p "$SSH_PORT")
  SSH+=(-- "$SSH_DEST")
  HELPER="bash $RELEASE_ROOT/scripts/managed-core-release.sh $ENV_FILE"
}

# A field of the flat release record cut-release.sh writes (one "key": "value" per line).
record_field() {
  sed -n "s/^[[:space:]]*\"$1\":[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p" -- "$2" | head -n 1
}

load_record() {
  local record="$RECORDS_DIR/$RELEASE.json"
  [ -f "$record" ] || refuse "no release record $record - cut the release first (cut-release.sh)"
  [ "$(record_field release "$record")" = "$RELEASE" ] || refuse "$record does not describe $RELEASE"
  COMMIT=$(record_field commit "$record"); IMAGE_ID=$(record_field imageId "$record")
  [[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || refuse "$record has no full commit"
  [[ "$IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]] || refuse "$record has no image ID"
}

# This machine must still hold the exact artifact the cut verified.
check_local_artifact() {
  oshal_core_image_identity "oshal-bot:sha-$COMMIT" || refuse "oshal-bot:sha-$COMMIT is no longer on this engine - re-cut or restore it"
  [ "$CORE_IMAGE_ID" = "$IMAGE_ID" ] || refuse "local oshal-bot:sha-$COMMIT is image ${CORE_IMAGE_ID:7:12}, not the cut artifact ${IMAGE_ID:7:12}"
  [ "$CORE_IMAGE_COMMIT" = "$COMMIT" ] && [ "$CORE_IMAGE_RELEASE" = "$RELEASE" ] || refuse "local image labels do not name $COMMIT / $RELEASE"
}

# Production only receives an image ID a verified staging promote already ran.
check_staging_receipt() {
  [ "$CHANNEL" = production ] || return 0
  local receipt="$RECORDS_DIR/$RELEASE.staging.json"
  [ -f "$receipt" ] || refuse "$RELEASE has not been validated on staging (no $receipt) - promote it to a staging target first"
  [ "$(record_field imageId "$receipt")" = "$IMAGE_ID" ] && [ "$(record_field commit "$receipt")" = "$COMMIT" ] \
    || refuse "the staging receipt for $RELEASE names a different image - staging validated other bytes"
}

remote_image_id() {
  "${SSH[@]}" "docker image inspect --format '{{.Id}}' oshal-bot:sha-$COMMIT" 2>/dev/null | tr -d '\r'
  return "${PIPESTATUS[0]}"
}

transfer_stream() {
  say "streaming oshal-bot:sha-$COMMIT to $SSH_DEST (docker save | gzip | ssh docker load)"
  docker save "oshal-bot:sha-$COMMIT" "oshal-bot:$RELEASE" | gzip -1 | "${SSH[@]}" "gzip -dc | docker load"
  local rc=("${PIPESTATUS[@]}")
  [ "${rc[0]}" -eq 0 ] && [ "${rc[1]}" -eq 0 ] && [ "${rc[2]}" -eq 0 ] \
    || { say "TRANSFER FAILED (save ${rc[0]}, gzip ${rc[1]}, ssh/load ${rc[2]}) - the box's running state is unchanged"; exit 4; }
}

transfer_registry() {
  local digest_ref
  digest_ref=$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "oshal-bot:sha-$COMMIT" 2>/dev/null \
    | tr -d '\r' | grep -E "^${REGISTRY//./\\.}@sha256:[0-9a-f]{64}$" | head -n 1)
  [ -n "$digest_ref" ] || refuse "this exact image was never pushed to $REGISTRY (no repo digest) - push it, or promote without --registry"
  say "pulling $digest_ref on $SSH_DEST"
  "${SSH[@]}" "docker pull $digest_ref && docker tag $digest_ref oshal-bot:sha-$COMMIT && docker tag $digest_ref oshal-bot:$RELEASE" \
    || { say "REGISTRY PULL FAILED - the box's running state is unchanged"; exit 4; }
}

# Put the artifact on the box and prove the box holds exactly that image ID.
place_artifact() {
  local remote rc
  remote=$(remote_image_id); rc=$?
  [ "$rc" -ne 255 ] || { say "cannot reach $SSH_DEST (ssh 255)"; exit 4; }
  if [ "$rc" -eq 0 ] && [ -n "$remote" ]; then
    [ "$remote" = "$IMAGE_ID" ] || refuse "the box's oshal-bot:sha-$COMMIT is image ${remote:7:12}, not the release ${IMAGE_ID:7:12} - a second build of different bytes; remove or retag it on the box deliberately"
    say "the box already holds image ${IMAGE_ID:7:12} - no transfer"
    return 0
  fi
  if [ -n "$REGISTRY" ]; then transfer_registry; else transfer_stream; fi
  remote=$(remote_image_id); rc=$?
  [ "$rc" -ne 255 ] || { say "cannot reach $SSH_DEST after the transfer (ssh 255)"; exit 4; }
  [ "$remote" = "$IMAGE_ID" ] || refuse "after the transfer the box holds ${remote:-nothing} under oshal-bot:sha-$COMMIT, not ${IMAGE_ID:7:12} - nothing promoted"
  say "the box holds image ${IMAGE_ID:7:12}"
}

write_receipt() {
  local receipt="$RECORDS_DIR/$RELEASE.$CHANNEL.json" tmp
  tmp="$receipt.tmp.$$"
  cat >"$tmp" <<EOF
{
  "release": "$RELEASE",
  "commit": "$COMMIT",
  "imageId": "$IMAGE_ID",
  "channel": "$CHANNEL",
  "target": "$TARGET",
  "host": "$SSH_DEST",
  "verifiedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
  mv -f "$tmp" "$receipt" || { say "promoted and verified, but writing $receipt failed"; exit 3; }
  say "receipt: $receipt"
}

run_promote() {
  load_record
  check_local_artifact
  check_staging_receipt
  if [ "$DRY_RUN" -eq 1 ]; then
    say "DRY RUN - $CHANNEL target $TARGET ($SSH_DEST): ship image ${IMAGE_ID:7:12} (${REGISTRY:-docker save | ssh docker load}),"
    say "DRY RUN - then: $HELPER promote $COMMIT $IMAGE_ID $RELEASE $CHANNEL. Nothing was sent."
    exit 0
  fi
  place_artifact
  say "running the box transaction on $SSH_DEST"
  "${SSH[@]}" "$HELPER promote $COMMIT $IMAGE_ID $RELEASE $CHANNEL"
  local rc=$?
  case "$rc" in
    0) say "PROMOTED $RELEASE to $CHANNEL target $TARGET"; write_receipt; exit 0 ;;
    1) say "the box's promote failed and it restored its prior release (verified serving)"; exit 1 ;;
    2) say "the box refused the promote - nothing changed there"; exit 2 ;;
    127) refuse "the box has no $RELEASE_ROOT/scripts/managed-core-release.sh - bootstrap it (runbook: first promote on a box)" ;;
    255) say "the connection dropped during the box transaction - its state is unknown; run --status"; exit 3 ;;
    *) say "the box transaction ended with exit $rc - it needs hands; run --status"; exit 3 ;;
  esac
}

run_helper_mode() {
  "${SSH[@]}" "$HELPER $MODE"
  local rc=$?
  case "$MODE:$rc" in
    *:127) refuse "the box has no $RELEASE_ROOT/scripts/managed-core-release.sh" ;;
    rollback:255) say "the connection dropped during the rollback - its state is unknown; run --status"; exit 3 ;;
    status:255) say "cannot reach $SSH_DEST"; exit 4 ;;
    *) exit "$rc" ;;
  esac
}

main() {
  parse_args "$@"
  load_target
  if [ "$MODE" = promote ]; then run_promote; fi
  [ "$DRY_RUN" -eq 0 ] || { say "DRY RUN - would run: $HELPER $MODE on $SSH_DEST"; exit 0; }
  run_helper_mode
}

main "$@"
