#!/usr/bin/env bash
#
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — deploy site/oswarm.ai to Cloudflare Pages (project 'oswarm-ai'). Stages a clean public dir (index.html + assets only; README.md never ships), deploys via wrangler, then VERIFIES prod serves the page + both screenshots before reporting success — the same verify-before-claiming-success gate publish-agenticfederal-recap.ps1 uses. Deploy is from the WORKING TREE: a git push does NOT publish.
# 2 | maintainer@emeraldcoastsystemsgroup.com   | Verify marker "PRE-RELEASE" -> "AGPL-3.0": the launch made pre-release false, and the page now states the real license (it said MIT in seven places; the project is AGPL-3.0-or-later).
# 3 | maintainer@emeraldcoastsystemsgroup.com   | Stage + hash-verify /lab (the nightly Strategy Lab report, written by site-lab-report.js). Optional on purpose: a tree without a generated report still deploys the main site.
# 4 | maintainer@emeraldcoastsystemsgroup.com   | Make the wrangler deploy non-interactive (CI=true, WRANGLER_SEND_METRICS=false) and bound it with `timeout 420`. wrangler 4.114.0 re-armed the first-run metrics-consent prompt, which has no TTY to answer in the hidden nightly task — the deploy hung indefinitely and three days of wedged runs starved the Docker host into an OOM crash loop that took the whole local swarm down. The timeout guarantees a wedge fails loud instead of piling up.
# 5 | maintainer@emeraldcoastsystemsgroup.com   | Generate, stage and hash-verify /product (the application + platform catalog). Its data island is regenerated from the kernel manifests AND the store trunk on every deploy, so the catalog can never drift the way the index grid did when it advertised 7 apps against 54 live.
# 6 | maintainer@emeraldcoastsystemsgroup.com   | Stage and hash-verify the /product + /platform PAGE TREES, not a single page. The one-page catalog it replaces had no URL per app to share or index; the tree is copied whole (a hand-listed set of ~70 pages rots on the next app) and verified one-of-each-shape: hub, shelf, deep app page and platform topic, so a deploy that shipped the hub and dropped the rest fails.
# 7 | maintainer@emeraldcoastsystemsgroup.com   | Stage and hash-verify /create, the hand-authored Create studio landing page (the product front door for create.oshal.ai). Required like the page trees: the address is printed on the studio itself, so a deploy that dropped it would ship a dead link.
# 8 | maintainer@emeraldcoastsystemsgroup.com   | Delegate to the curated launch source in oshal-kernel (marketing_videos/v2/oswarm_site/src/deploy.py); the legacy generator would overwrite the launch with the old brand, so it no longer runs, and the entry point fails closed when that source is missing.
#
# Open Swarm public site. The curated film launch supersedes the legacy catalog.
# Existing callers, including scheduled publication, use this same entry point.
# No legacy generator is run: it would overwrite the launch with the old brand.
set -euo pipefail
OSWARM_LEGACY_REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OSWARM_PROJECTS_ROOT="$(dirname "$OSWARM_LEGACY_REPO")"
OSWARM_LAUNCH_SOURCE="${OSWARM_SITE_SOURCE:-$OSWARM_PROJECTS_ROOT/oshal-kernel/marketing_videos/v2/oswarm_site}"
if [ ! -f "$OSWARM_LAUNCH_SOURCE/src/deploy.py" ]; then
  echo "Open Swarm launch source is missing: $OSWARM_LAUNCH_SOURCE" >&2
  echo "Set OSWARM_SITE_SOURCE to the curated launch checkout. The legacy site will not be republished." >&2
  exit 1
fi
exec python3 "$OSWARM_LAUNCH_SOURCE/src/deploy.py"
