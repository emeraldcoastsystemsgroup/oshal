#!/usr/bin/env node
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial trade-recap email tool (numbers in body + compressed video attached)
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Fix stale-date email: body/subject read recap-data.json, which the current pipeline no longer refreshes (it writes deck-data.json). A run left it dated June 30 while the video was July 6. Now prefer deck-data.json's {date, ...results} (today's authoritative numbers), fall back to recap-data.json.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Envelope-crypto compat (same drift that broke oshal-gmail.js, fixed there 07-21): connector tokens re-encrypt to `v2:` per-user-DEK blobs since OSHAL_ENVELOPE_CRYPTO defaulted ON (07-20), but this CLI's decrypt only knew the legacy single-KEK format — the daily recap email died with "Unsupported state or unable to authenticate data". Ported the format-aware decryptToken/userDek pattern from oshal-gmail.js (v2 -> unwrap per-user DEK from oshal_user_deks under the KEK, then DEK-decrypt; legacy -> KEK), made an access-token decrypt failure fall through to a refresh instead of aborting, and exported the helpers behind a require.main guard for the regression spec. Live-proven same evening: SEND_OK on the 2026-07-24 recap email, then archive + site publish completed.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | SECURITY-HARDENING 3.1/9: removed the hardcoded dev-key fallback from the token-key derivation - SESSION_SECRET unset now fails loud instead of silently deriving a well-known AES key any reader of this public repo can compute. No change on a correctly-provisioned box; guard: tests/unit/no-dev-secret-fallback.spec.ts.
 */
/*
 * trade_recap_email tool (in-container CLI). Sends the daily trade-recap email — the day's
 * numbers in the body + the compressed video as an attachment (the "let me know + preview").
 * Reuses the user's Google connection token. Sets the RLS user-context GUC (oshal.current_sub)
 * on its DB connection so the walled oshal_connections row is visible (ADR-076 FORCE RLS).
 *
 *   Usage:  node oshal-recap-email.js [{input}]
 *   input/env (all optional): { to?, sub?, data?, attachment? }
 *   Prints: SEND_OK id=... / SEND_FAIL ...
 */
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const OUT = '/run/desktop/mnt/host/c/Projects/open-shal-swarm-harness-agent-llm/packages/oshal-vids-operator/out';
function parseInput(raw) { if (!raw) return {}; try { return JSON.parse(raw); } catch { return {}; } }
function key() { return crypto.createHash('sha256').update(process.env.SESSION_SECRET || (() => { throw new Error('SESSION_SECRET is required - the hardcoded dev-key fallback was removed (docs/security/SECURITY-HARDENING.md 3.1/9); a well-known key is no key at all'); })()).digest(); }
function gcmDecryptRaw(k, blob) {
  const [iv, tag, enc] = String(blob).split(':');
  const d = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]);
}
/** Legacy single-KEK decrypt of an unprefixed `iv:tag:enc` blob. */
function decrypt(blob) { return gcmDecryptRaw(key(), blob).toString('utf8'); }

/** Version tag on per-user-DEK envelope blobs (mirrors src/app/routes/connector-token-crypto.ts). */
const ENVELOPE_V2 = 'v2:';
const _dekCache = new Map();
/**
 * @description Unwrap this user's 32-byte data-encryption-key from oshal_user_deks. The stored
 * wrapped_dek is itself an `iv:tag:enc` blob encrypted under the KEK = SHA256(SESSION_SECRET).
 * @param {object} pool pg pool or client (anything with .query)
 * @param {string} userSub connection owner's OIDC sub
 * @returns {Promise<Buffer>} the raw 32-byte DEK
 */
async function userDek(pool, userSub) {
  if (_dekCache.has(userSub)) return _dekCache.get(userSub);
  const row = (await pool.query('SELECT wrapped_dek FROM oshal_user_deks WHERE user_sub=$1', [userSub])).rows[0];
  if (!row) throw new Error(`no DEK row in oshal_user_deks for user ${userSub} (v2 blob but DEK missing)`);
  const dek = gcmDecryptRaw(key(), String(row.wrapped_dek));
  _dekCache.set(userSub, dek);
  return dek;
}
/**
 * @description Format-aware connector-token decrypt. Mirrors connector-token-crypto.ts decryptToken:
 * a `v2:`-prefixed blob is per-user-DEK encrypted (envelope crypto, ON by default since 2026-07-20);
 * an unprefixed blob is legacy single-KEK. Without this the CLI reads only legacy blobs and breaks
 * the moment a token is refreshed/reconnected into v2 (which is what killed the daily recap email).
 * @param {object} pool pg pool or client (anything with .query)
 * @param {string|undefined} userSub token owner's OIDC sub (required for v2 blobs)
 * @param {string} blob at-rest token blob
 * @returns {Promise<string>} plaintext token
 */
async function decryptToken(pool, userSub, blob) {
  if (String(blob).startsWith(ENVELOPE_V2)) {
    if (!userSub) throw new Error('decryptToken: v2 blob requires a userSub');
    return gcmDecryptRaw(await userDek(pool, userSub), String(blob).slice(ENVELOPE_V2.length)).toString('utf8');
  }
  return decrypt(blob);
}
function encrypt(plain) { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', key(), iv); const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]); return `${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${enc.toString('base64')}`; }
function b64url(buf) { return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function wrap76(s) { return s.replace(/.{1,76}/g, '$&\r\n'); }

function sign(n) { const x = Number(n); return `${x >= 0 ? '+' : ''}${x}`; }
function signMoney(n) { const x = Number(n); return `${x >= 0 ? '+' : '-'}$${Math.abs(x)}`; }
/**
 * @description Composes the recap email body. The closing paragraph describes what is ACTUALLY
 * attached: promising "video attached" on a numbers-only night (render node down, upstream API
 * outage, no headroom to render) is exactly the kind of small lie that erodes trust in every other
 * number in the mail. Callers pass hasVideo so the words match the payload.
 * @param d - The deck-data results block for the report day.
 * @param hasVideo - Whether a video attachment is actually going out with this mail.
 * @param note - Optional operations note explaining a late or degraded report.
 * @returns The plain-text email body.
 */
function composeBody(d, hasVideo, note) {
  const tail = hasVideo
    ? ['A ~36-second charted video recap (PowerPoint deck + narration) is attached',
       'as a compressed preview. Rendered on the render node via the',
       'daily-trade-recap workflow (remote-node A2A dispatch).']
    : ['No video accompanies this edition — the numbers above are the full report,',
       'and the deck and PDF are in the archive. Every figure comes from the trading',
       'ledger, not the broker\'s live equity.'];
  if (!d) return ['OSHAL Daily Trade Recap', '', ...(note ? [note, ''] : []), ...tail].join('\n');
  return [
    `OSHAL — Daily Trade Recap, ${d.date || ''}`, '',
    `The desk finished ${Number(d.pl) >= 0 ? 'UP' : 'DOWN'} ${signMoney(d.pl)} (${sign(d.pct)}%).`,
    `  Equity at close:  $${d.equity}`,
    `  Open positions:   ${d.positions}  (unrealized ${signMoney(d.unrealized)})`,
    `  Fills today:      ${d.fills}  — every trade tied to a signal`,
    `  Leaders:          ${d.leaders}`, '',
    ...(note ? [note, ''] : []),
    ...tail,
  ].join('\n');
}

async function sendMail(token, account, to, subject, body, attachPath) {
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
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ raw: b64url(mime) }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { console.error('SEND_FAIL ' + r.status + ' ' + JSON.stringify(j).slice(0, 240)); process.exit(4); }
  console.log('SEND_OK id=' + j.id + ' to=' + to + ' from=' + account + (attachPath && fs.existsSync(attachPath) ? ' attached=' + path.basename(attachPath) : ' (no attachment)'));
}

/**
 * Load the day's authoritative recap numbers in the flat shape composeBody() expects.
 * Prefers deck-data.json (what the current pipeline actually writes each run) and flattens
 * its {date, results:{...}} into the top-level fields; falls back to recap-data.json for
 * older runs / explicit --data overrides. This is what stops the email from carrying a stale
 * prior-day date + numbers when recap-data.json wasn't refreshed.
 * @param {object} input - parsed CLI input; input.data forces a specific file (flat shape).
 * @returns {object|null} flat recap data {date, pl, pct, equity, unrealized, fills, positions, leaders} or null.
 */
function loadRecapData(input) {
  if (input.data) { try { return JSON.parse(fs.readFileSync(input.data, 'utf8')); } catch { return null; } }
  try {
    const d = JSON.parse(fs.readFileSync(`${OUT}/deck-data.json`, 'utf8'));
    if (d && d.results) return { date: d.date, ...d.results };
  } catch { /* fall through to recap-data.json */ }
  try { return JSON.parse(fs.readFileSync(`${OUT}/recap-data.json`, 'utf8')); } catch { return null; }
}

/**
 * @description Entry point: load the day's numbers, resolve the user's Google token
 * (format-aware decrypt, refresh fallthrough), and send the recap email.
 * @returns {Promise<void>} resolves after SEND_OK is printed; exits non-zero on failure.
 */
async function main() {
  const input = parseInput(process.argv[2]);
  const to = input.to || process.env.RECAP_EMAIL_TO || 'owner@example.com';
  const sub = input.sub || process.env.OSHAL_USER_SUB || 'example-user-sub';
  const attach = input.attachment || `${OUT}/recap-email.mp4`;
  const data = loadRecapData(input);
  const subject = `OSHAL Daily Trade Recap${data && data.date ? ` — ${data.date}` : ''}`;
  // The body must describe the mail that is actually being sent, not the mail we usually send.
  const body = composeBody(data, fs.existsSync(attach), input.note || process.env.RECAP_NOTE || '');

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query("SELECT set_config('oshal.current_sub', $1, false)", [sub]);
    const row = (await client.query("SELECT * FROM oshal_connections WHERE provider='google' AND user_sub=$1 ORDER BY updated_at DESC LIMIT 1", [sub])).rows[0];
    if (!row) { console.error('SEND_FAIL no Google connection for sub ' + sub); process.exit(2); }
    let token;
    if (row.access_token && row.expiry && new Date(row.expiry).getTime() - Date.now() > 60000) {
      // A decrypt failure here must fall through to the refresh path, not abort — a stored
      // blob this process can't read (e.g. format drift) is recoverable via the refresh token.
      try { token = await decryptToken(client, sub, row.access_token); } catch { token = undefined; }
    }
    if (!token) {
      if (!row.refresh_token) { console.error('SEND_FAIL no refresh token'); process.exit(2); }
      const clientId = process.env.GOOGLE_CONNECT_CLIENT_ID || process.env.OIDC_CLIENT_ID || '';
      const clientSecret = process.env.GOOGLE_CONNECT_CLIENT_SECRET || process.env.OIDC_CLIENT_SECRET || '';
      const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: await decryptToken(client, sub, row.refresh_token), grant_type: 'refresh_token' }) });
      if (!r.ok) { console.error('SEND_FAIL token refresh ' + r.status + ' ' + (await r.text()).slice(0, 200)); process.exit(3); }
      const tok = await r.json(); token = tok.access_token;
      await client.query("UPDATE oshal_connections SET access_token=$3, expiry=$4, updated_at=NOW() WHERE provider='google' AND account_email=$1 AND user_sub=$2", [row.account_email, row.user_sub, encrypt(tok.access_token), tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000) : null]).catch(() => {});
    }
    await sendMail(token, row.account_email, to, subject, body, attach);
  } finally { client.release(); await pool.end(); }
}

if (require.main === module) {
  main().catch((e) => { console.error('SEND_FAIL ' + ((e && e.message) || e)); process.exit(1); });
}

module.exports = { key, gcmDecryptRaw, decrypt, userDek, decryptToken };
