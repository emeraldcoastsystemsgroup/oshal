#!/usr/bin/env bash
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com | Post-deploy live verification for scripts/oshal-deploy.sh. On 2026-09-15 a deploy reported DEPLOYED while Jarvis answered nothing and a ticket raised at 00:51Z escalated on manifest_worker_dispatch_failed instead of being worked. Container health, image parity and a 200 on /health were all green throughout: every existing gate measures the STACK, and none of them measures the PRODUCT. These three checks do - the bot role can still read what its own posture guard reads, Jarvis answers a question as the operator, and one synthetic ticket leaves the queue without parking in a failed state.
# 2 | maintainer@emeraldcoastsystemsgroup.com | Hand the probe runner a path that resolves where the probe actually executes. The first real run of this gate reported jarvis-ask and ticket-dispatch FAILED against a stack where both were fine: Git Bash rewrites a POSIX-absolute argument on its way into native docker.exe, so the container path reached node as a Windows host path, node resolved it against /app and died MODULE_NOT_FOUND. Neither product check ever ran. The staging cp beside it was already guarded; the runner was not, and no existing case could see it because they shadow docker with a bash function, which never crosses the boundary that rewrites the argument.
# -----------------------------------------------------------------------------
#
# Sourced by scripts/oshal-deploy.sh; also runnable on its own after fixing a failure:
#   bash -c 'source scripts/lib/deploy-verify.sh && oshal_deploy_post_verify'
#
# Every check prints one PASS/FAIL line, and a FAIL prints the remedy underneath it.
# A failure is LOUD and non-zero and NEVER rolls the deploy back: the new image is
# already live and serving, and replacing it with the previous one would trade a
# product outage for a product outage plus a version surprise.
#
# The single documented escape hatch is OSHAL_DEPLOY_SKIP_LIVE_VERIFY=1, for a box
# that carries no operator identity to act as (no OSHAL_OPERATOR_SUBS). There is
# deliberately no per-check switch: three separate skips is how a gate rots.

# Route output through the caller's run-log writer when there is one, so a deploy keeps
# every verification line in $RUN_LOG, and print plainly when sourced on its own.
oshal_verify_emit() {
  if declare -F log >/dev/null 2>&1; then log "$*"; else printf '%s\n' "$*"; fi
}

# One PASS line per check, always the same shape so a run log is greppable.
oshal_verify_pass() {
  oshal_verify_emit "VERIFY PASS  $1  $2"
}

# One FAIL line per check, followed by the remedy lines that make it actionable.
oshal_verify_fail() {
  local check="$1" detail="$2"; shift 2
  oshal_verify_emit "VERIFY FAIL  $check  $detail"
  local line
  for line in "$@"; do oshal_verify_emit "             remedy: $line"; done
  return 1
}

# (1) The bot database role must still be able to read the table its own ADR-149 posture
# guard reads. scripts/governance/provision-app-role.mjs re-converges oshal_bot to an exact
# allowlist on every api boot and that allowlist does not contain this table, so migration
# 140's grants are stripped at boot and every Jarvis ask answers 503
# authorization_bot_posture_unavailable until someone re-applies them by hand.
oshal_verify_bot_role_grant() {
  local db="${OSHAL_VERIFY_DB_CONTAINER:-oshal-local-db}"
  local db_user="${OSHAL_VERIFY_DB_USER:-oshal}" db_name="${OSHAL_VERIFY_DB_NAME:-oshal}"
  local role="${OSHAL_VERIFY_BOT_ROLE:-oshal_bot}"
  local table="${OSHAL_VERIFY_GRANT_TABLE:-public.oshal_authorization_applications}"
  local grant_sql="${OSHAL_VERIFY_GRANT_SQL:-scripts/migrations/140-bot-role-ownership-reads.sql}"
  local answer
  answer=$(docker exec "$db" psql -U "$db_user" -d "$db_name" -Atc \
    "SELECT has_table_privilege('$role', '$table', 'SELECT')" 2>&1 | tr -d '[:space:]')
  if [ "$answer" = "t" ]; then
    oshal_verify_pass bot-role-grant "$role can SELECT $table"
    return 0
  fi
  oshal_verify_fail bot-role-grant "$role cannot SELECT $table (psql answered: ${answer:-<nothing>})" \
    "MSYS_NO_PATHCONV=1 docker cp $grant_sql $db:/tmp/bot-role-grants.sql" \
    "docker exec $db psql -U $db_user -d $db_name -f /tmp/bot-role-grants.sql" \
    "Every Jarvis ask answers 503 authorization_bot_posture_unavailable until that runs." \
    "It is stripped again on the NEXT api boot: scripts/governance/provision-app-role.mjs re-converges" \
    "$role to an exact allowlist that omits this table. The permanent fix is core PR #459."
}

# Copy the loopback probe into the api container. It runs THERE so the service secret it needs
# to mint a short-lived operator token never has to be read out of the container and into a
# deploy log. Docker is given a relative source path so MSYS path conversion has nothing to eat.
oshal_verify_stage_probe() {
  local api="${OSHAL_VERIFY_API_CONTAINER:-oshal-local-api}"
  local src="${OSHAL_VERIFY_PROBE_SRC:-scripts/operations/deploy-live-verification.js}"
  local dest="${OSHAL_VERIFY_PROBE_DEST:-/tmp/oshal-deploy-live-verification.js}"
  [ -f "$src" ] || { OSHAL_VERIFY_STAGE_ERROR="probe not found at $src"; return 1; }
  MSYS_NO_PATHCONV=1 docker cp "$src" "$api:$dest" >/dev/null 2>&1 \
    || { OSHAL_VERIFY_STAGE_ERROR="docker cp $src -> $api:$dest failed"; return 1; }
}

# Run one staged probe check inside the api container. Its stdout is a single detail line.
#
# $dest is a CONTAINER path and has to reach node inside the container spelled exactly that way.
# Git Bash rewrites every POSIX-absolute argument handed to a native Windows executable, and
# docker.exe is one - so an unguarded call arrives in the container as
#   node C:/Users/<user>/AppData/Local/Temp/oshal-deploy-live-verification.js
# which node resolves against its /app working directory and rejects as MODULE_NOT_FOUND before
# the probe can reach the product. That is not hypothetical: it is how both product checks failed
# on this gate's first real deploy while the stack itself was healthy. The staging cp above is
# guarded for precisely this reason and the runner beside it was missed, because the path is
# behind $dest where a grep for "/tmp/" cannot see it.
#
# MSYS_NO_PATHCONV is read only by the Git Bash runtime when it marshals arguments into a native
# child. On a Linux operator's box nothing reads it, the argument was never rewritten, and the
# call is byte-for-byte the one that already works there.
oshal_verify_run_probe() {
  local api="${OSHAL_VERIFY_API_CONTAINER:-oshal-local-api}"
  local dest="${OSHAL_VERIFY_PROBE_DEST:-/tmp/oshal-deploy-live-verification.js}"
  MSYS_NO_PATHCONV=1 docker exec "$api" node "$dest" "$1" 2>&1
}

# (2) Jarvis must answer a fixed question AS THE OPERATOR on a fresh thread.
oshal_verify_jarvis_answers() {
  local detail rc
  detail=$(oshal_verify_run_probe jarvis); rc=$?
  [ "$rc" -eq 0 ] && { oshal_verify_pass jarvis-ask "$detail"; return 0; }
  oshal_verify_fail jarvis-ask "${detail:-the probe produced no output} (exit $rc)" \
    "Read the bubble, not the spoken line: docs/runbooks/jarvis-couldnt-do-that-just-now.md" \
    "A failing bot-role-grant check above is the usual cause - fix that one first." \
    "exit 2 means this box has no OSHAL_OPERATOR_SUBS entry to act as; see the skip switch in" \
    "docs/runbooks/deploy-parity.md if that is permanent for this deployment."
}

# (3) One synthetic ticket must be dispatched by the queue and must not park in a failed state.
oshal_verify_ticket_moves() {
  local detail rc
  detail=$(oshal_verify_run_probe ticket); rc=$?
  [ "$rc" -eq 0 ] && { oshal_verify_pass ticket-dispatch "$detail"; return 0; }
  oshal_verify_fail ticket-dispatch "${detail:-the probe produced no output} (exit $rc)" \
    "docker logs ${OSHAL_VERIFY_API_CONTAINER:-oshal-local-api} 2>&1 | grep -i 'dispatch failed'" \
    "and read the ticket's status-history metadata: manifest_worker_dispatch_failed names the" \
    "dispatch that threw, authorization_recorded_delegation_required means the bot-node request" \
    "had no recorded delegation issuer to prepare. The ticket is cancelled and deleted either way."
}

# The post-deploy product gate. 0 = every check passed (or the documented skip is set),
# 1 = at least one check failed. It never rolls back and never exits the caller itself.
oshal_deploy_post_verify() {
  local failures=0
  case "${OSHAL_DEPLOY_SKIP_LIVE_VERIFY:-0}" in
    1|true|TRUE|yes|YES|on|ON)
      oshal_verify_emit "post-deploy live verification SKIPPED by OSHAL_DEPLOY_SKIP_LIVE_VERIFY"
      oshal_verify_emit "  the stack is deployed but UNVERIFIED as a product - nothing proved Jarvis answers or a ticket moves"
      return 0 ;;
  esac
  oshal_verify_emit "post-deploy live verification (bot-role grant, Jarvis ask, ticket dispatch)"
  oshal_verify_bot_role_grant || failures=$((failures + 1))
  if oshal_verify_stage_probe; then
    oshal_verify_jarvis_answers || failures=$((failures + 1))
    oshal_verify_ticket_moves || failures=$((failures + 1))
  else
    oshal_verify_fail probe-staging "${OSHAL_VERIFY_STAGE_ERROR:-could not stage the loopback probe}" \
      "Jarvis and ticket dispatch were NOT verified on this deploy." \
      "Run it by hand once the api container is reachable:" \
      "bash -c 'source scripts/lib/deploy-verify.sh && oshal_deploy_post_verify'" || true
    failures=$((failures + 1))
  fi
  [ "$failures" -eq 0 ] || { oshal_verify_emit "post-deploy live verification: $failures check(s) FAILED"; return 1; }
  oshal_verify_emit "post-deploy live verification: all checks passed"
}
