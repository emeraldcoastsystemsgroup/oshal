#!/usr/bin/env node
/*
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Outlook/Microsoft 365 reader (email swarm). Reads recent mail + today's calendar via Microsoft Graph using the OSHAL connector token (oshal_connections, provider=outlook). Mirrors oshal-gmail.js: AES-256-GCM decrypt + refresh (Azure AD). Prints the same digest JSON shape so the email bot can reason over Gmail OR Outlook identically.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-037 provider parity with oshal-gmail.js: (1) token broker — prefer the controller-provided short-lived token (.oshal-cred-outlook in cwd, or OSHAL_CRED_OUTLOOK env) so the bot never needs SESSION_SECRET/DB; (2) per-user scoping — OSHAL_USER_SUB (env or .oshal-user-sub file) scopes the DB fallback to the caller's own connection and FAILS CLOSED (exit 2) when >1 connection exists unscoped; (3) new verbs list/read/send over real Graph v1.0 endpoints (GET /me/messages with $top/$filter, GET /me/messages/{id}, POST /me/sendMail — send is --confirm-gated); (4) digest rows now carry id/receivedAt/providerFlags like the Gmail digest; (5) machine-readable JSON errors on every failure path + --help that needs no credentials. Refresh scope now includes Mail.Send.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Review findings (gap-list build 2026-07-15): (1) --body-file now fails closed (exit 1, machine-readable JSON) when the named file is missing instead of silently sending the literal path string as the email body — the positional bodyFileOrText keeps its file-or-literal duality for oshal-gmail-send.js parity; (2) body-file reads route through readBodyFile so EISDIR/EACCES print the {error, message} JSON contract instead of crashing main() with a raw stack outside the try/catch; (3) the token-persist UPDATE no longer swallows its rejection (.catch removed) — it propagates to main()'s handler like oshal-gmail.js, so a dropped rotated refresh token is diagnosable (no-swallowed-catches compliance).
 *
 * Prints JSON for a connected Microsoft 365 (Outlook) account. The account is
 * connected by a user at /utilities (provider id: outlook). Same output contract
 * as oshal-gmail.js so the communications-bot can run either provider.
 *
 *   node scripts/oshal-outlook.js                    # digest: recent mail + today's calendar
 *   node scripts/oshal-outlook.js list --top 25 [--filter "isRead eq false"]
 *   node scripts/oshal-outlook.js read <messageId>
 *   node scripts/oshal-outlook.js send <to> <subject> <bodyFileOrText> --confirm
 *   node scripts/oshal-outlook.js --help
 *
 * Exit 2 = no Outlook connection (connect at /utilities). Exit 3 = token refresh
 * failed. Exit 4 = send rejected by Graph. Exit 5 = send without --confirm.
 * Failures print one machine-readable JSON object {error, message} on stdout.
 */
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const LIST_SELECT = 'id,subject,from,receivedDateTime,bodyPreview,isRead,importance,flag';
const READ_SELECT = LIST_SELECT + ',body,toRecipients,ccRecipients';
const TENANT = process.env.AZURE_EMAIL_TENANT || process.env.AZURE_EMAIL_DIRECTORY_ID || process.env.OUTLOOK_TENANT_ID || 'common';
const CLIENT_ID = process.env.AZURE_EMAIL_APPLICATION_ID || process.env.AZURE_EMAIL_APPLICCATION_ID || '';
// The Azure client secret VALUE — OUTLOOK_CLIENT_VALUE is the var compose passes through
// (OUTLOOK_CLIENT_SECRET is historically the secret *id* GUID; tolerated last).
const CLIENT_SECRET = process.env.OUTLOOK_CLIENT_VALUE || process.env.AZURE_EMAIL_CLIENT_SECRET || process.env.OUTLOOK_CLIENT_SECRET || '';
const REFRESH_SCOPE = 'openid profile email offline_access Mail.Read Mail.Send Calendars.Read';

/** Machine-readable failure: JSON on stdout (the bot parses it), message on stderr, exit. */
function fail(exitCode, errorCode, message) {
  console.log(JSON.stringify({ error: errorCode, message }));
  console.error('oshal-outlook: ' + message);
  process.exit(exitCode);
}

/** The codex sandbox may not forward OSHAL_USER_SUB to shelled commands, so the
 *  codex wrapper also drops it as a cwd-relative file. Read whichever is present. */
function resolveUserSub() {
  if (process.env.OSHAL_USER_SUB) return process.env.OSHAL_USER_SUB;
  try { return (fs.readFileSync(path.join(process.cwd(), '.oshal-user-sub'), 'utf8').trim() || undefined); }
  catch { return undefined; }
}

/** Token broker: a short-lived access token the controller decrypted for THIS user and
 *  dropped into the workspace. Prefer it so we never touch SESSION_SECRET / the DB.
 *  Read the cwd file first (codex's channel), then the env (claude/cline). */
function resolveProvidedToken() {
  try {
    const t = fs.readFileSync(path.join(process.cwd(), '.oshal-cred-outlook'), 'utf8').trim();
    if (t) return t;
  } catch { /* no file — try env */ }
  return process.env.OSHAL_CRED_OUTLOOK || undefined;
}

function key() { return crypto.createHash('sha256').update(process.env.SESSION_SECRET || 'oshal-dev-secret').digest(); }
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

/** Pick THE caller's Outlook connection row. Per-user scoping mirrors oshal-gmail.js:
 *  never silently read someone else's mailbox when more than one connection exists. */
async function findConnectionRow(pool) {
  const userSub = resolveUserSub();
  const account = process.env.OUTLOOK_ACCOUNT;
  if (userSub) {
    const row = (await pool.query(`SELECT * FROM oshal_connections WHERE provider='outlook' AND user_sub=$1 ORDER BY updated_at DESC LIMIT 1`, [userSub])).rows[0];
    if (!row) fail(2, 'not_connected', `No Outlook connection for user ${userSub}. Connect at /utilities first.`);
    return row;
  }
  if (account) {
    return (await pool.query(`SELECT * FROM oshal_connections WHERE provider='outlook' AND lower(account_email)=lower($1) LIMIT 1`, [account])).rows[0];
  }
  const all = (await pool.query(`SELECT account_email FROM oshal_connections WHERE provider='outlook' ORDER BY updated_at DESC`)).rows;
  if (all.length > 1) {
    fail(2, 'ambiguous_account', `Refusing to guess: ${all.length} Outlook connections exist (${all.map((r) => r.account_email).join(', ')}). Set OSHAL_USER_SUB or OUTLOOK_ACCOUNT.`);
  }
  return all[0] ? (await pool.query(`SELECT * FROM oshal_connections WHERE provider='outlook' AND account_email=$1 LIMIT 1`, [all[0].account_email])).rows[0] : undefined;
}

/** DB fallback: decrypt the caller's stored token, refreshing via Azure AD when stale.
 *  Microsoft rotates refresh tokens, so a returned refresh_token is persisted too. */
async function getAccessToken(pool) {
  const row = await findConnectionRow(pool);
  if (!row) fail(2, 'not_connected', 'No Outlook connection found. Connect Outlook at /utilities first.');
  if (row.access_token && row.expiry && new Date(row.expiry).getTime() - Date.now() > 60000) {
    return { token: decrypt(row.access_token), account: row.account_email };
  }
  if (!row.refresh_token) fail(2, 'no_refresh_token', 'Connection has no refresh token; reconnect at /utilities.');
  const body = new URLSearchParams({
    client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: 'refresh_token',
    refresh_token: decrypt(row.refresh_token), scope: REFRESH_SCOPE,
  });
  const r = await fetch(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  if (!r.ok) fail(3, 'refresh_failed', 'Token refresh failed: ' + r.status + ' ' + (await r.text()).slice(0, 160));
  const tok = await r.json();
  // Persist the rotated tokens. Do NOT swallow a failure here: dropping a rotated
  // Microsoft refresh_token silently leaves every future call refreshing a stale
  // token with no diagnostic trail. Let it propagate to main()'s try/catch, which
  // prints the machine-readable {error, message} JSON — same as oshal-gmail.js,
  // which lets the identical UPDATE propagate.
  await pool.query(
    `UPDATE oshal_connections SET access_token=$3, refresh_token=COALESCE($4, refresh_token), expiry=$5, updated_at=NOW() WHERE provider='outlook' AND account_email=$1 AND user_sub=$2`,
    [row.account_email, row.user_sub, encrypt(tok.access_token), tok.refresh_token ? encrypt(tok.refresh_token) : null, tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000) : null],
  );
  return { token: tok.access_token, account: row.account_email };
}

/** Build the Graph list-messages URL. $filter (OData, e.g. "isRead eq false") is
 *  passed through verbatim; Graph rejects $orderby combined with most $filter
 *  expressions, so the orderby is only applied on unfiltered lists. */
function buildListMessagesUrl(opts) {
  const o = opts || {};
  const top = Math.min(Math.max(parseInt(o.top, 10) || 25, 1), 100);
  const params = new URLSearchParams();
  params.set('$top', String(top));
  params.set('$select', LIST_SELECT);
  if (o.filter) params.set('$filter', String(o.filter));
  else params.set('$orderby', 'receivedDateTime desc');
  return `${GRAPH_BASE}/me/messages?${params.toString()}`;
}

/** Build the Graph read-one URL (message id is URL-encoded — Graph ids carry '=' and '/'). */
function buildGetMessageUrl(messageId) {
  if (!messageId || typeof messageId !== 'string') throw new Error('read requires a message id');
  return `${GRAPH_BASE}/me/messages/${encodeURIComponent(messageId)}?$select=${READ_SELECT}`;
}

/** Build the real POST /me/sendMail payload shape (message + saveToSentItems). */
function buildSendMailPayload(opts) {
  const o = opts || {};
  const toList = (Array.isArray(o.to) ? o.to : String(o.to || '').split(',')).map((s) => String(s).trim()).filter(Boolean);
  if (toList.length === 0) throw new Error('send requires at least one recipient');
  if (!o.subject) throw new Error('send requires a subject');
  const ccList = (Array.isArray(o.cc) ? o.cc : String(o.cc || '').split(',')).map((s) => String(s).trim()).filter(Boolean);
  const message = {
    subject: String(o.subject),
    body: { contentType: o.contentType === 'HTML' ? 'HTML' : 'Text', content: String(o.body || '') },
    toRecipients: toList.map((address) => ({ emailAddress: { address } })),
  };
  if (ccList.length > 0) message.ccRecipients = ccList.map((address) => ({ emailAddress: { address } }));
  return { message, saveToSentItems: true };
}

/** Privacy-bounded row with the SAME field names the Gmail digest emits, so the
 *  communications-bot reasons over either provider without a translation step. */
function summarizeOutlookMessage(m) {
  const msg = m || {};
  const unread = msg.isRead === false;
  const important = String(msg.importance || '').toLowerCase() === 'high';
  const starred = String((msg.flag && msg.flag.flagStatus) || '').toLowerCase() === 'flagged';
  const receivedAt = msg.receivedDateTime || '';
  return {
    id: String(msg.id || ''),
    from: (msg.from && msg.from.emailAddress && (msg.from.emailAddress.name || msg.from.emailAddress.address)) || '',
    subject: msg.subject || '(no subject)',
    date: receivedAt,
    receivedAt,
    snippet: msg.bodyPreview || '',
    unread,
    important,
    starred,
    providerFlags: { unread, important, starred },
  };
}

/** Fetch one Graph JSON resource and fail closed on HTTP/provider errors. */
async function graphGet(token, url, fetchImpl) {
  const doFetch = fetchImpl || fetch;
  const response = await doFetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Graph API ${response.status}: ${detail.slice(0, 160)}`);
  }
  const data = await response.json();
  if (data && data.error) {
    throw new Error(`Graph API error: ${String(data.error.message || data.error).slice(0, 160)}`);
  }
  return data;
}

/** List recent messages (GET /me/messages with $top/$filter) as digest rows. */
async function mailDigest(token, opts, fetchImpl) {
  const data = await graphGet(token, buildListMessagesUrl(opts), fetchImpl);
  return (data.value || []).map(summarizeOutlookMessage);
}

/** Read one full message (GET /me/messages/{id}) — digest row + full body + recipients. */
async function readMessage(token, messageId, fetchImpl) {
  const msg = await graphGet(token, buildGetMessageUrl(messageId), fetchImpl);
  const row = summarizeOutlookMessage(msg);
  row.body = {
    contentType: (msg.body && msg.body.contentType) || 'Text',
    content: (msg.body && msg.body.content) || '',
  };
  row.to = (msg.toRecipients || []).map((r) => (r.emailAddress && r.emailAddress.address) || '').filter(Boolean);
  row.cc = (msg.ccRecipients || []).map((r) => (r.emailAddress && r.emailAddress.address) || '').filter(Boolean);
  return row;
}

/** Send mail (POST /me/sendMail). Graph answers 202 Accepted with an empty body. */
async function sendMail(token, payload, fetchImpl) {
  const doFetch = fetchImpl || fetch;
  const response = await doFetch(`${GRAPH_BASE}/me/sendMail`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (response.status !== 202 && !response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`sendMail rejected: ${response.status} ${detail.slice(0, 200)}`);
  }
  return { status: response.status };
}

/** Today's calendar (GET /me/calendarView) — ancillary; an outage must not falsify mail state. */
async function calendarDigest(token, fetchImpl) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
  const url = `${GRAPH_BASE}/me/calendarView?startDateTime=${encodeURIComponent(start)}&endDateTime=${encodeURIComponent(end)}&$select=subject,start,location&$orderby=start/dateTime`;
  const data = await graphGet(token, url, fetchImpl);
  return (data.value || []).map((e) => ({ summary: e.subject || '(busy)', start: (e.start && e.start.dateTime) || '' }));
}

function usage() {
  return [
    'Usage: node scripts/oshal-outlook.js [command] [options]',
    '',
    'Commands (default: digest):',
    '  digest                             Recent mail + today\'s calendar (same JSON shape as oshal-gmail.js)',
    '  list [--top N] [--filter <OData>]  List messages (GET /me/messages; e.g. --filter "isRead eq false")',
    '  read <messageId>                   One full message (GET /me/messages/{id})',
    '  send <to> <subject> <bodyFileOrText> --confirm',
    '                                     Send mail (POST /me/sendMail). REAL send — requires --confirm.',
    '                                     Flags also accepted: --to a@b.c[,c@d.e] --subject S --body T | --body-file F [--cc ...]',
    '',
    'Auth: prefers the controller-brokered token (.oshal-cred-outlook / OSHAL_CRED_OUTLOOK);',
    'falls back to the per-user connection in oshal_connections (DATABASE_URL + SESSION_SECRET,',
    'scoped by OSHAL_USER_SUB or OUTLOOK_ACCOUNT).',
    '',
    'Exit codes: 0 ok, 1 provider/other error, 2 not connected, 3 refresh failed, 4 send rejected, 5 send without --confirm.',
  ].join('\n');
}

/** Parse argv into {cmd, id, top, filter, to, subject, body, bodyFile, cc, confirm, help}. */
function parseCliArgs(argv) {
  const out = { cmd: 'digest', positional: [], confirm: false, help: false };
  const flagsWithValue = new Set(['--top', '--filter', '--to', '--subject', '--body', '--body-file', '--cc']);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--confirm') out.confirm = true;
    else if (flagsWithValue.has(a)) { out[a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[i + 1]; i += 1; }
    else out.positional.push(a);
  }
  if (['digest', 'list', 'read', 'send'].includes(out.positional[0])) out.cmd = out.positional.shift();
  return out;
}

/** Read a body file, failing closed with the standard machine-readable {error, message}
 *  JSON (exit 1) on any read error — EISDIR when the path is a directory, EACCES when
 *  unreadable — rather than throwing a raw stack. resolveSendInputs is called from
 *  main() outside the try/catch, so an uncaught throw here would crash the process with
 *  no JSON on stdout, breaking the documented failure contract the bot parses. */
function readBodyFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    fail(1, 'bad_arguments', `Cannot read body file ${filePath}: ${String((err && err.message) || err)}`);
    return ''; // unreachable — fail() calls process.exit
  }
}

/** Resolve the send inputs from flags or the oshal-gmail-send.js-style positionals.
 *  --body-file declares FILE semantics: fail closed (exit 1) when the file is missing,
 *  so a mistyped/cleaned-up path never sends the literal path string as the email body.
 *  The positional bodyFileOrText keeps the deliberate file-or-literal duality for exact
 *  parity with oshal-gmail-send.js. */
function resolveSendInputs(args) {
  const to = args.to || args.positional[0];
  const subject = args.subject || args.positional[1];
  let body = args.body;
  if (args.bodyFile !== undefined) {
    if (!fs.existsSync(args.bodyFile)) {
      fail(1, 'bad_arguments', `--body-file not found: ${args.bodyFile}. Pass an existing file or use --body <text>.`);
    }
    body = readBodyFile(args.bodyFile);
  } else {
    const bodyRef = args.body === undefined ? args.positional[2] : undefined;
    if (bodyRef !== undefined) body = fs.existsSync(bodyRef) ? readBodyFile(bodyRef) : String(bodyRef);
  }
  return { to, subject, body: body || '', cc: args.cc };
}

/** Run the selected command against Graph and print its JSON result. */
async function executeCommand(args, token, account) {
  const retrievedAt = new Date().toISOString();
  if (args.cmd === 'list') {
    const emails = await mailDigest(token, { top: args.top, filter: args.filter });
    console.log(JSON.stringify({ account, provider: 'outlook', retrievedAt, emails }, null, 2));
  } else if (args.cmd === 'read') {
    const id = args.positional[0];
    if (!id) fail(1, 'bad_arguments', 'read requires a message id: oshal-outlook.js read <messageId>');
    console.log(JSON.stringify({ account, provider: 'outlook', retrievedAt, message: await readMessage(token, id) }, null, 2));
  } else if (args.cmd === 'send') {
    const payload = buildSendMailPayload(resolveSendInputs(args));
    const result = await sendMail(token, payload).catch((err) => fail(4, 'send_rejected', String((err && err.message) || err)));
    const to = payload.message.toRecipients.map((r) => r.emailAddress.address);
    console.log(JSON.stringify({ account, provider: 'outlook', sent: true, status: result.status, to, subject: payload.message.subject, sentAt: retrievedAt }, null, 2));
  } else {
    // digest — mail is the provider record (fail closed); calendar stays best-effort.
    const [emails, events] = await Promise.all([mailDigest(token, {}), calendarDigest(token).catch(() => [])]);
    console.log(JSON.stringify({ account, provider: 'outlook', date: retrievedAt.slice(0, 10), retrievedAt, emails, events }, null, 2));
  }
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.help) { console.log(usage()); return; }
  if (args.cmd === 'send') {
    const inputs = resolveSendInputs(args);
    if (!inputs.to || !inputs.subject) fail(1, 'bad_arguments', 'usage: oshal-outlook.js send <to> <subject> <bodyFileOrText> --confirm');
    if (!args.confirm) fail(5, 'confirm_required', 'send is a REAL outward-facing action — re-run with --confirm to acknowledge the user asked for it.');
  }
  // Token broker: if the controller handed us a token, use it directly — no DB, no SESSION_SECRET.
  const provided = resolveProvidedToken();
  if (provided) {
    try {
      await executeCommand(args, provided, process.env.OUTLOOK_ACCOUNT || 'connected');
    } catch (err) {
      fail(1, 'provider_error', String((err && err.message) || err));
    }
    return;
  }
  // Fallback: decrypt the per-user token from the DB (legacy path; needs SESSION_SECRET).
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const { token, account } = await getAccessToken(pool);
    await executeCommand(args, token, account);
  } catch (err) {
    fail(1, 'provider_error', String((err && err.message) || err));
  } finally {
    await pool.end().catch(() => {});
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  GRAPH_BASE,
  buildListMessagesUrl,
  buildGetMessageUrl,
  buildSendMailPayload,
  summarizeOutlookMessage,
  mailDigest,
  readMessage,
  sendMail,
  parseCliArgs,
};
