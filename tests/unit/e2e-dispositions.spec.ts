/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | New. Partition guard for the Playwright suite: every spec the default config discovers is in tests/e2e-green-suite.txt or has exactly one row in tests/e2e-dispositions.json, never both, and every row carries what its class needs. The unsupported-in-ci rows are checked through Playwright's own config loader and file matcher in a child process, so the guard proves the runner really leaves those specs out (and only those), not that a string appears in playwright.config.ts. Planted inputs prove each rule goes red.
 */

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { readGreenSuite } from '../../scripts/e2e-green-list.mjs';
import {
  INCLUDE_UNSUPPORTED_ENV,
  listE2eSpecFiles,
  partitionViolations,
  readE2eDispositions,
  type E2eDispositionRegistry,
} from '../helpers/e2e-dispositions';

const ROOT = path.resolve(__dirname, '..', '..');
const green = (): string[] => readGreenSuite(path.join(ROOT, 'tests', 'e2e-green-suite.txt')) as string[];
const backlogHeadings = (): string[] =>
  readFileSync(path.join(ROOT, 'docs', 'BACKLOG.md'), 'utf8')
    .split(/\r?\n/)
    .filter((line) => /^#{2,4} /.test(line))
    .map((line) => line.replace(/^#+ /, '').trim());

/**
 * Loads playwright.config.ts through Playwright's OWN loader (the transform and config
 * resolution `npx playwright test` uses) and applies Playwright's own createFileMatcher to each
 * file, printing which ones the default project would collect. Runs in a child so the config's
 * dotenv load can never leak a real environment into this vitest worker.
 */
const PROBE = [
  "const path = require('path');",
  "const req = require('module').createRequire(path.resolve('package.json'));",
  "const { loadConfigFromFile } = req('playwright/lib/common/configLoader');",
  "const { createFileMatcher } = req('playwright/lib/util');",
  '(async () => {',
  "  const files = JSON.parse(process.env.E2E_PROBE_FILES);",
  "  const full = await loadConfigFromFile(path.resolve('playwright.config.ts'));",
  '  const project = full.projects[0].project;',
  '  const ignore = createFileMatcher(project.testIgnore);',
  '  const match = createFileMatcher(project.testMatch);',
  '  const out = files.map((f) => ({ file: f, match: match(path.resolve(f)), ignored: ignore(path.resolve(f)) }));',
  "  process.stdout.write('\\n@@PROBE@@' + JSON.stringify(out) + '\\n');",
  '})().catch((e) => { console.error(e); process.exit(1); });',
].join('\n');

/**
 * @description Asks the real Playwright config which of the given files it would collect.
 * @param files Repo-relative spec paths.
 * @param includeUnsupported Whether to set the opt-in that lifts the registry ignores.
 * @returns Per-file: does testMatch match it, and does testIgnore drop it.
 */
function playwrightCollects(files: string[], includeUnsupported: boolean): Array<{ file: string; match: boolean; ignored: boolean }> {
  const env: NodeJS.ProcessEnv = { ...process.env, E2E_PROBE_FILES: JSON.stringify(files) };
  delete env[INCLUDE_UNSUPPORTED_ENV];
  if (includeUnsupported) env[INCLUDE_UNSUPPORTED_ENV] = 'true';
  const r = spawnSync(process.execPath, ['-e', PROBE], { cwd: ROOT, env, encoding: 'utf8', timeout: 90_000 });
  expect(r.status, `config probe failed: ${r.stdout}${r.stderr}`).toBe(0);
  const marker = r.stdout.split('\n').find((line) => line.startsWith('@@PROBE@@'));
  expect(marker, `config probe printed no result: ${r.stdout}`).toBeTruthy();
  return JSON.parse(marker!.slice('@@PROBE@@'.length));
}

describe('e2e disposition registry', () => {
  it('partitions every discovered spec between the green list and the registry', () => {
    const discovered = listE2eSpecFiles(ROOT);
    // Sanity on the discovery itself: an empty walk would make every check below vacuous.
    expect(discovered.length).toBeGreaterThan(100);
    expect(discovered).toContain('tests/swarm-memory-rls-live.spec.ts');
    expect(discovered.some((file) => file.startsWith('tests/unit/'))).toBe(false);
    expect(partitionViolations(discovered, green(), readE2eDispositions(ROOT), backlogHeadings())).toEqual([]);
  });

  it('gives every unsupported-in-ci case a reason and a place it can run', () => {
    const rows = readE2eDispositions(ROOT).specs.filter((row) => row.class === 'unsupported-in-ci');
    // The CDP-attached live proofs are the bulk of this class; each must be named, not globbed.
    const cdp = listE2eSpecFiles(ROOT).filter((file) => {
      const source = readFileSync(path.join(ROOT, file), 'utf8');
      return /from '\.\/(fixtures|_attach-noprune)'/.test(source);
    });
    expect(cdp.length).toBeGreaterThan(0);
    for (const file of cdp) expect(rows.map((row) => row.file), `${file} attaches over CDP`).toContain(file);
    for (const row of rows) {
      expect(row.reason.length, row.file).toBeGreaterThan(40);
      expect(row.runWith, row.file).toBeTruthy();
    }
  });

  it('the real Playwright config leaves out exactly the unsupported-in-ci specs', () => {
    const discovered = listE2eSpecFiles(ROOT);
    const unsupported = readE2eDispositions(ROOT).specs.filter((row) => row.class === 'unsupported-in-ci').map((row) => row.file);
    const collected = playwrightCollects(discovered, false);
    expect(collected.filter((entry) => !entry.match), 'Playwright testMatch disagrees with the discovery').toEqual([]);
    expect(collected.filter((entry) => entry.ignored).map((entry) => entry.file).sort()).toEqual([...unsupported].sort());
    const greenSet = new Set(green());
    expect(collected.filter((entry) => entry.ignored && greenSet.has(entry.file))).toEqual([]);
  });

  it(`${INCLUDE_UNSUPPORTED_ENV}=true lifts the registry ignores so a row's runWith can be followed`, () => {
    const unsupported = readE2eDispositions(ROOT).specs.filter((row) => row.class === 'unsupported-in-ci').map((row) => row.file);
    expect(playwrightCollects(unsupported, true).filter((entry) => entry.ignored)).toEqual([]);
  });
});

describe('e2e disposition registry - planted violations go red', () => {
  const registry = (specs: E2eDispositionRegistry['specs'], skippedTests: E2eDispositionRegistry['skippedTests'] = []): E2eDispositionRegistry => ({ specs, skippedTests });
  const discovered = ['tests/a.spec.ts', 'tests/b.spec.ts', 'tests/c.spec.ts'];
  const ok = registry([
    { file: 'tests/b.spec.ts', class: 'awaiting-classification', reason: 'not yet run' },
    { file: 'tests/c.spec.ts', class: 'unsupported-in-ci', reason: 'needs an IdP', runWith: 'with a Keycloak' },
  ]);

  it('accepts a clean partition', () => {
    expect(partitionViolations(discovered, ['tests/a.spec.ts'], ok, [])).toEqual([]);
  });

  it('flags a spec that is neither green nor dispositioned', () => {
    expect(partitionViolations([...discovered, 'tests/planted.spec.ts'], ['tests/a.spec.ts'], ok, []))
      .toEqual(['tests/planted.spec.ts: neither in the green list nor in the registry']);
  });

  it('flags overlap, duplicates, stale rows and stale green entries', () => {
    const bad = registry([...ok.specs, { file: 'tests/a.spec.ts', class: 'fixture-defect', reason: 'x' }, { file: 'tests/b.spec.ts', class: 'awaiting-classification', reason: 'y' }, { file: 'tests/gone.spec.ts', class: 'awaiting-classification', reason: 'z' }]);
    const out = partitionViolations(discovered, ['tests/a.spec.ts', 'tests/missing.spec.ts'], bad, []);
    expect(out).toContain('tests/a.spec.ts: both in the green list and in the registry');
    expect(out).toContain('tests/b.spec.ts: 2 registry rows');
    expect(out).toContain('tests/gone.spec.ts: registry row for a spec Playwright does not discover');
    expect(out).toContain('tests/missing.spec.ts: green-list entry for a spec Playwright does not discover');
  });

  it('flags rows missing what their class requires', () => {
    const bad = registry([
      { file: 'tests/b.spec.ts', class: 'unsupported-in-ci', reason: 'needs a stack' },
      { file: 'tests/c.spec.ts', class: 'product-defect', reason: 'broken', backlog: 'No such entry' },
      { file: 'tests/a.spec.ts', class: 'flaky' as never, reason: ' ' },
    ]);
    const out = partitionViolations(discovered, [], bad, ['A real entry']);
    expect(out).toContain('tests/b.spec.ts: unsupported-in-ci without runWith');
    expect(out).toContain('tests/c.spec.ts: product-defect must name an existing docs/BACKLOG.md heading (got "No such entry")');
    expect(out).toContain('tests/a.spec.ts: unknown class "flaky"');
    expect(out).toContain('tests/a.spec.ts: no reason');
  });

  it('flags a skipped-test row outside the green list', () => {
    const bad = registry(ok.specs, [{ file: 'tests/b.spec.ts', skipMessage: 'm', class: 'unsupported-in-ci', reason: 'r', runWith: 'w' }]);
    expect(partitionViolations(discovered, ['tests/a.spec.ts'], bad, [])).toEqual(['tests/b.spec.ts: skippedTests row for a spec outside the green list']);
  });
});
