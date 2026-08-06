#!/usr/bin/env node
/*
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Per-site ATS account credentials for the apply-operator. Workday/Lever/iCIMS need an ACCOUNT per employer tenant — the reason WORKER_BRIEF parks them — and with `oshal-gmail.js verify` able to read the activation link, the only remaining gate was somewhere safe to keep the password. Stores an AES-256-GCM envelope (never plaintext) in the FORCE-RLS'd ats_site_credentials table (086), scoped to OSHAL_USER_SUB exactly like oshal-gmail.js resolves its mailbox. `gen` mints a strong password that satisfies the usual ATS rules so the operator never reuses one.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | SECURITY-HARDENING 3.1/9: removed the hardcoded dev-key fallback from the token-key derivation - SESSION_SECRET unset now fails loud instead of silently deriving a well-known AES key any reader of this public repo can compute. No change on a correctly-provisioned box; guard: tests/unit/no-dev-secret-fallback.spec.ts.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Preserve the exact scoped OIDC subject through the shared CLI identity reader.
 *
 * The apply runner shells out to this the same way it shells out to getcode.sh:
 *
 *   node scripts/oshal-site-creds.js gen                                   # a fresh strong password
 *   node scripts/oshal-site-creds.js put  --site <host> --username <email> [--password <p>|--generate] [--family workday]
 *   node scripts/oshal-site-creds.js get  --site <host>                    # {site, username, password}
 *   node scripts/oshal-site-creds.js list                                  # metadata only — never passwords
 *
 * Exit 2 = no user identity (set OSHAL_USER_SUB). Exit 3 = no credential for that site.
 */
'use strict';
const crypto = require('crypto');
const { Pool } = require('pg');
const { resolveExactUserSubject } = require('./lib/exact-user-subject');

/** The codex sandbox may not forward OSHAL_USER_SUB to shelled commands, so the wrapper also
 *  drops it as a cwd-relative file. Read whichever is present (same contract as oshal-gmail.js). */
function resolveUserSub() {
  return resolveExactUserSubject();
}

function key() { return crypto.createHash('sha256').update(process.env.SESSION_SECRET || (() => { throw new Error('SESSION_SECRET is required - the hardcoded dev-key fallback was removed (docs/security/SECURITY-HARDENING.md 3.1/9); a well-known key is no key at all'); })()).digest(); }

/** AES-256-GCM envelope `iv:tag:ciphertext` — the identical shape oshal_connections uses, so the
 *  secret at rest is never plaintext and a DB dump alone cannot reveal a site password. */
function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return `${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
}
function decrypt(blob) {
  const [iv, tag, enc] = String(blob).split(':');
  const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]).toString('utf8');
}

const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';   // no I/O — ATS support desks read these aloud
const LOWER = 'abcdefghijkmnpqrstuvwxyz';   // no l
const DIGIT = '23456789';                   // no 0/1
const SYMBOL = '!@#$%*?-_';                 // the punctuation ATS validators reliably accept

/** Uniform pick from `alphabet` using rejection sampling — `% len` on a random byte biases toward
 *  the low characters, which quietly shrinks the keyspace of every password we mint. */
function pick(alphabet) {
  const limit = 256 - (256 % alphabet.length);
  for (;;) {
    const b = crypto.randomBytes(1)[0];
    if (b < limit) return alphabet[b % alphabet.length];
  }
}

/** Mint a password that satisfies the usual ATS rules (>=1 of each class, length 20) and shuffle
 *  so the guaranteed characters aren't positionally predictable.
 *  @param {number} len total length (min 12)
 *  @returns {string} */
function generatePassword(len = 20) {
  const n = Math.max(12, len);
  const all = UPPER + LOWER + DIGIT + SYMBOL;
  const chars = [pick(UPPER), pick(LOWER), pick(DIGIT), pick(SYMBOL)];
  while (chars.length < n) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) { // Fisher-Yates with unbiased indices
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

/** Scope the connection to this user so the FORCE-RLS policy admits exactly their own rows.
 *  Set even though the CLI may connect as the superuser (which masks RLS): the WHERE clause is
 *  the real filter, and the GUC keeps it correct if it is ever run as oshal_app. */
async function scoped(pool, userSub) {
  const client = await pool.connect();
  await client.query("SELECT set_config('oshal.current_sub', $1, false)", [userSub]);
  return client;
}

function flag(argv, name, dflt) {
  const i = argv.indexOf('--' + name);
  return i > -1 && argv[i + 1] ? argv[i + 1] : dflt;
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] || 'list';

  if (cmd === 'gen') { console.log(generatePassword(Number(flag(argv, 'len', '20')) || 20)); return; }

  const userSub = resolveUserSub();
  if (!userSub) { console.error('No user identity. Set OSHAL_USER_SUB (the signed-in user).'); process.exit(2); }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  let client;
  try {
    client = await scoped(pool, userSub);
    if (cmd === 'put') {
      const site = String(flag(argv, 'site', '')).trim().toLowerCase();
      const username = String(flag(argv, 'username', '')).trim();
      if (!site || !username) { console.error('put needs --site <host> --username <email>'); process.exit(1); }
      const password = argv.includes('--generate')
        ? generatePassword(Number(flag(argv, 'len', '20')) || 20)
        : String(flag(argv, 'password', ''));
      if (!password) { console.error('put needs --password <p> or --generate'); process.exit(1); }
      await client.query(
        `INSERT INTO ats_site_credentials (user_sub, site, ats_family, username, password_enc)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (user_sub, site) DO UPDATE
           SET username=EXCLUDED.username, password_enc=EXCLUDED.password_enc,
               ats_family=COALESCE(EXCLUDED.ats_family, ats_site_credentials.ats_family),
               status='active', updated_at=NOW()`,
        [userSub, site, flag(argv, 'family', null), username, encrypt(password)]);
      // Echo the password ONCE on create so the caller can use it in the signup form it just filled.
      console.log(JSON.stringify({ site, username, password, stored: true }, null, 2));
      return;
    }
    if (cmd === 'get') {
      const site = String(flag(argv, 'site', '')).trim().toLowerCase();
      if (!site) { console.error('get needs --site <host>'); process.exit(1); }
      const row = (await client.query(
        `SELECT site, username, password_enc, ats_family, status FROM ats_site_credentials
          WHERE user_sub=$1 AND site=$2 LIMIT 1`, [userSub, site])).rows[0];
      if (!row) { console.error(`No credential for ${site}. Create one with: put --site ${site} --username <email> --generate`); process.exit(3); }
      await client.query(`UPDATE ats_site_credentials SET last_used_at=NOW() WHERE user_sub=$1 AND site=$2`, [userSub, site]);
      console.log(JSON.stringify({ site: row.site, username: row.username, password: decrypt(row.password_enc), family: row.ats_family, status: row.status }, null, 2));
      return;
    }
    if (cmd === 'list') { // metadata only — a listing must never leak secrets
      const rows = (await client.query(
        `SELECT site, username, ats_family, status, last_used_at, updated_at FROM ats_site_credentials
          WHERE user_sub=$1 ORDER BY updated_at DESC`, [userSub])).rows;
      console.log(JSON.stringify({ count: rows.length, credentials: rows }, null, 2));
      return;
    }
    console.error(`usage: oshal-site-creds <gen|put|get|list> [flags]`);
    process.exit(1);
  } catch (err) {
    console.error('oshal-site-creds failed: ' + ((err && err.message) || err));
    process.exit(1);
  } finally {
    if (client) client.release();
    await pool.end();
  }
}

if (require.main === module) { main(); }

module.exports = { generatePassword, encrypt, decrypt };
