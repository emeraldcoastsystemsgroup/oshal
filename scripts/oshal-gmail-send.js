#!/usr/bin/env node
/*
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation (header added retroactively - file predates change-log enforcement)
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | SECURITY-HARDENING 3.1/9: removed the hardcoded dev-key fallback from the token-key derivation - SESSION_SECRET unset now fails loud instead of silently deriving a well-known AES key any reader of this public repo can compute. No change on a correctly-provisioned box; guard: tests/unit/no-dev-secret-fallback.spec.ts.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Two bugs that made this CLI unable to send anything but an mp4, and then unable to send at all. (a) ENVELOPE-CRYPTO DRIFT, the third and last CLI carrying it: OSHAL_ENVELOPE_CRYPTO defaulted ON 2026-07-20 so connector tokens re-encrypt to `v2:` per-user-DEK blobs, but this file's decrypt knew only the legacy single-KEK format and THREW UNCAUGHT out of getAccessToken - every send died with "Unsupported state or unable to authenticate data". oshal-gmail.js (SEQ 6) and oshal-recap-email.js (SEQ 3) were ported at the time and this one was missed. Fixed by REUSING the sibling's exported decryptToken rather than pasting a third copy, and an access_token decrypt failure now falls through to a refresh_token refresh instead of aborting - same shape as both siblings. (b) The attachment Content-Type was hardcoded `video/mp4` from the recap-video use case, so a PDF/PNG/zip attachment went out mislabelled as video; now derived from the file extension with an application/octet-stream fallback. Guard: tests/unit/gmail-send-attachment-mime.spec.ts.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | THIRD bug in the same path, and the one that made SEQ 3 look like it had not worked: oshal_connections is RLS-enabled AND force-RLS, and its policy grants on `oshal.is_operator='on'` OR `user_sub = current_setting('oshal.current_sub')`. This CLI queried on a PLAIN pool that sets neither GUC, so current_setting returned NULL, every row was filtered, and it exited "SEND_FAIL no Google connection" on a box with three live Google connections — indistinguishable from genuinely having none. oshal-recap-email.js (SEQ 2) already set oshal.current_sub for exactly this reason; the pattern was never ported here or to oshal-gmail.js. Now takes a pooled CLIENT with the GUC set before any query, and the failure message names RLS instead of blaming the connection. Operator-wide lookup (GMAIL_ACCOUNT / single-connection auto-pick) requires an EXPLICIT OSHAL_OPERATOR=1 rather than silently escalating. Guard: the RLS block in tests/unit/gmail-send-attachment-mime.spec.ts.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Use the shared connector-token codec directly; refreshed access tokens remain caller-owned v2 envelopes with hkdf1 DEK wrapping instead of being rewritten as shared raw-SHA256 blobs.
 */
/* Send an email (optionally with one attachment) via the OSHAL Google connection token.
 * Reuses the oshal-gmail.js auth (controller-provided token, else DB refresh-token decrypt).
 * Usage: node oshal-gmail-send.js <to> <subject> <bodyFile> [attachmentPath]
 * Requires the Google connection to have a send-capable scope (gmail.send / modify / compose). */
'use strict';
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { decryptToken, encryptToken } = require('./lib/connector-token-crypto');

/**
 * @description Attachment MIME type from the filename extension. This CLI was written for the
 * recap-video path and hardcoded `video/mp4`, which mislabels every other attachment kind.
 * @param {string} name attachment basename
 * @returns {string} a MIME type, or application/octet-stream when the extension is unknown
 */
function mimeFor(name) {
  const types = {
    '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
    '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json',
    '.html': 'text/html', '.zip': 'application/zip', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  };
  return types[path.extname(String(name)).toLowerCase()] || 'application/octet-stream';
}

function resolveProvidedToken() {
  try { const t = fs.readFileSync(path.join(process.cwd(), '.oshal-cred-google'), 'utf8').trim(); if (t) return t; } catch {}
  return process.env.OSHAL_CRED_GOOGLE || undefined;
}
/**
 * @description Put the pooled client into the RLS context its queries need. oshal_connections is
 * relrowsecurity AND relforcerowsecurity, and its policy admits a row only when
 * `oshal.is_operator='on'` or `user_sub = current_setting('oshal.current_sub')`. A connection that
 * sets neither GUC reads ZERO rows and is indistinguishable from an unconnected box — which is
 * exactly how this CLI reported "no Google connection" against three live ones.
 * @param {object} client pooled pg client (GUCs are connection-scoped, so a Pool is not enough)
 * @param {string|undefined} userSub the identity to act as
 * @returns {Promise<boolean>} true when acting operator-wide rather than as one user
 */
async function applyRlsContext(client, userSub) {
  if (userSub) {
    await client.query("SELECT set_config('oshal.current_sub', $1, false)", [userSub]);
    return false;
  }
  // No sub: an account-name or single-connection lookup has to see every row. That is an operator
  // read, so it must be asked for explicitly — never escalated silently to make a query "work".
  if (process.env.OSHAL_OPERATOR === '1') {
    await client.query("SELECT set_config('oshal.is_operator', 'on', false)");
    return true;
  }
  console.error('SEND_FAIL no OSHAL_USER_SUB set. oshal_connections is force-RLS, so an unscoped');
  console.error('  query returns zero rows regardless of what is connected. Set OSHAL_USER_SUB to');
  console.error('  the sending identity, or OSHAL_OPERATOR=1 to look up by GMAIL_ACCOUNT.');
  process.exit(2);
  return false;
}

async function getAccessToken(client) {
  const account = process.env.GMAIL_ACCOUNT;
  const userSub = process.env.OSHAL_USER_SUB;
  await applyRlsContext(client, userSub);
  let row;
  if (userSub) row = (await client.query(`SELECT * FROM oshal_connections WHERE provider='google' AND user_sub=$1 ORDER BY updated_at DESC LIMIT 1`, [userSub])).rows[0];
  else if (account) row = (await client.query(`SELECT * FROM oshal_connections WHERE provider='google' AND lower(account_email)=lower($1) LIMIT 1`, [account])).rows[0];
  else {
    const all = (await client.query(`SELECT account_email FROM oshal_connections WHERE provider='google' ORDER BY updated_at DESC`)).rows;
    if (all.length !== 1) { console.error('SEND_FAIL specify GMAIL_ACCOUNT (connections: ' + all.map((r) => r.account_email).join(', ') + ')'); process.exit(2); }
    row = (await client.query(`SELECT * FROM oshal_connections WHERE provider='google' AND account_email=$1 LIMIT 1`, [all[0].account_email])).rows[0];
  }
  if (!row) {
    console.error('SEND_FAIL no Google connection visible for '
      + (userSub ? 'sub ' + userSub : 'account ' + (account || '(auto)'))
      + ' — note oshal_connections is force-RLS, so this means "not visible in this context",');
    console.error('  not necessarily "does not exist". Check the sub before concluding it is absent.');
    process.exit(2);
  }
  console.error('scopes:', row.scope || row.scopes || '(unknown)');
  if (row.access_token && row.expiry && new Date(row.expiry).getTime() - Date.now() > 60000) {
    try {
      return { token: await decryptToken(client, row.user_sub, row.access_token), account: row.account_email };
    } catch (e) {
      // Format drift (a v2 blob whose DEK we cannot unwrap) or a stale blob must not be fatal —
      // the refresh_token below is the recovery path. Aborting here is what killed every send.
      console.error('access_token decrypt failed (' + e.message + '); refreshing via refresh_token');
    }
  }
  if (!row.refresh_token) { console.error('SEND_FAIL no refresh token'); process.exit(2); }
  const clientId = process.env.GOOGLE_CONNECT_CLIENT_ID || process.env.OIDC_CLIENT_ID || '';
  const clientSecret = process.env.GOOGLE_CONNECT_CLIENT_SECRET || process.env.OIDC_CLIENT_SECRET || '';
  const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: await decryptToken(client, row.user_sub, row.refresh_token), grant_type: 'refresh_token' });
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  if (!r.ok) { console.error('SEND_FAIL token refresh ' + r.status + ' ' + (await r.text()).slice(0, 200)); process.exit(3); }
  const tok = await r.json();
  await client.query(`UPDATE oshal_connections SET access_token=$3, expiry=$4, updated_at=NOW() WHERE provider='google' AND account_email=$1 AND user_sub=$2`,
    [row.account_email, row.user_sub, await encryptToken(client, row.user_sub, tok.access_token), tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000) : null]).catch(() => {});
  return { token: tok.access_token, account: row.account_email };
}
function b64url(buf) { return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function wrap76(s) { return s.replace(/.{1,76}/g, '$&\r\n'); }

async function send(token, account, to, subject, body, attachPath) {
  const lines = [`From: ${account}`, `To: ${to}`, `Subject: ${subject}`, 'MIME-Version: 1.0'];
  let mime;
  if (attachPath && fs.existsSync(attachPath)) {
    const b = wrap76(fs.readFileSync(attachPath).toString('base64'));
    const name = path.basename(attachPath); const bnd = 'oshal_' + Date.now();
    mime = lines.concat([
      `Content-Type: multipart/mixed; boundary="${bnd}"`, '',
      `--${bnd}`, 'Content-Type: text/plain; charset="UTF-8"', '', body, '',
      `--${bnd}`, `Content-Type: ${mimeFor(name)}; name="${name}"`, 'Content-Transfer-Encoding: base64', `Content-Disposition: attachment; filename="${name}"`, '', b, `--${bnd}--`, '',
    ]).join('\r\n');
  } else {
    mime = lines.concat(['Content-Type: text/plain; charset="UTF-8"', '', body]).join('\r\n');
  }
  const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: b64url(mime) }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { console.error('SEND_FAIL ' + r.status + ' ' + JSON.stringify(j).slice(0, 240)); process.exit(4); }
  console.log('SEND_OK id=' + j.id + ' to=' + to + ' from=' + account);
}

async function main() {
  const [to, subject, bodyFile, attachPath] = process.argv.slice(2);
  if (!to || !subject) { console.error('usage: oshal-gmail-send.js <to> <subject> <bodyFile> [attachment]'); process.exit(1); }
  const body = bodyFile && fs.existsSync(bodyFile) ? fs.readFileSync(bodyFile, 'utf8') : (bodyFile || '');
  const provided = resolveProvidedToken();
  if (provided) { await send(provided, process.env.GMAIL_ACCOUNT || 'me', to, subject, body, attachPath); return; }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  // A pooled CLIENT, not the Pool: set_config is connection-scoped, so a GUC set through
  // pool.query() can land on a different backend than the SELECT that depends on it.
  const client = await pool.connect();
  try { const { token, account } = await getAccessToken(client); await send(token, account, to, subject, body, attachPath); }
  finally { client.release(); await pool.end(); }
}

// Guarded so the guard spec can require mimeFor without firing a live send (the IIFE this
// replaced ran on import, which is why this file had no test).
if (require.main === module) {
  main().catch((e) => { console.error('SEND_FAIL ' + (e && e.message || e)); process.exit(1); });
}

module.exports = { mimeFor, send, applyRlsContext };
