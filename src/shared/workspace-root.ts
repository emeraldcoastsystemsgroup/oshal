/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Canonical shared-workspace-root resolver. The RALF handover manager, workspace artifact enforcer, and failure governance service each defaulted to OSHAL_WORKSPACE_ROOT || '/tmp/oshal-workspace' — a path nothing mounts. Bots write deliverables under SHARED_WORKSPACE_ROOT (/app/workspace-shared, the oshal_workspace volume code-server browses), so handovers/continuation briefs/artifact validation diverged onto an ephemeral, invisible dir. This centralizes the lookup so every reader/writer agrees on one root.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | CKR-17 step 2: this is now the ONLY place any of the six workspace-root variables is read, so it reads all six. Thirty-six inline chains across at least fifteen distinct precedence orders were collapsed onto it; each honoured a different subset, so a resolver reading four would have silently dropped a configuration that worked before the sweep. CLINE_SHARED_WORKSPACE_ROOT matters in particular - docker-compose.core.yml and docker-compose.yml set it and SHARED_WORKSPACE_ROOT and nothing else, which is where the divergence was live. Also adds resolveSharedWorkspaceRootPosix for the sites that MATCH bot-written text rather than joining paths: step 1 learned that the host separator breaks matching on Windows against paths a Linux container wrote.
 */

import fs from 'fs';
import path from 'path';

/**
 * @description The container default workspace mount. The docker-compose
 * `oshal_workspace` volume is mounted here for the API + every bot, and is the
 * folder code-server is rooted at, so artifacts written here are browsable.
 */
const CONTAINER_WORKSPACE_ROOT = '/app/workspace-shared';

/**
 * @description Legacy in-container mount probed only when no env var is set,
 * preserving the historical fallback used across the orchestration services.
 */
const LEGACY_CONTAINER_WORKSPACE_ROOT = '/app/workspace';

/**
 * @description Resolves the one shared workspace root that bots and readers must
 * agree on. Resolution order, highest priority first:
 *
 *   1. OSHAL_WORKSPACE_ROOT        — explicit override (kept for backward compatibility)
 *   2. SHARED_WORKSPACE_ROOT       — the canonical docker-compose value (/app/workspace-shared)
 *   3. CLINE_SHARED_WORKSPACE_ROOT — set beside (2) by docker-compose.core.yml and docker-compose.yml
 *   4. CLINE_WORKSPACE_ROOT        — Cline harness alias
 *   5. WORKSPACE_ROOT              — generic alias
 *   6. WORKSPACE_DIR               — the bot-node/remote-client alias
 *   7. /app/workspace if it exists, else <cwd>/workspace-shared (local dev)
 *
 * All SIX variables are read here because this is the only place any of them is read. The
 * convergence (CKR-17 step 2) collapsed at least fifteen distinct inline chains onto this
 * function, and each of those chains honoured a different subset — a resolver reading four
 * would have silently dropped a configuration that worked before it.
 *
 * This mirrors the convention already used by token-chase-read-service and
 * task-explorer-workspace-service, and intentionally drops the old
 * `/tmp/oshal-workspace` default that wrote artifacts to an unmounted,
 * ephemeral directory invisible to code-server.
 *
 * Read at call time (not module load) so tests and per-instance construction
 * observe the current environment.
 *
 * @returns Absolute path to the shared workspace root.
 */
export function resolveSharedWorkspaceRoot(): string {
  // First env var with a non-blank value wins. A blank/whitespace value (e.g.
  // OSHAL_WORKSPACE_ROOT="") must NOT shadow a valid lower-priority var.
  const candidates = [
    process.env.OSHAL_WORKSPACE_ROOT,
    process.env.SHARED_WORKSPACE_ROOT,
    process.env.CLINE_SHARED_WORKSPACE_ROOT,
    process.env.CLINE_WORKSPACE_ROOT,
    process.env.WORKSPACE_ROOT,
    process.env.WORKSPACE_DIR,
  ];
  for (const candidate of candidates) {
    if (candidate && candidate.trim().length > 0) {
      return path.resolve(candidate.trim());
    }
  }

  if (fs.existsSync(CONTAINER_WORKSPACE_ROOT)) {
    return CONTAINER_WORKSPACE_ROOT;
  }
  if (fs.existsSync(LEGACY_CONTAINER_WORKSPACE_ROOT)) {
    return LEGACY_CONTAINER_WORKSPACE_ROOT;
  }
  return path.resolve(process.cwd(), 'workspace-shared');
}

/**
 * @description The shared workspace root with POSIX separators, for code that MATCHES text
 * rather than joining paths. `resolveSharedWorkspaceRoot` normalises to the HOST separator,
 * while the paths a bot writes into a deliverable were produced inside a Linux container and
 * always use `/`. Converging a path-matching site without this broke the deliverable capture on
 * Windows during CKR-17 step 1 — 4 of 14 cases went red. Production is a Linux container either
 * way, so the two agree there; this exists so a developer box agrees too.
 * @returns The shared workspace root, separators normalised to `/`.
 */
export function resolveSharedWorkspaceRootPosix(): string {
  return resolveSharedWorkspaceRoot().split(path.sep).join('/');
}

/**
 * @description Whether a shared workspace root actually EXISTS to be used — either one of the six
 * variables names it, or one of the container mounts is present. False means
 * `resolveSharedWorkspaceRoot` would fall through to `<cwd>/workspace-shared`, which it invents
 * rather than finds. A caller with its own sensible off-container fallback (a temp dir for scan
 * media, say) asks this first instead of writing into a directory nobody mounted.
 * @returns True when the resolver has a configured or mounted root to return.
 */
export function hasConfiguredWorkspaceRoot(): boolean {
  const named = [
    process.env.OSHAL_WORKSPACE_ROOT,
    process.env.SHARED_WORKSPACE_ROOT,
    process.env.CLINE_SHARED_WORKSPACE_ROOT,
    process.env.CLINE_WORKSPACE_ROOT,
    process.env.WORKSPACE_ROOT,
    process.env.WORKSPACE_DIR,
  ].some((value) => typeof value === 'string' && value.trim().length > 0);
  return named || fs.existsSync(CONTAINER_WORKSPACE_ROOT) || fs.existsSync(LEGACY_CONTAINER_WORKSPACE_ROOT);
}
