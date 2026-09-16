#!/usr/bin/env bash
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com | Post-deploy live verification for scripts/oshal-deploy.sh. On 2026-09-15 a deploy reported DEPLOYED while Jarvis answered nothing and a ticket raised at 00:51Z escalated on manifest_worker_dispatch_failed instead of being worked. Container health, image parity and a 200 on /health were all green throughout: every existing gate measures the STACK, and none of them measures the PRODUCT. These three checks do - the bot role can still read what its own posture guard reads, Jarvis answers a question as the operator, and one synthetic ticket leaves the queue without parking in a failed state.
# 2 | maintainer@emeraldcoastsystemsgroup.com | Hand the probe runner a path that resolves where the probe actually executes. The first real run of this gate reported jarvis-ask and ticket-dispatch FAILED against a stack where both were fine: Git Bash rewrites a POSIX-absolute argument on its way into native docker.exe, so the container path reached node as a Windows host path, node resolved it against /app and died MODULE_NOT_FOUND. Neither product check ever ran. The staging cp beside it was already guarded; the runner was not, and no existing case could see it because they shadow docker with a bash function, which never crosses the boundary that rewrites the argument.
# 3 | maintainer@emeraldcoastsystemsgroup.com | Add the third verdict, and make the dispatch check mean something under delegation signing. With OSHAL_DELEGATION_SIGNING_* configured this gate could not pass at all: the Jarvis check asks through a service-secret PAT, which records no principal issuer by design, so the controller refuses a user-bound delegation raised under it - and the dispatch check's 'task' ticket routed by ADR-083 call-out onto an INLINE bid winner, which signed delegation refuses before the issuer is even consulted. Both went FAIL on 2026-09-15 and 2026-09-16 on a stack that was healthy, which is a red gate nobody can act on. Now the probe pins its ticket to the workflow's declared owner (a dedicated bot node) and exits 3 for the ONE refusal automation structurally cannot answer; this library prints VERIFY UNVERIFIED for exit 3 - not PASS, not FAIL - counts it separately, names the remedy, and still returns 0 so a deploy is never gated on something no automation can do. Any other refusal is still a FAIL and still non-zero. Caller-exported OSHAL_VERIFY_* knobs are also forwarded into the container by name, because the probe reads them from ITS OWN environment - without that the documented knobs, and the remedy this state prints, reached nothing.
# 4 | maintainer@emeraldcoastsystemsgroup.com | Assert the privilege the bot contract actually carries. The bot role's ADR-149 posture guard no longer reads oshal_authorization_applications; it calls the derived helper oshal_application_execution_claims (migration 142), and the governed contract grants oshal_bot EXECUTE on that helper while withholding the tables on purpose. So has_table_privilege on the table was about to become a check that fails on a CORRECTLY provisioned box, forever, with a remedy naming a migration file that no longer exists. The check now asks has_function_privilege on the helper - the one privilege whose absence still means every Jarvis ask answers 503 - and its remedy applies migration 142 and says that, unlike the grants it replaced, this one survives the next api boot.
# -----------------------------------------------------------------------------
#
# Sourced by scripts/oshal-deploy.sh; also runnable on its own after fixing a failure:
#   bash -c 'source scripts/lib/deploy-verify.sh && oshal_deploy_post_verify'
#
# Every check prints one PASS/FAIL/UNVERIFIED line, and anything that is not a PASS
# prints the remedy underneath it. A failure is LOUD and non-zero and NEVER rolls the
# deploy back: the new image is already live and serving, and replacing it with the
# previous one would trade a product outage for a product outage plus a version surprise.
#
# UNVERIFIED is the third state, and it is deliberately NOT a pass. It means the check
# hit an authorization rule that automation structurally cannot satisfy - today exactly
# one: with controller delegation signing configured, the only identity this gate can
# mint for itself is a service-secret PAT, and that mint records no verified principal
# issuer BY DESIGN (a fleet-wide secret is not proof of an identity-provider namespace).
# Gating a deploy on that would make the gate permanently red; printing PASS would make
# it a lie. So it prints UNVERIFIED, says what was not proved, names the remedy
# (OSHAL_VERIFY_OPERATOR_PAT - a PAT minted from a signed-in session carries an issuer),
# and returns 0. Every other refusal is still a FAIL.
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

# The THIRD state. Same shape as the other two so a run log stays greppable, and a different
# verb from both so nobody reads it as either. It returns 2, not 1: oshal_deploy_post_verify
# counts it in its own bucket and does NOT fail the deploy on it.
oshal_verify_unverified() {
  local check="$1" detail="$2"; shift 2
  oshal_verify_emit "VERIFY UNVERIFIED  $check  $detail"
  local line
  for line in "$@"; do oshal_verify_emit "                   remedy: $line"; done
  return 2
}

# The remedy every UNVERIFIED check prints. It is the same remedy for both product checks
# because it is the same missing fact - an identity carrying a verified principal issuer.
oshal_verify_issuer_remedy() {
  printf '%s\n' \
    "Delegation signing is on and this check can only mint a service-secret PAT, which records" \
    "no principal issuer (src/app/routes/cli-token-routes.ts: a fleet-wide secret is not proof of" \
    "an IdP namespace). resolveDelegatedPrincipal then refuses - correctly - in bot-node-client.ts." \
    "To verify for real: from a SIGNED-IN browser session POST /api/cli-tokens (a session mint DOES" \
    "record the issuer), then re-run this gate with OSHAL_VERIFY_OPERATOR_PAT=<that token>." \
    "Until then this deploy is UNPROVEN as a product: nothing here says Jarvis answers or a ticket moves."
}

# (1) The bot database role must still hold the one derived decision its own ADR-149 posture
# guard reads: oshal_application_execution_claims (migration 142) answers "which application
# claims this bot, and is it protected". The tables behind that answer are withheld from
# oshal_bot on purpose, so the privilege that has to be present is EXECUTE on the helper, not
# SELECT on a table. Without it every Jarvis ask answers 503
# authorization_bot_posture_unavailable, because the posture guard fails closed on the 42501.
oshal_verify_bot_role_grant() {
  local db="${OSHAL_VERIFY_DB_CONTAINER:-oshal-local-db}"
  local db_user="${OSHAL_VERIFY_DB_USER:-oshal}" db_name="${OSHAL_VERIFY_DB_NAME:-oshal}"
  local role="${OSHAL_VERIFY_BOT_ROLE:-oshal_bot}"
  local helper="${OSHAL_VERIFY_GRANT_FUNCTION:-public.oshal_application_execution_claims(text,text,text,boolean)}"
  local grant_sql="${OSHAL_VERIFY_GRANT_SQL:-scripts/migrations/142-application-execution-claims-helper.sql}"
  local answer
  answer=$(docker exec "$db" psql -U "$db_user" -d "$db_name" -Atc \
    "SELECT has_function_privilege('$role', '$helper', 'EXECUTE')" 2>&1 | tr -d '[:space:]')
  if [ "$answer" = "t" ]; then
    oshal_verify_pass bot-role-grant "$role can EXECUTE $helper"
    return 0
  fi
  oshal_verify_fail bot-role-grant "$role cannot EXECUTE $helper (psql answered: ${answer:-<nothing>})" \
    "MSYS_NO_PATHCONV=1 docker cp $grant_sql $db:/tmp/ownership-helper.sql" \
    "MSYS_NO_PATHCONV=1 docker exec $db psql -U $db_user -d $db_name -f /tmp/ownership-helper.sql" \
    "Every Jarvis ask answers 503 authorization_bot_posture_unavailable until that runs." \
    "Unlike the table grants this replaced, the EXECUTE grant SURVIVES the next api boot:" \
    "scripts/governance/provision-app-role.mjs converges $role onto an allowlist that includes this" \
    "helper, so if it is missing after a boot the provisioner did not run or did not reach its final phase."
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
#
# Every OSHAL_VERIFY_* variable the CALLER exported is forwarded into the container by NAME.
# The probe reads its knobs from the environment of the process it runs in - which is the api
# container, not this shell - so before this, a documented knob set on the command line reached
# nothing, and the UNVERIFIED remedy below ("re-run with OSHAL_VERIFY_OPERATOR_PAT=...") would
# have been advice that could not work. `docker exec -e NAME` with no `=value` takes the value
# from this process's own environment, so a token forwarded this way never appears in the
# command line, in `ps`, or in the run log.
oshal_verify_run_probe() {
  local api="${OSHAL_VERIFY_API_CONTAINER:-oshal-local-api}"
  local dest="${OSHAL_VERIFY_PROBE_DEST:-/tmp/oshal-deploy-live-verification.js}"
  local -a forwarded=()
  local name
  for name in ${!OSHAL_VERIFY_@}; do
    [ -n "${!name}" ] && forwarded+=(-e "$name")
  done
  MSYS_NO_PATHCONV=1 docker exec "${forwarded[@]}" "$api" node "$dest" "$1" 2>&1
}

# (2) Jarvis must answer a fixed question AS THE OPERATOR on a fresh thread.
oshal_verify_jarvis_answers() {
  local detail rc
  detail=$(oshal_verify_run_probe jarvis); rc=$?
  [ "$rc" -eq 0 ] && { oshal_verify_pass jarvis-ask "$detail"; return 0; }
  if [ "$rc" -eq 3 ]; then
    local remedy; mapfile -t remedy < <(oshal_verify_issuer_remedy)
    oshal_verify_unverified jarvis-ask "$detail" "${remedy[@]}"
    return 2
  fi
  oshal_verify_fail jarvis-ask "${detail:-the probe produced no output} (exit $rc)" \
    "Read the bubble, not the spoken line: docs/runbooks/jarvis-couldnt-do-that-just-now.md" \
    "A failing bot-role-grant check above is the usual cause - fix that one first." \
    "exit 2 means this box has no OSHAL_OPERATOR_SUBS entry to act as; see the skip switch in" \
    "docs/runbooks/deploy-parity.md if that is permanent for this deployment."
}

# (3) One synthetic ticket must be dispatched by the queue TO A DEDICATED BOT NODE and must not
# park in a failed state. The probe pins the workflow's declared owner (general-bot, which the
# registry marks requiresOwnNode) so the ADR-083 call-out cannot substitute an inline bid winner -
# signed delegation refuses every inline target, and a gate whose target changes per run is no gate.
oshal_verify_ticket_moves() {
  local detail rc
  detail=$(oshal_verify_run_probe ticket); rc=$?
  [ "$rc" -eq 0 ] && { oshal_verify_pass ticket-dispatch "$detail"; return 0; }
  if [ "$rc" -eq 3 ]; then
    local remedy; mapfile -t remedy < <(oshal_verify_issuer_remedy)
    oshal_verify_unverified ticket-dispatch "$detail" "${remedy[@]}"
    return 2
  fi
  oshal_verify_fail ticket-dispatch "${detail:-the probe produced no output} (exit $rc)" \
    "docker logs ${OSHAL_VERIFY_API_CONTAINER:-oshal-local-api} 2>&1 | grep -i 'dispatch failed'" \
    "and read the ticket's status-history metadata: manifest_worker_dispatch_failed names the" \
    "dispatch that threw, authorization_recorded_delegation_required means the bot-node request" \
    "had no recorded delegation issuer to prepare, and 'Signed HTTP delegation requires a dedicated" \
    "bot-node endpoint' means the pinned worker runs INLINE on the api - point OSHAL_VERIFY_TICKET_WORKER" \
    "at a bot the registry marks requiresOwnNode. The ticket is cancelled and deleted either way."
}

# Run one check and bucket its outcome: 0 passes, 2 is UNVERIFIED, anything else FAILED.
# Written once because the two product checks must be bucketed identically - a second copy is
# how one of them would quietly start counting an UNVERIFIED as a pass.
oshal_verify_tally() {
  local rc
  "$@"; rc=$?
  case "$rc" in
    0) return 0 ;;
    2) OSHAL_VERIFY_UNVERIFIED=$((OSHAL_VERIFY_UNVERIFIED + 1)) ;;
    *) OSHAL_VERIFY_FAILURES=$((OSHAL_VERIFY_FAILURES + 1)) ;;
  esac
  return 0
}

# The post-deploy product gate. 0 = nothing FAILED (every check passed, or the documented skip is
# set, or a check was UNVERIFIED - which is reported loudly and is never a pass), 1 = at least one
# check failed. It never rolls back and never exits the caller itself.
oshal_deploy_post_verify() {
  OSHAL_VERIFY_FAILURES=0
  OSHAL_VERIFY_UNVERIFIED=0
  case "${OSHAL_DEPLOY_SKIP_LIVE_VERIFY:-0}" in
    1|true|TRUE|yes|YES|on|ON)
      oshal_verify_emit "post-deploy live verification SKIPPED by OSHAL_DEPLOY_SKIP_LIVE_VERIFY"
      oshal_verify_emit "  the stack is deployed but UNVERIFIED as a product - nothing proved Jarvis answers or a ticket moves"
      return 0 ;;
  esac
  oshal_verify_emit "post-deploy live verification (bot-role grant, Jarvis ask, ticket dispatch)"
  oshal_verify_tally oshal_verify_bot_role_grant
  if oshal_verify_stage_probe; then
    oshal_verify_tally oshal_verify_jarvis_answers
    oshal_verify_tally oshal_verify_ticket_moves
  else
    oshal_verify_fail probe-staging "${OSHAL_VERIFY_STAGE_ERROR:-could not stage the loopback probe}" \
      "Jarvis and ticket dispatch were NOT verified on this deploy." \
      "Run it by hand once the api container is reachable:" \
      "bash -c 'source scripts/lib/deploy-verify.sh && oshal_deploy_post_verify'" || true
    OSHAL_VERIFY_FAILURES=$((OSHAL_VERIFY_FAILURES + 1))
  fi
  [ "$OSHAL_VERIFY_UNVERIFIED" -eq 0 ] || oshal_verify_emit "post-deploy live verification: $OSHAL_VERIFY_UNVERIFIED check(s) NOT VERIFIABLE from automation - this deploy is UNPROVEN as a product"
  [ "$OSHAL_VERIFY_FAILURES" -eq 0 ] || { oshal_verify_emit "post-deploy live verification: $OSHAL_VERIFY_FAILURES check(s) FAILED"; return 1; }
  [ "$OSHAL_VERIFY_UNVERIFIED" -eq 0 ] || return 0
  oshal_verify_emit "post-deploy live verification: all checks passed"
}
