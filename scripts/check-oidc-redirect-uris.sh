#!/usr/bin/env bash
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Probe whether https://<host>/callback is a registered
#                     |                             | redirect URI on the deployment's Google OIDC client, without
#                     |                             | touching the Google console. Google answers a BAD redirect_uri
#                     |                             | with a 302 to .../error?authError=<base64> whose payload begins
#                     |                             | "redirect_uri_mismatch"; a GOOD one 302s into the sign-in flow
#                     |                             | with no authError. Validated against known-bogus controls — a
#                     |                             | probe that reports every host "registered" is a broken probe,
#                     |                             | so pass a control host you KNOW is unregistered alongside the
#                     |                             | real ones. Client id comes from the repo .env; nothing secret
#                     |                             | is read or sent (the client id is public by protocol).
# 2 | maintainer@emeraldcoastsystemsgroup.com   | Resolve .env relative to the script's own location instead of a
#                     |                             | hard-coded /c/Projects/oshal so the probe works from any clone.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CID=$(grep -m1 "^OIDC_CLIENT_ID=" "$REPO_ROOT/.env" | cut -d= -f2 | tr -d '\r\n')

probe() {
  local host="$1"
  local ru; ru=$(printf 'https://%s/callback' "$host" | sed 's|:|%3A|g; s|/|%2F|g')
  local body; body=$(curl -sS --max-time 20 \
    "https://accounts.google.com/o/oauth2/v2/auth?client_id=${CID}&scope=openid%20profile%20email&response_type=code&redirect_uri=${ru}&nonce=probe&state=probe" 2>/dev/null)
  local enc; enc=$(printf '%s' "$body" | grep -oE 'authError=[A-Za-z0-9_-]+' | head -1 | cut -d= -f2)
  if [ -z "$enc" ]; then echo "REGISTERED"; return; fi
  # URL-safe base64 -> standard, pad, decode; the reason is the leading ASCII token.
  local dec; dec=$(printf '%s' "$enc" | tr '_-' '/+' | base64 -d 2>/dev/null | tr -cd '\11\12\15\40-\176')
  if printf '%s' "$dec" | grep -qi "redirect_uri_mismatch"; then echo "NOT-REGISTERED"; else echo "ERROR:$(printf '%s' "$dec" | head -c 40)"; fi
}

for h in "$@"; do printf "%-38s %s\n" "$h" "$(probe "$h")"; done
