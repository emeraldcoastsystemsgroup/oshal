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

/** Token broker environment key to the cwd file a shelled tool prefers. */
const CRED_FILES = {
  OSHAL_CRED_GOOGLE: '.oshal-cred-google',
  OSHAL_CRED_OUTLOOK: '.oshal-cred-outlook',
  OSHAL_CRED_TWITTER: '.oshal-cred-twitter',
  OSHAL_CRED_SMARTTHINGS: '.oshal-cred-smartthings',
  OSHAL_CRED_GCP: '.oshal-cred-gcp',
  OSHAL_CRED_WALMART: '.oshal-cred-walmart',
  OSHAL_CRED_UBER: '.oshal-cred-uber',
  OSHAL_CRED_UBER_RIDES: '.oshal-cred-uber-rides',
  OSHAL_CRED_SPOTIFY: '.oshal-cred-spotify',
  OSHAL_CRED_TMDB: '.oshal-cred-tmdb',
  OSHAL_CRED_DUFFEL: '.oshal-cred-duffel',
  OSHAL_CRED_TWILIO: '.oshal-cred-twilio',
};
const workspaceScopeTails = new Map();
const directOwnedScopes = new Map();

/**
 * @description Copies only supported, non-empty, bounded broker credentials from a candidate map.
 * @param {unknown} value - Candidate environment map.
 * @returns {object} New allowlisted credential map.
 */
function sanitizeBrokeredCreds(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([key, token]) => (
    Object.prototype.hasOwnProperty.call(CRED_FILES, key)
      && typeof token === 'string'
      && token.length > 0
      && token.length <= 32_768
  )));
}

/** Write the exact subject and its filesystem-safe hash through the common writer. */
function writeIdentityScope(directory, sub, out, ownedFiles) {
  if (sub === undefined) return;
  const userKey = crypto.createHash('sha256').update(sub).digest('hex').slice(0, 32);
  ownedFiles.push(writeScopedFile(path.join(directory, '.oshal-user-sub'), sub));
  ownedFiles.push(writeScopedFile(path.join(directory, '.oshal-user-key'), userKey));
  out.OSHAL_USER_SUB = sub;
  out.OSHAL_USER_KEY = userKey;
}

/** Write all allowlisted broker tokens through the same atomic scoped-file writer. */
function writeCredentialScopes(directory, credentials, out, ownedFiles) {
  for (const [envKey, fileName] of Object.entries(CRED_FILES)) {
    const value = credentials[envKey];
    if (value === undefined) continue;
    ownedFiles.push(writeScopedFile(path.join(directory, fileName), value));
    out[envKey] = value;
  }
}

/**
 * @description Delivers an exact caller subject and short-lived credentials to both the CLI
 * environment and invocation-owned files. Any hostile entry/parent aborts the complete scope;
 * already-published files from this attempt are removed only by verified identity.
 * @param {string} workspaceDir - Existing real per-task CLI cwd.
 * @param {object} [extraEnv] - Optional exact subject and broker credential map.
 * @param {object[]} [ownedFiles] - Lease-owned identity collector.
 * @returns {object} Safe environment additions.
 */
function applyUserScoping(workspaceDir, extraEnv, ownedFiles) {
  if (!extraEnv) return {};
  const sub = optionalExactUserSubject(extraEnv.OSHAL_USER_SUB, 'OSHAL_USER_SUB');
  const credentials = sanitizeBrokeredCreds(extraEnv);
  const directory = assertLinkFreeDirectory(workspaceDir);
  const invocationOwned = ownedFiles || [];
  const out = {};
  try {
    writeIdentityScope(directory, sub, out, invocationOwned);
    writeCredentialScopes(directory, credentials, out, invocationOwned);
  } catch (error) {
    for (const identity of invocationOwned) removeOwnedScopedFile(identity);
    throw error;
  }
  if (!ownedFiles) directOwnedScopes.set(path.resolve(directory), invocationOwned);
  return out;
}

/** Per-request scoping filenames retained for compatibility/introspection. */
const SCOPING_FILES = [...Object.values(CRED_FILES), '.oshal-user-sub', '.oshal-user-key'];

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
 * @param {object} [extraEnv] - Optional exact subject and broker credential map.
 * @returns {Promise<{env:object,release:Function}>} Scope environment and release callback.
 */
async function acquireUserScoping(workspaceDir, extraEnv) {
  const sub = optionalExactUserSubject(extraEnv?.OSHAL_USER_SUB, 'OSHAL_USER_SUB');
  const credentials = sanitizeBrokeredCreds(extraEnv);
  const key = assertLinkFreeDirectory(workspaceDir);
  const { tail, unlock } = await waitForWorkspaceLease(key);
  const ownedFiles = [];
  let env;
  try {
    env = sub === undefined && Object.keys(credentials).length === 0
      ? {}
      : applyUserScoping(key, { ...(sub === undefined ? {} : { OSHAL_USER_SUB: sub }), ...credentials }, ownedFiles);
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
  CRED_FILES,
  SCOPING_FILES,
  acquireUserScoping,
  applyUserScoping,
  sanitizeBrokeredCreds,
  wipeUserScoping,
};
