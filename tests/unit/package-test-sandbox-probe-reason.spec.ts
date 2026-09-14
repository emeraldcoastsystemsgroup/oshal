/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove the runner probe reads its report through the real Node TAP reporter's diagnostic framing and names the condition that denied a capability set.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PackageTestSandboxResult } from '@/features/swarm-apps/services/package-test-sandbox';

const logSpies = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
vi.mock('@/shared/logger', () => ({ createChildLogger: () => logSpies }));

const { PackageTestSandbox, probeFailureReason, probeReportPayload } = await import('@/features/swarm-apps/services/package-test-sandbox');
type SandboxResult = PackageTestSandboxResult;

/** @description One bounded sandbox outcome; no live container, image or credential is involved. */
function outcome(overrides: Partial<SandboxResult> = {}): SandboxResult {
  return { exitCode: 0, output: '', timedOut: false, cancelled: false, image: 'sha256:fixture', cleanupVerified: true, ...overrides };
}

/** @description Drive the real probe decision path over a fixed outcome instead of a Docker run. */
async function probeOver(result: SandboxResult): Promise<ReadonlySet<string>> {
  const sandbox = new PackageTestSandbox();
  sandbox.run = async () => result;
  return sandbox.probe('oshal-fixture:latest');
}

beforeEach(() => { for (const spy of Object.values(logSpies)) spy.mockClear(); });

describe('runner probe report recovery', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'oshal-probe-'));
  afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

  it('recovers the report the real Node test TAP reporter emits for a test that printed it', () => {
    const suite = path.join(directory, 'marker.test.cjs');
    writeFileSync(suite, "const {test}=require('node:test');\n"
      + "test('runner probe',()=>{console.log('OSHAL_RUNNER_PROBE '+JSON.stringify({chromium:true,theme:true,bridge:true,dependencies:true}));});\n");
    const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--', suite], { encoding: 'utf8', timeout: 60000 });
    const output = `${run.stdout || ''}${run.stderr || ''}`;
    expect(run.status, output).toBe(0);
    expect(output).toContain('OSHAL_RUNNER_PROBE ');
    // The defect: the reporter re-emits the test's stdout as a diagnostic comment, so no line ever
    // starts with the marker and a column-zero match silently reported an image with no capability.
    expect(output.split('\n').some(line => line.startsWith('OSHAL_RUNNER_PROBE '))).toBe(false);
    const payload = probeReportPayload(output);
    expect(payload, output).toBeDefined();
    expect(JSON.parse(String(payload))).toEqual({ chromium: true, theme: true, bridge: true, dependencies: true });
  }, 60000);

  it('refuses a marker that is not framed as reporter diagnostics', () => {
    expect(probeReportPayload('not ok 1 - OSHAL_RUNNER_PROBE {"chromium":true}')).toBeUndefined();
    expect(probeReportPayload('# OSHAL_RUNNER_PROBE {"chromium":true}\n')).toBe('{"chromium":true}');
    expect(probeReportPayload('TAP version 13\n# pass 1\n')).toBeUndefined();
  });
});

describe('runner probe failure reasons', () => {
  it('names each distinct condition rather than collapsing them into no capability', () => {
    expect(probeFailureReason(outcome(), false, false)).toBe('probe_marker_absent');
    expect(probeFailureReason(outcome({ exitCode: 3 }), true, true)).toBe('probe_exit_nonzero');
    expect(probeFailureReason(outcome({ cleanupVerified: false }), true, true)).toBe('probe_cleanup_unverified');
    expect(probeFailureReason(outcome(), true, false)).toBe('probe_report_unparseable');
    expect(probeFailureReason(outcome(), true, true)).toBe('probe_reported_no_capability');
  });

  it('logs the reason and bounded evidence at every early return, still returning the empty set', async () => {
    const cases: Array<[SandboxResult, string]> = [
      [outcome({ output: 'TAP version 13\n# fail 1\n' }), 'probe_marker_absent'],
      [outcome({ exitCode: 3, output: '# OSHAL_RUNNER_PROBE {"chromium":true}' }), 'probe_exit_nonzero'],
      [outcome({ cleanupVerified: false, output: '# OSHAL_RUNNER_PROBE {"chromium":true}' }), 'probe_cleanup_unverified'],
      [outcome({ output: '# OSHAL_RUNNER_PROBE {not-json' }), 'probe_report_unparseable'],
      [outcome({ output: '# OSHAL_RUNNER_PROBE {"chromium":false,"error":"Executable doesn\'t exist"}' }), 'probe_reported_no_capability'],
    ];
    for (const [result, reason] of cases) {
      logSpies.warn.mockClear();
      expect([...await probeOver(result)]).toEqual([]);
      expect(logSpies.warn, reason).toHaveBeenCalledTimes(1);
      expect(logSpies.warn.mock.calls[0][0]).toMatchObject({ reason, image: 'oshal-fixture:latest', exitCode: result.exitCode });
      expect(String(logSpies.warn.mock.calls[0][0].output)).toBe(result.output.slice(0, 200));
    }
    expect(logSpies.warn.mock.calls[0][0].probeError).toBe("Executable doesn't exist");
  });

  it('verifies and remembers capabilities from a diagnostic-framed report without warning', async () => {
    const verified = await probeOver(outcome({ output: 'TAP version 13\n# OSHAL_RUNNER_PROBE {"theme":true,"bridge":true,"dependencies":true,"chromium":true}\nok 1\n' }));
    expect([...verified].sort()).toEqual(['browser:chromium', 'core:dependencies', 'core:shared-theme-assets', 'core:surface-bridge', 'harness:oshal-core-root', 'runner:playwright']);
    expect(logSpies.warn).not.toHaveBeenCalled();
    expect(logSpies.info).toHaveBeenCalledTimes(1);
  });
});
