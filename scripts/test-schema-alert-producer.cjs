/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Run the isolated schema alarm producer guards through one bounded local command.
 */

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const result = spawnSync(process.execPath, [
  path.join(path.dirname(require.resolve('vitest/package.json')), 'vitest.mjs'),
  'run', '--no-file-parallelism', '--hookTimeout', '180000', '--testTimeout', '60000',
  'tests/unit/internal-alert-producer.spec.ts',
  'tests/unit/data-model-alert-postgres.spec.ts',
], { cwd: path.resolve(__dirname, '..'), stdio: 'inherit' });
if (result.error) process.stderr.write(`Schema alert producer test runner failed: ${result.error.message}\n`);
process.exitCode = result.status ?? 1;
