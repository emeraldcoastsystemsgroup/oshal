#!/usr/bin/env bash
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-128 Amendment 1 box-state migration: every container's persisted output/global-config.json carried actMode/planMode provider "claude-code" from before the 2026-08-12 fleet flip. FORCE_LLM_PROVIDER=openai-codex masks it at runtime on this box, which is exactly why it went unnoticed for a day — the mask is ABSENT in the self-install shape the product recommends, so a fresh deployment reading this file lands on a subscription that is being cancelled. Rewrites provider+model in place, backs up first, idempotent, --dry-run prints the plan.
set -euo pipefail

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

TARGET_PROVIDER="${TARGET_PROVIDER:-openai-codex}"
TARGET_MODEL="${TARGET_MODEL:-gpt-5.5}"
CONFIG_PATH="/app/output/global-config.json"

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }

log "migrating persisted global-config.json → ${TARGET_PROVIDER}/${TARGET_MODEL}"
[ "$DRY_RUN" -eq 1 ] && log "DRY RUN — nothing will be written"

changed=0; skipped=0; absent=0

for container in $(docker ps --format '{{.Names}}' | grep -E '^oshal-local-' | sort); do
  # Only oshal-bot images carry the config + a node runtime; infra containers do not.
  if ! docker exec "$container" sh -lc "[ -f '$CONFIG_PATH' ]" >/dev/null 2>&1; then
    absent=$((absent + 1)); continue
  fi

  current=$(docker exec "$container" sh -lc \
    "node -e \"process.stdout.write(String((JSON.parse(require('fs').readFileSync('$CONFIG_PATH','utf8')).actModeApiProvider)||''))\"" 2>/dev/null || echo '')

  if [ "$current" = "$TARGET_PROVIDER" ]; then
    skipped=$((skipped + 1)); continue
  fi

  log "  $container: $current → $TARGET_PROVIDER"
  if [ "$DRY_RUN" -eq 1 ]; then changed=$((changed + 1)); continue; fi

  # Back up before the first rewrite only, so re-runs never clobber the original.
  docker exec "$container" sh -lc \
    "[ -f '${CONFIG_PATH}.pre-codex.bak' ] || cp '$CONFIG_PATH' '${CONFIG_PATH}.pre-codex.bak'"

  docker exec "$container" node -e "
    const fs = require('fs');
    const p = '$CONFIG_PATH';
    const c = JSON.parse(fs.readFileSync(p, 'utf8'));
    c.actModeApiProvider = '$TARGET_PROVIDER';
    c.planModeApiProvider = '$TARGET_PROVIDER';
    c.actModeApiModelId = '$TARGET_MODEL';
    c.planModeApiModelId = '$TARGET_MODEL';
    fs.writeFileSync(p, JSON.stringify(c, null, 2));
  "
  changed=$((changed + 1))
done

log "done: $changed migrated, $skipped already on $TARGET_PROVIDER, $absent without a config"
[ "$DRY_RUN" -eq 1 ] && log "DRY RUN — re-run without --dry-run to apply"
exit 0
