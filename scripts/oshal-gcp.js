#!/usr/bin/env node
/*
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Smart-cloud (devops bundle) GCP control CLI — the API-based replacement for `gcloud` so a REMOTE web user (not just the host operator) can drive Google Cloud through a bot. Reads the per-user GCP token from the OSHAL connector store (oshal_connections, provider='gcp') — connected at /utilities via web OAuth (cloud-platform scope), NO interactive CLI login. Mirrors scripts/oshal-gmail.js (Google refresh-token flow) + scripts/oshal-smartthings.js (account selector + personal∪shared). gcloud is just a wrapper over the Cloud REST APIs, so this calls them directly. Verbs: accounts, projects, project <id>, services <projectId>, instances <projectId>.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | SECURITY-HARDENING 3.1/9: removed the hardcoded dev-key fallback from the token-key derivation - SESSION_SECRET unset now fails loud instead of silently deriving a well-known AES key any reader of this public repo can compute. No change on a correctly-provisioned box; guard: tests/unit/no-dev-secret-fallback.spec.ts.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Preserve the exact scoped OIDC subject through the shared CLI identity reader.
 *
 *   node scripts/oshal-gcp.js projects                 # list the user's GCP projects
 *   node scripts/oshal-gcp.js project <projectId>      # one project's detail
 *   node scripts/oshal-gcp.js services <projectId>     # enabled APIs on a project
 *   node scripts/oshal-gcp.js instances <projectId>    # compute instances (all zones)
 *   node scripts/oshal-gcp.js accounts                 # THIS user's labeled GCP connections
 *   OSHAL_CONNECTION_LABEL="work gcp" node scripts/oshal-gcp.js projects   # pick an account
 *
 * Exit 2 = no GCP connection (connect at /utilities) or ambiguous account.
 * Read-only by default — write verbs need the full cloud-platform scope (GCP_SCOPES).
 */
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { resolveExactUserSubject } = require('./lib/exact-user-subject');

const CRM = 'https://cloudresourcemanager.googleapis.com/v1';
const SU = 'https://serviceusage.googleapis.com/v1';
const GCE = 'https://compute.googleapis.com/compute/v1';

/** Caller identity (env or the wrapper-dropped cwd file). */
function resolveUserSub() {
  return resolveExactUserSubject();
}

/** Which connection the bot/user named (multi-account). */
function resolveSelector() {
  return {
    label: process.env.OSHAL_CONNECTION_LABEL || undefined,
    email: process.env.OSHAL_CONNECTION_EMAIL || undefined,
    connectionId: process.env.OSHAL_CONNECTION_ID || undefined,
  };
}

/** Controller-brokered fresh access token (preferred — no DB / SESSION_SECRET needed). */
function resolveProvidedToken() {
  try { const t = fs.readFileSync(path.join(process.cwd(), '.oshal-cred-gcp'), 'utf8').trim(); if (t) return t; } catch { /* env next */ }
  return process.env.OSHAL_CRED_GCP || undefined;
}

function key() { return crypto.createHash('sha256').update(process.env.SESSION_SECRET || (() => { throw new Error('SESSION_SECRET is required - the hardcoded dev-key fallback was removed (docs/security/SECURITY-HARDENING.md 3.1/9); a well-known key is no key at all'); })()).digest(); }
function decrypt(blob) {
  const [iv, tag, enc] = String(blob).split(':');
  const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]).toString('utf8');
}
function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return `${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
}

/** WHERE for the caller's accessible GCP connections (personal ∪ shared/household). $1=userSub. */
function accessibleWhere(userSub) {
  return `provider='gcp' AND ((user_sub=$1 AND tenant_id IS NULL)
            OR tenant_id IN (SELECT tenant_id FROM oshal_tenant_memberships WHERE user_sub=$1))`;
}

/** List the caller's labeled GCP connections (the catalog). */
async function listAccounts(pool) {
  const userSub = resolveUserSub();
  const sql = userSub
    ? `SELECT label, account_email, tenant_id, is_default FROM oshal_connections WHERE ${accessibleWhere()} ORDER BY is_default DESC, updated_at DESC`
    : `SELECT label, account_email, tenant_id, is_default FROM oshal_connections WHERE provider='gcp' ORDER BY updated_at DESC`;
  const rows = (await pool.query(sql, userSub ? [userSub] : [])).rows;
  return { accounts: rows };
}

/** Resolve a valid GCP access token from the DB (refreshing via the Google refresh-token
 *  flow when expired), honoring the selector across personal ∪ shared connections. */
async function tokenFromDb(pool, sel) {
  const userSub = resolveUserSub();
  sel = sel || {};
  const named = !!(sel.label || sel.email || sel.connectionId);
  let rows;
  if (userSub) {
    const params = [userSub];
    let sql = accessibleWhere(userSub);
    if (sel.connectionId) { params.push(sel.connectionId); sql += ` AND connection_id=$${params.length}`; }
    else if (sel.label) { params.push(sel.label); sql += ` AND lower(label)=lower($${params.length})`; }
    else if (sel.email) { params.push(sel.email); sql += ` AND lower(account_email)=lower($${params.length})`; }
    rows = (await pool.query(`SELECT connection_id, user_sub, access_token, refresh_token, expiry FROM oshal_connections WHERE ${sql} ORDER BY is_default DESC, updated_at DESC`, params)).rows;
  } else {
    rows = (await pool.query(`SELECT connection_id, user_sub, access_token, refresh_token, expiry FROM oshal_connections WHERE provider='gcp' ORDER BY updated_at DESC`)).rows;
    if (rows.length > 1 && !named) { console.error(`Refusing to guess: ${rows.length} GCP connections. Set OSHAL_USER_SUB or a label.`); process.exit(2); }
  }
  if (!rows || !rows.length) { console.error(named ? 'No GCP connection matches that account.' : 'No GCP connection. Connect Google Cloud at /utilities first.'); process.exit(2); }
  const row = rows[0]; // is_default DESC, updated_at DESC → the default/newest
  if (row.access_token && row.expiry && new Date(row.expiry).getTime() - Date.now() > 60_000) return decrypt(row.access_token);
  if (!row.refresh_token) return row.access_token ? decrypt(row.access_token) : (console.error('GCP token expired and no refresh token; reconnect at /utilities.'), process.exit(2));
  // Refresh (Google OAuth) — same flow as oshal-gmail.js. Client id/secret fall back to
  // the OIDC login client (the gcp connector reuses it; no separate GCP_CLIENT_ID needed).
  const clientId = process.env.GCP_CLIENT_ID || process.env.OIDC_CLIENT_ID || '';
  const clientSecret = process.env.GCP_CLIENT_SECRET || process.env.OIDC_CLIENT_SECRET || '';
  const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: decrypt(row.refresh_token), grant_type: 'refresh_token' });
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  if (!r.ok) { console.error('GCP token refresh failed: ' + r.status + ' ' + (await r.text()).slice(0, 160)); process.exit(3); }
  const tok = await r.json();
  await pool.query('UPDATE oshal_connections SET access_token=$2, expiry=$3, updated_at=NOW() WHERE connection_id=$1',
    [row.connection_id, encrypt(tok.access_token), tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000) : null]);
  return tok.access_token;
}

/** Authorized GCP API GET → parsed JSON (throws on non-2xx with a short body). */
async function api(token, url) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`GCP ${r.status} ${url.replace(/^https:\/\//, '')}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

async function run(token, argv) {
  const [verb, a] = argv;
  if (!verb || verb === 'projects') {
    const j = await api(token, `${CRM}/projects`);
    return { projects: (j.projects || []).map((p) => ({ projectId: p.projectId, name: p.name, projectNumber: p.projectNumber, state: p.lifecycleState })) };
  }
  if (verb === 'project') { if (!a) throw new Error('usage: project <projectId>'); return api(token, `${CRM}/projects/${a}`); }
  if (verb === 'services') {
    if (!a) throw new Error('usage: services <projectId>');
    const j = await api(token, `${SU}/projects/${a}/services?filter=state:ENABLED&pageSize=200`);
    return { enabled: (j.services || []).map((s) => (s.config && s.config.name) || s.name) };
  }
  if (verb === 'instances') {
    if (!a) throw new Error('usage: instances <projectId>');
    const j = await api(token, `${GCE}/projects/${a}/aggregated/instances`);
    const out = [];
    for (const z of Object.values(j.items || {})) for (const i of (z.instances || [])) out.push({ name: i.name, zone: String(i.zone || '').split('/').pop(), status: i.status, machineType: String(i.machineType || '').split('/').pop() });
    return { instances: out };
  }
  throw new Error(`unknown command: ${verb}`);
}

(async () => {
  const argv = process.argv.slice(2);
  const sel = resolveSelector();
  const named = !!(sel.label || sel.email || sel.connectionId);
  if (argv[0] === 'accounts') {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    try { console.log(JSON.stringify(await listAccounts(pool), null, 2)); }
    catch (err) { console.error('oshal-gcp failed: ' + (err && err.message || err)); process.exit(1); }
    finally { await pool.end(); }
    return;
  }
  const provided = named ? undefined : resolveProvidedToken();
  if (provided) {
    try { console.log(JSON.stringify(await run(provided, argv), null, 2)); }
    catch (err) { console.error('oshal-gcp failed: ' + (err && err.message || err)); process.exit(1); }
    return;
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const token = await tokenFromDb(pool, sel);
    console.log(JSON.stringify(await run(token, argv), null, 2));
  } catch (err) {
    console.error('oshal-gcp failed: ' + (err && err.message || err));
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
