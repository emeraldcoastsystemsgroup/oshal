/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Issue a transient first-root setup proof from the local installation terminal.
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  process.stdout.write('Usage: node scripts/oshal-setup-root.mjs --origin https://your-oshal-host\n'
    + 'Run locally in the initialized API container with LOCAL_AUTH=true and its DATABASE_URL.\n'
    + 'Creates/reissues a one-use 15-minute code. Only its hash and expiry are stored.\n');
} else {
  let pool;
  try {
    if (args.length !== 2 || args[0] !== '--origin') throw new Error('use --origin with the exact browser origin');
    if (!['true', '1', 'yes'].includes((process.env.LOCAL_AUTH ?? '').toLowerCase())) throw new Error('LOCAL_AUTH must be enabled');
    if (['true', '1', 'yes'].includes((process.env.MOCK_OIDC ?? '').toLowerCase())) throw new Error('disable MOCK_OIDC before root setup');
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required in the local installation environment');
    const require = createRequire(import.meta.url);
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const built = resolve(root, 'dist/app/composition/installer-root-bootstrap.js');
    if (existsSync(built)) require('tsconfig-paths').register({ baseUrl: resolve(root, 'dist'), paths: { '@/*': ['*'] } });
    else require('tsx/cjs');
    const module = require(existsSync(built) ? built : resolve(root, 'src/app/composition/installer-root-bootstrap.ts'));
    const { wrapPoolWithGuc } = require(existsSync(built)
      ? resolve(root, 'dist/shared/services/database/guc-pool.js') : resolve(root, 'src/shared/services/database/guc-pool.ts'));
    pool = wrapPoolWithGuc(new (require('pg').Pool)({ connectionString: process.env.DATABASE_URL }));
    const proof = await module.issueInstallerRootSetup(pool, args[1]);
    // Deliberate terminal-only delivery, never a log event or URL parameter.
    process.stdout.write(`Open ${proof.origin}/login\nInstaller setup code: ${proof.token}\nExpires: ${proof.expiresAt}\n`);
  } catch (error) {
    // Database errors can contain connection details. No raw error/stack or input credentials are printed.
    const safe = error && typeof error === 'object' && 'status' in error;
    process.stderr.write(`Root setup failed${safe ? `: ${error.message}` : '; check local authentication, database readiness and command arguments'}\n`);
    process.exitCode = 1;
  } finally { if (pool) await pool.end(); }
}
