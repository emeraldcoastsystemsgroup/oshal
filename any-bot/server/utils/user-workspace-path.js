/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Per-user task storage for the bot runtime (ADR-060, bot side). Mirrors src/features/chat-orchestration/services/user-scoped-workspace-path.ts so an executing bot writes a NEW task's files into the owning user's namespace (<base>/users/<sub>/<taskId>) instead of a flat shared root. Pre-existing flat dirs are detected and reused so no existing work is orphaned.
 */
'use strict';
const fs = require('fs');
const path = require('path');

/** Sanitize an id (OIDC sub / task id) into one safe filesystem path segment. */
function normalizeSegment(id) {
  return String(id || '').trim().replace(/[^a-zA-Z0-9-_]/g, '_');
}

/**
 * @description Resolve the task workspace dir under the owner's namespace (ADR-060):
 *   - if a pre-existing LEGACY flat dir <base>/<taskId> exists → reuse it (no orphaning)
 *   - else if userSub present → <base>/users/<sub>/<taskId>
 *   - else (no owner) → <base>/_shared/<taskId>
 * @param {string} base - config.filesystem.workspaceDir
 * @param {string|undefined} userSub - the owning user's OIDC sub
 * @param {string} taskId - task/workspace folder id
 * @returns {string} absolute workspace dir
 */
function resolveUserTaskDir(base, userSub, taskId) {
  const safeTask = normalizeSegment(taskId);
  const legacy = path.join(base, safeTask);
  try {
    if (fs.existsSync(legacy)) return legacy;
  } catch (_e) { /* fall through to per-user path */ }
  if (userSub && String(userSub).trim().length > 0) {
    return path.join(base, 'users', normalizeSegment(userSub), safeTask);
  }
  return path.join(base, '_shared', safeTask);
}

module.exports = { resolveUserTaskDir, normalizeSegment };
