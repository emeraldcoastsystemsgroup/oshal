/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added Outlook broker-file parity for Microsoft Graph connector tokens.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Made the per-workspace lease unconditional so auth rotation and scoped files cannot interleave.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Expanded the strict connector map and invocation-owned mode-0600 files.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Centralized dual-channel subject propagation for all any-bot CLI wrappers.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Added short-lived broker credential files so bot tools do not need the controller master key.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Added the SHA-256-derived OSHAL_USER_KEY environment and file channel.
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Preserve exact subjects and route every identity/credential file through the shared link-safe atomic writer; cleanup removes only invocation-owned regular entries.
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05: stop placing broker credentials in autonomous child environments or model-readable workspace files; fixed server-side brokers retain the credential allowlist.
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | Remove the obsolete credential allowlist/sanitizer exports so this workspace-scoping module can carry identity only by construction.
 */
'use strict';

const crypto = require('crypto');
const path = require('path');
const { optionalExactUserSubject } = require('./exact-user-subject');
const {
  assertLinkFreeDirectory,
  removeOwnedScopedFile,
  writeScopedFile,
} = require('./scoped-file-writer');

const workspaceScopeTails = new Map();
const directOwnedScopes = new Map();

/** Write the exact subject and its filesystem-safe hash through the common writer. */
function writeIdentityScope(directory, sub, out, ownedFiles) {
  if (sub === undefined) return;
  const userKey = crypto.createHash('sha256').update(sub).digest('hex').slice(0, 32);
  ownedFiles.push(writeScopedFile(path.join(directory, '.oshal-user-sub'), sub));
  ownedFiles.push(writeScopedFile(path.join(directory, '.oshal-user-key'), userKey));
  out.OSHAL_USER_SUB = sub;
  out.OSHAL_USER_KEY = userKey;
}

/**
 * @description Delivers only the exact caller subject to an invocation-owned identity file.
 * Connector credentials stay inside fixed server-side broker handlers and are never copied into
 * a model process environment or task workspace.
 * @param {string} workspaceDir - Existing real per-task CLI cwd.
 * @param {object} [extraEnv] - Optional exact subject carrier; all other fields are ignored.
 * @param {object[]} [ownedFiles] - Lease-owned identity collector.
 * @returns {object} Safe environment additions.
 */
function applyUserScoping(workspaceDir, extraEnv, ownedFiles) {
  if (!extraEnv) return {};
  const sub = optionalExactUserSubject(extraEnv.OSHAL_USER_SUB, 'OSHAL_USER_SUB');
  const directory = assertLinkFreeDirectory(workspaceDir);
  const invocationOwned = ownedFiles || [];
  const out = {};
  try {
    writeIdentityScope(directory, sub, out, invocationOwned);
  } catch (error) {
    for (const identity of invocationOwned) removeOwnedScopedFile(identity);
    throw error;
  }
  if (!ownedFiles) directOwnedScopes.set(path.resolve(directory), invocationOwned);
  return out;
}

/** Per-request scoping filenames retained for compatibility/introspection. */
const SCOPING_FILES = ['.oshal-user-sub', '.oshal-user-key'];

/**
 * @description Removes only files recorded as owned by a direct {@link applyUserScoping} call.
 * Raced replacements, linked entries, and unrelated pre-existing files remain untouched.
 * @param {string} workspaceDir - Workspace used by the direct call.
 * @returns {void}
 */
function wipeUserScoping(workspaceDir) {
  if (!workspaceDir) return;
  const key = path.resolve(workspaceDir);
  const ownedFiles = directOwnedScopes.get(key) || [];
  for (const identity of ownedFiles) removeOwnedScopedFile(identity);
  directOwnedScopes.delete(key);
}

/** Build one tail promise and wait for the prior holder without propagating its failure. */
async function waitForWorkspaceLease(key) {
  const previous = workspaceScopeTails.get(key) || Promise.resolve();
  let unlock;
  const gate = new Promise((resolve) => { unlock = resolve; });
  const tail = previous.catch(() => {}).then(() => gate);
  workspaceScopeTails.set(key, tail);
  await previous.catch(() => {});
  return { tail, unlock };
}

/**
 * @description Serializes scoped files and auth rotation per workspace. The returned release is
 * idempotent and removes only the entries whose identities this invocation published.
 * @param {string} workspaceDir - Existing real per-task CLI cwd.
 * @param {object} [extraEnv] - Optional exact subject carrier; all other fields are ignored.
 * @returns {Promise<{env:object,release:Function}>} Scope environment and release callback.
 */
async function acquireUserScoping(workspaceDir, extraEnv) {
  const sub = optionalExactUserSubject(extraEnv?.OSHAL_USER_SUB, 'OSHAL_USER_SUB');
  const key = assertLinkFreeDirectory(workspaceDir);
  const { tail, unlock } = await waitForWorkspaceLease(key);
  const ownedFiles = [];
  let env;
  try {
    env = sub === undefined
      ? {}
      : applyUserScoping(key, { OSHAL_USER_SUB: sub }, ownedFiles);
  } catch (error) {
    unlock();
    if (workspaceScopeTails.get(key) === tail) workspaceScopeTails.delete(key);
    throw error;
  }
  let released = false;
  return {
    env,
    release: () => {
      if (released) return;
      released = true;
      for (const identity of ownedFiles) removeOwnedScopedFile(identity);
      unlock();
      if (workspaceScopeTails.get(key) === tail) workspaceScopeTails.delete(key);
    },
  };
}

module.exports = {
  SCOPING_FILES,
  acquireUserScoping,
  applyUserScoping,
  wipeUserScoping,
};
