/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Guard the sealed-profile runner table: which runner kinds a profile satisfies, which are deliberately out of scope and why, and that a vitest recipe really runs inside the closed container.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { PackageTestSandbox } from '@/features/swarm-apps/services/package-test-sandbox';
import { sandboxPayload, SANDBOX_PROFILES } from '@/features/swarm-apps/services/package-test-sandbox-launcher';
import { reportedTestCounts } from '@/features/swarm-apps/services/package-test-execution';
import {
  CORE_SCOPE_UNAVAILABLE, NODE_RUNNER_CAPABILITIES, PROBE_VERIFIED_PREREQUISITES, packageTestRecipePending,
  RUNNER_OUT_OF_SCOPE, RUNNER_PROFILES, runnerHarnessFailure,
} from '@/features/swarm-apps/services/package-test-snapshot';
import type { PackageTestCase, PackageTestRunner } from '@/shared/package-testing';

const base: PackageTestCase = {
  id: 'unit', name: 'unit', purpose: 'prove the runner table', level: 'unit',
  runner: { kind: 'vitest', scope: 'package', files: ['tests/a.mjs'] },
  expected: ['passes'], prerequisites: [], sideEffects: 'none', isolation: { mode: 'disposable' },
  limits: { timeoutMs: 60000 }, installation: 'never',
};
const withRunner = (runner: PackageTestRunner, over: Partial<PackageTestCase> = {}): PackageTestCase => ({ ...base, runner, ...over });
const verified = (...names: string[]): ReadonlySet<string> => new Set([...NODE_RUNNER_CAPABILITIES, ...names]);

describe('sealed-profile runner table', () => {
  it('admits a vitest recipe once the image has verified runner:vitest', () => {
    expect(packageTestRecipePending(base, verified('runner:vitest'))).toBeUndefined();
    expect(RUNNER_PROFILES.vitest.profile).toBe('vitest');
  });

  it('refuses a recipe whose capability no profile has verified yet', () => {
    expect(packageTestRecipePending(base, verified('runner:playwright', 'browser:chromium')))
      .toBe('The vitest runner is unavailable.');
  });

  it('refuses the external runner as out of scope and says which boundary would have to move', () => {
    const reason = packageTestRecipePending(withRunner({ kind: 'external', scope: 'package', files: ['tests/a.mjs'] }),
      verified('runner:vitest', 'runner:playwright', 'browser:chromium'));
    expect(reason).toBe(RUNNER_OUT_OF_SCOPE.external);
    expect(reason).toMatch(/no network, no mounts and no daemon socket/);
  });

  it('refuses a core-scoped recipe of an otherwise admitted kind', () => {
    expect(packageTestRecipePending(withRunner({ kind: 'vitest', scope: 'core', files: ['tests/a.mjs'] }), verified('runner:vitest')))
      .toBe(CORE_SCOPE_UNAVAILABLE);
  });

  it('keeps every declared runner kind either satisfiable or explicitly out of scope', () => {
    for (const kind of ['smoke', 'vitest', 'node-test', 'playwright', 'external']) {
      expect(Boolean(RUNNER_PROFILES[kind]) !== Boolean(RUNNER_OUT_OF_SCOPE[kind])).toBe(true);
    }
  });

  it('holds a vitest recipe to its level and its harness', () => {
    expect(packageTestRecipePending({ ...base, level: 'browser' }, verified('runner:vitest')))
      .toBe('Browser and live suites require their own verified runner.');
    expect(runnerHarnessFailure('vitest', Buffer.from('test("a", () => {});'))).toMatch(/explicit vitest import/);
    expect(runnerHarnessFailure('vitest', Buffer.from('import { test } from "vitest"; test("a", () => {});'))).toBeUndefined();
    expect(runnerHarnessFailure('playwright', Buffer.from('import { test } from "vitest";')))
      .toBe('Browser recipe requires the Node test harness (node:test).');
  });

  it('accepts the vitest profile in a payload and refuses an unknown one', () => {
    const files = [{ path: 'tests/a.mjs', content: Buffer.from('import { test } from "vitest";') }];
    expect(JSON.parse(sandboxPayload(files, ['tests/a.mjs'], 'vitest')).profile).toBe('vitest');
    expect(() => sandboxPayload(files, ['tests/a.mjs'], 'postgres' as never)).toThrow('package_test_profile_invalid');
    expect(SANDBOX_PROFILES).toContain('vitest');
    expect(PROBE_VERIFIED_PREREQUISITES.has('runner:vitest')).toBe(true);
  });
});

describe('counting what the runner actually reported', () => {
  it('counts a vitest tap-flat stream from its plan and points', () => {
    expect(reportedTestCounts('TAP version 13\n1..2\nok 1 - a.mjs > a\nnot ok 2 - a.mjs > b\n')).toEqual({ tests: 2, pass: 1, fail: 1 });
  });

  it('still prefers the node --test summary when one is present', () => {
    expect(reportedTestCounts('1..1\nok 1 - a\n# tests 3\n# pass 3\n# fail 0\n')).toEqual({ tests: 3, pass: 3, fail: 0 });
  });

  it('refuses to read a truncated plan as a pass', () => {
    expect(reportedTestCounts('TAP version 13\n1..4\nok 1 - a\n')).toEqual({ tests: 4, pass: 1, fail: 3 });
    expect(reportedTestCounts('TAP version 13\n1..0\n')).toEqual({ tests: 0, pass: 0, fail: 0 });
    expect(reportedTestCounts('nothing at all')).toBeNull();
  });
});

/** The Docker VM, not the host, is what a sandbox container competes for; a saturated VM declines rather than lies. */
const dockerReady = (): string | null => {
  try {
    const load = Number(execFileSync('docker', ['exec', 'oshal-local-redis', 'cut', '-d', ' ', '-f1', '/proc/loadavg'],
      { encoding: 'utf8', timeout: 15000 }).trim());
    if (!Number.isFinite(load) || load > 6) return null;
    execFileSync('docker', ['image', 'inspect', '--format', '{{.Id}}', 'oshal-bot:latest'], { encoding: 'utf8', timeout: 20000 });
    return 'oshal-bot:latest';
  } catch { return null; }
};

describe('the vitest profile on the real image', () => {
  it('runs a vitest suite inside the sealed container and reports its TAP points', async () => {
    const image = dockerReady();
    if (!image) { console.warn('DECLINED: Docker VM unavailable or above load 6 - this is not a pass.'); return; }
    const suite = 'import { test, expect } from "vitest";\ntest("sealed", () => { expect(1 + 1).toBe(2); });\n';
    const result = await new PackageTestSandbox().run({
      files: [{ path: 'tests/sealed.test.mjs', content: Buffer.from(suite) }],
      suiteFiles: ['tests/sealed.test.mjs'], image, timeoutMs: 180000, maxMemoryMb: 1024, profile: 'vitest',
    });
    expect(result.output).toMatch(/^ok 1 /m);
    expect(result.exitCode).toBe(0);
    expect(result.cleanupVerified).toBe(true);
    expect(reportedTestCounts(result.output)).toMatchObject({ pass: 1, fail: 0 });
  }, 300000);

  it('verifies runner:vitest on the image only by running vitest, never by inspecting a path', async () => {
    const image = dockerReady();
    if (!image) { console.warn('DECLINED: Docker VM unavailable or above load 6 - this is not a pass.'); return; }
    const capabilities = await new PackageTestSandbox().probe(image);
    expect([...capabilities]).toContain('runner:vitest');
  }, 300000);
});
