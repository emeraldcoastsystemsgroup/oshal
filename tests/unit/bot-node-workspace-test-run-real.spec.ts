/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Real-boundary companion of bot-node-workspace-test-run.spec.ts: the real spawner runs a real `npm test` (this repository's vitest, reached through a linked node_modules) in a temp workspace shaped like the architect's scaffold, once green and once red, and the run carries the real exit code, counts and failing name. This is the boundary the unit spec doubles.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runWorkspaceTests } from '../../src/app/bot-node-workspace-test-run';

const FOLDER = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
let root: string;

function scaffold(testBody: string): void {
  const ws = join(root, FOLDER);
  mkdirSync(join(ws, 'deliverables', 'src'), { recursive: true });
  writeFileSync(join(ws, 'package.json'), JSON.stringify({ name: 'ws', private: true, scripts: { test: 'vitest run --config vitest.config.ts' } }));
  writeFileSync(join(ws, 'vitest.config.ts'), "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: { include: ['deliverables/**/*.test.ts'] } });\n");
  writeFileSync(join(ws, 'deliverables', 'src', 'slugify.ts'), "export function slugify(t: string): string { return t.toLowerCase().trim().split(/\\s+/).join('-'); }\n");
  writeFileSync(join(ws, 'deliverables', 'src', 'slugify.test.ts'), testBody);
  symlinkSync(resolve(process.cwd(), 'node_modules'), join(ws, 'node_modules'), 'junction');
}

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'bot-node-workspace-tests-real-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('the real spawner runs the workspace suite', () => {
  it('green: npm test exits 0 and the counts are the real ones', async () => {
    scaffold("import { describe, expect, it } from 'vitest';\nimport { slugify } from './slugify';\ndescribe('slugify', () => {\n  it('hyphenates', () => { expect(slugify('Hello World')).toBe('hello-world'); });\n  it('trims', () => { expect(slugify('  a b ')).toBe('a-b'); });\n});\n");
    const run = await runWorkspaceTests(FOLDER, { workspaceRoot: root });
    expect(run).toMatchObject({ ran: true, command: 'npm test', exitCode: 0, passed: 2, failed: 0, failedTests: [] });
  }, 120_000);

  it('red: npm test exits non-zero and the failing test is named', async () => {
    scaffold("import { describe, expect, it } from 'vitest';\nimport { slugify } from './slugify';\ndescribe('slugify', () => {\n  it('hyphenates', () => { expect(slugify('Hello World')).toBe('hello-world'); });\n  it('keeps underscores', () => { expect(slugify('a_b c')).toBe('a-b-c'); });\n});\n");
    const run = await runWorkspaceTests(FOLDER, { workspaceRoot: root });
    expect(run.ran).toBe(true);
    expect(run.exitCode).not.toBe(0);
    expect(run).toMatchObject({ passed: 1, failed: 1 });
    expect(run.failedTests).toEqual(['deliverables/src/slugify.test.ts > slugify > keeps underscores']);
  }, 120_000);
});
