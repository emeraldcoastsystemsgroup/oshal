#!/usr/bin/env node
/*
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Outlook (and Yahoo) mail reader over IMAP XOAUTH2 — the read path for the IMAP-scoped connector (IMAP.AccessAsUser.All), which can't call Microsoft Graph. Refreshes the short-lived MS access token itself (login.microsoftonline.com/{tenant}, IMAP scope), then connects imapflow to outlook.office365.com:993 with XOAUTH2 and emits the SAME digest JSON shape as oshal-gmail.js so the email bot reasons over Gmail OR Outlook identically. MAIL_PROVIDER=yahoo swaps the IMAP host (imap.mail.yahoo.com) — Yahoo token refresh is a follow-up once a Yahoo connector exists.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | SECURITY-HARDENING 3.1/9: removed the hardcoded dev-key fallback from the token-key derivation - SESSION_SECRET unset now fails loud instead of silently deriving a well-known AES key any reader of this public repo can compute. No change on a correctly-provisioned box; guard: tests/unit/no-dev-secret-fallback.spec.ts.
 *
 *   node scripts/oshal-outlook-imap.js                 # newest Outlook connection
 *   OUTLOOK_ACCOUNT=foo@bar.com node …                 # a specific connected account
 *   MAIL_PROVIDER=yahoo node …                         # read a Yahoo connection instead
 *
 * Exit 2 = no connection / ambiguous. Exit 3 = token refresh rejected.
 * Env: DATABASE_URL, SESSION_SECRET, OUTLOOK_TENANT_ID, AZURE_EMAIL_APPLICATION_ID, OUTLOOK_CLIENT_VALUE.
 */
'use strict';
const crypto = require('crypto');
const { Pool } = require('pg');
const { ImapFlow } = require('imapflow');

const PROVIDER = process.env.MAIL_PROVIDER || 'outlook';
const IMAP_HOSTS = { outlook: 'outlook.office365.com', yahoo: 'imap.mail.yahoo.com' };
const TENANT = process.env.OUTLOOK_TENANT_ID || process.env.AZURE_EMAIL_TENANT || process.env.AZURE_EMAIL_DIRECTORY_ID || 'common';
const MS_CLIENT_ID = process.env.AZURE_EMAIL_APPLICATION_ID || process.env.AZURE_EMAIL_APPLICCATION_ID || '';
const MS_CLIENT_SECRET = process.env.OUTLOOK_CLIENT_VALUE || process.env.AZURE_EMAIL_CLIENT_SECRET || process.env.OUTLOOK_CLIENT_SECRET || '';
const IMAP_SCOPE = 'openid profile email offline_access https://outlook.office.com/IMAP.AccessAsUser.All';

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

/** Microsoft refresh-token exchange, requesting the IMAP delegated scope. */
async function refreshOutlook(refresh) {
  const body = new URLSearchParams({
    client_id: MS_CLIENT_ID, client_secret: MS_CLIENT_SECRET,
    grant_type: 'refresh_token', refresh_token: refresh, scope: IMAP_SCOPE,
  });
  const r = await fetch(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
  });
  if (!r.ok) { console.error('Outlook token refresh failed: ' + r.status + ' ' + (await r.text()).slice(0, 160)); process.exit(3); }
  return r.json();
}

/** Resolve the connection + a valid access token (refreshing the short-lived one). Fails closed on ambiguity. */
async function getAccessToken(pool) {
  const account = process.env.OUTLOOK_ACCOUNT;
  let row;
  if (account) {
    row = (await pool.query(`SELECT * FROM oshal_connections WHERE provider=$1 AND lower(account_email)=lower($2) LIMIT 1`, [PROVIDER, account])).rows[0];
  } else {
    const all = (await pool.query(`SELECT account_email FROM oshal_connections WHERE provider=$1 ORDER BY updated_at DESC`, [PROVIDER])).rows;
    if (all.length > 1) {
      console.error(`Refusing to guess: ${all.length} ${PROVIDER} connections exist (${all.map((r) => r.account_email).join(', ')}). Set OUTLOOK_ACCOUNT=<email>.`);
      process.exit(2);
    }
    row = all[0] ? (await pool.query(`SELECT * FROM oshal_connections WHERE provider=$1 AND account_email=$2 LIMIT 1`, [PROVIDER, all[0].account_email])).rows[0] : undefined;
  }
  if (!row || !row.access_token) { console.error(`No ${PROVIDER} connection found. Connect it at /utilities first.`); process.exit(2); }
  if (row.expiry && new Date(row.expiry).getTime() - Date.now() > 60000) {
    return { token: decrypt(row.access_token), account: row.account_email };
  }
  if (!row.refresh_token) return { token: decrypt(row.access_token), account: row.account_email };
  const tok = await refreshOutlook(decrypt(row.refresh_token));
  await pool.query(
    `UPDATE oshal_connections SET access_token=$3, refresh_token=COALESCE($4, refresh_token), expiry=$5, updated_at=NOW()
     WHERE provider=$1 AND account_email=$2`,
    [PROVIDER, row.account_email, encrypt(tok.access_token), tok.refresh_token ? encrypt(tok.refresh_token) : null,
      tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000) : null],
  );
  return { token: tok.access_token, account: row.account_email };
}

/** Connect via IMAP XOAUTH2 and return the newest ~25 INBOX messages as a digest. */
async function imapDigest(account, token) {
  const client = new ImapFlow({
    host: IMAP_HOSTS[PROVIDER] || IMAP_HOSTS.outlook,
    port: 993, secure: true,
    auth: { user: account, accessToken: token },
    logger: false,
  });
  await client.connect();
  const out = [];
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const total = client.mailbox.exists || 0;
      if (total > 0) {
        const start = Math.max(1, total - 24);
        for await (const msg of client.fetch(`${start}:*`, { envelope: true, flags: true })) {
          const f = msg.envelope.from && msg.envelope.from[0];
          out.push({
            from: (f && (f.name || f.address)) || '',
            subject: msg.envelope.subject || '(no subject)',
            date: msg.envelope.date || '',
            unread: !(msg.flags && msg.flags.has('\\Seen')),
          });
        }
      }
    } finally { lock.release(); }
  } finally { await client.logout(); }
  return out.reverse(); // newest first
}

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const { token, account } = await getAccessToken(pool);
    const emails = await imapDigest(account, token).catch((e) => { console.error('imap: ' + (e && e.message || e)); return []; });
    // IMAP scope has no calendar; events stay empty (matches the gmail digest shape).
    console.log(JSON.stringify({ account, provider: PROVIDER, date: new Date().toISOString().slice(0, 10), emails, events: [] }, null, 2));
  } catch (err) {
    console.error('oshal-outlook-imap failed: ' + (err && err.message || err));
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
