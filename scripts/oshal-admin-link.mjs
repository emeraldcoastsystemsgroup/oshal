/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Issue a one-time set-password link for an existing local account from the installation terminal. The installer creates the administrator (root claim, app ownership) before any browser exists; this link is how that person then chooses their own password AND gets a signed-in browser — /api/local-auth/accept sets the session cookie — so they land on the welcome screen logged in, with no generated password to print, copy or lose. Also the recovery path when a password is forgotten on a box with no mail rail.
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
// Argument/configuration refusals carry no secrets, so they are marked safe to echo; only
// unexpected errors (which may embed connection details) stay generic.
const usage = (message) => Object.assign(new Error(message), { status: 400 });

if (args.length === 1 && args[0] === '--help') {
  process.stdout.write('Usage: node scripts/oshal-admin-link.mjs --origin http://localhost:35457 --email you@example.com\n'
    + 'Run locally in the initialized API container with LOCAL_AUTH=true and its DATABASE_URL.\n'
    + 'Issues a one-time, one-hour set-password link for an ACTIVE local account. Only its hash is stored.\n');
} else {
  let pool;
  try {
    const origin = flag('--origin');
    const email = flag('--email');
    if (args.length !== 4 || !origin || !email) throw usage('use --origin <browser origin> --email <account email>');
    if (!/^https?:\/\/[^/\s]+$/.test(origin)) throw usage('--origin must be a bare http(s) origin with no path');
    if (!['true', '1', 'yes'].includes((process.env.LOCAL_AUTH ?? '').toLowerCase())) throw usage('LOCAL_AUTH must be enabled');
    if (['true', '1', 'yes'].includes((process.env.MOCK_OIDC ?? '').toLowerCase())) throw usage('MOCK_OIDC has no local accounts');
    if (!process.env.DATABASE_URL) throw usage('DATABASE_URL is required in the local installation environment');
    const require = createRequire(import.meta.url);
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const built = resolve(root, 'dist/features/local-auth/services/local-user-store.js');
    if (existsSync(built)) require('tsconfig-paths').register({ baseUrl: resolve(root, 'dist'), paths: { '@/*': ['*'] } });
    else require('tsx/cjs');
    const store = require(existsSync(built) ? built : resolve(root, 'src/features/local-auth/services/local-user-store.ts'));
    const { wrapPoolWithGuc } = require(existsSync(built)
      ? resolve(root, 'dist/shared/services/database/guc-pool.js') : resolve(root, 'src/shared/services/database/guc-pool.ts'));
    pool = wrapPoolWithGuc(new (require('pg').Pool)({ connectionString: process.env.DATABASE_URL }));
    const reset = await store.createPasswordReset(pool, email);
    // createPasswordReset only touches ACTIVE accounts and never creates one — same guarantee the
    // public forgot-password route relies on.
    if (!reset) { const e = new Error('no active local account has that email'); e.status = 404; throw e; }
    // Deliberate terminal-only delivery. The invite URL is the designed carrier for this token.
    process.stdout.write(`Set your password: ${origin}/invite?token=${encodeURIComponent(reset.token)}\n`
      + `Expires: ${reset.expiresAt}\n`);
  } catch (error) {
    // Database errors can contain connection details: only deliberate, status-bearing errors are echoed.
    const safe = error && typeof error === 'object' && 'status' in error;
    process.stderr.write(`Admin link failed${safe ? `: ${error.message}` : '; check local authentication, database readiness and command arguments'}\n`);
    process.exitCode = 1;
  } finally { if (pool) await pool.end(); }
}
