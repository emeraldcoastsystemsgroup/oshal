#!/usr/bin/env node
/* Send an email (optionally with one attachment) via the OSHAL Google connection token.
 * Reuses the oshal-gmail.js auth (controller-provided token, else DB refresh-token decrypt).
 * Usage: node oshal-gmail-send.js <to> <subject> <bodyFile> [attachmentPath]
 * Requires the Google connection to have a send-capable scope (gmail.send / modify / compose). */
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

function resolveProvidedToken() {
  try { const t = fs.readFileSync(path.join(process.cwd(), '.oshal-cred-google'), 'utf8').trim(); if (t) return t; } catch {}
  return process.env.OSHAL_CRED_GOOGLE || undefined;
}
function key() { return crypto.createHash('sha256').update(process.env.SESSION_SECRET || 'oshal-dev-secret').digest(); }
function decrypt(blob) {
  const [iv, tag, enc] = String(blob).split(':');
  const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]).toString('utf8');
}
function encrypt(plain) {
  const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return `${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
}
async function getAccessToken(pool) {
  const account = process.env.GMAIL_ACCOUNT;
  const userSub = process.env.OSHAL_USER_SUB;
  let row;
  if (userSub) row = (await pool.query(`SELECT * FROM oshal_connections WHERE provider='google' AND user_sub=$1 ORDER BY updated_at DESC LIMIT 1`, [userSub])).rows[0];
  else if (account) row = (await pool.query(`SELECT * FROM oshal_connections WHERE provider='google' AND lower(account_email)=lower($1) LIMIT 1`, [account])).rows[0];
  else {
    const all = (await pool.query(`SELECT account_email FROM oshal_connections WHERE provider='google' ORDER BY updated_at DESC`)).rows;
    if (all.length !== 1) { console.error('SEND_FAIL specify GMAIL_ACCOUNT (connections: ' + all.map((r) => r.account_email).join(', ') + ')'); process.exit(2); }
    row = (await pool.query(`SELECT * FROM oshal_connections WHERE provider='google' AND account_email=$1 LIMIT 1`, [all[0].account_email])).rows[0];
  }
  if (!row) { console.error('SEND_FAIL no Google connection'); process.exit(2); }
  console.error('scopes:', row.scope || row.scopes || '(unknown)');
  if (row.access_token && row.expiry && new Date(row.expiry).getTime() - Date.now() > 60000) return { token: decrypt(row.access_token), account: row.account_email };
  if (!row.refresh_token) { console.error('SEND_FAIL no refresh token'); process.exit(2); }
  const clientId = process.env.GOOGLE_CONNECT_CLIENT_ID || process.env.OIDC_CLIENT_ID || '';
  const clientSecret = process.env.GOOGLE_CONNECT_CLIENT_SECRET || process.env.OIDC_CLIENT_SECRET || '';
  const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: decrypt(row.refresh_token), grant_type: 'refresh_token' });
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  if (!r.ok) { console.error('SEND_FAIL token refresh ' + r.status + ' ' + (await r.text()).slice(0, 200)); process.exit(3); }
  const tok = await r.json();
  await pool.query(`UPDATE oshal_connections SET access_token=$3, expiry=$4, updated_at=NOW() WHERE provider='google' AND account_email=$1 AND user_sub=$2`,
    [row.account_email, row.user_sub, encrypt(tok.access_token), tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000) : null]).catch(() => {});
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
      `--${bnd}`, `Content-Type: video/mp4; name="${name}"`, 'Content-Transfer-Encoding: base64', `Content-Disposition: attachment; filename="${name}"`, '', b, `--${bnd}--`, '',
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

(async () => {
  const [to, subject, bodyFile, attachPath] = process.argv.slice(2);
  if (!to || !subject) { console.error('usage: oshal-gmail-send.js <to> <subject> <bodyFile> [attachment]'); process.exit(1); }
  const body = bodyFile && fs.existsSync(bodyFile) ? fs.readFileSync(bodyFile, 'utf8') : (bodyFile || '');
  const provided = resolveProvidedToken();
  if (provided) { await send(provided, process.env.GMAIL_ACCOUNT || 'me', to, subject, body, attachPath); return; }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try { const { token, account } = await getAccessToken(pool); await send(token, account, to, subject, body, attachPath); }
  finally { await pool.end(); }
})().catch((e) => { console.error('SEND_FAIL ' + (e && e.message || e)); process.exit(1); });
