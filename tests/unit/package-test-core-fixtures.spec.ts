/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Guard the harness:core-test-fixtures prerequisite end to end: the fixture closure the image carries is exactly the staged set, closed over its relative imports and loadable from runtime dependencies after npm prune; Dockerfile.oshal COPYs and .dockerignore allowlists every file of it and nothing else from tests/; the probe asks the image to load each file through tsx from the core root; and the prerequisite is advertised only on a positive report, so a browser case that declares it stays pending until the image proves it.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PackageTestSandbox, probeReportPayload, type PackageTestSandboxInput, type PackageTestSandboxResult } from '@/features/swarm-apps/services/package-test-sandbox';
import { CORE_TEST_FIXTURES } from '@/features/swarm-apps/services/package-test-sandbox-launcher';
import { BROWSER_RUNNER_PREREQUISITES, NODE_RUNNER_CAPABILITIES, packageTestRecipePending, PROBE_VERIFIED_PREREQUISITES } from '@/features/swarm-apps/services/package-test-snapshot';
import type { PackageTestCase } from '@/shared/package-testing';

const PREREQUISITE = 'harness:core-test-fixtures';
/** The set the three store browser cases (cad-studio surface-lifecycle, embodied surface-browser, scan-to-print
 * surface-freshness) require from OSHAL_CORE_ROOT. Widening it is a Dockerfile change and a re-measured closure. */
const EXPECTED_CLOSURE = ['tests/fixtures/isolated-browser.ts', 'tests/fixtures/stl-viewer.ts'];
/** A bound on the whole staged closure, so "bounded" stays a checked property rather than a remembered one. */
const CLOSURE_BYTE_BOUND = 64 * 1024;
const IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;
const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

/** @description Every module specifier a staged fixture imports, split into relative targets and bare package names. */
function importsOf(file: string): { relative: string[]; bare: string[] } {
  const relative: string[] = [], bare: string[] = [];
  for (const match of readFileSync(file, 'utf8').matchAll(IMPORT)) {
    const spec = match[1];
    if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('@/')) relative.push(spec); else bare.push(spec);
  }
  return { relative, bare };
}

/** @description Drive the real probe decision over a fixed outcome, capturing the suite the probe would run. */
async function probeOver(report: Record<string, unknown>): Promise<{ verified: ReadonlySet<string>; input: PackageTestSandboxInput }> {
  const sandbox = new PackageTestSandbox();
  let captured: PackageTestSandboxInput | undefined;
  const result: PackageTestSandboxResult = { exitCode: 0, timedOut: false, cancelled: false, image: 'sha256:fixture', cleanupVerified: true, truncated: false,
    output: `TAP version 13\n# OSHAL_RUNNER_PROBE ${JSON.stringify(report)}\nok 1 - runner probe\n` };
  sandbox.run = async (input: PackageTestSandboxInput) => { captured = input; return result; };
  const verified = await sandbox.probe('oshal-fixture:latest');
  return { verified, input: captured! };
}

const browserCase: PackageTestCase = {
  id: 'surface', name: 'surface', purpose: 'drive the tile in the image Chromium', level: 'browser',
  runner: { kind: 'playwright', scope: 'package', files: ['tests/surface.core.spec.mjs'] },
  expected: ['renders'], prerequisites: ['runner:playwright', 'harness:oshal-core-root', 'browser:chromium', 'core:dependencies', PREREQUISITE],
  sideEffects: 'fixture-write', isolation: { mode: 'disposable' }, limits: { timeoutMs: 120000 }, installation: 'never',
};
const verified = (...names: string[]): ReadonlySet<string> => new Set([...NODE_RUNNER_CAPABILITIES, ...names]);

describe('the staged core fixture closure', () => {
  it('is exactly the set the three store browser cases import from the core root', () => {
    expect([...CORE_TEST_FIXTURES].sort()).toEqual([...EXPECTED_CLOSURE].sort());
    for (const file of CORE_TEST_FIXTURES) expect(statSync(file).isFile(), `${file} is not a regular file`).toBe(true);
  });

  it('is closed over its relative imports and bounded in bytes', () => {
    let bytes = 0;
    for (const file of CORE_TEST_FIXTURES) {
      bytes += statSync(file).size;
      for (const spec of importsOf(file).relative) {
        const base = spec.startsWith('@/') ? path.posix.join('src', spec.slice(2)) : path.posix.join(path.posix.dirname(file), spec);
        const resolved = ['', '.ts', '.js', '.mjs', '.cjs', '/index.ts'].map(ext => base + ext).find(candidate => existsSync(candidate));
        expect(CORE_TEST_FIXTURES, `${file} imports ${spec} (${resolved ?? 'unresolved'}), which the image would not carry`).toContain(resolved);
      }
    }
    expect(bytes).toBeLessThan(CLOSURE_BYTE_BOUND);
  });

  it('loads from Node builtins and runtime dependencies only, so npm prune --production keeps every module it needs', () => {
    const runtime = new Set(Object.keys(pkg.dependencies ?? {}));
    expect(runtime, 'tsx is the CommonJS hook the store specs and the probe load the .ts fixtures through').toContain('tsx');
    for (const file of CORE_TEST_FIXTURES) {
      for (const spec of importsOf(file).bare) {
        if (spec.startsWith('node:')) continue;
        const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
        expect(runtime, `${file} imports ${spec}, which is not a runtime dependency`).toContain(name);
      }
    }
  });
});

describe('the image build carries that closure and nothing else from tests/', () => {
  const dockerfile = readFileSync('Dockerfile.oshal', 'utf8');
  const dockerignore = readFileSync('.dockerignore', 'utf8');

  it('COPYs exactly the staged set to /app/tests/fixtures/ in Dockerfile.oshal', () => {
    const copies = [...dockerfile.matchAll(/^COPY\s+(.+?)\s+\.\/tests\/fixtures\/\s*$/mg)].map(match => match[1].trim().split(/\s+/));
    expect(copies, 'Dockerfile.oshal has no COPY into ./tests/fixtures/').toHaveLength(1);
    expect([...copies[0]].sort()).toEqual([...CORE_TEST_FIXTURES].sort());
    expect(dockerfile).not.toMatch(/^COPY\s+tests\/\s/m);
  });

  it('keeps tests/ out of the build context except each staged file, allowlisted by exact name', () => {
    expect(dockerignore).toMatch(/^tests$/m);
    for (const file of CORE_TEST_FIXTURES) expect(dockerignore, `.dockerignore does not allowlist ${file}`).toContain(`\n!${file}\n`);
    expect(dockerignore).not.toMatch(/^!tests\/?$/m);
    expect(dockerignore).not.toMatch(/^!tests\/fixtures\/?$/m);
  });
});

describe('the probe and the advertisement', () => {
  it('asks the image to load every staged fixture through tsx from the core root, under the browser profile', async () => {
    const { input } = await probeOver({ chromium: true, dependencies: true, fixtures: true });
    const suite = input.files[0].content.toString('utf8');
    expect(input.profile).toBe('browser');
    expect(suite).toContain("'tsx/cjs'");
    for (const file of CORE_TEST_FIXTURES) expect(suite).toContain(JSON.stringify(file));
  });

  const scratch: string[] = [];
  afterEach(() => { for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true }); });

  it('loads the staged fixtures for real: the probe suite under node --test, this checkout as the core root, the real tsx hook', () => {
    // The Docker case proves the image; this proves the probe code itself against the real fixture files and the real
    // tsx CommonJS hook, with no browser and no vitest CLI available so those two legs answer false quickly. The child
    // gets the launcher's shape of environment: the core root and its node_modules on NODE_PATH, nothing else special.
    const directory = mkdtempSync(path.join(tmpdir(), 'oshal-fixture-probe-')); scratch.push(directory);
    const browsers = path.join(directory, 'no-browsers');
    return probeOver({}).then(({ input }) => {
      const suite = path.join(directory, 'runner-probe.test.cjs');
      writeFileSync(suite, input.files[0].content);
      const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--', suite], {
        encoding: 'utf8', timeout: 120000, cwd: process.cwd(),
        env: { ...process.env, OSHAL_CORE_ROOT: process.cwd(), NODE_PATH: path.join(process.cwd(), 'node_modules'),
          PLAYWRIGHT_BROWSERS_PATH: browsers, NODE_OPTIONS: '' },
      });
      const output = `${run.stdout || ''}${run.stderr || ''}`;
      const payload = probeReportPayload(output);
      expect(payload, output).toBeDefined();
      const report = JSON.parse(String(payload)) as Record<string, unknown>;
      expect(report.fixturesError, output).toBeUndefined();
      expect(report.fixtures, output).toBe(true);
      expect(report.dependencies).toBe(true);
    });
  }, 120000);

  it('advertises harness:core-test-fixtures only on a positive report', async () => {
    const positive = await probeOver({ chromium: true, dependencies: true, theme: true, bridge: true, vitest: true, fixtures: true });
    expect(positive.verified.has(PREREQUISITE)).toBe(true);
    const negative = await probeOver({ chromium: true, dependencies: true, theme: true, bridge: true, vitest: true, fixtures: false, fixturesError: 'Cannot find module' });
    expect(negative.verified.has(PREREQUISITE)).toBe(false);
    expect([...negative.verified]).toEqual(expect.arrayContaining(['runner:playwright', 'browser:chromium', 'core:dependencies', 'harness:oshal-core-root']));
    const silent = await probeOver({ chromium: true, dependencies: true });
    expect(silent.verified.has(PREREQUISITE)).toBe(false);
  });

  it('is a probe-verified browser prerequisite in the vocabulary', () => {
    expect(BROWSER_RUNNER_PREREQUISITES.has(PREREQUISITE)).toBe(true);
    expect(PROBE_VERIFIED_PREREQUISITES.has(PREREQUISITE)).toBe(true);
    expect(NODE_RUNNER_CAPABILITIES.has(PREREQUISITE)).toBe(false);
  });

  it('keeps a browser case that declares it pending until the image verified it, then admits it', () => {
    expect(packageTestRecipePending(browserCase, verified('runner:playwright', 'browser:chromium', 'core:dependencies', 'harness:oshal-core-root')))
      .toBe(`Additional prerequisites require verification: ${PREREQUISITE}.`);
    expect(packageTestRecipePending(browserCase, verified('runner:playwright', 'browser:chromium', 'core:dependencies', 'harness:oshal-core-root', PREREQUISITE)))
      .toBeUndefined();
  });
});
