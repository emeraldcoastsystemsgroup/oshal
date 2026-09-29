/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Initial implementation: the identity half of scripts/operations/installed-sandbox.js. Registers LOCAL_AUTH fake users on a sandbox api through the product's own doors, in the installer's order: the one-use installer proof (scripts/oshal-setup-root.mjs, issued inside the sandbox api) redeemed at POST /api/local-auth/bootstrap claims the swarm root for the first user; every other user is invited by that root (POST /api/local-auth/users), reads its invitation (GET /invite-info), accepts it (POST /accept) and must see the spent link refused with 410; then every user signs in through POST /api/local-auth/login, the session is checked at GET /api/auth/user, and a personal access token is minted through POST /api/cli-tokens and checked at GET /api/cli-tokens/whoami. Subjects are the store's own local-<sha256(email)[0..16]> derivation. Passwords, sessions and tokens only ever go to a mode-600 env file under names like OSHAL_SANDBOX_ALPHA_PAT; nothing here prints a value.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Every request is bounded (120 s by default). A door that accepted the connection and never answered made `up` wait forever, and a wait is not a failure, so nothing was torn down.
 */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');

const LOCAL_SESSION_COOKIE = 'oshal_local';
const PAT_PATTERN = /^oshal_pat_[a-f0-9]{48}$/;
const LABEL_PATTERN = /^[a-z][a-z0-9-]{1,20}$/;
const EMAIL_DOMAIN = 'sandbox.oshal.example.com';
const DEFAULT_MEMBERS = Object.freeze(['alpha', 'bravo']);
const ROOT_LABEL = 'admin';
const CREDENTIAL_FIELDS = Object.freeze(['EMAIL', 'SUB', 'PASSWORD', 'SESSION', 'PAT']);
/** How long one request to the sandbox api may take. */
const REQUEST_TIMEOUT_MS = 120000;

/**
 * @description The local-auth subject for an email - byte-for-byte the store's localSubForEmail
 * (trimmed, lowercased, sha256, first 16 hex characters), so a plan can name subjects before boot.
 * @param {string} email Login email. @returns {string} `local-` subject.
 */
function localSubForEmail(email) {
  return `local-${crypto.createHash('sha256').update(String(email).trim().toLowerCase()).digest('hex').slice(0, 16)}`;
}

/** @description Environment name of one credential. @param {string} label User label. @param {string} field One of CREDENTIAL_FIELDS. @returns {string} Name. */
function credentialName(label, field) {
  if (!CREDENTIAL_FIELDS.includes(field)) throw new Error(`unknown credential field ${field}`);
  return `OSHAL_SANDBOX_${label.toUpperCase().replace(/-/g, '_')}_${field}`;
}

/**
 * @description The fake users: the root administrator first, then the invited members (default
 * alpha and bravo - two identities with differing rights for acceptance), each with a random password.
 * @param {string[]} labels Member labels (without the root). @param {(n: number) => Buffer} randomBytes Entropy.
 * @returns {object[]} Users { label, email, name, sub, password, root }.
 */
function sandboxUsers(labels, randomBytes) {
  const members = labels && labels.length ? labels : DEFAULT_MEMBERS;
  const all = [ROOT_LABEL, ...members];
  for (const label of all) if (!LABEL_PATTERN.test(label)) throw new Error(`invalid user label "${label}"`);
  if (new Set(all).size !== all.length) throw new Error(`user labels must be unique (the root is "${ROOT_LABEL}")`);
  return all.map((label) => {
    const email = `${label}@${EMAIL_DOMAIN}`;
    return {
      label, email, name: `Sandbox ${label.charAt(0).toUpperCase()}${label.slice(1)}`, sub: localSubForEmail(email),
      password: `Sbx-${randomBytes(18).toString('base64url')}-9z`, root: label === ROOT_LABEL,
    };
  });
}

/** @description Name=value cookie pairs from a response. @param {Response} res Fetch response. @returns {string[]} Pairs. */
function responseCookies(res) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
  return list.map((cookie) => String(cookie).split(';')[0]).filter((pair) => /=./.test(pair));
}

/**
 * @description A JSON client for one sandbox origin. Every request carries the sandbox's own Origin
 * (the bootstrap route refuses any other), and cookies/bearers are passed per call, never stored.
 * A request that is not answered in time is refused, never awaited forever.
 * @param {string} baseUrl Sandbox origin. @param {Function} fetchImpl fetch. @param {number} [timeoutMs] Bound on one request.
 * @returns {Function} call(method, path, { body, cookie, bearer }) -> { status, json, cookies }.
 */
function createClient(baseUrl, fetchImpl, timeoutMs = REQUEST_TIMEOUT_MS) {
  const origin = new URL(baseUrl).origin;
  return async (method, pathName, options = {}) => {
    const headers = { accept: 'application/json', origin };
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (options.cookie) headers.cookie = options.cookie;
    if (options.bearer) headers.authorization = `Bearer ${options.bearer}`;
    const res = await fetchImpl(new URL(pathName, origin), {
      method, headers, redirect: 'manual', body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(timeoutMs),
    }).catch((error) => {
      if (error && error.name === 'TimeoutError') throw new Error(`${method} ${pathName} was not answered within ${timeoutMs} ms`);
      throw error;
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: res.status, json, cookies: responseCookies(res) };
  };
}

/** @description The local session pair from a response, or a refusal. @param {object} res Client result. @param {string} step Step name. @returns {string} Cookie pair. */
function sessionCookie(res, step) {
  const pair = res.cookies.find((cookie) => cookie.startsWith(`${LOCAL_SESSION_COOKIE}=`));
  if (!pair) throw new Error(`${step}: no ${LOCAL_SESSION_COOKIE} session was issued`);
  return pair;
}

/** @description A short, value-free description of a refusal. @param {object} res Client result. @returns {string} Text. */
function refusal(res) {
  const error = res.json && typeof res.json.error === 'string' ? res.json.error : '';
  return `HTTP ${res.status}${error ? ` (${error.slice(0, 160)})` : ''}`;
}

/**
 * @description Redeem the installer proof: the first user becomes the swarm root.
 * @param {Function} call Client. @param {object} admin Root user. @param {string} setupCode Installer proof.
 * @returns {Promise<string>} Root session cookie.
 */
async function bootstrapRoot(call, admin, setupCode) {
  const res = await call('POST', '/api/local-auth/bootstrap', { body: { email: admin.email, name: admin.name, password: admin.password, setupToken: setupCode } });
  if (res.status !== 201 || !res.json || res.json.rootClaimed !== true) throw new Error(`root bootstrap refused: ${refusal(res)}`);
  if (res.json.sub !== admin.sub) throw new Error(`root bootstrap created ${res.json.sub}, expected ${admin.sub}`);
  return sessionCookie(res, 'root bootstrap');
}

/**
 * @description Invite one user as the root, read and accept the invitation, and require that the
 * spent link is refused (410).
 * @param {Function} call Client. @param {string} rootCookie Root session. @param {object} user Invitee.
 * @returns {Promise<void>} Resolves when every check held.
 */
async function inviteAndAccept(call, rootCookie, user) {
  const invite = await call('POST', '/api/local-auth/users', { cookie: rootCookie, body: { email: user.email, name: user.name } });
  if (invite.status !== 201 || !invite.json || typeof invite.json.invitePath !== 'string') throw new Error(`invite ${user.label} refused: ${refusal(invite)}`);
  const token = new URL(invite.json.invitePath, 'http://invite.invalid').searchParams.get('token');
  if (!token) throw new Error(`invite ${user.label}: the invitation path carries no token`);
  const info = await call('GET', `/api/local-auth/invite-info?token=${encodeURIComponent(token)}`);
  if (info.status !== 200 || String(info.json && info.json.email).toLowerCase() !== user.email) throw new Error(`invite-info ${user.label}: ${refusal(info)} or a different email`);
  const accept = await call('POST', '/api/local-auth/accept', { body: { token, password: user.password } });
  if (accept.status !== 200) throw new Error(`accept ${user.label} refused: ${refusal(accept)}`);
  const reuse = await call('POST', '/api/local-auth/accept', { body: { token, password: user.password } });
  if (reuse.status !== 410) throw new Error(`a spent invitation for ${user.label} answered ${reuse.status}, not 410`);
}

/**
 * @description Sign one user in and prove the session is that user.
 * @param {Function} call Client. @param {object} user User. @returns {Promise<string>} Session cookie.
 */
async function signIn(call, user) {
  const res = await call('POST', '/api/local-auth/login', { body: { email: user.email, password: user.password } });
  if (res.status !== 200 || !res.json || res.json.ok !== true) throw new Error(`login ${user.label} refused: ${refusal(res)}`);
  const cookie = sessionCookie(res, `login ${user.label}`);
  const me = await call('GET', '/api/auth/user', { cookie });
  const who = me.json && (me.json.user || me.json);
  if (me.status !== 200 || !who || who.sub !== user.sub || String(who.email).toLowerCase() !== user.email) {
    throw new Error(`session for ${user.label} did not resolve to ${user.sub}: ${refusal(me)}`);
  }
  return cookie;
}

/**
 * @description Mint a personal access token for a signed-in user and prove it acts as that user.
 * @param {Function} call Client. @param {string} cookie Session. @param {object} user User. @param {string} label Token label.
 * @returns {Promise<string>} The token.
 */
async function mintPat(call, cookie, user, label) {
  const res = await call('POST', '/api/cli-tokens', { cookie, body: { label } });
  const token = res.json && res.json.token;
  if (res.status !== 201 || !PAT_PATTERN.test(String(token))) throw new Error(`token mint for ${user.label} refused: ${refusal(res)}`);
  const whoami = await call('GET', '/api/cli-tokens/whoami', { bearer: token });
  if (whoami.status !== 200 || !whoami.json || whoami.json.sub !== user.sub) throw new Error(`token for ${user.label} did not act as ${user.sub}: ${refusal(whoami)}`);
  return token;
}

/**
 * @description Register every user through the real doors and return their credentials by name.
 * @param {object} input { call, users, issueSetupCode: () => Promise<string>, patLabel, log }.
 * @returns {Promise<{credentials: Map<string,string>, identities: object[]}>} Credentials (values) and identities (no values).
 */
async function registerIdentities(input) {
  const [root, ...members] = input.users;
  if (!root || !root.root) throw new Error('the first user must be the root');
  const rootCookie = await bootstrapRoot(input.call, root, await input.issueSetupCode());
  input.log(`root claimed by ${root.label} (${root.sub}) through the installer proof`);
  for (const user of members) {
    await inviteAndAccept(input.call, rootCookie, user);
    input.log(`${user.label} (${user.sub}) invited by the root, accepted, spent link refused (410)`);
  }
  const credentials = new Map();
  const identitiesOut = [];
  for (const user of input.users) {
    const session = await signIn(input.call, user);
    const pat = await mintPat(input.call, session, user, input.patLabel);
    const values = { EMAIL: user.email, SUB: user.sub, PASSWORD: user.password, SESSION: session, PAT: pat };
    for (const field of CREDENTIAL_FIELDS) credentials.set(credentialName(user.label, field), values[field]);
    identitiesOut.push({ label: user.label, email: user.email, sub: user.sub, root: user.root, credentialNames: CREDENTIAL_FIELDS.map((field) => credentialName(user.label, field)) });
    input.log(`${user.label} signed in (session ${user.sub}) and holds a token that acts as ${user.sub}`);
  }
  return { credentials, identities: identitiesOut };
}

/**
 * @description Write credentials as an env file readable only by the owner.
 * @param {string} file Destination. @param {Map<string,string>} values Name -> value.
 * @returns {string[]} The names written (never the values).
 */
function writeCredentialsFile(file, values) {
  const lines = [];
  for (const [name, value] of values) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error(`invalid credential name ${name}`);
    if (/[\r\n]/.test(String(value))) throw new Error(`credential ${name} spans lines`);
    lines.push(`${name}=${value}`);
  }
  fs.writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });
  return [...values.keys()];
}

/**
 * @description Read a sandbox credentials file back (for acceptance scripts), by name.
 * @param {string} file credentials.env written by writeCredentialsFile. @returns {Map<string,string>} Name -> value.
 */
function readCredentialsFile(file) {
  const out = new Map();
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const at = line.indexOf('=');
    if (at > 0) out.set(line.slice(0, at), line.slice(at + 1));
  }
  return out;
}

module.exports = {
  LOCAL_SESSION_COOKIE, PAT_PATTERN, EMAIL_DOMAIN, ROOT_LABEL, CREDENTIAL_FIELDS, REQUEST_TIMEOUT_MS,
  localSubForEmail, credentialName, sandboxUsers, createClient, registerIdentities, writeCredentialsFile, readCredentialsFile,
};
