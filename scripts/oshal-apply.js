#!/usr/bin/env node
/*
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                          | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | apply-operator per-user tools: the four
 *   CLIs the apply-operator bot calls (career_profile / apply_queue / email_code / apply_trace).
 *   Strictly scoped to OSHAL_USER_SUB — every path resolves under {STORE}/{tenant}/{user_sub}/,
 *   identical to scripts/oshal-jobhunter.js, so one user's run can never read another's resume,
 *   profile, queue, or trace. Exit 2 = no user identity (set OSHAL_USER_SUB).
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | queue next: optional --posting <id>
 *   targeting so the mobile review card can auto-apply the SPECIFIC packet the operator reviewed
 *   (still packet- and US-gated) instead of only "newest generated first". Threshold gate is skipped
 *   for a deliberate per-job choice; default (no --posting) behaviour is unchanged.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | queue list [--threshold N] [--limit N]
 *   -> the same packet-ready, US-eligible set as `queue next` but as an ARRAY (up to --limit), so the
 *   durable enqueuer can mint ONE job-apply ticket per posting (queue works them one-at-a-time). Does
 *   NOT claim (dispatch claims each at apply time).
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | queue requeue <postingId> — undo a
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | SECURITY-HARDENING 3.1/9: removed the hardcoded dev-key fallback from the token-key derivation - SESSION_SECRET unset now fails loud instead of silently deriving a well-known AES key any reader of this public repo can compute. No change on a correctly-provisioned box; guard: tests/unit/no-dev-secret-fallback.spec.ts.
 *   claim (apply_active=1) + a 'deferred' status for a dispatch that never reached the desktop. Without
 *   it a durable job-apply ticket poisoned its OWN posting: gatherAndDispatch claims before dispatching,
 *   so a transient node-offline left the posting unfindable and the retry escalated "no submittable job
 *   ready" (8 tickets lost that way 2026-07-21). HARD-REFUSES when applied_at is set — a genuinely
 *   submitted application is never resurrected into a duplicate.
 *
 * Verbs:
 *   profile                                   -> canonical per-user form values (career_db.json + apply_profile.json overlay)
 *   queue next [--threshold N] [--posting ID] -> next approved, packet-ready, US-eligible item (newest generated first, or the given posting)
 *   queue list [--threshold N] [--limit N]    -> up to N packet-ready, US-eligible postings (for the durable ticket enqueuer)
 *   queue claim <postingId>                   -> claim the item (apply_active=0) so no other worker double-submits
 *   queue requeue <postingId>                 -> undo a claim/deferred that never reached the desktop (refuses if applied_at set)
 *   queue record <postingId> <status> [note]  -> record outcome (applied|deferred|dismissed); --confirmation <path>
 *   email-code                                -> newest ATS security code from the user's Gmail (OSHAL OAuth helper)
 *   trace                                     -> append one learning line to applications/_auto_apply_trace.jsonl
 *
 * Packets are located by SCANNING applications/<Company>__<postingId>/ — never by trusting a
 * stored resume_path (imported rows hold stale pre-migration Windows paths).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ── Identity + per-user path resolution (mirrors scripts/oshal-jobhunter.js) ───────────────
const STORE_ROOT = process.env.JOBHUNTER_STORE_ROOT
  || path.resolve(__dirname, '..', 'output', 'career-hunter-data');

/** OSHAL_USER_SUB env, or the cwd-relative file the codex wrapper drops (sandbox may not forward env). */
function resolveUserSub() {
  if (process.env.OSHAL_USER_SUB) return process.env.OSHAL_USER_SUB.trim();
  try { return fs.readFileSync(path.join(process.cwd(), '.oshal-user-sub'), 'utf8').trim() || undefined; }
  catch { return undefined; }
}

function userContext() {
  const userSub = resolveUserSub();
  if (!userSub) { console.error('No user identity. Set OSHAL_USER_SUB (the signed-in user).'); process.exit(2); }
  const tenant = (process.env.OSHAL_TENANT || 'default').trim();
  const tenantDir = path.join(STORE_ROOT, tenant);
  const userDir = path.join(tenantDir, userSub);
  return {
    userSub, tenant, tenantDir, userDir,
    corpusDb: process.env.JOBHUNTER_CORPUS_DB || path.join(tenantDir, 'corpus.db'),
    userDb: path.join(userDir, `user-${userSub}.db`),
    careerDb: path.join(userDir, 'career_db.json'),
    applyProfile: path.join(userDir, 'apply_profile.json'),
    appsDir: path.join(userDir, 'applications'),
  };
}

const out = (obj) => { process.stdout.write(JSON.stringify(obj) + '\n'); };
const fail = (msg, code = 1) => { console.error(msg); process.exit(code); };

// ── Token broker (Google), copied from oshal-jobhunter.js / oshal-gmail.js ─────────────────
function sessionKey() {
  return crypto.createHash('sha256').update(process.env.SESSION_SECRET || (() => { throw new Error('SESSION_SECRET is required - the hardcoded dev-key fallback was removed (docs/security/SECURITY-HARDENING.md 3.1/9); a well-known key is no key at all'); })()).digest();
}
function decrypt(blob) {
  const [iv, tag, enc] = String(blob).split(':');
  const d = crypto.createDecipheriv('aes-256-gcm', sessionKey(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]).toString('utf8');
}

// ── career_profile ─────────────────────────────────────────────────────────────────────────
// The canonical, per-user source of form values. career_db.json holds experience/skills/education
// (+ contact if present); apply_profile.json is an optional overlay for apply-only facts the resume
// doesn't carry (E.164 phone, address, work-auth/sponsorship, citizenship, clearance, EEO prefs).
// The bot must PAUSE if a required value is missing — never invent one.
function cmdProfile(ctx) {
  let career = null, overlay = {};
  try { career = JSON.parse(fs.readFileSync(ctx.careerDb, 'utf8')); }
  catch { fail(`No career profile for this user yet (${ctx.careerDb}). Upload+index a resume first.`, 2); }
  try { overlay = JSON.parse(fs.readFileSync(ctx.applyProfile, 'utf8')); } catch { /* optional */ }
  out({ user_sub: ctx.userSub, career_db: career, apply_profile: overlay,
        note: 'Pull every form value from here. If a required field is absent, pause and report it.' });
}

// ── apply_queue (next / claim / record) — operates on the per-user user_signals DB ───────────
/** ALTER-in the post-v1 apply columns if this DB predates them (the Node tool may touch the
 *  user DB before the Python engine's own _ensure_user_columns runs). Idempotent. */
function ensureUserColumns(db) {
  const have = new Set(db.prepare('PRAGMA table_info(user_signals)').all().map((r) => r.name));
  if (!have.has('apply_active')) { try { db.exec('ALTER TABLE user_signals ADD COLUMN apply_active INTEGER DEFAULT 1'); } catch { /* */ } }
  if (!have.has('confirmation_path')) { try { db.exec('ALTER TABLE user_signals ADD COLUMN confirmation_path TEXT'); } catch { /* */ } }
}

function openUserDb(ctx) {
  if (!fs.existsSync(ctx.corpusDb) || !fs.existsSync(ctx.userDb)) {
    fail(`No job data for this user yet (missing ${fs.existsSync(ctx.userDb) ? 'corpus' : 'user'} DB).`, 2);
  }
  const Database = require('better-sqlite3');
  const db = new Database(ctx.userDb);   // writable: claim/record write, and next may ALTER-in columns
  db.pragma('busy_timeout = 120000');
  db.exec(`ATTACH DATABASE '${ctx.corpusDb.replace(/'/g, "''")}' AS corpus`);
  ensureUserColumns(db);
  return db;
}

/** Locate a packet dir by its <Company>__<postingId> name — never trust a stored path. */
function packetDir(ctx, postingId) {
  try {
    const suffix = `__${postingId}`;
    const hit = fs.readdirSync(ctx.appsDir, { withFileTypes: true }).find((d) =>
      d.isDirectory() && d.name.endsWith(suffix) && fs.existsSync(path.join(ctx.appsDir, d.name, 'application.json')));
    return hit ? path.join(ctx.appsDir, hit.name) : null;
  } catch { return null; }
}

function cmdQueueNext(ctx, threshold, posting) {
  const db = openUserDb(ctx);
  try {
    // Packet-FIRST: a row can be status='generated' yet have its packet only in a legacy/OneDrive
    // location, not the swarm store — and the bot can't submit what isn't here. So we index the
    // packets that actually exist on disk (dir name = <Company>__<postingId>) and only ever return
    // a generated item whose Resume_ATS.pdf is present. Never trust a stored resume_path.
    const packetById = {};
    try {
      for (const name of fs.readdirSync(ctx.appsDir)) {
        const m = name.match(/__(\d+)$/);
        if (m) packetById[m[1]] = path.join(ctx.appsDir, name);
      }
    } catch { /* no applications dir yet */ }
    // Targeted mode (--posting <id>): the operator reviewed THIS packet in the mobile review card and
    // chose to auto-apply it, so return exactly that posting (still packet- and US-gated) rather than
    // "newest generated first". The fit-threshold gate is skipped for a deliberate, per-job choice.
    const targeted = Number.isFinite(posting) && posting > 0;
    // US filter is light (remote, a US state set by geocoding, or a US location string); the bot
    // re-checks US-only as a guardrail before opening a form.
    const rows = db.prepare(`
      SELECT pc.id AS posting_id, pc.title, pc.url, pc.location, pc.state, pc.remote,
             co.id AS company_id, co.name AS company,
             us.status, us.ai_fit_score, us.fit_score, us.generated_at,
             MAX(COALESCE(us.ai_fit_score,0), COALESCE(us.fit_score,0)) AS fit
        FROM corpus.postings_corpus pc
        JOIN corpus.companies co ON co.id = pc.company_id
        JOIN user_signals us ON us.posting_id = pc.id
       WHERE us.status = 'generated'
         AND us.applied_at IS NULL
         AND COALESCE(us.apply_active, 1) = 1
         AND ( @posting IS NULL OR pc.id = @posting )
         AND ( @posting IS NOT NULL OR MAX(COALESCE(us.ai_fit_score,0), COALESCE(us.fit_score,0)) >= @thr )
         AND ( pc.remote = 1
               OR pc.location LIKE '%United States%' OR pc.location LIKE '%USA%'
               OR (pc.state IS NOT NULL AND pc.state <> '') )
         -- light non-US exclusion (the bot still re-checks US-eligibility as a guardrail)
         AND pc.location NOT LIKE '%Canada%'  AND pc.location NOT LIKE '%United Kingdom%'
         AND pc.location NOT LIKE '%Ireland%' AND pc.location NOT LIKE '%, India%'
         AND pc.location NOT LIKE '%Germany%' AND pc.location NOT LIKE '%Australia%'
       ORDER BY us.generated_at DESC, fit DESC
       LIMIT 1000`).all({ thr: threshold, posting: targeted ? posting : null });
    let noPacket = 0;
    for (const row of rows) {
      const dir = packetById[String(row.posting_id)];
      const resume = dir ? path.join(dir, 'Resume_ATS.pdf') : null;
      if (!dir || !fs.existsSync(resume)) { noPacket++; continue; }   // packet not in the swarm store
      out({ item: {
        ...row,
        packet_dir: dir,
        resume_pdf: resume,
        cover_pdf: fs.existsSync(path.join(dir, 'CoverLetter.pdf')) ? path.join(dir, 'CoverLetter.pdf') : null,
        workday_autofill: fs.existsSync(path.join(dir, 'Resume_Workday_Autofill.txt')) ? path.join(dir, 'Resume_Workday_Autofill.txt') : null,
      }, checked: rows.length, skipped_without_packet: noPacket });
      return;
    }
    out({ item: null, note: `No submittable item (checked ${rows.length} generated; ${noPacket} had no packet in the swarm store).` });
  } finally { db.close(); }
}

function cmdQueueList(ctx, threshold, limit) {
  // Like cmdQueueNext but returns up to `limit` packet-ready, US-eligible postings (newest generated
  // first) instead of just the head — so the durable enqueuer can mint ONE job-apply ticket per
  // posting. Does NOT claim (dispatch claims each at apply time). Same packet-FIRST discipline: only
  // ever list a generated item whose Resume_ATS.pdf actually exists in the swarm store.
  const db = openUserDb(ctx);
  try {
    const packetById = {};
    try {
      for (const name of fs.readdirSync(ctx.appsDir)) {
        const m = name.match(/__(\d+)$/);
        if (m) packetById[m[1]] = path.join(ctx.appsDir, name);
      }
    } catch { /* no applications dir yet */ }
    const rows = db.prepare(`
      SELECT pc.id AS posting_id, pc.title, pc.url, pc.location, pc.state, pc.remote,
             co.name AS company,
             MAX(COALESCE(us.ai_fit_score,0), COALESCE(us.fit_score,0)) AS fit
        FROM corpus.postings_corpus pc
        JOIN corpus.companies co ON co.id = pc.company_id
        JOIN user_signals us ON us.posting_id = pc.id
       WHERE us.status = 'generated'
         AND us.applied_at IS NULL
         AND COALESCE(us.apply_active, 1) = 1
         AND MAX(COALESCE(us.ai_fit_score,0), COALESCE(us.fit_score,0)) >= @thr
         AND ( pc.remote = 1
               OR pc.location LIKE '%United States%' OR pc.location LIKE '%USA%'
               OR (pc.state IS NOT NULL AND pc.state <> '') )
         AND pc.location NOT LIKE '%Canada%'  AND pc.location NOT LIKE '%United Kingdom%'
         AND pc.location NOT LIKE '%Ireland%' AND pc.location NOT LIKE '%, India%'
         AND pc.location NOT LIKE '%Germany%' AND pc.location NOT LIKE '%Australia%'
       ORDER BY us.generated_at DESC, fit DESC
       LIMIT 2000`).all({ thr: threshold });
    const items = [];
    for (const row of rows) {
      if (items.length >= limit) break;
      const dir = packetById[String(row.posting_id)];
      if (!dir || !fs.existsSync(path.join(dir, 'Resume_ATS.pdf'))) continue; // packet not in the store
      items.push({ posting_id: row.posting_id, title: row.title, company: row.company, url: row.url, location: row.location });
    }
    out({ items, checked: rows.length, returned: items.length });
  } finally { db.close(); }
}

function cmdQueueClaim(ctx, postingId) {
  const db = openUserDb(ctx);
  try {
    db.prepare(`INSERT INTO user_signals (posting_id, apply_active) VALUES (?, 0)
                ON CONFLICT(posting_id) DO UPDATE SET apply_active = 0`).run(postingId);
    out({ ok: true, posting_id: postingId, claimed: true });
  } finally { db.close(); }
}

function cmdQueueRequeue(ctx, postingId) {
  // Roll a posting BACK to eligible after a dispatch that never reached the desktop. gatherAndDispatch
  // claims (apply_active=0) before dispatching, and the old failure path also recorded 'deferred' —
  // both make `queue next --posting <id>` return nothing, so a durable job-apply ticket that retries
  // would escalate with "no submittable job ready" (it poisoned its own posting). This undoes exactly
  // that. HARD REFUSAL when applied_at is set: a genuinely-submitted application must NEVER be
  // resurrected into a duplicate submission.
  const db = openUserDb(ctx);
  try {
    const row = db.prepare('SELECT posting_id, status, applied_at, apply_active FROM user_signals WHERE posting_id = ?').get(postingId);
    if (!row) { out({ ok: false, posting_id: postingId, note: 'no user_signals row' }); return; }
    if (row.applied_at) { out({ ok: false, posting_id: postingId, applied_at: row.applied_at, note: 'already applied — refusing to requeue (would duplicate the application)' }); return; }
    db.prepare(`UPDATE user_signals
                   SET apply_active = 1,
                       status = CASE WHEN status = 'deferred' THEN 'generated' ELSE status END
                 WHERE posting_id = ? AND applied_at IS NULL`).run(postingId);
    const after = db.prepare('SELECT status, apply_active FROM user_signals WHERE posting_id = ?').get(postingId);
    out({ ok: true, posting_id: postingId, from: { status: row.status, apply_active: row.apply_active }, to: after });
  } finally { db.close(); }
}

function cmdQueueRecord(ctx, postingId, status, note, confirmation) {
  const ALLOWED = new Set(['applied', 'deferred', 'dismissed']);
  if (!ALLOWED.has(status)) fail(`status must be one of ${[...ALLOWED].join('|')}`, 2);
  const appliedAt = status === 'applied' ? new Date().toISOString() : null;
  const db = openUserDb(ctx);
  try {
    db.prepare(`
      INSERT INTO user_signals (posting_id, status, applied_at, apply_active, notes, confirmation_path)
      VALUES (@id, @status, @appliedAt, 1, @note, @conf)
      ON CONFLICT(posting_id) DO UPDATE SET
        status = @status,
        applied_at = COALESCE(@appliedAt, user_signals.applied_at),
        apply_active = 1,
        notes = @note,
        confirmation_path = COALESCE(@conf, user_signals.confirmation_path)`)
      .run({ id: postingId, status, appliedAt, note: note || null, conf: confirmation || null });
    out({ ok: true, posting_id: postingId, status });
  } finally { db.close(); }
}

// ── email_code: newest ATS verification code from the user's connected Gmail ─────────────────
function resolveProvidedToken() {
  try { const t = fs.readFileSync(path.join(process.cwd(), '.oshal-cred-google'), 'utf8').trim(); if (t) return t; }
  catch { /* no file — try env */ }
  return process.env.OSHAL_CRED_GOOGLE || undefined;
}
async function googleToken(ctx) {
  const provided = resolveProvidedToken();
  if (provided) return provided;
  const { Pool } = require('pg');
  const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL }) : new Pool();
  try {
    const row = (await pool.query(
      `SELECT access_token, refresh_token, expiry, account_email FROM oshal_connections
        WHERE provider='google' AND user_sub=$1 ORDER BY updated_at DESC LIMIT 1`, [ctx.userSub])).rows[0];
    if (!row) fail(`No Google connection for this user. Connect a Google account at /utilities first.`, 2);
    if (row.access_token && row.expiry && new Date(row.expiry).getTime() - Date.now() > 60000) {
      try { return decrypt(row.access_token); } catch { return row.access_token; }
    }
    if (!row.refresh_token) fail('Google connection has no refresh token; reconnect at /utilities.', 2);
    const clientId = process.env.GOOGLE_CONNECT_CLIENT_ID || process.env.OIDC_CLIENT_ID || '';
    const clientSecret = process.env.GOOGLE_CONNECT_CLIENT_SECRET || process.env.OIDC_CLIENT_SECRET || '';
    const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret,
      refresh_token: decrypt(row.refresh_token), grant_type: 'refresh_token' });
    const r = await fetch('https://oauth2.googleapis.com/token',
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    if (!r.ok) fail('Google token refresh failed: ' + r.status, 3);
    return (await r.json()).access_token;
  } finally { await pool.end(); }
}
/**
 * Extract an ATS security code from subject+snippet. Handles BOTH numeric one-time codes AND
 * alphanumeric codes (Greenhouse emails mixed-case 8-char codes like "MOdQxvYC"; a bare \d{4,8}
 * matched the "© 2026" YEAR instead — the bug that made every code entry fail). Order: a LABELLED
 * code ("...code...: XXXX" / "paste this ...: XXXX") wins; then a mixed-case/alnum 6-8 token; then
 * 4-8 digits as a last resort. Returns null when nothing code-shaped is present.
 */
/** True if a 6-8 char token looks like a code, not a capitalized English word. A Title-case word
 *  (Thanks, Security) has exactly ONE case transition; a random code (MOdQxvYC) has several, or a
 *  digit. So: has a digit, OR >=2 upper/lower transitions. */
function looksLikeCode(t) {
  if (/[0-9]/.test(t) && /[A-Za-z]/.test(t)) return true;
  let trans = 0;
  for (let i = 1; i < t.length; i++) { if (/[A-Z]/.test(t[i - 1]) !== /[A-Z]/.test(t[i])) trans++; }
  return trans >= 2;
}
function extractCode(hay) {
  const m1 = hay.match(/(?:code(?:\s+field)?[^:\n]{0,40}:|paste[^:\n]{0,40}:|code\s+is\s*[:]?)\s*([A-Za-z0-9]{4,10})\b/i);
  if (m1 && !/^(19|20)\d{2}$/.test(m1[1])) return m1[1];  // labelled (ignore a bare 4-digit year)
  for (const t of (hay.match(/\b[A-Za-z0-9]{6,8}\b/g) || [])) { if (looksLikeCode(t)) return t; }
  for (const t of (hay.match(/\b\d{4,8}\b/g) || [])) { if (!/^(19|20)\d{2}$/.test(t)) return t; } // digits, skip years
  return null;
}

async function cmdEmailCode(ctx) {
  const token = await googleToken(ctx);
  const q = encodeURIComponent('newer_than:1h (code OR verification OR verify OR "one-time" OR passcode OR PIN OR confirm OR security)');
  const list = await (await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${q}&maxResults=15`,
    { headers: { Authorization: `Bearer ${token}` } })).json();
  for (const m of (list.messages || [])) {
    const msg = await (await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
      { headers: { Authorization: `Bearer ${token}` } })).json();
    const h = Object.fromEntries((msg.payload?.headers || []).map((x) => [x.name.toLowerCase(), x.value]));
    const hay = `${h.subject || ''} ${msg.snippet || ''}`;
    const code = extractCode(hay);
    if (code) { out({ code, from: h.from || '', subject: h.subject || '', date: h.date || '', snippet: msg.snippet || '' }); return; }
  }
  out({ code: null, note: 'No verification code found in the last hour.' });
}

// ── apply_trace: append one learning line (per-user) ─────────────────────────────────────────
function cmdTrace(ctx) {
  const rec = {
    id: process.env.APPLY_POSTING_ID || null,
    company: process.env.APPLY_COMPANY || null,
    title: process.env.APPLY_TITLE || null,
    ats: process.env.APPLY_ATS || null,
    ai_fit: process.env.APPLY_AI_FIT ? Number(process.env.APPLY_AI_FIT) : null,
    result: process.env.APPLY_RESULT || null,      // applied | deferred | dismissed | escalated
    how: process.env.APPLY_HOW || null,            // submit_ok | verify_code | assist | timeout | ...
    blocker: process.env.APPLY_BLOCKER || null,
    ts: new Date().toISOString(),
  };
  fs.mkdirSync(ctx.appsDir, { recursive: true });
  fs.appendFileSync(path.join(ctx.appsDir, '_auto_apply_trace.jsonl'), JSON.stringify(rec) + '\n', 'utf8');
  out({ ok: true, traced: rec });
}

// Export the pure code extractor for regression tests (require() must NOT run the CLI — the
// dispatch IIFE below is gated on require.main === module so importing this file is side-effect free).
module.exports = { extractCode };

// ── Dispatch ─────────────────────────────────────────────────────────────────────────────────
function argVal(flag, def) { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : def; }

if (require.main === module) {
  (async () => {
    const ctx = userContext();
    const [verb, sub] = process.argv.slice(2);
    try {
      switch (verb) {
        case 'profile': cmdProfile(ctx); break;
        case 'email-code': await cmdEmailCode(ctx); break;
        case 'trace': cmdTrace(ctx); break;
        case 'queue': {
          if (sub === 'next') cmdQueueNext(ctx, Number(argVal('--threshold', '55')), Number(argVal('--posting')));
          else if (sub === 'list') cmdQueueList(ctx, Number(argVal('--threshold', '55')), Number(argVal('--limit', '200')));
          else if (sub === 'claim') cmdQueueClaim(ctx, Number(process.argv[4]));
          else if (sub === 'requeue') cmdQueueRequeue(ctx, Number(process.argv[4]));
          else if (sub === 'record') cmdQueueRecord(ctx, Number(process.argv[4]), process.argv[5], argVal('--note', process.argv[6]), argVal('--confirmation'));
          else fail('usage: oshal-apply queue <next|list|claim|requeue|record> [...]', 2);
          break;
        }
        default:
          fail('usage: oshal-apply <profile|queue|email-code|trace> [...]', 2);
      }
    } catch (err) {
      fail('oshal-apply failed: ' + (err && err.message ? err.message : String(err)), 1);
    }
  })();
}
