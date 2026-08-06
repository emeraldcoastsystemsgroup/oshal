#!/usr/bin/env node
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Generic alert email sender for the trading watchdog (subject + body args, Gmail via the operator's Google connection token, same RLS-aware token flow as oshal-recap-email.js, no attachment).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Fix silent alert black-hole: all 5 callers (trading/stack watchdog, lab-report, ci-local, earnings-gate) invoke this via `docker exec` without OSHAL_USER_SUB, so it defaulted to the 'example-user-sub' placeholder and returned "SEND_FAIL no Google connection" on EVERY alert — that is why the 3-day wrangler deploy pile-up (which OOM-crashed the swarm) never notified anyone. Now sub falls back to the first OSHAL_OPERATOR_SUBS entry (set in the container) and the recipient falls back to the connected account's own inbox instead of the 'owner@example.com' placeholder.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Envelope-crypto v2 compat (same drift fixed in oshal-gmail.js 07-21 and oshal-recap-email.js 07-24/PR#28): connector tokens re-encrypt to `v2:` per-user-DEK blobs since OSHAL_ENVELOPE_CRYPTO defaulted ON (07-20), but this sibling's decrypt only knew the legacy single-KEK format, so even after the sub fix it died with "Unsupported state or unable to authenticate data". Ported the format-aware userDek/decryptToken helpers; an access-token decrypt failure now falls through to a refresh instead of aborting.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Telegram leg for every watchdog-family caller (BACKLOG "Telegram notification bot" go-live): runAlert() now sends the alert to the operator's Telegram chat FIRST (sendTelegramAlert — no-op without TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID, fixed-string errors so the token can never leak through an exception), then runs the unchanged Gmail leg. The trading/stack watchdogs, lab-report, ci-local, and earnings-gate all inherit the phone-push with zero caller changes; email exit codes are preserved.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | SECURITY-HARDENING 3.1/9: removed the hardcoded dev-key fallback from the token-key derivation - SESSION_SECRET unset now fails loud instead of silently deriving a well-known AES key any reader of this public repo can compute. No change on a correctly-provisioned box; guard: tests/unit/no-dev-secret-fallback.spec.ts.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Replace the copied v2/raw-SHA codec with the shared connector-token codec so alert delivery reads hkdf1 DEK wrappers and k2 shared blobs without drifting from the controller.
 */
/*
 * Usage (in the api container): node oshal-send-alert.js "<subject>" "<body>"
 * Prints TG_OK/TG_SKIP/TG_FAIL for the Telegram leg, then SEND_OK / SEND_FAIL for email.
 */
'use strict';
const { Pool } = require('pg');
const connectorTokenCrypto = require('./lib/connector-token-crypto');

const key = connectorTokenCrypto.legacyKey;
const gcmDecryptRaw = connectorTokenCrypto.gcmDecryptRaw;
/** Legacy single-KEK decrypt of an unprefixed `iv:tag:enc` blob. */
function decrypt(blob) { return gcmDecryptRaw(key(), blob).toString('utf8'); }
/** Version tag on per-user-DEK envelope blobs (mirrors connector-token-crypto.ts / oshal-recap-email.js). */
/** Unwrap this user's 32-byte DEK from oshal_user_deks (wrapped_dek is an iv:tag:enc blob under the KEK). */
async function userDek(pool, userSub) {
  return connectorTokenCrypto.userDek(pool, userSub, { createIfMissing: false });
}
/** Format-aware token decrypt: `v2:` = per-user-DEK envelope (default ON since 2026-07-20); else legacy KEK. */
async function decryptToken(pool, userSub, blob) {
  return connectorTokenCrypto.decryptToken(pool, userSub, blob);
}
function b64url(buf) { return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }

/**
 * Best-effort Telegram push of the alert — the free first-party channel of the pluggable notify
 * harness, duplicated here in the script's own self-contained style (it already hand-rolls Gmail).
 * No-op ({skipped:true}) unless BOTH TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are set. Errors are
 * FIXED strings or Telegram's own description — never a thrown message, which could carry the
 * request URL and with it the token.
 */
async function sendTelegramAlert(subject, body, deps = {}) {
  const env = deps.env || process.env;
  const fetchImpl = deps.fetch || fetch;
  const token = String(env.TELEGRAM_BOT_TOKEN || '').trim();
  const chatId = String(env.TELEGRAM_CHAT_ID || '').trim();
  if (!token || !chatId) return { skipped: true };
  const text = (subject + '\n\n' + body).slice(0, 3900); // Bot API caps message text at 4096
  try {
    const resp = await fetchImpl('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    const j = await resp.json().catch(() => ({}));
    if (!resp.ok || !j.ok) {
      return { skipped: false, ok: false, error: 'telegram_http_' + resp.status + (j.description ? ':' + j.description : '') };
    }
    return { skipped: false, ok: true, id: String((j.result && j.result.message_id) || '') };
  } catch {
    return { skipped: false, ok: false, error: 'telegram_send_failed' };
  }
}

/**
 * The alert legs, in order: Telegram first (so a broken email path still reaches the phone), then
 * the Gmail leg with its original exit-code contract. deps ({env,fetch,sendEmail}) is the test
 * seam — the guard spec proves BOTH legs are called without touching the network or a DB.
 */
async function runAlert(subject, body, deps = {}) {
  const tg = await sendTelegramAlert(subject, body, deps);
  if (tg.skipped) console.log('TG_SKIP not-configured');
  else if (tg.ok) console.log('TG_OK id=' + tg.id);
  else console.error('TG_FAIL ' + tg.error);
  const sendEmail = deps.sendEmail || sendEmailAlert;
  await sendEmail(subject, body);
  return tg;
}

async function sendEmailAlert(subject, body) {
  // Recipient: an explicit ALERT_EMAIL_TO override, else fall back to the connected account's own
  // inbox (resolved after the row fetch below) — never the 'owner@example.com' placeholder, which
  // silently black-holed every alert.
  const to = process.env.ALERT_EMAIL_TO || null;
  // Sender identity: callers (trading-watchdog, publish-lab-report, ci-local, stack-watchdog,
  // earnings-gate) invoke this via `docker exec` WITHOUT passing OSHAL_USER_SUB, so it used to
  // default to the 'example-user-sub' placeholder -> "SEND_FAIL no Google connection" even though a
  // real connection exists. Fall back to the first operator sub (OSHAL_OPERATOR_SUBS is set in the
  // container) so alerts resolve the operator's Google connection without every caller passing it.
  const sub = process.env.OSHAL_USER_SUB
    || (process.env.OSHAL_OPERATOR_SUBS || '').split(',')[0].trim()
    || 'example-user-sub';

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query("SELECT set_config('oshal.current_sub', $1, false)", [sub]);
    const row = (await client.query("SELECT * FROM oshal_connections WHERE provider='google' AND user_sub=$1 ORDER BY updated_at DESC LIMIT 1", [sub])).rows[0];
    if (!row) { console.error('SEND_FAIL no Google connection'); process.exit(2); }
    let token;
    // A stored access token can be legacy OR v2 envelope; a decrypt failure (e.g. token re-encrypted
    // to v2 after a reconnect) must fall through to the refresh path, not abort the whole send.
    if (row.access_token && row.expiry && new Date(row.expiry).getTime() - Date.now() > 60000) {
      try { token = await decryptToken(client, sub, row.access_token); } catch { token = undefined; }
    }
    if (!token) {
      if (!row.refresh_token) { console.error('SEND_FAIL no refresh token'); process.exit(2); }
      const r = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: process.env.GOOGLE_CONNECT_CLIENT_ID || process.env.OIDC_CLIENT_ID || '',
          client_secret: process.env.GOOGLE_CONNECT_CLIENT_SECRET || process.env.OIDC_CLIENT_SECRET || '',
          refresh_token: await decryptToken(client, sub, row.refresh_token), grant_type: 'refresh_token',
        }),
      });
      if (!r.ok) { console.error('SEND_FAIL token refresh ' + r.status); process.exit(3); }
      token = (await r.json()).access_token;
    }
    const recipient = to || row.account_email;
    const mime = [`From: ${row.account_email}`, `To: ${recipient}`, `Subject: ${subject}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset="UTF-8"', '', body].join('\r\n');
    const resp = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ raw: b64url(mime) }),
    });
    const j = await resp.json().catch(() => ({}));
    if (!resp.ok) { console.error('SEND_FAIL ' + resp.status + ' ' + JSON.stringify(j).slice(0, 200)); process.exit(4); }
    console.log('SEND_OK id=' + j.id + ' to=' + recipient);
  } finally { client.release(); await pool.end(); }
}

async function main() {
  const subject = process.argv[2] || 'OSHAL alert';
  const body = process.argv[3] || '(no body)';
  await runAlert(subject, body);
}

if (require.main === module) {
  main().catch((e) => { console.error('SEND_FAIL ' + ((e && e.message) || e)); process.exit(1); });
}

module.exports = { key, gcmDecryptRaw, decrypt, userDek, decryptToken, sendTelegramAlert, runAlert };
