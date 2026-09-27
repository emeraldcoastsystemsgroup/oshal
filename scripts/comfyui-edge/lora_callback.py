# Box-side signer for the LoRA Studio callback grant (store package `lora` 1.6.0+). The controller
# mints one grant per dispatch and the worker's shell task receives it in the
# OSHAL_LORA_CALLBACK_GRANT environment variable as "<grant id>.<secret>". train-lora.py,
# validate-lora.py and overnight-loop.py sign every callback to /api/lora/ingest with it; nested
# steps inherit it through the environment, so it never appears in any script's argv.
#
# The contract (shared with the package verifier, lora/src-routes/lora-callback-grants.ts):
#   key       = SHA-256("oshal-lora-callback-grant-v1:" + secret)
#   signature = hex HMAC-SHA256(key, METHOD|path?query|unix seconds|nonce|hex SHA-256(body))
#   headers   = x-lora-callback-grant, x-lora-callback-owner (base64url owner sub),
#               x-lora-callback-timestamp, x-lora-callback-nonce, x-lora-callback-signature
#   JSON callbacks travel as application/vnd.oshal.lora-callback+json, so the controller hashes
#   the exact bytes signed here. Every request gets a fresh nonce; the controller records each
#   nonce once and refuses a repeat.
#
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                                    | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Sign LoRA worker callbacks with the per-dispatch
#     grant instead of the fleet SWARM_SERVICE_SECRET. One implementation of the header contract
#     for all three callback scripts, so the box and the controller verifier cannot drift apart
#     script by script.
import hashlib
import hmac
import json
import os
import re
import secrets
import time
import urllib.parse
import urllib.request

GRANT_ENV = "OSHAL_LORA_CALLBACK_GRANT"
CALLBACK_CONTENT_TYPE = "application/vnd.oshal.lora-callback+json"
KEY_DOMAIN = "oshal-lora-callback-grant-v1:"
_GRANT_RE = re.compile(r"^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$")


def load_grant(environ=None):
    """
    @description Read this task's callback grant from the environment the dispatcher set.
    @param environ - Mapping to read (defaults to os.environ).
    @returns (grant_id, secret), or None when absent or malformed - a script with no grant keeps
      its results locally rather than calling back unauthenticated.
    """
    raw = (environ if environ is not None else os.environ).get(GRANT_ENV, "")
    match = _GRANT_RE.match(raw or "")
    return (match.group(1), match.group(2)) if match else None


def _target(url):
    """The request target exactly as urllib sends it: path plus the raw query string."""
    parts = urllib.parse.urlsplit(url)
    return (parts.path or "/") + ("?" + parts.query if parts.query else "")


def signed_headers(grant, owner_sub_b64, method, url, body=b"", now=None, nonce=None):
    """
    @description The five contract headers for one request.
    @param grant - (grant_id, secret) from load_grant().
    @param owner_sub_b64 - The initiating owner, canonical base64url (from --owner-sub-b64).
    @param method - HTTP method.
    @param url - The full URL the request goes to.
    @param body - The exact body bytes (empty for a GET).
    @param now - Optional Unix seconds (tests).
    @param nonce - Optional nonce (tests); a fresh random one otherwise.
    @returns A dict of headers.
    """
    grant_id, secret = grant
    key = hashlib.sha256((KEY_DOMAIN + secret).encode("utf-8")).digest()
    timestamp = str(int(now if now is not None else time.time()))
    nonce = nonce or secrets.token_urlsafe(24)
    canonical = "|".join([method.upper(), _target(url), timestamp, nonce, hashlib.sha256(body or b"").hexdigest()])
    return {
        "x-lora-callback-grant": grant_id,
        "x-lora-callback-owner": owner_sub_b64,
        "x-lora-callback-timestamp": timestamp,
        "x-lora-callback-nonce": nonce,
        "x-lora-callback-signature": hmac.new(key, canonical.encode("utf-8"), hashlib.sha256).hexdigest(),
    }


def post_bytes(url, grant, owner_sub_b64, data, content_type, timeout=30):
    """
    @description POST exact bytes under the grant and return the raw response body.
    @param url - Full callback URL, including any query string.
    @param grant - (grant_id, secret).
    @param owner_sub_b64 - Canonical base64url owner.
    @param data - Body bytes.
    @param content_type - Media type of the body.
    @param timeout - Seconds.
    @returns Response bytes; raises on an HTTP or network error.
    """
    headers = signed_headers(grant, owner_sub_b64, "POST", url, data)
    headers["Content-Type"] = content_type
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    return urllib.request.urlopen(req, timeout=timeout).read()


def post_json(controller, grant, owner_sub_b64, payload, timeout=30):
    """
    @description POST one JSON callback to the controller's /api/lora/ingest under the grant.
    @param controller - Controller origin (LORA_CONTROLLER_URL on the dispatch side).
    @param grant - (grant_id, secret).
    @param owner_sub_b64 - Canonical base64url owner.
    @param payload - The callback object.
    @param timeout - Seconds.
    @returns The parsed JSON response; raises on an HTTP or network error.
    """
    url = controller.rstrip("/") + "/api/lora/ingest"
    body = json.dumps(payload).encode("utf-8")
    return json.loads(post_bytes(url, grant, owner_sub_b64, body, CALLBACK_CONTENT_TYPE, timeout) or b"{}")
