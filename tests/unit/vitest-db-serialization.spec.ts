/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Resolve the real unit-runner configuration and discover its files without executing database fixtures; guard the tree-walk serial group and unchanged collection/budgets.
 */
import { relative, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createVitest, type Vitest } from 'vitest/node';

const ROOT = resolve(__dirname, '../..');
const DATABASE_FILES = [
  'tests/unit/alert-incident-cutover.spec.ts',
  'tests/unit/alert-incident-reopen.spec.ts',
  'tests/unit/topology-traversal.spec.ts',
];
const LEGACY_INCLUDE = ['src/**/*.test.ts', 'tests/unit/**/*.spec.ts'];
const LEGACY_EXCLUDE = ['node_modules/**', 'dist/**', '.codex-harness-runs/**', '**/.codex-home/**', 'tests/tool-integrations/**'];
let runner: Vitest | undefined;
let legacyFiles: string[];
let specifications: Awaited<ReturnType<Vitest['globTestSpecifications']>>;

/** Read discovery only: never collect/import a database spec or start its hooks/workers. */
async function originalCollection(): Promise<string[]> {
  const legacy = await createVitest('test', { root: ROOT, config: false, watch: false, api: false,
    include: LEGACY_INCLUDE, exclude: LEGACY_EXCLUDE }, { server: { watch: null } });
  try { return (await legacy.globTestSpecifications()).map(spec => spec.moduleId).sort(); }
  finally { await legacy.close(); }
}

beforeAll(async () => {
  legacyFiles = await originalCollection();
  runner = await createVitest('test', { root: ROOT, config: resolve(ROOT, 'vitest.config.ts'), watch: false, api: false },
    { server: { watch: null } });
  specifications = await runner.globTestSpecifications();
});
afterAll(async () => { await runner?.close(); });

describe('real Vitest discovery isolates the tree-walk database group', () => {
  it('retains the entire original two-tree collection exactly once', () => {
    const files = specifications.map(spec => spec.moduleId).sort();
    expect(files).toEqual(legacyFiles);
    expect(new Set(files).size).toBe(files.length);
    expect(files.some(file => relative(ROOT, file).replaceAll('\\', '/').startsWith('src/'))).toBe(true);
  });

  it('assigns exactly the three named database specs to the serial project, never the ordinary project', () => {
    const serial = specifications.filter(spec => spec.project.name === 'tree-walk-postgres');
    expect(serial.map(spec => relative(ROOT, spec.moduleId).replaceAll('\\', '/')).sort()).toEqual(DATABASE_FILES);
    for (const file of DATABASE_FILES) {
      expect(specifications.filter(spec => spec.moduleId === resolve(ROOT, file).replaceAll('\\', '/'))).toHaveLength(1);
    }
    expect(specifications.some(spec => spec.project.name === 'unit')).toBe(true);
  });

  it('resolves one isolated fork with no file parallelism for the database group', () => {
    const project = runner!.projects.find(project => project.name === 'tree-walk-postgres');
    expect(project, 'the production config must define the isolated project').toBeDefined();
    expect(project!.config).toMatchObject({ pool: 'forks', isolate: true, fileParallelism: false, maxWorkers: 1 });
  });

  it('uses a later nonzero scheduling group so database files cannot overlap the ordinary corpus', () => {
    const normal = runner!.projects.find(project => project.name === 'unit');
    const serial = runner!.projects.find(project => project.name === 'tree-walk-postgres');
    expect(normal).toBeDefined(); expect(serial).toBeDefined();
    expect(normal!.config.fileParallelism).not.toBe(false);
    // Zero has special single-worker scheduling semantics in Vitest; explicit positive groups
    // retain this ordering even when an outer command requests a single worker for all projects.
    expect(normal!.config.sequence.groupOrder).toBeGreaterThan(0);
    expect(serial!.config.sequence.groupOrder).toBeGreaterThan(normal!.config.sequence.groupOrder);
  });

  it('retains the existing budgets and zero retries in both resolved projects', () => {
    expect(runner!.projects.map(project => project.name).sort()).toEqual(['tree-walk-postgres', 'unit']);
    for (const project of runner!.projects) {
      expect(project.config).toMatchObject({ environment: 'node', globals: true, testTimeout: 30_000,
        hookTimeout: 30_000, retry: 0 });
    }
  });
});
