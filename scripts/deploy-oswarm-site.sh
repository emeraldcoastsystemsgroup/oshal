#!/usr/bin/env bash
#
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — deploy site/oswarm.ai to Cloudflare Pages (project 'oswarm-ai'). Stages a clean public dir (index.html + assets only; README.md never ships), deploys via wrangler, then VERIFIES prod serves the page + both screenshots before reporting success — the same verify-before-claiming-success gate publish-agenticfederal-recap.ps1 uses. Deploy is from the WORKING TREE: a git push does NOT publish.
# 2 | maintainer@emeraldcoastsystemsgroup.com   | Verify marker "PRE-RELEASE" -> "AGPL-3.0": the launch made pre-release false, and the page now states the real license (it said MIT in seven places; the project is AGPL-3.0-or-later).
# 3 | maintainer@emeraldcoastsystemsgroup.com   | Stage + hash-verify /lab (the nightly Strategy Lab report, written by site-lab-report.js). Optional on purpose: a tree without a generated report still deploys the main site.
# 5 | maintainer@emeraldcoastsystemsgroup.com   | Generate, stage and hash-verify /product (the application + platform catalog). Its data island is regenerated from the kernel manifests AND the store trunk on every deploy, so the catalog can never drift the way the index grid did when it advertised 7 apps against 54 live.
# 4 | maintainer@emeraldcoastsystemsgroup.com   | Make the wrangler deploy non-interactive (CI=true, WRANGLER_SEND_METRICS=false) and bound it with `timeout 420`. wrangler 4.114.0 re-armed the first-run metrics-consent prompt, which has no TTY to answer in the hidden nightly task — the deploy hung indefinitely and three days of wedged runs starved the Docker host into an OOM crash loop that took the whole local swarm down. The timeout guarantees a wedge fails loud instead of piling up.
#
# Usage: bash scripts/deploy-oswarm-site.sh
# Exit 0 = deployed AND verified. Non-zero = the real error (nothing is claimed live).
#
# Custom domain: oswarm.ai is attached to this Pages project in the Cloudflare
# dashboard (wrangler has no `pages domain` subcommand). Deploys inherit it.

set -euo pipefail

PROJECT="oswarm-ai"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/site/oswarm.ai"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

note() { echo "[deploy-oswarm] $*"; }
fail() { echo "[deploy-oswarm] FAILED: $*" >&2; exit 1; }

[ -f "$SRC/index.html" ] || fail "missing $SRC/index.html"

# 0) Regenerate the app grid from swarm-apps/*.yaml, so the site can never drift from what is
#    actually live (it used to hand-list 12 apps while 32 were shipping). The generator PRINTS what
#    it publishes and what it deliberately withholds (internal + business apps) — read that output:
#    a NEW app publishes automatically unless it is added to PRIVATE_APPS in the script.
note "regenerating the app catalog from swarm-apps/ ..."
node "$(dirname "${BASH_SOURCE[0]}")/site-apps-catalog.js" || fail "app-catalog generation failed"

# 0b) Regenerate the /product catalog island. Same anti-drift reasoning, wider source: it reads the
#     kernel manifests AND the sibling store trunk, which is why it can show the whole catalog where
#     the index grid only ever saw swarm-apps/. It prints what it publishes and what it withholds —
#     read that line. If the store trunk is not checked out it WARNS and leaves the committed island
#     alone (never shrinks the public catalog), so a fresh clone still deploys the site.
note "regenerating the product catalog from the manifests + store trunk ..."
node "$(dirname "${BASH_SOURCE[0]}")/site-product-page.js" || fail "product-catalog generation failed"

# 1) Stage only what should be public. README.md is repo-internal and must not ship.
note "staging public files..."
mkdir -p "$STAGE/assets"
cp "$SRC/index.html" "$STAGE/index.html"
# The downloadable Windows installer + the Pages _headers that force it to download
# (text-ish types render in the browser otherwise). Source of truth for the .bat is the
# repo ROOT; staging from there keeps exactly one copy.
cp "$SRC/../../Install-OSHAL.bat" "$STAGE/Install-OSHAL.bat"
cp "$SRC/_headers" "$STAGE/_headers"
cp "$SRC"/assets/*.png "$STAGE/assets/" 2>/dev/null || fail "no screenshots in $SRC/assets"
# The nightly Strategy Lab report (site-lab-report.js writes it; the publish task regenerates it
# before every deploy). Optional on purpose: a deploy from a tree where the generator has never
# run still ships the main site — it must not fail on a missing report.
if [ -f "$SRC/lab/index.html" ]; then
  mkdir -p "$STAGE/lab"
  cp "$SRC/lab/index.html" "$STAGE/lab/index.html"
  note "staged /lab (nightly strategy report)"
fi
# The product catalog. NOT optional (unlike /lab): it is a committed page and the index links to it,
# so a deploy that silently dropped it would publish a dead nav link.
[ -f "$SRC/product/index.html" ] || fail "missing $SRC/product/index.html"
mkdir -p "$STAGE/product"
cp "$SRC/product/index.html" "$STAGE/product/index.html"
note "staged /product (application + platform catalog)"

# 2) Deploy. Force wrangler NON-INTERACTIVE and time-bounded. In the hidden nightly scheduled task
#    there is no TTY, so wrangler's first-run "send usage metrics?" consent prompt (re-armed by the
#    4.114.0 version bump on 2026-07-22) blocked forever waiting for input — three days of hung
#    deploys piled up and starved the Docker host into an OOM crash loop. CI=true +
#    WRANGLER_SEND_METRICS=false suppress every interactive prompt; the timeout is the guard that
#    makes a wedge fail LOUD (exit 124) instead of hanging indefinitely. Auth is unchanged — still
#    wrangler's own OAuth profile, never a token in the repo.
note "deploying to Cloudflare Pages project '$PROJECT'..."
CI=true WRANGLER_SEND_METRICS=false timeout 420 \
  npx wrangler pages deploy "$STAGE" --project-name="$PROJECT" --branch=main --commit-dirty=true \
  || fail "wrangler pages deploy failed or timed out after 420s (check auth: CI=true npx wrangler whoami)"

# 3) VERIFY prod before claiming success.
#    The PRIMARY gate is a byte-hash match between the file we staged and the file prod serves. The
#    edge briefly serves the PREVIOUS deployment after `wrangler pages deploy` returns, so any check
#    that only looks at content ("does the page contain X?") can pass against the OLD build — which
#    is how a removed screenshot verified as present. Hash-match proves we are looking at THIS build.
BASE="https://${PROJECT}.pages.dev"
MARKERS=("Run the swarm" "Own the stack" "AGPL-3.0")
STAGED_SHA="$(sha256sum "$STAGE/index.html" | cut -d' ' -f1)"
SERVED="$STAGE/.served.html"
note "verifying $BASE (expecting sha256 ${STAGED_SHA:0:12}…) ..."
ok=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
  code="$(curl -s -o "$SERVED" -w '%{http_code}' -L --max-time 25 "$BASE/" || true)"
  if [ "$code" != "200" ]; then
    note "  edge returned HTTP $code — retrying in 8s"; sleep 8; continue
  fi
  served_sha="$(sha256sum "$SERVED" | cut -d' ' -f1)"
  if [ "$served_sha" != "$STAGED_SHA" ]; then
    note "  edge still serving a different build (${served_sha:0:12}…) — retrying in 8s"; sleep 8; continue
  fi
  ok=1; break
done
[ -n "$ok" ] || fail "prod verify: $BASE/ never served the build we just staged (sha256 $STAGED_SHA)"

body="$(cat "$SERVED")"
for marker in "${MARKERS[@]}"; do
  # Native bash substring match — no subprocess. Do NOT use grep here: `echo "$body" | grep -q`
  # trips `set -o pipefail` (grep exits early, echo takes SIGPIPE 141 -> pipeline "fails" on a
  # MATCH), and `grep <<< "$body"` SIGABRTs on msys/Git-Bash with a body this size. Both produced
  # false "page missing <marker>" failures on a page that was serving correctly.
  [[ "$body" == *"$marker"* ]] || fail "prod verify: served build is missing '$marker'"
done

# Verify every asset the SERVED page actually references — never a hardcoded list. A stale list
# silently passes on assets the current page no longer uses.
assets="$(grep -o 'src="assets/[^"]*"' "$SERVED" | sed 's/src="//;s/"//' | sort -u || true)"   # || true: zero matches must reach the diagnostic below, not die under set -e
[ -n "$assets" ] || fail "prod verify: served page references no assets (expected screenshots)"
count=0
while IFS= read -r a; do
  # Assert CONTENT-TYPE, not just status. Pages serves the index page (HTTP 200, text/html) for any
  # unknown /assets/* path, so a status-only check passes on a MISSING image. Verified: a file that
  # never existed returns 200 text/html.
  meta="$(curl -s -o /dev/null -w '%{http_code} %{content_type}' -L --max-time 25 "$BASE/$a" || true)"
  code="${meta%% *}"; ctype="${meta#* }"
  [ "$code" = "200" ] || fail "prod verify: referenced asset $a returned HTTP $code"
  case "$ctype" in
    image/*) : ;;
    *) fail "prod verify: $a served as '$ctype' (not an image) — the file is missing from the deploy" ;;
  esac
  note "  asset ok: $a ($ctype)"
  count=$((count + 1))
done <<< "$assets"

note "VERIFIED: $BASE serves the page and all $count referenced asset(s)"

# 4b) Hash-verify /product (same edge-lag rationale as the index gate). Required, not conditional.
#     The marker is the data island's id, not a sentence: editorial copy on that page is expected to
#     change, but a build that lost the island renders an empty catalog and must fail the deploy.
PROD_SHA="$(sha256sum "$STAGE/product/index.html" | cut -d' ' -f1)"
PROD_SERVED="$STAGE/.served-product.html"
prod_ok=""
note "verifying $BASE/product/ (expecting sha256 ${PROD_SHA:0:12}…) ..."
for _ in 1 2 3 4 5 6 7 8; do
  code="$(curl -s -o "$PROD_SERVED" -w '%{http_code}' -L --max-time 25 "$BASE/product/" || true)"
  if [ "$code" = "200" ] && [ "$(sha256sum "$PROD_SERVED" | cut -d' ' -f1)" = "$PROD_SHA" ]; then prod_ok=1; break; fi
  note "  /product/ not serving this build yet (HTTP $code) — retrying in 8s"; sleep 8
done
[ -n "$prod_ok" ] || fail "prod verify: $BASE/product/ never served the catalog we staged"
prod_body="$(cat "$PROD_SERVED")"
[[ "$prod_body" == *'id="product-data"'* ]] || fail "prod verify: /product/ build has lost its catalog data island"
note "VERIFIED: $BASE/product/ serves the catalog"

# 5) When the lab report was staged, hash-verify it too (same edge-lag rationale as the index gate).
if [ -f "$STAGE/lab/index.html" ]; then
  LAB_SHA="$(sha256sum "$STAGE/lab/index.html" | cut -d' ' -f1)"
  LAB_SERVED="$STAGE/.served-lab.html"
  lab_ok=""
  note "verifying $BASE/lab/ (expecting sha256 ${LAB_SHA:0:12}…) ..."
  for _ in 1 2 3 4 5 6 7 8; do
    code="$(curl -s -o "$LAB_SERVED" -w '%{http_code}' -L --max-time 25 "$BASE/lab/" || true)"
    if [ "$code" = "200" ] && [ "$(sha256sum "$LAB_SERVED" | cut -d' ' -f1)" = "$LAB_SHA" ]; then lab_ok=1; break; fi
    note "  /lab/ not serving this build yet (HTTP $code) — retrying in 8s"; sleep 8
  done
  [ -n "$lab_ok" ] || fail "prod verify: $BASE/lab/ never served the report we staged"
  lab_body="$(cat "$LAB_SERVED")"
  [[ "$lab_body" == *"Strategy Lab"* ]] || fail "prod verify: /lab/ build is missing the report marker"
  note "VERIFIED: $BASE/lab/ serves tonight's report"
fi
note "DONE"
