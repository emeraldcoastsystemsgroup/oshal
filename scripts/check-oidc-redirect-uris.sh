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
# 3 | maintainer@emeraldcoastsystemsgroup.com   | Fail closed. "REGISTERED" is exactly "Google answered and said
#                     |                             | nothing was wrong" — the same shape a dead network, a DNS
#                     |                             | failure, or an empty OIDC_CLIENT_ID faked, because curl errors
#                     |                             | were discarded unchecked. A transport failure now prints
#                     |                             | PROBE-FAILED for that host and the script exits 1; a missing
#                     |                             | client id or zero hosts aborts with usage on exit 2. Controls
#                     |                             | need a real TLD: Google rejects RFC-2606 reserved TLDs
#                     |                             | (.invalid/.example) as malformed (ERROR:invalid_request)
#                     |                             | before ever checking registration.
# 4 | maintainer@emeraldcoastsystemsgroup.com   | Microsoft mode for multi-provider login (ADR-126):
#                     |                             | `-p microsoft` probes https://<host>/callback/microsoft against
#                     |                             | the Entra authorize endpoint (MICROSOFT_OIDC_CLIENT_ID +
#                     |                             | MICROSOFT_TENANT_ID from .env) with prompt=none. Live-validated
#                     |                             | design: a plain GET does NOT validate server-side (bad client,
#                     |                             | bad redirect, and a registered URI all render the same page, no
#                     |                             | AADSTS discriminator). With prompt=none Entra must deliver the
#                     |                             | silent-sign-in error TO the redirect URI, which it only does for
#                     |                             | a registered one: 302 whose Location is the probed URI is proof
#                     |                             | of registration; the inline 200 error page means unregistered OR
#                     |                             | a wrong client id (Entra hides which — verdict says so, never a
#                     |                             | false REGISTERED). MS_PROBE_PATH overrides the probed path to
#                     |                             | validate the probe itself against a known-registered URI.

set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PROVIDER="google"
if [ "${1:-}" = "-p" ]; then
  PROVIDER="${2:-}"
  shift 2 || true
fi

usage() {
  echo "usage: $(basename "$0") [-p google|microsoft] <host> [host ...]" >&2
  echo "  google (default): probes https://<host>/callback" >&2
  echo "  microsoft:        probes https://<host>/callback/microsoft" >&2
  exit 2
}

envval() { grep -m1 "^$1=" "$REPO_ROOT/.env" 2>/dev/null | cut -d= -f2- | tr -d '\r\n'; }

case "$PROVIDER" in
  google)
    CID=$(envval OIDC_CLIENT_ID)
    if [ -z "$CID" ]; then
      echo "ERROR: no OIDC_CLIENT_ID in ${REPO_ROOT}/.env — the probe cannot run without it" >&2
      exit 2
    fi
    ;;
  microsoft)
    CID=$(envval MICROSOFT_OIDC_CLIENT_ID)
    TENANT=$(envval MICROSOFT_TENANT_ID)
    if [ -z "$TENANT" ]; then
      # Fall back to extracting the tenant from an explicit issuer URL.
      TENANT=$(envval MICROSOFT_OIDC_ISSUER_URL | sed -n 's|.*login\.microsoftonline\.com/\([^/]*\)/v2\.0.*|\1|p')
    fi
    if [ -z "$CID" ] || [ -z "$TENANT" ]; then
      echo "ERROR: microsoft mode needs MICROSOFT_OIDC_CLIENT_ID and MICROSOFT_TENANT_ID (or MICROSOFT_OIDC_ISSUER_URL) in ${REPO_ROOT}/.env" >&2
      exit 2
    fi
    ;;
  *) usage ;;
esac

if [ "$#" -eq 0 ]; then
  usage
fi

# One verdict per host: REGISTERED | NOT-REGISTERED | ERROR:<reason> | PROBE-FAILED:<why>.
# A nonzero return means the probe itself failed (transport), never a finding about the host.
probe_google() {
  local host="$1"
  local ru; ru=$(printf 'https://%s/callback' "$host" | sed 's|:|%3A|g; s|/|%2F|g')
  local body
  if ! body=$(curl -sS --max-time 20 \
    "https://accounts.google.com/o/oauth2/v2/auth?client_id=${CID}&scope=openid%20profile%20email&response_type=code&redirect_uri=${ru}&nonce=probe&state=probe" 2>/dev/null); then
    echo "PROBE-FAILED:curl"; return 1
  fi
  if [ -z "$body" ]; then
    echo "PROBE-FAILED:empty-response"; return 1
  fi
  local enc; enc=$(printf '%s' "$body" | grep -oE 'authError=[A-Za-z0-9_-]+' | head -1 | cut -d= -f2)
  if [ -z "$enc" ]; then echo "REGISTERED"; return 0; fi
  # URL-safe base64 -> standard, pad, decode; the reason is the leading ASCII token.
  local dec; dec=$(printf '%s' "$enc" | tr '_-' '/+' | base64 -d 2>/dev/null | tr -cd '\11\12\15\40-\176')
  if printf '%s' "$dec" | grep -qi "redirect_uri_mismatch"; then echo "NOT-REGISTERED"; else echo "ERROR:$(printf '%s' "$dec" | head -c 40)"; fi
}

# prompt=none forces server-side validation: Entra may only deliver the silent-sign-in
# error to a REGISTERED redirect URI, so a 302 whose Location is the probed URI is proof
# of registration. The inline 200 error page means the URI is unregistered OR the client
# id is wrong — Entra deliberately renders the identical page for both (live-checked
# against a bogus client id AND a bogus URI), so the verdict names the ambiguity instead
# of ever reporting a false REGISTERED. MS_PROBE_PATH (default /callback/microsoft) lets
# you point the probe at a URI you KNOW is registered to validate the probe itself.
probe_microsoft() {
  local host="$1"
  local target="https://${host}${MS_PROBE_PATH:-/callback/microsoft}"
  local ru; ru=$(printf '%s' "$target" | sed 's|:|%3A|g; s|/|%2F|g')
  local resp
  if ! resp=$(curl -sS -i --max-time 20 \
    "https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize?client_id=${CID}&scope=openid%20profile%20email&response_type=code&redirect_uri=${ru}&nonce=probe&state=probe&prompt=none" 2>/dev/null); then
    echo "PROBE-FAILED:curl"; return 1
  fi
  if [ -z "$resp" ]; then
    echo "PROBE-FAILED:empty-response"; return 1
  fi
  local status; status=$(printf '%s' "$resp" | head -1 | grep -oE '[0-9]{3}' | head -1)
  local loc; loc=$(printf '%s' "$resp" | grep -iE '^location:' | head -1 | sed 's/^[Ll]ocation:[[:space:]]*//' | tr -d '\r')
  case "$status" in
    302|303)
      case "$loc" in
        "$target"|"$target"\?*) echo "REGISTERED"; return 0 ;;
        *) echo "ERROR:redirected-elsewhere:$(printf '%s' "$loc" | head -c 60)"; return 0 ;;
      esac ;;
    200) echo "NOT-REGISTERED-OR-BAD-CLIENT"; return 0 ;;
    *) echo "ERROR:http-${status:-none}"; return 0 ;;
  esac
}

FAILED=0
for h in "$@"; do
  verdict=$("probe_${PROVIDER}" "$h") || FAILED=1
  printf "%-38s %s\n" "$h" "$verdict"
done
exit "$FAILED"
