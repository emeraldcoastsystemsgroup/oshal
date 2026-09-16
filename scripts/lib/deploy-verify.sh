#!/usr/bin/env bash
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com | Post-deploy live verification for scripts/oshal-deploy.sh. On 2026-09-15 a deploy reported DEPLOYED while Jarvis answered nothing and a ticket raised at 00:51Z escalated on manifest_worker_dispatch_failed instead of being worked. Container health, image parity and a 200 on /health were all green throughout: every existing gate measures the STACK, and none of them measures the PRODUCT. These three checks do - the bot role can still read what its own posture guard reads, Jarvis answers a question as the operator, and one synthetic ticket leaves the queue without parking in a failed state.
# 2 | maintainer@emeraldcoastsystemsgroup.com | Hand the probe runner a path that resolves where the probe actually executes. The first real run of this gate reported jarvis-ask and ticket-dispatch FAILED against a stack where both were fine: Git Bash rewrites a POSIX-absolute argument on its way into native docker.exe, so the container path reached node as a Windows host path, node resolved it against /app and died MODULE_NOT_FOUND. Neither product check ever ran. The staging cp beside it was already guarded; the runner was not, and no existing case could see it because they shadow docker with a bash function, which never crosses the boundary that rewrites the argument.
# 3 | maintainer@emeraldcoastsystemsgroup.com | Add the third verdict, and make the dispatch check mean something under delegation signing. With OSHAL_DELEGATION_SIGNING_* configured this gate could not pass at all: the Jarvis check asks through a service-secret PAT, which records no principal issuer by design, so the controller refuses a user-bound delegation raised under it - and the dispatch check's 'task' ticket routed by ADR-083 call-out onto an INLINE bid winner, which signed delegation refuses before the issuer is even consulted. Both went FAIL on 2026-09-15 and 2026-09-16 on a stack that was healthy, which is a red gate nobody can act on. Now the probe pins its ticket to the workflow's declared owner (a dedicated bot node) and exits 3 for the ONE refusal automation structurally cannot answer; this library prints VERIFY UNVERIFIED for exit 3 - not PASS, not FAIL - counts it separately, names the remedy, and still returns 0 so a deploy is never gated on something no automation can do. Any other refusal is still a FAIL and still non-zero. Caller-exported OSHAL_VERIFY_* knobs are also forwarded into the container by name, because the probe reads them from ITS OWN environment - without that the documented knobs, and the remedy this state prints, reached nothing.
# 4 | maintainer@emeraldcoastsystemsgroup.com | Assert the privilege the bot contract actually carries. The bot role's ADR-149 posture guard no longer reads oshal_authorization_applications; it calls the derived helper oshal_application_execution_claims (migration 142), and the governed contract grants oshal_bot EXECUTE on that helper while withholding the tables on purpose. So has_table_privilege on the table was about to become a check that fails on a CORRECTLY provisioned box, forever, with a remedy naming a migration file that no longer exists. The check now asks has_function_privilege on the helper - the one privilege whose absence still means every Jarvis ask answers 503 - and its remedy applies migration 142 and says that, unlike the grants it replaced, this one survives the next api boot.
# 5 | maintainer@emeraldcoastsystemsgroup.com | Give the third state consequences, and close the hole that let it print for weeks while the product was down. Two things. (a) UNVERIFIED is no longer reachable when the caller supplied OSHAL_VERIFY_OPERATOR_PAT - with a token in hand the two product checks are binary, PASS or FAIL. The probe already refused to classify its way to exit 3 on a supplied token, but the SHELL, which is what decides the deploy's exit code, accepted a 3 unconditionally - and a 3 is reachable with the token visibly set: ${!OSHAL_VERIFY_@} enumerates NON-exported variables too, so a PAT assigned without export is forwarded as `-e NAME`, docker resolves that name against its own environment, finds nothing, and the probe inside the container mints its own service-secret PAT and refuses exactly as if no token existed (measured in this host's Git Bash on 2026-09-16). That path is now a FAIL naming both causes. (b) An unproven run escalates instead of repeating itself. Every completed run appends one outcome line to $OSHAL_DEPLOY_STATE/live-verify.log and the gate derives the consecutive-unproven streak from it - the BUG-22 shape scripts/ci/ci-gate-streak.mjs proved, where the history is a parse of the log the tool already writes rather than new state to maintain. Inside a three-deploy grace the run still returns 0, but says how many consecutive deploys have proved nothing, since when, and how many are left; on the third it returns 3 and scripts/oshal-deploy.sh exits 5 - deployed and serving, but never proved, which is a different fact from exit 4's proved-broken. There is deliberately NO variable that widens the grace: a knob that defuses a gate gets used to defuse the gate. OSHAL_VERIFY_REQUIRE_PROOF=1 only tightens it to zero, and that is the intended steady state the moment an operator PAT exists.
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
# Gating a deploy on that the first time it happens would make the gate permanently red;
# printing PASS would make it a lie. So it prints UNVERIFIED, says what was not proved,
# and names the remedy - OSHAL_VERIFY_OPERATOR_PAT, a PAT minted from a signed-in session,
# which does carry an issuer. Every other refusal is still a FAIL.
#
# Two rules keep that state from becoming the wallpaper it became between 2026-09-15 and
# 2026-09-16, when it printed on every deploy while Jarvis answered 503 to everything:
#
#   1. UNVERIFIED IS UNREACHABLE WHEN OSHAL_VERIFY_OPERATOR_PAT IS SET. With a token in
#      hand the two product checks are binary. If the probe still reports "not verifiable"
#      it means the token carries no issuer, or it never reached the container - and both
#      are failures of something the caller controls, so both are a FAIL.
#   2. AN UNPROVEN RUN ESCALATES. Each completed run appends one outcome to the ledger
#      (OSHAL_VERIFY_LEDGER, default $OSHAL_DEPLOY_STATE/live-verify.log) and the gate
#      counts consecutive unproven runs back from it. Inside the grace of
#      OSHAL_VERIFY_UNPROVEN_GRACE_DEPLOYS runs the gate still returns 0, but the line it
#      prints changes every run - how long, since when, how many deploys are left. On the
#      last one it returns 3, and scripts/oshal-deploy.sh exits 5: deployed and serving,
#      but never proved. That is a different fact from exit 4, which means proved broken.
#
# The grace is a CONSTANT in this file, not an environment variable, because a knob that
# widens a gate is the knob that gets used to defuse it. OSHAL_VERIFY_REQUIRE_PROOF=1
# tightens it to zero and is the intended steady state once an operator PAT exists.
#
# The single documented escape hatch is still OSHAL_DEPLOY_SKIP_LIVE_VERIFY=1, for a box
# that carries no operator identity to act as (no OSHAL_OPERATOR_SUBS). There is
# deliberately no per-check switch: three separate skips is how a gate rots. A skipped run
# measures nothing, so it records nothing - it neither grows nor resets the streak.

# How many consecutive unproven runs are tolerated before the gate starts failing the
# deploy. Three: one is a notice, by the third it is a standing condition, and on this
# box's deploy cadence three lands inside a day. Deliberately not readable from the
# environment - see the header above.
OSHAL_VERIFY_UNPROVEN_GRACE_DEPLOYS=3

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

# The remedy for the OTHER shape: the caller DID supply OSHAL_VERIFY_OPERATOR_PAT and the probe
# still came back "not verifiable from automation". That is never an honest UNVERIFIED - it is one
# of exactly two failures of something the caller controls, and the operator has to be told which
# to look at first, because the second one is invisible from inside the container.
oshal_verify_supplied_token_remedy() {
  printf '%s\n' \
    "OSHAL_VERIFY_OPERATOR_PAT is set in this shell, so this check must come back PASS or FAIL." \
    "It came back 'not verifiable', which means the probe inside the container did not see a token." \
    "Either (a) the token reached the probe and carries no verified principal issuer - it was not" \
    "minted from a signed-in session - or (b) it never reached the container at all: this library" \
    "forwards OSHAL_VERIFY_* by NAME (docker exec -e NAME), and docker resolves a bare name against" \
    "its OWN environment, so a variable assigned without 'export' is forwarded as a name that" \
    "resolves to nothing. Check (b) first, it is free:  export OSHAL_VERIFY_OPERATOR_PAT" \
    "Then re-run: bash -c 'source scripts/lib/deploy-verify.sh && oshal_deploy_post_verify'"
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
    "helper, so if it is missing after a boot the provisioner did not run or did not reach its final phase."     "The migration ALONE may not be enough: the provisioner re-enables  LOGIN inside the same"     "transaction as its helper checks, so a final phase that failed leaves the role unable to log in at"     "all (28000) while this check reads PASS. Run the provisioner too:"     "MSYS_NO_PATHCONV=1 docker exec \$(docker ps --filter name=api -q | head -1) node scripts/governance/provision-app-role.mjs"
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

# Turn one probe exit code into one verdict line. Written ONCE because the two product checks must
# classify identically - two copies is how one of them quietly starts calling an outage unverifiable.
#
# The rule that matters is the exit-3 rule. Exit 3 means "not verifiable from automation", and that
# is only an honest verdict when this gate had no issuer-carrying identity to offer. When the caller
# supplied OSHAL_VERIFY_OPERATOR_PAT it is not honest and it is not accepted: the check is binary,
# and a 3 is a FAIL that names both ways it can happen. The probe reaches the same conclusion from
# inside the container (classifyVerdict refuses to return 3 on a supplied token), but the probe only
# knows what it RECEIVED - and the gap between "the caller set it" and "the probe received it" is
# real and reachable. ${!OSHAL_VERIFY_@} below enumerates non-exported variables too, so a PAT
# assigned without 'export' is forwarded as a bare `-e NAME`, docker resolves that name against its
# own environment, finds nothing, and the probe mints a service-secret PAT and refuses exactly as if
# no token had been supplied. Only this side of the boundary can see that, so only this side can
# refuse it.
# $1 check name, $2 detail line from the probe, $3 the probe's exit code, $4.. the FAIL remedy.
oshal_verify_classify() {
  local check="$1" detail="$2" rc="$3"; shift 3
  [ "$rc" -eq 0 ] && { oshal_verify_pass "$check" "$detail"; return 0; }
  if [ "$rc" -eq 3 ]; then
    if [ -z "${OSHAL_VERIFY_OPERATOR_PAT:-}" ]; then
      local remedy; mapfile -t remedy < <(oshal_verify_issuer_remedy)
      oshal_verify_unverified "$check" "$detail" "${remedy[@]}"
      return 2
    fi
    local supplied; mapfile -t supplied < <(oshal_verify_supplied_token_remedy)
    oshal_verify_fail "$check" "$detail (exit 3 with OSHAL_VERIFY_OPERATOR_PAT set - this check is not allowed a third state)" \
      "${supplied[@]}"
    return 1
  fi
  oshal_verify_fail "$check" "${detail:-the probe produced no output} (exit $rc)" "$@"
}

# (2) Jarvis must answer a fixed question AS THE OPERATOR on a fresh thread.
oshal_verify_jarvis_answers() {
  local detail rc
  detail=$(oshal_verify_run_probe jarvis); rc=$?
  oshal_verify_classify jarvis-ask "$detail" "$rc" \
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
  oshal_verify_classify ticket-dispatch "$detail" "$rc" \
    "docker logs ${OSHAL_VERIFY_API_CONTAINER:-oshal-local-api} 2>&1 | grep -i 'dispatch failed'" \
    "and read the ticket's status-history metadata: manifest_worker_dispatch_failed names the" \
    "dispatch that threw, authorization_recorded_delegation_required means the bot-node request" \
    "had no recorded delegation issuer to prepare, and 'Signed HTTP delegation requires a dedicated" \
    "bot-node endpoint' means the pinned worker runs INLINE on the api - point OSHAL_VERIFY_TICKET_WORKER" \
    "at a bot the registry marks requiresOwnNode. The ticket is cancelled and deleted either way."
}

# Where one line per completed run is appended. The deploy already keeps its per-run logs in
# $OSHAL_DEPLOY_STATE (default ~/.oshal-deploy) and already creates it, so the streak needs no new
# home and no new lifecycle. A caller may point it elsewhere - a test does exactly that.
oshal_verify_ledger_path() {
  printf '%s\n' "${OSHAL_VERIFY_LEDGER:-${OSHAL_DEPLOY_STATE:-$HOME/.oshal-deploy}/live-verify.log}"
}

# Append one outcome. The format is deliberately the shape scripts/ci/ci-gate-streak.mjs reads for
# the nightly gate - an append-only line per run, parsed rather than maintained as separate state:
#
#   2026-09-16T18:22:41Z UNPROVEN unverified=2
#   2026-09-16T18:40:03Z PROVEN
#   2026-09-16T18:55:12Z FAILED failed=1
#
# Returns non-zero and records the path in OSHAL_VERIFY_LEDGER_ERROR when it could not write, which
# the caller reports out loud: an unwritable ledger means the streak can never grow, and an
# escalation that silently cannot fire is the defect this whole change exists to remove.
oshal_verify_record_outcome() {
  local outcome="$1"; shift
  local ledger; ledger=$(oshal_verify_ledger_path)
  OSHAL_VERIFY_LEDGER_ERROR=""
  mkdir -p "$(dirname "$ledger")" 2>/dev/null || { OSHAL_VERIFY_LEDGER_ERROR="$ledger"; return 1; }
  printf '%s %s%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$outcome" "${*:+ $*}" >>"$ledger" 2>/dev/null \
    || { OSHAL_VERIFY_LEDGER_ERROR="$ledger"; return 1; }
  return 0
}

# How many runs in a row, ending at the most recent one, ended UNPROVEN - and when that run started.
# Prints "<count> <first-timestamp>", or "0 -" when there is no readable history.
#
# Any line that is not an UNPROVEN outcome ends the streak, PROVEN and FAILED alike. A FAILED run is
# not silent - it already exits non-zero - so it needs no escalation, and resetting on it keeps the
# arithmetic auditable from the file by eye. A garbled line also resets, which under-counts rather
# than over-counts: the cost of that is a later escalation, never a deploy failed on corrupt history.
oshal_verify_unproven_streak() {
  local ledger; ledger=$(oshal_verify_ledger_path)
  [ -r "$ledger" ] || { printf '0 -\n'; return 1; }
  tail -n 500 "$ledger" 2>/dev/null | awk '
    { sub(/\r$/, "") }
    $2 == "UNPROVEN" { n += 1; if (n == 1) first = $1; next }
    { n = 0; first = "" }
    END { printf "%d %s\n", n + 0, (first == "" ? "-" : first) }'
}

# How many consecutive unproven runs this deployment tolerates. The constant, unless
# OSHAL_VERIFY_REQUIRE_PROOF says prove it or fail - which only ever tightens it to zero.
oshal_verify_unproven_grace() {
  case "${OSHAL_VERIFY_REQUIRE_PROOF:-0}" in
    1|true|TRUE|yes|YES|on|ON) printf '0\n'; return 0 ;;
  esac
  printf '%s\n' "$OSHAL_VERIFY_UNPROVEN_GRACE_DEPLOYS"
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

# The post-deploy product gate. It never rolls back and never exits the caller itself; it returns:
#
#   0  every check passed, or the documented skip is set, or nothing FAILED and the unproven grace
#      has not run out yet (reported loudly, with a countdown, and never as a pass)
#   1  at least one check FAILED - the product is proved broken            -> deploy exits 4
#   3  nothing FAILED, but the product could not be PROVED and the grace is spent -> deploy exits 5
#
# 1 and 3 are different facts and the deploy spells them differently: 4 means fix the product, 5
# means give the gate an identity it can prove the product with. Both leave the new image serving.
oshal_deploy_post_verify() {
  OSHAL_VERIFY_FAILURES=0
  OSHAL_VERIFY_UNVERIFIED=0
  OSHAL_VERIFY_UNPROVEN_STREAK=0
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
  if [ "$OSHAL_VERIFY_FAILURES" -ne 0 ]; then
    oshal_verify_record_outcome FAILED "failed=$OSHAL_VERIFY_FAILURES" || true
    oshal_verify_emit "post-deploy live verification: $OSHAL_VERIFY_FAILURES check(s) FAILED"
    return 1
  fi
  [ "$OSHAL_VERIFY_UNVERIFIED" -eq 0 ] || { oshal_verify_unproven_outcome; return $?; }
  oshal_verify_record_outcome PROVEN || oshal_verify_emit "post-deploy live verification: could not record this run in ${OSHAL_VERIFY_LEDGER_ERROR:-the ledger}"
  oshal_verify_emit "post-deploy live verification: all checks passed"
}

# Nothing FAILED, but something could not be PROVED. This is the state that printed on every deploy
# between 2026-09-15 and 2026-09-16 while Jarvis answered 503 to every ask, in the same words each
# time, which is how it became boilerplate. So the wording changes every run - how many consecutive
# deploys have proved nothing, since when, and how many are left before it stops being advisory.
# Returns 0 inside the grace, 3 once it is spent.
oshal_verify_unproven_outcome() {
  local streak=1 first="-" note=""
  if oshal_verify_record_outcome UNPROVEN "unverified=$OSHAL_VERIFY_UNVERIFIED"; then
    local reading; reading=$(oshal_verify_unproven_streak)
    streak="${reading%% *}"; first="${reading##* }"
    [ "$streak" -ge 1 ] 2>/dev/null || { streak=1; first="-"; }
  else
    # An unwritable ledger cannot fail a deploy - a gate that goes red because $HOME is read-only is
    # a gate nobody can act on. But it must never be quiet either: without the ledger the streak can
    # never grow, so the escalation below is permanently frozen at its first rung.
    note="cannot record this run in ${OSHAL_VERIFY_LEDGER_ERROR:-the ledger} - the unproven streak cannot escalate"
  fi
  OSHAL_VERIFY_UNPROVEN_STREAK="$streak"
  local since=""; [ "$first" = "-" ] || since=" (first $first)"
  local grace; grace=$(oshal_verify_unproven_grace)
  [ -z "$note" ] || oshal_verify_emit "post-deploy live verification: $note"
  if [ "$streak" -ge "$grace" ]; then
    oshal_verify_emit "post-deploy live verification: UNPROVEN on $streak consecutive run(s)$since and the grace for that is SPENT - FAILING this deploy"
    oshal_verify_emit "  Nothing above proved Jarvis answers or that a ticket moves. The stack is deployed and serving;"
    oshal_verify_emit "  what is missing is an identity this gate can prove the product with, and only an operator can mint one:"
    oshal_verify_emit "    1. in a SIGNED-IN cockpit browser session: POST /api/cli-tokens (a session mint records the issuer)"
    oshal_verify_emit "    2. export OSHAL_VERIFY_OPERATOR_PAT='<that token>'   (export, not a bare assignment - it is forwarded by NAME)"
    oshal_verify_emit "    3. bash -c 'source scripts/lib/deploy-verify.sh && oshal_deploy_post_verify'"
    oshal_verify_emit "  docs/runbooks/deploy-parity.md. If this deployment can never carry one, say so with"
    oshal_verify_emit "  OSHAL_DEPLOY_SKIP_LIVE_VERIFY=1 rather than leaving the gate red and ignored."
    return 3
  fi
  oshal_verify_emit "post-deploy live verification: UNPROVEN on $streak consecutive run(s)$since - $((grace - streak)) more before this FAILS the deploy (export OSHAL_VERIFY_OPERATOR_PAT to clear it; docs/runbooks/deploy-parity.md)"
  return 0
}
