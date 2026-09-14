/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Run approved package Node suites in pinned local Docker images without host mounts, network or inherited application credentials.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Correlate durable runs with disposable containers and a controller-independent deadline for safe crash recovery.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Mark only trusted pre-container validation failures as requiring no cleanup.
 * 4 | maintainer@emeraldcoastsystemsgroup.com | Add the browser container profile (more processes, descriptors and tmp for Chromium; still no network, no mounts, no daemon socket) and a real in-profile capability probe that verifies which runner prerequisites the image satisfies.
 * 5 | maintainer@emeraldcoastsystemsgroup.com | Read the probe report out of the TAP reporter's diagnostic framing (it re-emits a test's stdout as a comment, so the marker is never at column zero) and log which condition denied a capability set instead of silently returning nothing.
 * 6 | maintainer@emeraldcoastsystemsgroup.com | Generalize the container profile to a per-profile budget table and prove the vitest runner by actually executing a one-assertion suite with it inside the sealed container, rather than inferring it from a file's presence.
 */
import { randomUUID } from 'node:crypto';
import { createChildLogger } from '@/shared/logger';
import { PACKAGE_TEST_LAUNCHER, sandboxPayload, VITEST_CLI, type PackageTestSandboxFile, type PackageTestSandboxProfile } from './package-test-sandbox-launcher';
import { dockerControl, removeSandbox, runAttachedSandbox, sandboxName } from './package-test-sandbox-process';

/** @description Trusted catalog snapshot and controller-only limits; no command or environment fields exist. */
export interface PackageTestSandboxInput {
  files: PackageTestSandboxFile[];
  suiteFiles: string[];
  timeoutMs: number;
  maxMemoryMb?: number;
  signal?: AbortSignal;
  /** Server configuration or test fixture only; resolved locally to an immutable image ID. */
  image?: string;
  /** Durable controller run ID only; never accepted from an application test or request payload. */
  executionId?: string;
  /** Closed container profile chosen by the catalog from the declared runner kind, never by the package. */
  profile?: PackageTestSandboxProfile;
}

/** Fixed probe suite: reports, from inside the closed browser profile, what this image can actually run. */
const RUNNER_PROBE_SUITE = `const { test } = require('node:test'); const fs = require('node:fs'); const path = require('node:path'); const cp = require('node:child_process');
test('runner probe', async () => {
  const core = process.env.OSHAL_CORE_ROOT || '/app';
  const report = { theme: fs.existsSync(path.join(core, 'src/shared/ui/css/surface-themes.css')),
    bridge: fs.existsSync(path.join(core, 'src/shared/ui/js/surface-bridge-client.js')), dependencies: false, chromium: false, vitest: false };
  try { require.resolve('express'); report.dependencies = true; } catch {}
  try {
    const { chromium } = require('playwright'); const browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
    await page.goto('data:text/html,<title>runner-probe</title>'); report.chromium = (await page.title()) === 'runner-probe';
    report.browser = browser.version(); await browser.close();
  } catch (error) { report.error = String(error && error.message || error).slice(0, 200); }
  try {
    // Prove the runner, do not infer it: run a one-assertion suite through the image's own vitest CLI and
    // require a real TAP point back. A present file is not a working runner.
    const dir = fs.mkdtempSync('/tmp/vitest-probe-');
    fs.writeFileSync(path.join(dir, 'probe.test.mjs'), 'import { test, expect } from "vitest"; test("probe", () => { expect(1).toBe(1); });');
    const run = cp.spawnSync(process.execPath, ['${VITEST_CLI}', 'run', '--root', dir, '--reporter=tap-flat', '--no-color', '--pool=forks', '--no-file-parallelism'],
      { cwd: dir, encoding: 'utf8', timeout: 60000, env: Object.assign({}, process.env, { NODE_PATH: '/app/node_modules:/usr/local/lib/node_modules' }) });
    report.vitest = run.status === 0 && /^ok 1 /m.test(String(run.stdout || ''));
    if (!report.vitest) report.vitestError = String(run.stderr || run.stdout || run.error || '').slice(0, 200);
  } catch (error) { report.vitestError = String(error && error.message || error).slice(0, 200); }
  console.log('OSHAL_RUNNER_PROBE ' + JSON.stringify(report));
});
`;
const PROBE_MARKER = 'OSHAL_RUNNER_PROBE ';
const logger = createChildLogger({ module: 'package-test-sandbox' });

/** @description Actual process outcome and verified cleanup; output is bounded and remains caller-scoped. */
export interface PackageTestSandboxResult {
  exitCode: number | null; output: string; timedOut: boolean; cancelled: boolean;
  image: string; cleanupVerified: boolean;
}

/**
 * @description Recover the fixed probe report from harness output. The Node test runner's TAP
 * reporter re-emits a test's own stdout as a diagnostic comment, so the controller-owned marker
 * arrives as `# OSHAL_RUNNER_PROBE {...}` and never at column zero; only comment or blank framing
 * is accepted ahead of it so an assertion message quoting the marker cannot be mistaken for it.
 * @param output Bounded sandbox output from the probe run.
 * @returns The JSON payload that follows the marker, or undefined when no report line was emitted.
 */
export function probeReportPayload(output: string): string | undefined {
  for (const line of output.split('\n')) {
    const at = line.indexOf(PROBE_MARKER);
    if (at >= 0 && /^[#\s]*$/.test(line.slice(0, at))) return line.slice(at + PROBE_MARKER.length).trim();
  }
  return undefined;
}

/**
 * @description Name the first condition that denied the probe a capability set, so an operator can
 * tell a missing report from a failed container, an unreaped container or an image that answered
 * honestly that it carries nothing.
 * @param result Bounded sandbox outcome for the probe run.
 * @param marker Whether the fixed report line was recovered from the output.
 * @param parsed Whether that recovered line parsed as a report object.
 * @returns Stable reason identifier for logs and guards.
 */
export function probeFailureReason(result: PackageTestSandboxResult, marker: boolean, parsed: boolean): string {
  if (!marker) return 'probe_marker_absent';
  if (result.exitCode !== 0) return 'probe_exit_nonzero';
  if (!result.cleanupVerified) return 'probe_cleanup_unverified';
  if (!parsed) return 'probe_report_unparseable';
  return 'probe_reported_no_capability';
}

/**
 * @description Record why a probe verified nothing. The empty set stays the contract callers depend
 * on; only the reason becomes observable, with bounded evidence and no package-supplied secrets.
 * @param image Requested runner image reference, when one was configured.
 * @param result Bounded sandbox outcome for the probe run.
 * @param marker Whether the fixed report line was recovered from the output.
 * @param report Parsed probe report, when the recovered line parsed.
 * @param parseError JSON failure, when the recovered line did not parse.
 * @returns Nothing; this is a diagnostic side effect only.
 */
function logProbeFailure(image: string | undefined, result: PackageTestSandboxResult,
  marker: boolean, report?: Record<string, unknown>, parseError?: unknown): void {
  const reported = report?.error;
  logger.warn({
    reason: probeFailureReason(result, marker, parseError === undefined),
    image: image ?? 'current-container', markerSeen: marker, exitCode: result.exitCode,
    cleanupVerified: result.cleanupVerified, timedOut: result.timedOut, cancelled: result.cancelled,
    probeError: typeof reported === 'string' ? reported.slice(0, 200) : undefined,
    parseError: parseError instanceof Error ? parseError.message.slice(0, 200) : undefined,
    output: result.output.slice(0, 200),
  }, 'Package test runner probe verified no capability');
}

/** @description Certify absence only for validation work that cannot create a Docker container. */
async function beforeContainer<T>(work: () => T | Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) {
    const failure = error instanceof Error ? error : new Error('package_test_preflight_unavailable');
    throw Object.assign(failure, { cleanupVerified: true });
  }
}

/** @description Resolve only an existing local image; no registry pull or request-selected Docker endpoint occurs. */
async function localImage(selected?: string): Promise<{ image: string; environmentKeys: string[] }> {
  let reference = selected;
  if (!reference) {
    const hostname = process.env.HOSTNAME;
    if (!hostname || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(hostname)) throw new Error('package_test_image_unavailable');
    const current = await dockerControl(['inspect', '--format', '{{.Image}}', hostname]);
    if (current.code !== 0) throw new Error('package_test_image_unavailable'); reference = current.output.trim();
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:/@-]{0,255}$/.test(reference)) throw new Error('package_test_image_invalid');
  const result = await dockerControl(['image', 'inspect', '--format', '{{.Id}}', reference]);
  const image = result.output.trim();
  if (result.code !== 0 || !/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error('package_test_image_unavailable');
  const environment = await dockerControl(['image', 'inspect', '--format', '{{json .Config.Env}}', image]);
  let entries: unknown;
  try { entries = JSON.parse(environment.output); } catch { throw new Error('package_test_image_environment_invalid'); }
  if (environment.code !== 0 || !Array.isArray(entries) || entries.length > 256
    || entries.some(value => typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*=/.test(value))) throw new Error('package_test_image_environment_invalid');
  return { image, environmentKeys: entries.map(value => value.slice(0, value.indexOf('='))) };
}

/** @description Per-profile container budgets. Raising a budget is all a profile may do: the network stays off,
 * no host path is mounted and the Docker socket is never passed in, whichever profile runs. */
const PROFILE_BUDGETS: Readonly<Record<PackageTestSandboxProfile, { tmpMb: number; pids: string; cpus: string; nofile: string }>> = {
  node: { tmpMb: 64, pids: '64', cpus: '1', nofile: 'nofile=256:256' },
  browser: { tmpMb: 256, pids: '512', cpus: '2', nofile: 'nofile=4096:4096' },
  vitest: { tmpMb: 256, pids: '256', cpus: '2', nofile: 'nofile=2048:2048' },
};

/** @description Build the closed disposable container profile; package code receives no host mount or daemon socket.
 * A profile only raises the process, descriptor, tmp and CPU budgets its runner needs; the network stays off. */
function createArguments(name: string, image: string, memory: number, environmentKeys: string[], deadline: number, profile: PackageTestSandboxProfile): string[] {
  const budget = PROFILE_BUDGETS[profile] ?? PROFILE_BUDGETS.node;
  return ['create', '-i', '--rm', '--name', name, '--label', 'oshal.test-lab.sandbox=1',
    '--label', `oshal.test-lab.run-id=${name.slice(10)}`, '--label', `oshal.test-lab.deadline=${deadline}`, '--pull=never',
    '--network', 'none', '--read-only', '--init', '--user', '1000:1000',
    '--tmpfs', '/work:rw,nosuid,nodev,noexec,size=192m,uid=1000,gid=1000,mode=0700',
    '--tmpfs', `/tmp:rw,nosuid,nodev,noexec,size=${budget.tmpMb}m,uid=1000,gid=1000,mode=0700`,
    '--workdir', '/work', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--memory', `${memory}m`, '--memory-swap', `${memory}m`, '--pids-limit', budget.pids, '--cpus', budget.cpus,
    '--ulimit', budget.nofile, ...environmentKeys.flatMap(key => ['--env', `${key}=`]),
    '--env', 'PATH=/usr/local/bin:/usr/bin:/bin', '--env', 'HOME=/tmp', '--env', 'NODE_OPTIONS=', '--env', 'NODE_PATH=',
    '--entrypoint', 'node', image, '-e', PACKAGE_TEST_LAUNCHER, '--', String(deadline)];
}

/** @description Run fixed Node suites in disposable isolation with current-core defaults and explicit cleanup receipts. */
export class PackageTestSandbox {
  private readonly verified = new Map<string, ReadonlySet<string>>();

  /** @description Reap the exact durable run after controller recovery; refusal preserves occupied capacity. */
  async cleanupExecution(executionId: string): Promise<boolean> {
    return removeSandbox(sandboxName(executionId));
  }

  /** @description Verify inside the closed browser profile which runner prerequisites this image satisfies.
   * Only a positive result is remembered per image, so a probe that failed under load is retried next time.
   * @param image Configured runner image, or the current container's image. @returns Verified prerequisite names. */
  async probe(image?: string): Promise<ReadonlySet<string>> {
    const known = this.verified.get(image ?? '');
    if (known) return known;
    const result = await this.run({ files: [{ path: 'tests/runner-probe.test.cjs', content: Buffer.from(RUNNER_PROBE_SUITE) }],
      suiteFiles: ['tests/runner-probe.test.cjs'], timeoutMs: 150000, maxMemoryMb: 512, image, profile: 'browser', executionId: randomUUID() });
    const payload = probeReportPayload(result.output);
    const verified = new Set<string>();
    if (payload === undefined || result.exitCode !== 0 || !result.cleanupVerified) {
      logProbeFailure(image, result, payload !== undefined);
      return verified;
    }
    let report: Record<string, unknown>;
    try { report = JSON.parse(payload) as Record<string, unknown>; }
    catch (error) { logProbeFailure(image, result, true, undefined, error); return verified; }
    if (report.chromium === true) { verified.add('runner:playwright'); verified.add('browser:chromium'); }
    if (report.theme === true) verified.add('core:shared-theme-assets');
    if (report.bridge === true) verified.add('core:surface-bridge');
    if (report.dependencies === true) { verified.add('core:dependencies'); verified.add('harness:oshal-core-root'); }
    if (report.vitest === true) verified.add('runner:vitest');
    if (!verified.size) { logProbeFailure(image, result, true, report); return verified; }
    this.verified.set(image ?? '', verified);
    logger.info({ image: image ?? 'current-container', verified: [...verified] }, 'Package test runner probe verified image capabilities');
    return verified;
  }

  /** @description Execute one immutable source snapshot and reap its entire container after every outcome. */
  async run(input: PackageTestSandboxInput): Promise<PackageTestSandboxResult> {
    const profile = input.profile ?? 'node';
    const { payload, memory, name } = await beforeContainer(() => {
      const payload = sandboxPayload(input.files, input.suiteFiles, profile), memory = input.maxMemoryMb ?? 512;
      const name = sandboxName(input.executionId ?? randomUUID());
      if (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 100 || input.timeoutMs > 300000
        || !Number.isInteger(memory) || memory < 16 || memory > 4096) throw new Error('package_test_limits_invalid');
      return { payload, memory, name };
    });
    const empty = { exitCode: null, output: '', timedOut: false, cancelled: false, image: input.image || '', cleanupVerified: true };
    if (input.signal?.aborted) return { ...empty, cancelled: true };
    const { image, environmentKeys } = await beforeContainer(() => localImage(input.image));
    if (input.signal?.aborted) return { ...empty, image, cancelled: true };
    const deadline = Date.now() + input.timeoutMs;
    const created = await dockerControl(createArguments(name, image, memory, environmentKeys, deadline, profile), 15000);
    if (created.code !== 0) {
      const cleanupVerified = await removeSandbox(name);
      return { ...empty, image, output: 'The isolated package runner could not create its container.',
        timedOut: created.timedOut, cancelled: Boolean(input.signal?.aborted), cleanupVerified: cleanupVerified && !created.timedOut };
    }
    try {
      if (input.signal?.aborted) return { ...empty, image, cancelled: true, cleanupVerified: await removeSandbox(name) };
      const result = await runAttachedSandbox(name, payload, Math.max(1, deadline - Date.now()), input.signal);
      return { ...result, timedOut: result.timedOut || result.exitCode === 124, image, cleanupVerified: await removeSandbox(name) };
    } catch {
      return { ...empty, image, output: 'The isolated package runner became unavailable.', cleanupVerified: await removeSandbox(name) };
    }
  }
}

export type { PackageTestSandboxFile } from './package-test-sandbox-launcher';
