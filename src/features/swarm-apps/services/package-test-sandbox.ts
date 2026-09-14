/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Run approved package Node suites in pinned local Docker images without host mounts, network or inherited application credentials.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Correlate durable runs with disposable containers and a controller-independent deadline for safe crash recovery.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Mark only trusted pre-container validation failures as requiring no cleanup.
 * 4 | maintainer@emeraldcoastsystemsgroup.com | Add the browser container profile (more processes, descriptors and tmp for Chromium; still no network, no mounts, no daemon socket) and a real in-profile capability probe that verifies which runner prerequisites the image satisfies.
 */
import { randomUUID } from 'node:crypto';
import { PACKAGE_TEST_LAUNCHER, sandboxPayload, type PackageTestSandboxFile, type PackageTestSandboxProfile } from './package-test-sandbox-launcher';
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
const RUNNER_PROBE_SUITE = `const { test } = require('node:test'); const fs = require('node:fs'); const path = require('node:path');
test('runner probe', async () => {
  const core = process.env.OSHAL_CORE_ROOT || '/app';
  const report = { theme: fs.existsSync(path.join(core, 'src/shared/ui/css/surface-themes.css')),
    bridge: fs.existsSync(path.join(core, 'src/shared/ui/js/surface-bridge-client.js')), dependencies: false, chromium: false };
  try { require.resolve('express'); report.dependencies = true; } catch {}
  try {
    const { chromium } = require('playwright'); const browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
    await page.goto('data:text/html,<title>runner-probe</title>'); report.chromium = (await page.title()) === 'runner-probe';
    report.browser = browser.version(); await browser.close();
  } catch (error) { report.error = String(error && error.message || error).slice(0, 200); }
  console.log('OSHAL_RUNNER_PROBE ' + JSON.stringify(report));
});
`;
const PROBE_MARKER = 'OSHAL_RUNNER_PROBE ';

/** @description Actual process outcome and verified cleanup; output is bounded and remains caller-scoped. */
export interface PackageTestSandboxResult {
  exitCode: number | null; output: string; timedOut: boolean; cancelled: boolean;
  image: string; cleanupVerified: boolean;
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

/** @description Build the closed disposable container profile; package code receives no host mount or daemon socket.
 * The browser profile only raises the process, descriptor and tmp budgets Chromium needs; the network stays off. */
function createArguments(name: string, image: string, memory: number, environmentKeys: string[], deadline: number, profile: PackageTestSandboxProfile): string[] {
  const browser = profile === 'browser';
  return ['create', '-i', '--rm', '--name', name, '--label', 'oshal.test-lab.sandbox=1',
    '--label', `oshal.test-lab.run-id=${name.slice(10)}`, '--label', `oshal.test-lab.deadline=${deadline}`, '--pull=never',
    '--network', 'none', '--read-only', '--init', '--user', '1000:1000',
    '--tmpfs', '/work:rw,nosuid,nodev,noexec,size=192m,uid=1000,gid=1000,mode=0700',
    '--tmpfs', `/tmp:rw,nosuid,nodev,noexec,size=${browser ? 256 : 64}m,uid=1000,gid=1000,mode=0700`,
    '--workdir', '/work', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--memory', `${memory}m`, '--memory-swap', `${memory}m`, '--pids-limit', browser ? '512' : '64', '--cpus', browser ? '2' : '1',
    '--ulimit', browser ? 'nofile=4096:4096' : 'nofile=256:256', ...environmentKeys.flatMap(key => ['--env', `${key}=`]),
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
      suiteFiles: ['tests/runner-probe.test.cjs'], timeoutMs: 90000, maxMemoryMb: 512, image, profile: 'browser', executionId: randomUUID() });
    const line = result.output.split('\n').find(value => value.startsWith(PROBE_MARKER));
    const verified = new Set<string>();
    if (!line || result.exitCode !== 0 || !result.cleanupVerified) return verified;
    let report: Record<string, unknown> = {};
    try { report = JSON.parse(line.slice(PROBE_MARKER.length)) as Record<string, unknown>; } catch { return verified; }
    if (report.chromium === true) { verified.add('runner:playwright'); verified.add('browser:chromium'); }
    if (report.theme === true) verified.add('core:shared-theme-assets');
    if (report.bridge === true) verified.add('core:surface-bridge');
    if (report.dependencies === true) { verified.add('core:dependencies'); verified.add('harness:oshal-core-root'); }
    if (verified.size) this.verified.set(image ?? '', verified);
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
