#!/usr/bin/env bash
# =============================================================================
# CHANGE LOG
# 1 | maintainer@emeraldcoastsystemsgroup.com   | prepare_head_src cache seed: content check (an .onnx present) instead of -d, + SELF-HEAL — when the working tree's transformers cache is missing/EMPTY (any npm install rebuilds @xenova/transformers and wipes it), download MiniLM directly into the export while the gate shell still has network. The empty-dir case sailed past the old -d test and 11 memory/RAG specs redded with a misattributable huggingface error; with dead failure-alerts (fixed today) that state persisted since 07-23 unnoticed.
# 2 | maintainer@emeraldcoastsystemsgroup.com   | gate_trivy honors the repo's .trivyignore (mounted from GATE_SRC — the committed tree the run judges — so an uncommitted local ignore can't quietly pass the scheduled gate). First entry: CVE-2026-14257 (brace-expansion DoS) — upstream fixed ONLY v5.0.8; the minimatch@>=10 copy is override-pinned to it, but the 1.x/2.x copies under eslint/exceljs have NO compatible fixed release (v5's export-shape change breaks minimatch@3/@5 — proven). Quarantine justified in .trivyignore + BACKLOG done-when.
# 3 | maintainer@emeraldcoastsystemsgroup.com   | gate_lint is now BLOCKING (was advisory `|| echo`). The FSD/no-console governance counters reached 0: the 324-warning backlog was burned down (272 deep imports rewritten to slice barrels via 141 new barrel re-exports, 51 console calls converted to the pino logger or justified-disabled, the sanctioned harness second-barrel lint-exempted in eslint.config.mjs). A new deep import or console call now fails the gate. hardening.md #2 closed.
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 4 | maintainer@emeraldcoastsystemsgroup.com   | ADR-115: new `repo-separation` gate. The two-trunk split (swarm repo = platform, store repo = applications) is only real if something enforces it — ADR-085 carved 21 app surfaces out of core and nothing stopped one returning. Runs against GATE_SRC so it judges committed HEAD in --head mode.
# 5 | maintainer@emeraldcoastsystemsgroup.com   | prepare_head_src pre-seeds the @xenova/transformers model cache into the export. The 11-spec memory/RAG e2e family REDDED ONLY IN --head MODE because a fresh npm ci has no local MiniLM model, transformers tries to download it, the specs' global fetch mock blocks huggingface.co, embedding fails, and the BM25 fallback hits an unmocked route. Was misattributed first to ADR-091/pgvector, then to machine load — cache-present vs cache-empty was the real variable.
# 6 | maintainer@emeraldcoastsystemsgroup.com   | gate_e2e now sets MOCK_OIDC_ALLOW_HEADER=true: the two-user-isolation + privacy-export-delete live proofs in the green set SKIPPED without it every night — passing-by-skipping, so the cross-user isolation guard didn't actually exist in CI. The specs now also FAIL (not skip) under CI=true without the env, so the skip can never silently return. Header auth is honored only inside MOCK_OIDC (oidc.ts), so this changes nothing for production.
# 7 | maintainer@emeraldcoastsystemsgroup.com   | e2e datastore image postgres:16-alpine -> pgvector/pgvector:pg16 to MATCH THE LIVE STACK (docker-compose.oshal-local.yml). ADR-091 migrations run CREATE EXTENSION vector; on plain postgres the extension is absent, the migration fails, and 12 RAG/memory e2e specs go red every night against a bug that does not exist in production. CI datastores must track the production image, not a generic one.
# 8 | maintainer@emeraldcoastsystemsgroup.com   | ADR-090 D8: two new gates for the kernel-skill contract. `kernel-skills` (source) asserts every skill the kernel promises packages is re-exported by the build anchor; `kernel-skills-image` probes the BUILT IMAGE for each skill's compiled module. Closes the silent-prune class: tsconfig.server.json excludes src/features/**, so a feature core stops importing vanishes from dist and the first installed package that imports it dies at MOUNT time, far from the cause (this ate google-calendar, then notifications).
# 9 | maintainer@emeraldcoastsystemsgroup.com   | LOCAL CI - operator decision 2026-07-09: GitHub Actions is retired for this repo (billed real money, failed for weeks; workflows disabled + archived to docs/archive/github-actions-retired/). This script runs the same gates on the operator's machine for $0.
# 10 | maintainer@emeraldcoastsystemsgroup.com   | New `worktree-strays` gate (backlog "Seven agent-worktree branches" done-when 3): scripts/check-worktree-strays.sh fails on any linked worktree carrying unpushed commits or uncommitted changes. Worktree isolation made an unpushed agent commit INVISIBLE (the shared index used to surface it by accident); seven branches sat silent 2026-07-24→26, two of them regression guards. Runs against REPO_DIR, not the HEAD export — worktree state is repo plumbing, not tree content.
# 10 | maintainer@emeraldcoastsystemsgroup.com   | e2e gate: --retries=2 --workers=4 (was retries=1, default workers). This is a shared workstation - other agents commit/build while the suite runs, and the flake signatures (context destroyed by navigation, toBeVisible timeouts) tracked machine load, passing 30 min earlier untouched. Trivy tarball now streams into a docker volume (see gate comment).
# 11 | maintainer@emeraldcoastsystemsgroup.com   | Proveout round 2: (1) smoke container joins a private oshal-ci-net and dials the datastores by container name - on Docker Desktop's WSL2 backend host.docker.internal cannot reach 127.0.0.1-bound host ports (shallow /health 200 masked a dead DB); ticket assert retries 3x (health is shallow, migrations settle late). (2) NEW --head mode (implied by --scheduled): node gates run from a clean git-archive HEAD export with its own npm ci - this multi-agent tree is routinely mid-edit (ambient-listening was literally broken mid-run by another agent), and an unattended gate must judge committed code or it emails false alarms.
# 12 | maintainer@emeraldcoastsystemsgroup.com   | First proveout run: ephemeral ports moved 15432/16379 -> 25432/26379 - the LIVE stack's redis is published at 127.0.0.1:16379 (.env OSHAL_REDIS_PORT overrides the compose default 56380), so the CI redis collided; DS_UP now set BEFORE container starts (a partial start leaked oshal-ci-pg past on_exit); INT/TERM also trap to cleanup (bash skips EXIT traps on untrapped fatal signals).
# 13 | maintainer@emeraldcoastsystemsgroup.com   | Hardened per the 10-finding adversarial review before first run: single-instance lock (overlap destroyed e2e datastores); timeouts on every external command (hung trivy pull = invisible zombie); secret-scan runs on a git-archive HEAD export, --network none (working-tree scan tripped on the operator's live .env; unpinned image could exfil it); e2e gate blanks all broker/trading env so dotenv cannot back-fill LIVE keys into the mock-auth test server; datastore ports bound 127.0.0.1 (were LAN-exposed 0.0.0.0); trivy scans a docker-save tarball instead of holding the docker socket; image-smoke gate restores the retired quickstart coverage (image boots + serves + ticket + swarm apps loaded); alert exec fixed (MSYS path mangling silently killed failure emails); scoped dangling-image/builder prune (disk creep threatened the live stack's VM disk).
# 14 | maintainer@emeraldcoastsystemsgroup.com   | ADR-045/ADR-090 closure: pass the store checkout to the kernel-skills gate so its new PHASE 3 (every store package DECLARES the kernel skills its compiled js imports) can actually run. The script autodetects the conventional sibling, but --head mode runs from a temp git-archive export with no sibling, so the path comes from the REAL repo (OSHAL_STORE_DIR overrides). Absent store = the script's loud PHASE 3 SKIPPED line, never a silent pass.
# =============================================================================
#
# Usage:  bash scripts/ci-local.sh [--scheduled] [--head] [--skip-e2e] [--skip-image] [--install]
#   --scheduled   quiet mode for the Windows task: full output to the run log,
#                 email alert on failure only (never on success). Implies --head.
#   --head        run the node gates (typecheck/unit/lint/connectors/manifests/e2e) from a clean
#                 git-archive HEAD export instead of the working tree. In this
#                 multi-agent repo the working tree is routinely mid-edit by
#                 another agent; an unattended gate must judge COMMITTED code
#                 or it emails false alarms about half-typed changes.
#   --skip-e2e    skip the Playwright green-ratchet gate
#   --skip-image  skip image build + image smoke + trivy
#   --install     run `npm ci --legacy-peer-deps` first (working-tree mode only;
#                 the HEAD export always npm-ci's its own node_modules)
#
# Contract:
#   - typecheck/unit/lint/connectors/manifests/e2e test the WORKING TREE; secret-scan and the image
#     gates test committed HEAD (git archive) - commit first for those to see it.
#   - e2e needs port 3456 free (green-set specs hardcode it) and blanks every
#     broker/trading credential so the mock-auth test server can never touch a
#     live account even though src/app/server.ts loads the repo .env.
#   - Exit: 0 = all gates green, 1 = gate failure, 2 = another run holds the lock.
#   - Logs: %LOCALAPPDATA%\oshal\ci-local.log (summary) + ci-local-last-run.log (full).
#
# Register the daily task (10:00 local, windowless):
#   schtasks /create /tn "OSHAL Local CI" /sc daily /st 10:00 /f ^
#     /tr "wscript.exe //B //Nologo C:\Projects\open-shal-swarm-harness-agent-llm\scripts\ci-local-hidden.vbs"
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_WIN="$(cd "$REPO_DIR" && pwd -W 2>/dev/null || echo "$REPO_DIR")"
STATE_DIR="$(cygpath -u "${LOCALAPPDATA:-$HOME/AppData/Local}")/oshal"
LOG="$STATE_DIR/ci-local.log"
RUN_LOG="$STATE_DIR/ci-local-last-run.log"
mkdir -p "$STATE_DIR"

SCHEDULED=0; SKIP_E2E=0; SKIP_IMAGE=0; DO_INSTALL=0; HEAD_MODE=0
for arg in "$@"; do
  case "$arg" in
    --scheduled)  SCHEDULED=1; HEAD_MODE=1 ;;
    --head)       HEAD_MODE=1 ;;
    --skip-e2e)   SKIP_E2E=1 ;;
    --skip-image) SKIP_IMAGE=1 ;;
    --install)    DO_INSTALL=1 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

if [ "$SCHEDULED" = "1" ]; then exec >"$RUN_LOG" 2>&1; else : >"$RUN_LOG"; fi

log() { printf '[%s] %s\n' "$(date +%FT%T)" "$*" | tee -a "$LOG"; }

# Git for Windows ships coreutils timeout; degrade to unbounded if absent.
if ! command -v timeout >/dev/null 2>&1; then timeout() { shift; "$@"; }; fi

# ── Single-instance lock (atomic mkdir). Without it, overlapping runs rm -f
# each other's e2e datastores and share port 3456. Stale (>4h) locks from a
# killed run are stolen - every external call below is timeout-bounded, so a
# legitimate run can never be that old.
LOCK="$STATE_DIR/ci-local.lock"
acquire_lock() {
  if mkdir "$LOCK" 2>/dev/null; then date +%s >"$LOCK/ts"; return 0; fi
  local ts; ts=$(cat "$LOCK/ts" 2>/dev/null || echo 0)
  if [ $(( $(date +%s) - ts )) -gt 14400 ]; then
    rm -rf "$LOCK" && mkdir "$LOCK" 2>/dev/null && { date +%s >"$LOCK/ts"; log "stale lock stolen"; return 0; }
  fi
  return 1
}
acquire_lock || { log "another ci-local run is in progress - exiting"; exit 2; }

# ── Ephemeral e2e/smoke datastores. 127.0.0.1-bound - never LAN-reachable.
# Ports 25432/26379: the LIVE stack publishes its redis at 127.0.0.1:16379
# (.env OSHAL_REDIS_PORT) and pg at 55433/55434 - do not move these onto
# anything the live stack uses. Names are ci-scoped: oshal-local-* containers
# are never touched.
E2E_PG=oshal-ci-pg; E2E_REDIS=oshal-ci-redis; SMOKE=oshal-ci-smoke
CI_NET=oshal-ci-net
CI_PG_PORT=25432; CI_REDIS_PORT=26379
DS_UP=0
# Published 127.0.0.1 ports serve the host-side e2e webServer; the private
# docker network serves the smoke container - on Docker Desktop's WSL2 backend,
# host.docker.internal CANNOT reach 127.0.0.1-bound host ports (proven by the
# first proveout: shallow /health 200, every DB call dead).
start_datastores() {
  docker rm -f "$E2E_PG" "$E2E_REDIS" >/dev/null 2>&1 || true
  docker network create "$CI_NET" >/dev/null 2>&1 || true
  DS_UP=1  # before the starts: a PARTIAL start must still be cleaned by on_exit
  timeout 300 docker run -d --name "$E2E_PG" --network "$CI_NET" \
    -e POSTGRES_DB=oshal -e POSTGRES_USER=oshal -e POSTGRES_PASSWORD=oshal \
    -p 127.0.0.1:${CI_PG_PORT}:5432 pgvector/pgvector:pg16 >/dev/null || return 1
  timeout 300 docker run -d --name "$E2E_REDIS" --network "$CI_NET" \
    -p 127.0.0.1:${CI_REDIS_PORT}:6379 redis:7-alpine >/dev/null || return 1
  local i
  for i in $(seq 1 30); do
    if docker exec "$E2E_PG" pg_isready -U oshal -d oshal >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  log "datastores: ephemeral postgres never became ready"; return 1
}
CLEANED=0
on_exit() {
  [ "$CLEANED" = "1" ] && return 0
  CLEANED=1
  docker rm -f "$SMOKE" oshal-ci-trivy >/dev/null 2>&1 || true
  [ "$DS_UP" = "1" ] && docker rm -f "$E2E_PG" "$E2E_REDIS" >/dev/null 2>&1
  docker network rm "$CI_NET" >/dev/null 2>&1 || true
  docker volume rm oshal-ci-scan >/dev/null 2>&1 || true
  rm -rf "$LOCK"
}
trap on_exit EXIT
# bash does not run EXIT traps on untrapped fatal signals - a killed run would
# leak the lock and containers for 4h (stale-lock window).
trap 'on_exit; exit 130' INT TERM

FAILED_GATES=()
# Runs one gate, records PASS/FAIL, never aborts - a full report of every broken
# gate beats stopping at the first one.
run_gate() {
  local name="$1"; shift
  log "GATE $name: start"
  local t0=$SECONDS
  if "$@"; then log "GATE $name: PASS ($((SECONDS - t0))s)"
  else log "GATE $name: FAIL ($((SECONDS - t0))s)"; FAILED_GATES+=("$name"); fi
}

# GATE_SRC is where the node gates run: the working tree by default, or a clean
# HEAD export in --head/--scheduled mode (multi-agent trees are routinely
# mid-edit; an unattended gate judges committed code).
GATE_SRC="$REPO_DIR"
prepare_head_src() {
  GATE_SRC="$STATE_DIR/ci-src"
  rm -rf "$GATE_SRC"; mkdir -p "$GATE_SRC"
  (cd "$REPO_DIR" && git archive HEAD | tar -x -C "$GATE_SRC") || return 1
  (cd "$GATE_SRC" && timeout 1800 npm ci --legacy-peer-deps) || return 1
  # Pre-seed the @xenova/transformers model cache from the working repo. The memory/RAG
  # e2e specs embed via the chromadb client's DefaultEmbeddingFunction (local ONNX
  # MiniLM); a fresh npm ci has an empty cache, transformers tries to DOWNLOAD the
  # model, and the specs' global fetch mock (rightly) blocks huggingface.co — so
  # embedding fails, the service drops to its BM25 fallback, and 11 specs red on a
  # mock route that fallback path uses. Root-caused 2026-07-19: this family was
  # previously misattributed to ADR-091/pgvector and then to machine load — the real
  # variable was always cache-present (working tree) vs cache-empty (fresh export).
  local xcache="$REPO_DIR/node_modules/@xenova/transformers/.cache"
  # Content check, not -d: any npm install in the working tree rebuilds @xenova/transformers and
  # leaves an EMPTY .cache dir behind — the old -d test then "pre-seeded" nothing and 11 memory/RAG
  # specs redded in the export with a misattributable huggingface fetch error (2026-07-25, again).
  if [ -n "$(find "$xcache" -type f -name '*.onnx' 2>/dev/null | head -1)" ]; then
    cp -r "$xcache" "$GATE_SRC/node_modules/@xenova/transformers/" 2>/dev/null \
      && log "head-src: transformers model cache pre-seeded ($(du -sh "$xcache" 2>/dev/null | cut -f1))"
  else
    # Self-heal: download the model INTO THE EXPORT now, while the gate shell still has network —
    # the huggingface block only exists inside the test process (its global fetch mock).
    log "head-src: transformers cache missing/empty at $xcache - downloading MiniLM into the export"
    (cd "$GATE_SRC" && timeout 600 node -e "const{pipeline}=require('@xenova/transformers');pipeline('feature-extraction','Xenova/all-MiniLM-L6-v2').then((p)=>p('seed',{pooling:'mean'})).then(()=>console.log('model cached into export'))") \
      || log "head-src: WARN model download failed - memory/RAG e2e specs will red"
  fi
}

gate_typecheck() { (cd "$GATE_SRC" && timeout 1200 npm run typecheck); }

gate_unit() { (cd "$GATE_SRC" && timeout 1800 npm run test:unit); }

# Connector structural-audit gate (ADR-065): FAIL on any error-level issue in a
# swarm-apps/connectors/*.yaml spec (bad shape, duplicate tool name, paginating resource
# with no pagination block). Warnings stay advisory. Currently 306 specs, 0 errors.
gate_connectors() {
  (cd "$GATE_SRC" && timeout 300 npx ts-node -r tsconfig-paths/register --transpile-only \
    scripts/connectors/audit-gate.ts --quiet);
}

# Manifest + persona validation gate (ADR-085): every swarm-apps/*.yaml passes the real
# readManifest and each bot's persona path resolves + parses + has a perspective; a boot-breaking
# config fails here, not on the next boot. ADR-083 mis-route cases are advisory warnings.
gate_manifests() {
  (cd "$GATE_SRC" && timeout 300 npx ts-node -r tsconfig-paths/register --transpile-only \
    scripts/validate-manifests.ts --quiet);
}

# Kernel-skill contract, SOURCE half (ADR-090 D8): every skill the kernel promises packages is
# re-exported by the build anchor. tsconfig.server.json excludes src/features/**, so that
# re-export is the ONLY thing carrying a feature into dist — a skill declared but not anchored is
# a skill that gets silently pruned and breaks installed apps at MOUNT time. The image half runs
# after image-build (gate_kernel_skills_image), which is what the done-when actually requires.
#
# Phase 3 (the PACKAGE side: every store package DECLARES the kernel skills its compiled js
# imports) needs the store checkout, which the script cannot autodetect in --head mode because
# GATE_SRC is a temp export with no sibling. Pass it explicitly from the REAL repo's sibling when
# it exists; when it does not, the script prints a loud PHASE 3 SKIPPED line rather than passing
# quietly on an unchecked half.
gate_kernel_skills() {
  local store="${OSHAL_STORE_DIR:-$(cd "$REPO_DIR/.." 2>/dev/null && pwd)/oshal-applications}"
  local store_args=()
  [ -d "$store" ] && store_args=(--store "$store")
  (cd "$GATE_SRC" && timeout 300 npx ts-node -r tsconfig-paths/register --transpile-only \
    scripts/check-kernel-skills.ts --quiet "${store_args[@]+"${store_args[@]}"}");
}

# COST GUARD: every GitHub Actions workflow must be MANUAL-ONLY (workflow_dispatch). Hosted-runner
# minutes are the account's binding constraint, and this has regressed TWICE — per-push CI, then an
# hourly cron that ran ~55 full pipelines/week on the public mirror until it took the account to
# zero. THIS local gate is the automated one, and it is free. Fails on any push/schedule/pull_request.
gate_workflow_triggers() {
  (cd "$GATE_SRC" && timeout 60 node scripts/check-workflow-triggers.js --quiet);
}

# STRUCTURAL GUARD (ADR-115): application code must never mix into the swarm/kernel repo. ADR-085
# carved 21 app surfaces OUT of core and nothing stopped one walking back in; the public core trunk
# is app-free BY CONSTRUCTION, so a re-mixed app is a release-blocking defect discovered at publish
# time. Runs against $GATE_SRC (committed HEAD in --head mode), so it judges what was actually
# pushed. The store half runs too when the sibling checkout is on this box.
gate_repo_separation() {
  (cd "$GATE_SRC" && timeout 120 node scripts/check-repo-separation.js);
}

# Stray-worktree guard (2026-07-29): worktree isolation made an unpushed agent commit
# INVISIBLE — seven sat silent for two days in 2026-07, two of them regression guards.
# Runs against the REPO (not the HEAD export): worktree state is repo plumbing, not tree
# content. Loud on: unpushed commits in a linked worktree, uncommitted changes there,
# or a pruned-on-disk-but-registered worktree.
gate_worktree_strays() {
  (cd "$REPO_DIR" && timeout 60 bash scripts/check-worktree-strays.sh);
}

# BLOCKING (2026-07-24): the governance counters reached 0 (324 warnings burned down —
# FSD deep imports rewritten to slice barrels, no-console converted to the pino logger or
# justified-disabled, harness second-barrel lint-exempt). The gate now FAILS on any new
# warning so the FSD boundary + no-console discipline can't silently regress. To debug a
# failure locally: `npx eslint src` shows the offending imports/console calls.
gate_lint() {
  # eslint 9 flat config (eslint.config.mjs); --ext was removed in v9.
  (cd "$GATE_SRC" && timeout 600 npx eslint src --max-warnings 0) \
    || { log "lint: eslint reported findings (BLOCKING — drive to zero: npx eslint src)"; return 1; }
  return 0
}

# Scan committed HEAD (git-archive export), exactly like the retired checkout-based
# job - NOT the working tree, which holds the operator's live gitignored .env and
# credential files. --network none: gitleaks needs no egress; a compromised
# scanner image gets nothing to exfiltrate and nowhere to send it.
gate_secrets() {
  local exp="$STATE_DIR/ci-scan-src" rc=0
  rm -rf "$exp"; mkdir -p "$exp"
  (cd "$REPO_DIR" && git archive HEAD | tar -x -C "$exp") || { rm -rf "$exp"; return 1; }
  MSYS_NO_PATHCONV=1 timeout 900 docker run --rm --network none \
    -v "$(cygpath -m "$exp"):/scan:ro" \
    zricethezav/gitleaks:latest detect --source=/scan --no-git \
    --config=/scan/.gitleaks.toml --redact || rc=1
  rm -rf "$exp"
  return $rc
}

gate_e2e() {
  if netstat -an | grep -qE "[:.]3456 .*LISTEN"; then
    log "e2e: port 3456 already in use - green-set specs hardcode it. Free it and rerun."
    return 1
  fi
  # Browser preflight: no-op when the matching chromium is present (retired CI parity).
  (cd "$GATE_SRC" && timeout 900 npx playwright install chromium) || return 1
  start_datastores || return 1
  local rc=0
  # The webServer (src/app/server.ts) dotenv-loads the repo's live .env and MOCK_OIDC
  # disables auth, so every broker/trading credential is pinned EMPTY here - dotenv
  # never overrides an existing env var, so the test server cannot reach a live
  # account even while it listens on 3456 for the duration of the gate.
  # ipv4first: on Windows, node resolves localhost -> ::1 first, but the
  # webServer ends up IPv4-only (and this host has a documented history of
  # stale wslrelay squatting ::1 ports) - Playwright's node-side API request
  # contexts then die with ECONNREFUSED ::1:3456 while browser specs pass.
  (cd "$GATE_SRC" && \
    NODE_OPTIONS="--dns-result-order=ipv4first" \
    MOCK_OIDC=true MOCK_OIDC_ALLOW_HEADER=true CI=true FORCE_LLM_PROVIDER=noop RUN_MIGRATIONS=true \
    DATABASE_URL=postgresql://oshal:oshal@127.0.0.1:${CI_PG_PORT}/oshal \
    REDIS_URL=redis://127.0.0.1:${CI_REDIS_PORT} \
    PLAYWRIGHT_PORT=3456 \
    TRADING_LIVE_ENABLED=false TRADING_AUTOPILOT_ENABLED=false \
    TRADING_AUTOPILOT_LIVE=false TRADING_HALT=true \
    ALPACA_KEY_ID= ALPACA_SECRET_KEY= ALPACA_PAPER_KEY_ID= ALPACA_PAPER_SECRET_KEY= \
    SCHWAB_CLIENT_ID= SCHWAB_CLIENT_SECRET= SCHWAB_CLIENT_ID_PRD= SCHWAB_CLIENT_SECRET_PRD= \
    SWARM_SERVICE_SECRET=oshal-ci-ephemeral \
    timeout 3600 npm run test:e2e:green -- --retries=2 --workers=4 --reporter=line) || rc=1
  # Datastores stay up for the image-smoke gate; on_exit removes them.
  return $rc
}

# Build from committed HEAD via git archive - Docker Desktop's cached-COPY-layer
# trap ships stale code when building from the working directory. Scratch tag only.
gate_image() {
  (cd "$REPO_DIR" && git archive HEAD | timeout 2400 docker build -f Dockerfile.oshal -t oshal-ci:latest -)
}

# Kernel-skill contract, IMAGE half (ADR-090 D8 done-when): probe the image that would actually
# ship and assert every declared skill's compiled module is inside it. This is the gate that turns
# the google-calendar/notifications silent-prune bug into a red run instead of a mount-time failure
# in a customer's installed app.
gate_kernel_skills_image() {
  (cd "$GATE_SRC" && timeout 300 npx ts-node -r tsconfig-paths/register --transpile-only \
    scripts/check-kernel-skills.ts --image oshal-ci:latest --quiet);
}

# Restores the retired quickstart-smoke coverage: the built IMAGE (entrypoint,
# baked code - not ts-node source) boots, serves /health + /cockpit/, creates a
# real ticket on the noop path, and swarm apps are loaded. No published ports -
# all probes run inside the container.
gate_smoke() {
  [ "$DS_UP" = "1" ] || start_datastores || return 1
  docker rm -f "$SMOKE" >/dev/null 2>&1 || true
  # Same private network as the datastores: container-DNS names, no
  # host.docker.internal (unreachable for 127.0.0.1-bound ports on WSL2).
  timeout 300 docker run -d --name "$SMOKE" --network "$CI_NET" \
    -e BOT_RUNTIME=swarm -e PORT=5000 -e NODE_ENV=production \
    -e FORCE_LLM_PROVIDER=noop -e MOCK_OIDC=true -e RUN_MIGRATIONS=true \
    -e DATABASE_URL=postgresql://oshal:oshal@${E2E_PG}:5432/oshal \
    -e REDIS_URL=redis://${E2E_REDIS}:6379 \
    oshal-ci:latest >/dev/null || return 1
  local i code="" ok=0
  for i in $(seq 1 48); do
    code=$(MSYS_NO_PATHCONV=1 docker exec "$SMOKE" curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://localhost:5000/health 2>/dev/null || true)
    [ "$code" = "200" ] && { ok=1; break; }
    sleep 5
  done
  [ "$ok" = "1" ] || { log "smoke: /health never returned 200"; docker logs --tail 60 "$SMOKE" 2>&1 | tail -30; return 1; }
  # /health is shallow - migrations can still be settling. Retry the real assert.
  local resp="" try
  for try in 1 2 3; do
    resp=$(MSYS_NO_PATHCONV=1 docker exec "$SMOKE" curl -s -X POST http://localhost:5000/api/tickets \
      -H "Content-Type: application/json" \
      -d '{"title":"ci smoke","description":"local noop path check","ticketType":"build"}')
    echo "$resp" | grep -q '"ticketId"' && break
    sleep 10
  done
  echo "$resp" | grep -q '"ticketId"' || { log "smoke: ticket create returned no ticketId: $(echo "$resp" | head -c 200)"; return 1; }
  local apps
  apps=$(docker exec "$E2E_PG" psql -U oshal -d oshal -tAc "SELECT count(*) FROM swarm_applications" 2>/dev/null | tr -d '[:space:]')
  [ "${apps:-0}" -gt 0 ] || { log "smoke: swarm_applications empty - migration/auto-load regression"; return 1; }
  docker rm -f "$SMOKE" >/dev/null 2>&1 || true
  return 0
}

# Scan a docker-save tarball with --input: trivy never gets the docker socket
# (root-equivalent control of the daemon running the LIVE stack). It keeps
# network for CVE-DB updates; that's data-in, not host control.
TRIVY_CTR=oshal-ci-trivy
SCAN_VOL=oshal-ci-scan
gate_trivy() {
  local rc=0
  # A trivy container surviving a killed run (docker run --rm outlives its CLI)
  # holds the cache-volume lock and every later scan FATALs with "cache may be
  # in use by another process" - always clear it first. Named so it CAN be cleared.
  docker rm -f "$TRIVY_CTR" >/dev/null 2>&1 || true
  docker volume rm "$SCAN_VOL" >/dev/null 2>&1 || true
  # Stream the image tarball into a docker VOLUME (VM-native ext4): scanning a
  # 3GB tar through the Windows bind mount blew a 30-min timeout (run at
  # 20:09, 1871s); volume I/O is native speed. The volume also keeps the
  # docker socket out of the scanner container (review finding).
  timeout 900 bash -c "docker save oshal-ci:latest | MSYS_NO_PATHCONV=1 docker run --rm -i -v $SCAN_VOL:/scan alpine:3 sh -c 'cat > /scan/image.tar'" \
    || { docker volume rm "$SCAN_VOL" >/dev/null 2>&1; return 1; }
  # Honor the repo's reviewed quarantine file — mounted from GATE_SRC (the committed tree this run
  # judges), so an uncommitted local .trivyignore can never quietly pass the scheduled gate. Every
  # entry in that file must carry its justification + the BACKLOG done-when that retires it.
  local IGNORE_ARGS=()
  if [ -f "$GATE_SRC/.trivyignore" ]; then
    IGNORE_ARGS=(-v "$GATE_SRC/.trivyignore":/scan-ignore/.trivyignore:ro)
  fi
  MSYS_NO_PATHCONV=1 timeout 1800 docker run --rm --name "$TRIVY_CTR" \
    -v "$SCAN_VOL":/scan:ro \
    "${IGNORE_ARGS[@]}" \
    -v oshal-trivy-cache:/root/.cache \
    aquasec/trivy:latest image --input /scan/image.tar --timeout 15m \
    ${IGNORE_ARGS:+--ignorefile /scan-ignore/.trivyignore} \
    --severity CRITICAL,HIGH --ignore-unfixed --skip-dirs /usr/local/bin --exit-code 1 || rc=1
  docker volume rm "$SCAN_VOL" >/dev/null 2>&1 || true
  return $rc
}

# Housekeeping, not a gate: dangling layers from daily rebuilds + build cache
# share the Docker VM disk with the LIVE stack's volumes. Scoped: dangling-only
# prune never touches tagged images; keep-storage bounds the builder cache.
prune_scoped() {
  timeout 300 docker image prune -f >/dev/null 2>&1 || true
  timeout 300 docker builder prune -f --keep-storage 20GB >/dev/null 2>&1 || true
}

log "=== LOCAL CI start (scheduled=$SCHEDULED head=$HEAD_MODE skip-e2e=$SKIP_E2E skip-image=$SKIP_IMAGE) commit=$(cd "$REPO_DIR" && git rev-parse --short HEAD) ==="

NODE_GATES_OK=1
if [ "$HEAD_MODE" = "1" ]; then
  run_gate head-src prepare_head_src
  [[ " ${FAILED_GATES[*]-} " == *" head-src "* ]] && NODE_GATES_OK=0
elif [ "$DO_INSTALL" = "1" ]; then
  run_gate install bash -c "cd '$REPO_DIR' && timeout 1800 npm ci --legacy-peer-deps"
fi
if [ "$NODE_GATES_OK" = "1" ]; then
  run_gate typecheck gate_typecheck
  run_gate unit gate_unit
  run_gate lint gate_lint
  run_gate connectors gate_connectors
  run_gate manifests gate_manifests
  run_gate kernel-skills gate_kernel_skills
  run_gate workflow-triggers gate_workflow_triggers
  run_gate repo-separation gate_repo_separation
  run_gate worktree-strays gate_worktree_strays
else
  log "GATES typecheck/unit/lint/connectors/manifests/kernel-skills/e2e: SKIPPED (HEAD export failed)"
  FAILED_GATES+=(node-gates-skipped)
  SKIP_E2E=1
fi
run_gate secret-scan gate_secrets
if [ "$SKIP_E2E" != "1" ]; then run_gate e2e-green gate_e2e; fi
if [ "$SKIP_IMAGE" != "1" ]; then
  run_gate image-build gate_image
  if [[ ! " ${FAILED_GATES[*]-} " == *" image-build "* ]]; then
    run_gate kernel-skills-image gate_kernel_skills_image
    run_gate image-smoke gate_smoke
    run_gate trivy gate_trivy
  else
    log "GATES kernel-skills-image + image-smoke + trivy: SKIPPED (image build failed)"
    FAILED_GATES+=(kernel-skills-image-skipped image-smoke-skipped trivy-skipped)
  fi
  prune_scoped
fi

if [ "${#FAILED_GATES[@]}" -eq 0 ]; then
  log "=== LOCAL CI: ALL GATES GREEN ==="
  exit 0
fi

log "=== LOCAL CI: FAILED gates: ${FAILED_GATES[*]} ==="
# Email only on failure, only in scheduled mode (the trading watchdog's alert
# rail). MSYS_NO_PATHCONV is load-bearing: without it Git Bash rewrites
# /app/scripts/... into a C:/Program Files/... path that doesn't exist in the
# container and the alert silently never sends.
if [ "$SCHEDULED" = "1" ]; then
  if docker exec oshal-local-api true >/dev/null 2>&1; then
    MSYS_NO_PATHCONV=1 timeout 120 docker exec oshal-local-api node /app/scripts/oshal-send-alert.js \
      "OSHAL LOCAL CI FAILED" \
      "Failed gates: ${FAILED_GATES[*]} (commit $(cd "$REPO_DIR" && git rev-parse --short HEAD)). Full log: $RUN_LOG on ${COMPUTERNAME:-this machine}." \
      || log "alert: send failed"
  else
    log "alert: api container down - failure recorded in log only"
  fi
fi
exit 1
