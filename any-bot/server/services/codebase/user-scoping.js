/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | CRED_FILES += OSHAL_CRED_OUTLOOK → .oshal-cred-outlook: the caller's Microsoft Graph token brokered to the communications-bot's M365 mail leg (scripts/oshal-outlook.js) — ADR-037 Outlook provider parity; kept in sync with connector-token-broker.ts, bot-node-request-scope.ts, and base-cli-harness-adapter.ts.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Lease is now UNCONDITIONAL (parity with the TS twin base-cli-harness-adapter.ts, whose per-workspace tail always installs): the old fast-path returned a no-op release when the request carried no sub/creds, so two unscoped same-workspace codex runs could interleave — one would snapshot the auth.json copy pre-rotation and later CAS-fail its own rotation, re-stranding the single-use refresh token the write-back fix exists to preserve. Unscoped requests still write no files and get an empty env; they just serialize per workspace like scoped ones. Distinct workspaces remain fully concurrent.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Expand the strict connector credential map and add invocation-owned, mode-0600 files under an exclusive per-workspace lease.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Shared per-user scoping for the any-bot CLI wrappers (codex/claude/cline). Delivers the caller's OIDC sub to shelled-out tools (oshal-gmail.js, oshal-x-read.js) via BOTH channels so it works regardless of harness: the spawn env OSHAL_USER_SUB (claude/cline propagate env to tools) AND a .oshal-user-sub file in the per-request workspace dir (codex's sandbox strips env, but runs tools with cwd = workspace). The tool reads whichever is present. Centralized here so every wrapper follows the same protocol instead of duplicating the logic.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Token broker: also drop the controller-provided short-lived per-user access tokens (OSHAL_CRED_GOOGLE/OSHAL_CRED_TWITTER) as .oshal-cred-<provider> files in the per-request workspace. The tool prefers that file over decrypting oshal_connections, so the bot no longer needs SESSION_SECRET. Same dual-channel discipline as the user-sub: file in cwd + env passthrough.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Also emit OSHAL_USER_KEY (sha256(sub)[:32]) + a .oshal-user-key file — the FS-safe per-user key for per-user file space. codex-packer writes packs to packs/<OSHAL_USER_KEY>/<slug>/ so they land where the per-user-isolated swarm-pack routes read them. Matches userKey() in swarm-pack-routes.ts + applyUserScoping in base-cli-harness-adapter.ts.
 */
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/** Token broker: env key (from the controller) -> the cwd file a shelled tool prefers. */
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

function sanitizeBrokeredCreds(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([key, token]) => (
    Object.prototype.hasOwnProperty.call(CRED_FILES, key)
      && typeof token === 'string'
      && token.length > 0
      && token.length <= 32_768
  )));
}

function writePrivateFile(filePath, value) {
  fs.writeFileSync(filePath, String(value), { encoding: 'utf8', mode: 0o600 });
  // writeFileSync's mode applies only on create; chmod also constrains an existing file.
  fs.chmodSync(filePath, 0o600);
  const stat = fs.statSync(filePath);
  return { dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs, size: stat.size };
}

/**
 * @description Delivers the caller's sub AND any controller-provided short-lived per-user
 *   access tokens to shelled tools. Writes the per-request workspace files (.oshal-user-sub
 *   and .oshal-cred-<provider>) and returns env additions to spread into the spawn env.
 *   The cred files let a tool act with a provided token instead of decrypting the
 *   connections table — removing the bot's need for SESSION_SECRET (the token-broker fix).
 * @param {string} workspaceDir - The per-request workspace the CLI runs in (cwd).
 * @param {object} [extraEnv] - Per-request env from the controller; OSHAL_USER_SUB +
 *   OSHAL_CRED_GOOGLE/OSHAL_CRED_TWITTER/OSHAL_CRED_SMARTTHINGS are read from here.
 * @returns {object} Env additions to merge into the spawn env (empty if nothing provided).
 */
function applyUserScoping(workspaceDir, extraEnv, ownedFiles) {
  if (!extraEnv) return {};
  const sub = typeof extraEnv.OSHAL_USER_SUB === 'string' && extraEnv.OSHAL_USER_SUB.trim()
    ? extraEnv.OSHAL_USER_SUB.trim().slice(0, 512)
    : undefined;
  const brokeredCreds = sanitizeBrokeredCreds(extraEnv);
  const out = {};
  try { fs.mkdirSync(workspaceDir, { recursive: true }); } catch (_e) { /* best-effort */ }
  if (sub) {
    try {
      const filePath = path.join(workspaceDir, '.oshal-user-sub');
      const identity = writePrivateFile(filePath, sub);
      ownedFiles?.push({ filePath, identity });
    }
    catch (_e) { /* non-fatal — env channel still applies */ }
    out.OSHAL_USER_SUB = String(sub);
    // FS-safe per-user key for per-user file space (packs/<key>/...). Must match
    // userKey() in swarm-pack-routes.ts so packs land where the routes read them.
    const userKey = crypto.createHash('sha256').update(String(sub)).digest('hex').slice(0, 32);
    try {
      const filePath = path.join(workspaceDir, '.oshal-user-key');
      const identity = writePrivateFile(filePath, userKey);
      ownedFiles?.push({ filePath, identity });
    }
    catch (_e) { /* non-fatal — env channel still applies */ }
    out.OSHAL_USER_KEY = userKey;
  }
  // Token broker: drop each provided cred as a cwd file (codex's preferred channel) and
  // also pass it through env (claude/cline). The tool reads whichever is present.
  for (const [envKey, fileName] of Object.entries(CRED_FILES)) {
    const value = brokeredCreds[envKey];
    if (value === undefined) continue;
    try {
      const filePath = path.join(workspaceDir, fileName);
      const identity = writePrivateFile(filePath, value);
      ownedFiles?.push({ filePath, identity });
    }
    catch (_e) { /* non-fatal — env channel still applies */ }
    out[envKey] = String(value);
  }
  return out;
}

/** Per-request scoping files applyUserScoping writes into the workspace. */
const SCOPING_FILES = [...Object.values(CRED_FILES), '.oshal-user-sub', '.oshal-user-key'];

/**
 * @description Wipe the per-request credential/scoping files from the workspace after a task.
 *   Privileged-runtime hygiene: a provided short-lived token must not LINGER once the task is
 *   done ("issue -> use -> wipe"). Best-effort; never throws. Call in the wrapper's finally.
 * @param {string} workspaceDir - the per-request workspace applyUserScoping wrote into.
 */
function wipeUserScoping(workspaceDir) {
  if (!workspaceDir) return;
  for (const f of SCOPING_FILES) {
    try {
      const p = path.join(workspaceDir, f);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch (_e) { /* best-effort */ }
  }
}

function sameFileIdentity(filePath, identity) {
  try {
    const stat = fs.statSync(filePath);
    return stat.dev === identity.dev
      && stat.ino === identity.ino
      && stat.mtimeMs === identity.mtimeMs
      && stat.size === identity.size;
  } catch (_e) {
    return false;
  }
}

/**
 * Serialize credential-file ownership for one workspace. The returned release function
 * removes only files written by this invocation and only while their file identity still
 * matches, so an older completion cannot delete a newer request's credential.
 * The lease itself is UNCONDITIONAL — even a request with no sub/creds joins the tail,
 * because the codex wrapper's auth.json snapshot/write-back (token-stranding fix) depends
 * on same-workspace runs never interleaving. Unscoped requests write no files.
 */
async function acquireUserScoping(workspaceDir, extraEnv) {
  const sub = typeof extraEnv?.OSHAL_USER_SUB === 'string' && extraEnv.OSHAL_USER_SUB.trim();
  const creds = sanitizeBrokeredCreds(extraEnv);

  const key = path.resolve(workspaceDir);
  const previous = workspaceScopeTails.get(key) || Promise.resolve();
  let unlock;
  const gate = new Promise((resolve) => { unlock = resolve; });
  const tail = previous.catch(() => {}).then(() => gate);
  workspaceScopeTails.set(key, tail);
  await previous.catch(() => {});

  const ownedFiles = [];
  const env = (!sub && Object.keys(creds).length === 0)
    ? {}
    : applyUserScoping(workspaceDir, {
        ...(sub ? { OSHAL_USER_SUB: extraEnv.OSHAL_USER_SUB } : {}),
        ...creds,
      }, ownedFiles);
  let released = false;
  return {
    env,
    release: () => {
      if (released) return;
      released = true;
      for (const owned of ownedFiles) {
        try {
          if (sameFileIdentity(owned.filePath, owned.identity)) fs.unlinkSync(owned.filePath);
        } catch (_e) { /* best-effort */ }
      }
      unlock();
      if (workspaceScopeTails.get(key) === tail) workspaceScopeTails.delete(key);
    },
  };
}

module.exports = {
  CRED_FILES,
  acquireUserScoping,
  applyUserScoping,
  sanitizeBrokeredCreds,
  wipeUserScoping,
};
