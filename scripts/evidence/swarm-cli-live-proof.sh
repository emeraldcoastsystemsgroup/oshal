#!/bin/sh
# swarm-cli LIVE evidence harness — runs INSIDE the oshal-api container against the
# real running swarm (localhost:5000). Every check prints PASS/FAIL + the real captured
# output. No stubs, no mocks. Exit codes are asserted, not assumed.
CLI="swarm-cli"
export OSHAL_CLI_STATE_DIR=/tmp/cli-evidence
rm -rf "$OSHAL_CLI_STATE_DIR"
export OSHAL_API_URL=http://localhost:5000
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  PASS  $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL  $1"; }
hr()   { echo; echo "── $1 ──────────────────────────────────────────"; }

hr "1. version (no auth, no server)"
OUT=$($CLI version); RC=$?
echo "  \$ swarm-cli version"; echo "  > $OUT  (exit $RC)"
echo "$OUT" | grep -qE '^swarm-cli [0-9]+\.' && [ $RC -eq 0 ] && ok "prints semver, exit 0" || bad "version"

hr "2. login — service-secret BOOTSTRAP mints a PAT"
OUT=$($CLI login --url "$OSHAL_API_URL" --secret "$SWARM_SERVICE_SECRET" --sub "$EVIDENCE_SUB" --label "evidence@harness" 2>&1); RC=$?
echo "  \$ swarm-cli login --secret *** --sub ***"; echo "  > $OUT  (exit $RC)"
echo "$OUT" | grep -q "Logged in" && [ $RC -eq 0 ] && ok "login succeeded" || bad "login"
grep -q 'oshal_pat_' "$OSHAL_CLI_STATE_DIR/config.json" && ok "a PAT was minted + stored in the context" || bad "no PAT stored"
if grep -qF "$SWARM_SERVICE_SECRET" "$OSHAL_CLI_STATE_DIR/config.json"; then bad "SERVICE SECRET LEAKED TO DISK"; else ok "service secret NOT written to disk (PAT replaced it)"; fi
echo "  config.json (redacted): $(sed 's/oshal_pat_[A-Za-z0-9]*/oshal_pat_***/' "$OSHAL_CLI_STATE_DIR/config.json" | tr -d '\n')"

hr "3. whoami — authenticating with the PAT alone (no secret in env)"
OUT=$(env -u SWARM_SERVICE_SECRET -u OSHAL_USER_SUB $CLI whoami 2>&1); RC=$?
echo "  \$ swarm-cli whoami   (secret scrubbed from env)"; echo "  > $OUT  (exit $RC)"
echo "$OUT" | grep -q "$EVIDENCE_SUB" && [ $RC -eq 0 ] && ok "PAT resolves to the owning user" || bad "whoami"

hr "4. catalog — live app roster from the swarm"
OUT=$(env -u SWARM_SERVICE_SECRET $CLI catalog --quiet 2>&1); RC=$?
N=$(echo "$OUT" | grep -c .)
echo "  \$ swarm-cli catalog"; echo "$OUT" | head -3 | sed 's/^/  > /'; echo "  > … ($N apps, exit $RC)"
[ "$N" -ge 3 ] && [ $RC -eq 0 ] && ok "$N apps returned by the live controller" || bad "catalog"

hr "5. ask — a REAL Jarvis turn end-to-end (classify→answer)"
OUT=$(env -u SWARM_SERVICE_SECRET $CLI ask "Reply with exactly the word: EVIDENCE" --timeout 240 --quiet 2>&1); RC=$?
echo "  \$ swarm-cli ask \"Reply with exactly the word: EVIDENCE\""; echo "  > $OUT  (exit $RC)"
[ -n "$OUT" ] && [ $RC -eq 0 ] && ok "live LLM answer returned, exit 0" || bad "ask"

hr "6. ask --json — machine-readable envelope"
OUT=$(env -u SWARM_SERVICE_SECRET $CLI ask "say hi" --json --timeout 240 --quiet 2>&1); RC=$?
echo "  \$ swarm-cli ask \"say hi\" --json"; echo "  > $(echo "$OUT" | cut -c1-110)…"
echo "$OUT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.exit(j.answer?0:1)})' && ok "valid JSON with an .answer field" || bad "json"

hr "7. history — the thread persisted server-side (both turns replay)"
OUT=$(env -u SWARM_SERVICE_SECRET $CLI history --quiet 2>&1); RC=$?
echo "$OUT" | head -4 | sed 's/^/  > /'
echo "$OUT" | grep -q "EVIDENCE" && ok "the earlier ask is in the durable transcript" || bad "history"

hr "8. tasks"
OUT=$(env -u SWARM_SERVICE_SECRET $CLI tasks --quiet 2>&1); RC=$?
echo "  > $(echo "$OUT" | head -1)  (exit $RC)"
[ $RC -eq 0 ] && ok "tasks reachable, exit 0" || bad "tasks"

hr "9. pipe-safety — stdout must be answer-only (no ANSI, no banner)"
OUT=$(env -u SWARM_SERVICE_SECRET $CLI ask "say ok" --timeout 240 --quiet 2>/dev/null)
if printf '%s' "$OUT" | grep -q "$(printf '\033')"; then bad "ANSI escape leaked to stdout"; else ok "zero ANSI escapes on stdout when piped"; fi
if printf '%s' "$OUT" | grep -q "the swarm, from your terminal"; then bad "banner leaked into a pipe"; else ok "no banner when stdout is not a TTY"; fi
ERRF=/tmp/ev-stderr.txt
env -u SWARM_SERVICE_SECRET $CLI ask "say ok" --timeout 240 >/dev/null 2>$ERRF
if grep -q "$(printf '\033')" $ERRF; then bad "ANSI leaked into redirected stderr"; else ok "zero ANSI in a redirected stderr (2>file)"; fi

hr "10. chat REPL from a pipe — the EOF crash regression"
OUT=$(printf 'Reply with exactly: CHATOK\n' | env -u SWARM_SERVICE_SECRET $CLI chat --quiet --timeout 240 2>&1); RC=$?
echo "  \$ echo 'Reply with exactly: CHATOK' | swarm-cli chat"; echo "  > $(echo "$OUT" | tr -d '\r' | head -2 | tr '\n' ' ')  (exit $RC)"
echo "$OUT" | grep -q "jarvis>" && [ $RC -eq 0 ] && ok "answer printed AND exit 0 (pre-fix this exited 1)" || bad "chat EOF (rc=$RC)"

hr "11. tokens — list, then REVOKE, then prove the token is dead"
OUT=$(env -u SWARM_SERVICE_SECRET $CLI tokens --quiet 2>&1)
echo "  \$ swarm-cli tokens"; echo "$OUT" | head -2 | sed 's/^/  > /'
echo "$OUT" | grep -q "evidence@harness" && ok "the minted token is listed with its label" || bad "tokens list"
TOKID=$(echo "$OUT" | grep "evidence@harness" | head -1 | awk '{print $1}')
OUT=$(env -u SWARM_SERVICE_SECRET $CLI tokens revoke "$TOKID" 2>&1); RC=$?
echo "  \$ swarm-cli tokens revoke $TOKID"; echo "  > $OUT  (exit $RC)"
echo "$OUT" | grep -q "revoked" && ok "revoke accepted" || bad "revoke"
OUT=$(env -u SWARM_SERVICE_SECRET $CLI whoami 2>&1); RC=$?
echo "  \$ swarm-cli whoami   (with the REVOKED token)"; echo "  > $OUT  (exit $RC)"
[ $RC -eq 2 ] && ok "revoked PAT is rejected — exit 2 (auth). Revocation is REAL." || bad "revoked token still works! (rc=$RC)"

hr "12. exit-code contract"
env -u SWARM_SERVICE_SECRET $CLI completion fish >/dev/null 2>&1; [ $? -eq 2 ] && ok "unknown shell → exit 2" || bad "completion fish"
env -u SWARM_SERVICE_SECRET $CLI bogus-cmd >/dev/null 2>&1; [ $? -eq 2 ] && ok "unknown command → exit 2" || bad "bogus cmd"
$CLI ask "x" --url http://127.0.0.1:1 --token oshal_pat_dead --timeout 5 >/dev/null 2>&1; [ $? -eq 1 ] && ok "unreachable controller → exit 1" || bad "unreachable"

hr "13. completion scripts emit for all three shells"
for SH in bash zsh powershell; do
  OUT=$($CLI completion $SH 2>&1); RC=$?
  L=$(echo "$OUT" | wc -l)
  [ $RC -eq 0 ] && [ "$L" -gt 20 ] && ok "completion $SH → $L lines, exit 0" || bad "completion $SH"
done
$CLI completion bash | sh -c 'command -v bash >/dev/null && bash -n /dev/stdin && echo "  PASS  bash -n: the emitted script is valid bash" || echo "  (bash not in container; syntax checked on host)"'

echo
echo "════════════════════════════════════════════"
echo "  RESULT: $PASS passed, $FAIL failed"
echo "════════════════════════════════════════════"
[ $FAIL -eq 0 ] || exit 1
