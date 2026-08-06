/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Preserve exact caller subjects and fail closed on linked or out-of-root task cwd values before spawning brokered connector CLIs.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05: retire generic connector subprocess execution until an audited, versioned server broker exists; no credential-bearing child environment or workspace is created.
 */
'use strict';

const path = require('path');
const { optionalExactUserSubject } = require('../codebase/exact-user-subject');
const { resolveExistingTaskWorkspace } = require('../codebase/task-workspace-scope');

const APP_ROOT = path.resolve(__dirname, '../../../..');

function resolveTaskWorkspace(value) {
  if (value === undefined || value === null) return undefined;
  const roots = [
    process.env.WORKSPACE_DIR,
    process.env.SHARED_WORKSPACE_ROOT,
    process.env.CLINE_SHARED_WORKSPACE_ROOT,
    process.env.WORKSPACE_ROOT,
    path.join(APP_ROOT, 'workspace'),
    path.join(APP_ROOT, 'workspace-shared'),
  ].filter(Boolean);
  return resolveExistingTaskWorkspace(value, roots);
}

function trustedChildEnv(extraEnv) {
  // Kept as an inspection helper for regressions. It intentionally returns only owner
  // identity; runBrokeredCli never spawns while this legacy carrier lacks an audited broker.
  const env = {};
  const userSub = optionalExactUserSubject(extraEnv?.OSHAL_USER_SUB, 'brokered CLI userSub');
  if (userSub !== undefined) env.OSHAL_USER_SUB = userSub;
  return env;
}

function runBrokeredCli({ script, params = {}, context = {}, errorLabel }) {
  // Validate identity and workspace before returning the stable denial so malformed values
  // cannot hide behind an operational limitation. No executable, args, env, or cwd is used.
  trustedChildEnv(context.extraEnv);
  resolveTaskWorkspace(context.taskWorkspace || params.taskWorkspace || params.workspace_dir);
  return Promise.resolve({
    error: 'connector_cli_disabled_pending_audited_broker',
    provider: String(errorLabel || script || 'connector').slice(0, 128),
  });
}

module.exports = {
  APP_ROOT,
  resolveTaskWorkspace,
  runBrokeredCli,
  trustedChildEnv,
};
