'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { CRED_FILES, sanitizeBrokeredCreds } = require('../codebase/user-scoping');

const APP_ROOT = path.resolve(__dirname, '../../../..');

function normalizedUserSub(value) {
  return typeof value === 'string' && value.trim()
    ? value.trim().slice(0, 512)
    : undefined;
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveTaskWorkspace(value) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const candidate = path.resolve(value.trim());
  const roots = [
    process.env.WORKSPACE_DIR,
    process.env.SHARED_WORKSPACE_ROOT,
    process.env.CLINE_SHARED_WORKSPACE_ROOT,
    process.env.WORKSPACE_ROOT,
    path.join(APP_ROOT, 'workspace'),
    path.join(APP_ROOT, 'workspace-shared'),
  ].filter(Boolean).map((root) => path.resolve(root));
  if (!roots.some((root) => isWithin(root, candidate))) return undefined;
  try {
    return fs.statSync(candidate).isDirectory() ? candidate : undefined;
  } catch (_e) {
    return undefined;
  }
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
  const userSub = normalizedUserSub(extraEnv?.OSHAL_USER_SUB);
  if (userSub) env.OSHAL_USER_SUB = userSub;
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
