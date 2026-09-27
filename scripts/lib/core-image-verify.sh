#!/usr/bin/env bash
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-167 shared image identity + verification for the core release pipeline. One place reads an image's ID and its commit/revision/release labels (cut-release.sh, promote.sh, managed-core-release.sh and core-drift-check.sh all use it, so the four cannot disagree about what "the same image" means), and one place runs the probes a release artifact must pass before it is recorded: the commit and release labels plus the same kernel-skills and cline-entrypoint probe scripts scripts/oshal-deploy.sh runs. Unlike the dev-box deploy, a probe script that is missing refuses instead of skipping: a release that could not be verified is not a release.
# -----------------------------------------------------------------------------
#
# Sourced, never executed. Functions:
#   oshal_core_release_name_ok <name>          0 when <name> follows core-YYYY.MM.DD[.N]
#   oshal_core_image_identity <ref>            sets CORE_IMAGE_ID/_COMMIT/_REVISION/_RELEASE
#   oshal_core_image_verify <ref> <sha> <release> <log>
#                                              0 = every probe passed; 1 = CORE_VERIFY_FAILED names it

# The release-name scheme. src/app/routes/update-check-cron.ts CORE_RELEASE_PATTERN is the same
# rule and tests/unit/core-cut-release.spec.ts runs both over one sample set.
OSHAL_CORE_RELEASE_RE='^core-[0-9]{4}\.[0-9]{2}\.[0-9]{2}(\.[1-9][0-9]*)?$'
# One inspect, one format, one field order, for every reader of an image's identity.
OSHAL_CORE_IDENTITY_FORMAT='{{.Id}}|{{index .Config.Labels "oshal.git.commit"}}|{{index .Config.Labels "org.opencontainers.image.revision"}}|{{index .Config.Labels "oshal.release"}}'

# Return 0 when $1 is a well-formed core release name.
oshal_core_release_name_ok() {
  [[ "${1:-}" =~ $OSHAL_CORE_RELEASE_RE ]]
}

# Read an image's ID and identity labels. A missing label reads as empty (docker prints
# "<no value>" for it). Returns 1, with every field empty, when the image cannot be read or its
# ID is not a sha256 config digest - an unreadable image is never mistaken for a matching one.
oshal_core_image_identity() {
  local ref="$1" raw field
  CORE_IMAGE_ID=''; CORE_IMAGE_COMMIT=''; CORE_IMAGE_REVISION=''; CORE_IMAGE_RELEASE=''
  raw=$(docker image inspect --format "$OSHAL_CORE_IDENTITY_FORMAT" "$ref" 2>/dev/null) || return 1
  raw=${raw//$'\r'/}
  IFS='|' read -r CORE_IMAGE_ID CORE_IMAGE_COMMIT CORE_IMAGE_REVISION CORE_IMAGE_RELEASE <<<"$raw"
  for field in CORE_IMAGE_COMMIT CORE_IMAGE_REVISION CORE_IMAGE_RELEASE; do
    [ "${!field}" = '<no value>' ] && printf -v "$field" '%s' ''
  done
  if [[ ! "$CORE_IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    CORE_IMAGE_ID=''; CORE_IMAGE_COMMIT=''; CORE_IMAGE_REVISION=''; CORE_IMAGE_RELEASE=''
    return 1
  fi
  return 0
}

# Run one probe script against an image; the script's own output goes to the log.
# $1 = probe name, $2 = timeout seconds, $3 = log, rest = the command.
oshal_core_run_probe() {
  local name="$1" seconds="$2" log="$3"
  shift 3
  if ! timeout "$seconds" "$@" >>"$log" 2>&1; then
    CORE_VERIFY_FAILED="$name"
    return 1
  fi
  return 0
}

# Verify a built image is the release artifact it claims to be. Probes, in order: the image is
# readable; its oshal.git.commit AND OCI revision labels name <sha>; its oshal.release label is
# <release>; the kernel-skills probe and the cline-entrypoint probe pass inside it (the same two
# probe scripts scripts/oshal-deploy.sh runs). Must be called from the repository root.
oshal_core_image_verify() {
  local ref="$1" sha="$2" release="$3" log="$4"
  CORE_VERIFY_FAILED=''
  oshal_core_image_identity "$ref" || { CORE_VERIFY_FAILED='image-unreadable'; return 1; }
  if [ "$CORE_IMAGE_COMMIT" != "$sha" ] || [ "$CORE_IMAGE_REVISION" != "$sha" ]; then
    CORE_VERIFY_FAILED='commit-label'; return 1
  fi
  [ "$CORE_IMAGE_RELEASE" = "$release" ] || { CORE_VERIFY_FAILED='release-label'; return 1; }
  [ -f scripts/check-kernel-skills.ts ] || { CORE_VERIFY_FAILED='kernel-skills-probe-missing'; return 1; }
  [ -f scripts/check-cline-entrypoint.mjs ] || { CORE_VERIFY_FAILED='cline-entrypoint-probe-missing'; return 1; }
  oshal_core_run_probe kernel-skills 600 "$log" npx tsx scripts/check-kernel-skills.ts --image "$ref" --quiet || return 1
  oshal_core_run_probe cline-entrypoint 300 "$log" node scripts/check-cline-entrypoint.mjs --image "$ref" --quiet || return 1
  return 0
}
