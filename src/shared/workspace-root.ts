/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Canonical shared-workspace-root resolver. The RALF handover manager, workspace artifact enforcer, and failure governance service each defaulted to OSHAL_WORKSPACE_ROOT || '/tmp/oshal-workspace' — a path nothing mounts. Bots write deliverables under SHARED_WORKSPACE_ROOT (/app/workspace-shared, the oshal_workspace volume code-server browses), so handovers/continuation briefs/artifact validation diverged onto an ephemeral, invisible dir. This centralizes the lookup so every reader/writer agrees on one root.
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
 *   1. OSHAL_WORKSPACE_ROOT  — explicit override (kept for backward compatibility)
 *   2. SHARED_WORKSPACE_ROOT — the canonical docker-compose value (/app/workspace-shared)
 *   3. CLINE_WORKSPACE_ROOT  — Cline harness alias
 *   4. WORKSPACE_ROOT        — generic alias
 *   5. /app/workspace if it exists, else <cwd>/workspace-shared (local dev)
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
    process.env.CLINE_WORKSPACE_ROOT,
    process.env.WORKSPACE_ROOT,
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
