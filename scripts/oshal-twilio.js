#!/usr/bin/env node
/*
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Phone + text CLI for the communications-bot (Intelligent Communication swarm, ADR-037 pattern: connector + oshal-<provider>.js, never a new app). Reads the per-user Twilio credential ("AccountSid:AuthToken" combined secret, provider='twilio') from the OSHAL connector store — connected at /utilities. Mirrors scripts/oshal-smartthings.js resolution: prefer the controller-brokered secret (.oshal-cred-twilio / OSHAL_CRED_TWILIO), else decrypt the per-user secret from the DB, else the operator env pair (TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN). Read verbs: digest (default), account, numbers, messages, calls, accounts. Send verbs (sms, call) are OUTWARD-FACING and confirm-gated: OSHAL_MESSAGE_SEND_CONFIRM=true or --confirm, else exit with no send. The auth token is never printed.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | SECURITY-HARDENING 3.1/9: removed the hardcoded dev-key fallback from the token-key derivation - SESSION_SECRET unset now fails loud instead of silently deriving a well-known AES key any reader of this public repo can compute. No change on a correctly-provisioned box; guard: tests/unit/no-dev-secret-fallback.spec.ts.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Preserve the exact scoped OIDC subject through the shared CLI identity reader.
 *
 *   node scripts/oshal-twilio.js                       # JSON digest (account, numbers, recent messages + calls)
 *   node scripts/oshal-twilio.js account               # account info (friendly name, status, type)
 *   node scripts/oshal-twilio.js numbers               # the account's phone numbers (the "from" candidates)
 *   node scripts/oshal-twilio.js messages --limit 20   # recent SMS, both directions
 *   node scripts/oshal-twilio.js calls --limit 10      # recent voice calls
 *   node scripts/oshal-twilio.js accounts              # list THIS user's labeled Twilio connections
 *   node scripts/oshal-twilio.js sms +15551234567 "running late, there in 10" --confirm
 *   node scripts/oshal-twilio.js call +15551234567 "Your build finished successfully." --confirm
 *   OSHAL_CONNECTION_LABEL="work" node scripts/oshal-twilio.js   # pick a labeled account
 *
 * Exit 2 = no Twilio connection (or ambiguous — connect at /utilities / name a label).
 */
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { resolveExactUserSubject } = require('./lib/exact-user-subject');

const API = 'https://api.twilio.com/2010-04-01';

/** The codex sandbox may not forward OSHAL_USER_SUB to shelled commands, so the
 *  wrapper also drops it as a cwd-relative file. Read whichever is present. */
function resolveUserSub() {
  return resolveExactUserSubject();
}

function truthyEnv(name) {
  return /^(1|true|yes)$/i.test(String(process.env[name] || ''));
}

function stripConfirmArgs(argv) {
  return argv.filter((arg) => arg !== '--confirm' && arg !== '--yes');
}

/** sms + call reach a real phone on the user's paid Twilio account — outward-facing. */
function isSendVerb(argv) {
  return ['sms', 'call'].includes(String(argv[0] || ''));
}

function hasSendConfirmation(argv) {
  return truthyEnv('OSHAL_MESSAGE_SEND_CONFIRM')
    || truthyEnv('OSHAL_ALLOW_MESSAGE_SEND')
    || argv.includes('--confirm')
    || argv.includes('--yes');
}

function assertSendConfirmed(argv) {
  if (!isSendVerb(argv) || hasSendConfirmation(argv)) return;
  throw new Error('no-send: Twilio sms/call sends require OSHAL_MESSAGE_SEND_CONFIRM=true or --confirm. Nothing was sent.');
}

/** Token broker: the "SID:AuthToken" secret the controller decrypted for THIS user and
 *  dropped into the workspace. Prefer it so we never touch SESSION_SECRET / the DB. */
function resolveProvidedSecret() {
  try {
    const t = fs.readFileSync(path.join(process.cwd(), '.oshal-cred-twilio'), 'utf8').trim();
    if (t) return t;
  } catch { /* no file — try env */ }
  return process.env.OSHAL_CRED_TWILIO || undefined;
}

/** Operator env fallback (the notification-transport pair) composed into the same shape. */
function secretFromEnvPair() {
  const sid = (process.env.TWILIO_ACCOUNT_SID || '').trim();
  const tok = (process.env.TWILIO_AUTH_TOKEN || '').trim();
  return sid && tok ? `${sid}:${tok}` : undefined;
}

function key() { return crypto.createHash('sha256').update(process.env.SESSION_SECRET || (() => { throw new Error('SESSION_SECRET is required - the hardcoded dev-key fallback was removed (docs/security/SECURITY-HARDENING.md 3.1/9); a well-known key is no key at all'); })()).digest(); }
function decrypt(blob) {
  const [iv, tag, enc] = String(blob).split(':');
  const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]).toString('utf8');
}

/** The connection the bot/user named: a label, an account id, or a connection id. */
function resolveSelector() {
  return {
    label: process.env.OSHAL_CONNECTION_LABEL || undefined,
    email: process.env.OSHAL_CONNECTION_EMAIL || undefined,
    connectionId: process.env.OSHAL_CONNECTION_ID || undefined,
  };
}

/** WHERE clause + params for the caller's accessible Twilio connections
 *  (personal ∪ shared/household). $1 = userSub. */
function accessibleWhere(userSub) {
  return {
    where: `provider='twilio' AND ((user_sub=$1 AND tenant_id IS NULL)
              OR tenant_id IN (SELECT tenant_id FROM oshal_tenant_memberships WHERE user_sub=$1))`,
    params: [userSub],
  };
}

/** List the caller's labeled Twilio connections (the catalog the bot selects from). */
async function listAccounts(pool) {
  const userSub = resolveUserSub();
  if (!userSub) {
    const all = (await pool.query(`SELECT label, account_email, tenant_id, is_default FROM oshal_connections WHERE provider='twilio' ORDER BY updated_at DESC`)).rows;
    return { accounts: all };
  }
  const { where, params } = accessibleWhere(userSub);
  const rows = (await pool.query(`SELECT label, account_email, tenant_id, is_default FROM oshal_connections WHERE ${where} ORDER BY is_default DESC, updated_at DESC`, params)).rows;
  return { accounts: rows };
}

/** Resolve the "SID:AuthToken" secret from the DB for the signed-in user, honoring a
 *  selector (label/email/connectionId) across personal ∪ shared connections. */
async function secretFromDb(pool, sel) {
  const userSub = resolveUserSub();
  sel = sel || {};
  const named = !!(sel.label || sel.email || sel.connectionId);
  if (!userSub) {
    const all = (await pool.query(`SELECT access_token FROM oshal_connections WHERE provider='twilio' ORDER BY updated_at DESC`)).rows;
    if (all.length > 1 && !named) { console.error(`Refusing to guess: ${all.length} Twilio connections exist. Set OSHAL_USER_SUB or a connection label.`); process.exit(2); }
    if (!all[0]) { console.error('No Twilio connection found. Connect at /utilities first.'); process.exit(2); }
    return decrypt(all[0].access_token);
  }
  const { where, params } = accessibleWhere(userSub);
  let sql = where;
  if (sel.connectionId) { params.push(sel.connectionId); sql += ` AND connection_id=$${params.length}`; }
  else if (sel.label) { params.push(sel.label); sql += ` AND lower(label)=lower($${params.length})`; }
  else if (sel.email) { params.push(sel.email); sql += ` AND lower(account_email)=lower($${params.length})`; }
  const rows = (await pool.query(`SELECT access_token FROM oshal_connections WHERE ${sql} ORDER BY is_default DESC, updated_at DESC`, params)).rows;
  if (!rows.length) {
    console.error(named ? `No Twilio connection matches that account for user ${userSub}.`
      : `No Twilio connection for user ${userSub}. Connect at /utilities first.`);
    process.exit(2);
  }
  return decrypt(rows[0].access_token);
}

/** Split the combined secret on the FIRST ':' (the auth token may itself contain ':'). */
function splitSecret(secret) {
  const i = String(secret).indexOf(':');
  if (i < 1) { console.error('Twilio credential is malformed (expected "AccountSid:AuthToken"). Reconnect at /utilities.'); process.exit(2); }
  return { sid: secret.slice(0, i), authToken: secret.slice(i + 1) };
}

/** Authorized Twilio API call → parsed JSON (throws on non-2xx with a short body).
 *  Basic auth built per-call; the header/token is never logged or returned. */
async function tw(cred, method, urlPath, form) {
  const r = await fetch(`${API}${urlPath}`, {
    method,
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${cred.sid}:${cred.authToken}`).toString('base64'),
      ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    ...(form ? { body: new URLSearchParams(form).toString() } : {}),
  });
  if (!r.ok) throw new Error(`Twilio ${method} ${urlPath} → ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const text = await r.text();
  return text ? JSON.parse(text) : {};
}

function assertE164(to) {
  if (!/^\+[1-9]\d{1,14}$/.test(String(to || ''))) {
    throw new Error(`"${to}" is not an E.164 phone number (e.g. +15551234567).`);
  }
}

/** XML-escape spoken text so it can't break/inject the TwiML (mirrors twilio-voice-transport). */
function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

async function accountInfo(cred) {
  const j = await tw(cred, 'GET', `/Accounts/${encodeURIComponent(cred.sid)}.json`);
  return { sid: j.sid, friendlyName: j.friendly_name, status: j.status, type: j.type };
}

/** The account's own phone numbers — the "from" candidates for sms/call. */
async function listNumbers(cred) {
  const j = await tw(cred, 'GET', `/Accounts/${encodeURIComponent(cred.sid)}/IncomingPhoneNumbers.json?PageSize=20`);
  return (j.incoming_phone_numbers || []).map((n) => ({
    phoneNumber: n.phone_number,
    friendlyName: n.friendly_name,
    smsEnabled: n.capabilities ? !!n.capabilities.sms : null,
    voiceEnabled: n.capabilities ? !!n.capabilities.voice : null,
  }));
}

/** The "from" number: explicit env wins, else the account's first (only) number. */
async function resolveFrom(cred) {
  const explicit = (process.env.TWILIO_FROM_NUMBER || '').trim();
  if (explicit) return explicit;
  const numbers = await listNumbers(cred);
  if (!numbers.length) throw new Error('This Twilio account has no phone number. Buy one in the Twilio console, or set TWILIO_FROM_NUMBER.');
  return numbers[0].phoneNumber;
}

async function listMessages(cred, limit) {
  const j = await tw(cred, 'GET', `/Accounts/${encodeURIComponent(cred.sid)}/Messages.json?PageSize=${limit}`);
  return (j.messages || []).map((m) => ({
    sid: m.sid, direction: m.direction, from: m.from, to: m.to,
    body: m.body, status: m.status, sentAt: m.date_sent || m.date_created,
  }));
}

async function listCalls(cred, limit) {
  const j = await tw(cred, 'GET', `/Accounts/${encodeURIComponent(cred.sid)}/Calls.json?PageSize=${limit}`);
  return (j.calls || []).map((c) => ({
    sid: c.sid, direction: c.direction, from: c.from, to: c.to,
    status: c.status, durationSeconds: c.duration != null ? Number(c.duration) : null,
    startedAt: c.start_time || c.date_created,
  }));
}

async function sendSms(cred, to, body) {
  assertE164(to);
  if (!body || !body.trim()) throw new Error('sms needs a non-empty message body.');
  const from = await resolveFrom(cred);
  const j = await tw(cred, 'POST', `/Accounts/${encodeURIComponent(cred.sid)}/Messages.json`, { From: from, To: to, Body: body });
  return { sent: true, sid: j.sid, from, to, status: j.status };
}

/** Place a call that SPEAKS the given text (inline TwiML <Say>), then hangs up. */
async function placeCall(cred, to, say) {
  assertE164(to);
  if (!say || !say.trim()) throw new Error('call needs a non-empty message to speak.');
  const from = await resolveFrom(cred);
  const twiml = `<Response><Say>${xmlEscape(say)}</Say></Response>`;
  const j = await tw(cred, 'POST', `/Accounts/${encodeURIComponent(cred.sid)}/Calls.json`, { From: from, To: to, Twiml: twiml });
  return { called: true, sid: j.sid, from, to, status: j.status };
}

function limitArg(argv, fallback) {
  const i = argv.indexOf('--limit');
  const n = i >= 0 ? Number(argv[i + 1]) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 100) : fallback;
}

/** Everything after the phone-number arg is the message (quoted or bare words). */
function restAsText(argv, fromIndex) {
  return argv.slice(fromIndex).filter((a) => a !== '--limit').join(' ').trim();
}

async function run(secret, argv) {
  const cred = splitSecret(secret);
  const verb = argv[0] || 'digest';
  if (verb === 'account') return { account: await accountInfo(cred) };
  if (verb === 'numbers') return { numbers: await listNumbers(cred) };
  if (verb === 'messages') return { messages: await listMessages(cred, limitArg(argv, 20)) };
  if (verb === 'calls') return { calls: await listCalls(cred, limitArg(argv, 10)) };
  if (verb === 'sms') return sendSms(cred, argv[1], restAsText(argv, 2));
  if (verb === 'call') return placeCall(cred, argv[1], restAsText(argv, 2));
  if (verb === 'digest') {
    const [account, numbers, messages, calls] = await Promise.all([
      accountInfo(cred), listNumbers(cred), listMessages(cred, 10), listCalls(cred, 5),
    ]);
    return { account, numbers, messages, calls, retrievedAt: new Date().toISOString() };
  }
  throw new Error(`unknown command: ${verb}`);
}

(async () => {
  const rawArgv = process.argv.slice(2);
  assertSendConfirmed(rawArgv);
  const argv = stripConfirmArgs(rawArgv);
  const sel = resolveSelector();
  const named = !!(sel.label || sel.email || sel.connectionId);

  // `accounts` lists the caller's labeled connections (catalog) — DB metadata, no secret.
  if (argv[0] === 'accounts') {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    try { console.log(JSON.stringify(await listAccounts(pool), null, 2)); }
    catch (err) { console.error('oshal-twilio failed: ' + (err && err.message || err)); process.exit(1); }
    finally { await pool.end(); }
    return;
  }

  // Fast path: no specific account named → brokered secret, else the operator env pair.
  const provided = named ? undefined : (resolveProvidedSecret() || secretFromEnvPair());
  if (provided) {
    try { console.log(JSON.stringify(await run(provided, argv), null, 2)); }
    catch (err) { console.error('oshal-twilio failed: ' + (err && err.message || err)); process.exit(1); }
    return;
  }
  // Otherwise resolve the selected connection's secret from the DB.
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const secret = await secretFromDb(pool, sel);
    console.log(JSON.stringify(await run(secret, argv), null, 2));
  } catch (err) {
    console.error('oshal-twilio failed: ' + (err && err.message || err));
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
