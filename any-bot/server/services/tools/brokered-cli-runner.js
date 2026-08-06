/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Preserve exact caller subjects and fail closed on linked or out-of-root task cwd values before spawning brokered connector CLIs.
 */
'use strict';

const { execFile } = require('child_process');
const path = require('path');
const { CRED_FILES, sanitizeBrokeredCreds } = require('../codebase/user-scoping');
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
  const env = { ...process.env };
  // The connector child receives only request-scoped credentials, never a controller master key.
  delete env.SESSION_SECRET;
  delete env.AUTH_SESSION_SECRET;
  // A long-lived bot process may have served another owner. Never inherit a broker token
  // from that ambient process; populate the child exclusively from this invocation's map.
  for (const key of Object.keys(CRED_FILES)) delete env[key];
  Object.assign(env, sanitizeBrokeredCreds(extraEnv));
  const userSub = optionalExactUserSubject(extraEnv?.OSHAL_USER_SUB, 'brokered CLI userSub');
  if (userSub !== undefined) env.OSHAL_USER_SUB = userSub;
  else delete env.OSHAL_USER_SUB;
  return env;
}

function runBrokeredCli({ script, args, params = {}, context = {}, errorLabel }) {
  return new Promise((resolve) => {
    const env = trustedChildEnv(context.extraEnv);
    if (params.label) env.OSHAL_CONNECTION_LABEL = String(params.label).slice(0, 256);
    const taskWorkspace = resolveTaskWorkspace(
      context.taskWorkspace || params.taskWorkspace || params.workspace_dir,
    );
    const cli = path.join(APP_ROOT, 'scripts', script);
    execFile('node', [cli, ...args], {
      cwd: taskWorkspace || APP_ROOT,
      env,
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    }, (err, stdout) => {
      const text = (stdout || '').trim();
      try { resolve(JSON.parse(text || '{}')); }
      catch {
        resolve({
          error: (err && err.message) || `${errorLabel || script} CLI parse error`,
          raw: text.slice(0, 500),
        });
      }
    });
  });
}

module.exports = {
  APP_ROOT,
  resolveTaskWorkspace,
  runBrokeredCli,
  trustedChildEnv,
};
