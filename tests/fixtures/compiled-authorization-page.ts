/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Exercise the compiled Access route with the image's source-only HTML layout.
 */
import { buildSync } from 'esbuild';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, sep } from 'node:path';
import type { createAuthorizationPageRoutes } from '@/app/routes/authorization-routes';

/** @description Compile the production module beneath dist, without inventing dist HTML assets.
 * @returns The real page factory and cleanup for its isolated generated files. */
export function compileAuthorizationPage() {
  const scratch = resolve('temp');
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(resolve(scratch, 'compiled-access-'));
  const output = resolve(root, 'dist/app/routes/authorization-routes.cjs');
  buildSync({ entryPoints: [resolve('src/app/routes/authorization-routes.ts')], outfile: output,
    bundle: true, platform: 'node', format: 'cjs', packages: 'external', tsconfig: resolve('tsconfig.json') });
  const require = createRequire(import.meta.url);
  const compiled = require(output) as { createAuthorizationPageRoutes: typeof createAuthorizationPageRoutes };
  return { root, factory: compiled.createAuthorizationPageRoutes, close() {
    if (!root.startsWith(scratch + sep + 'compiled-access-')) throw new Error('Unexpected fixture cleanup path');
    delete require.cache[output];
    rmSync(root, { recursive: true, force: true });
  } };
}
