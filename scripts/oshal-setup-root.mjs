/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Issue a transient first-root setup proof from the local installation terminal.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | AUTH-03 identity-provider installations: `--issuer` and `--subject` bind the proof to one exact OIDC principal (LOCAL_AUTH off), who completes it signed in at /users; the local-account form is unchanged. Argument and posture refusals now name their reason.
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const USAGE = 'Usage: node scripts/oshal-setup-root.mjs --origin https://your-oshal-host [--issuer <exact OIDC issuer> --subject <exact subject>]\n'
  + 'Run locally in the initialized API container with its DATABASE_URL (on Kubernetes: kubectl exec into the api Deployment).\n'
  + 'Without --issuer/--subject (LOCAL_AUTH=true): the code creates the first local account and root at /login.\n'
  + 'With --issuer/--subject (identity-provider sign-in, LOCAL_AUTH off): only that exact signed-in identity can redeem the\n'
  + 'code at /users; /users shows your exact issuer and subject once you sign in.\n'
  + 'Creates/reissues a one-use 15-minute code. Only its hash, expiry and bound identity are stored.\n';
const enabled = (name) => ['true', '1', 'yes'].includes((process.env[name] ?? '').trim().toLowerCase());
const refuse = (message) => { throw Object.assign(new Error(message), { status: 400 }); };

/**
 * @description Parse `--origin X [--issuer I --subject S]`. Each flag once; the identity pair is all-or-nothing.
 * @param {string[]} argv Command arguments. @returns {{ origin: string, identity?: { issuer: string, subject: string } }}
 */
function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if (!['--origin', '--issuer', '--subject'].includes(flag) || argv[index + 1] === undefined || flag in values) {
      refuse('use --origin <exact browser origin> [--issuer <exact OIDC issuer> --subject <exact subject>]');
    }
    values[flag] = argv[index + 1];
  }
  if (!values['--origin']) refuse('use --origin with the exact browser origin');
  if (('--issuer' in values) !== ('--subject' in values)) refuse('--issuer and --subject are required together');
  return { origin: values['--origin'], identity: '--issuer' in values ? { issuer: values['--issuer'], subject: values['--subject'] } : undefined };
}

/** @description Refuse a posture the chosen ceremony cannot run under. @param {boolean} bound Identity-provider form. */
function requirePosture(bound) {
  if (enabled('MOCK_OIDC')) refuse('disable MOCK_OIDC before root setup');
  if (bound && enabled('LOCAL_AUTH')) refuse('--issuer/--subject is for identity-provider installations; with LOCAL_AUTH use --origin alone');
  if (!bound && !enabled('LOCAL_AUTH')) refuse('LOCAL_AUTH must be enabled, or bind an identity-provider account with --issuer and --subject');
  if (!process.env.DATABASE_URL) refuse('DATABASE_URL is required in the local installation environment');
}

/** @description Load the compiled bootstrap from dist when present, else the TypeScript source. @returns Modules and pg. */
function loadModules() {
  const require = createRequire(import.meta.url);
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const built = resolve(root, 'dist/app/composition/installer-root-bootstrap.js');
  if (existsSync(built)) require('tsconfig-paths').register({ baseUrl: resolve(root, 'dist'), paths: { '@/*': ['*'] } });
  else require('tsx/cjs');
  const bootstrap = require(existsSync(built) ? built : resolve(root, 'src/app/composition/installer-root-bootstrap.ts'));
  const { wrapPoolWithGuc } = require(existsSync(built)
    ? resolve(root, 'dist/shared/services/database/guc-pool.js') : resolve(root, 'src/shared/services/database/guc-pool.ts'));
  return { bootstrap, wrapPoolWithGuc, Pool: require('pg').Pool };
}

/** @description Terminal-only delivery of the proof, never a log event or URL parameter. @param proof Issued proof. */
function deliver(proof) {
  if (proof.identity) {
    process.stdout.write(`Sign in at ${proof.origin} as the bound account, open ${proof.origin}/users and enter the code under "Swarm root".\n`
      + `Installer setup code: ${proof.token}\nBound identity: issuer ${proof.identity.issuer} subject ${proof.identity.subject}\n`
      + `Expires: ${proof.expiresAt}\n`);
    return;
  }
  process.stdout.write(`Open ${proof.origin}/login\nInstaller setup code: ${proof.token}\nExpires: ${proof.expiresAt}\n`);
}

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  process.stdout.write(USAGE);
} else {
  let pool;
  try {
    const { origin, identity } = parseArgs(args);
    requirePosture(Boolean(identity));
    const { bootstrap, wrapPoolWithGuc, Pool } = loadModules();
    pool = wrapPoolWithGuc(new Pool({ connectionString: process.env.DATABASE_URL }));
    deliver(await bootstrap.issueInstallerRootSetup(pool, origin, identity));
  } catch (error) {
    // Database errors can contain connection details. No raw error/stack or input credentials are printed.
    const safe = error && typeof error === 'object' && 'status' in error;
    process.stderr.write(`Root setup failed${safe ? `: ${error.message}` : '; check local authentication, database readiness and command arguments'}\n`);
    process.exitCode = 1;
  } finally { if (pool) await pool.end(); }
}
