#!/usr/bin/env node
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | `npm run test:coverage`. Runs vitest
 *   with vitest.coverage.config.ts and prints the scope next to the figure, so a
 *   percentage copied out of this output can never travel without the set of source
 *   files and specs that produced it. Exits with vitest's status, which is non-zero
 *   when a threshold in tests/coverage-scope.mjs is breached.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COVERAGE_REPORTS_DIRECTORY,
  COVERAGE_SCOPE_NAME,
  COVERAGE_SOURCE_GLOBS,
  COVERAGE_SPEC_FILES,
  resolveCoverageThresholds,
} from '../tests/coverage-scope.mjs';

const thresholds = resolveCoverageThresholds();
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const passThroughArgs = process.argv.slice(2);

/**
 * @description Print the scope of the figure. Called before the run so the reader
 * knows what is being measured, and again after it so the scope sits next to the
 * number the reporter just printed.
 * @returns {void}
 */
function printScope() {
  console.log('');
  console.log('=============================== Coverage scope =================================');
  console.log(`Scope        : ${COVERAGE_SCOPE_NAME}`);
  console.log(`Source files : ${COVERAGE_SOURCE_GLOBS.join(', ')}`);
  console.log(`Produced by  : ${COVERAGE_SPEC_FILES.length} specs: ${COVERAGE_SPEC_FILES.join(', ')}`);
  console.log(
    `Thresholds   : statements ${thresholds.statements}%, branches ${thresholds.branches}%, ` +
      `functions ${thresholds.functions}%, lines ${thresholds.lines}% (the run fails below these)`,
  );
  console.log('This figure covers that scope ONLY. It is not a whole-tree coverage number.');
  console.log('================================================================================');
}

printScope();

const vitestBin = path.join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs');
const childEnv = { ...process.env };
// A nested vitest must not inherit the parent runner's worker identity, or the child
// reuses the parent's pool bookkeeping and can report a status that is not its own.
for (const key of Object.keys(childEnv)) {
  if (key.startsWith('VITEST')) delete childEnv[key];
}

const run = spawnSync(
  process.execPath,
  [vitestBin, 'run', '--config', 'vitest.coverage.config.ts', ...passThroughArgs],
  { cwd: repoRoot, stdio: 'inherit', env: childEnv },
);

if (run.error) {
  console.error(`test-coverage: could not run vitest: ${run.error.message}`);
  process.exit(1);
}

const summaryPath = path.join(repoRoot, COVERAGE_REPORTS_DIRECTORY, 'coverage-summary.json');
if (existsSync(summaryPath)) {
  const total = JSON.parse(readFileSync(summaryPath, 'utf8')).total;
  console.log('');
  console.log(`Measured over ${COVERAGE_SCOPE_NAME} [${COVERAGE_SOURCE_GLOBS.join(', ')}]:`);
  for (const metric of ['statements', 'branches', 'functions', 'lines']) {
    const entry = total[metric];
    console.log(
      `  ${metric.padEnd(11)}: ${entry.pct}% (${entry.covered}/${entry.total}) floor ${thresholds[metric]}%`,
    );
  }
} else {
  console.error(`test-coverage: no coverage summary at ${summaryPath} - the figure was NOT produced.`);
  if (run.status === 0) process.exit(1);
}

printScope();
process.exit(run.status === null ? 1 : run.status);
