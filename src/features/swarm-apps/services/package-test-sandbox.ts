/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Run approved package Node suites in pinned local Docker images without host mounts, network or inherited application credentials.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Correlate durable runs with disposable containers and a controller-independent deadline for safe crash recovery.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Mark only trusted pre-container validation failures as requiring no cleanup.
 */
import { randomUUID } from 'node:crypto';
import { PACKAGE_TEST_LAUNCHER, sandboxPayload, type PackageTestSandboxFile } from './package-test-sandbox-launcher';
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
}

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

/** @description Build the closed disposable container profile; package code receives no host mount or daemon socket. */
function createArguments(name: string, image: string, memory: number, environmentKeys: string[], deadline: number): string[] {
  return ['create', '-i', '--rm', '--name', name, '--label', 'oshal.test-lab.sandbox=1',
    '--label', `oshal.test-lab.run-id=${name.slice(10)}`, '--label', `oshal.test-lab.deadline=${deadline}`, '--pull=never',
    '--network', 'none', '--read-only', '--init', '--user', '1000:1000',
    '--tmpfs', '/work:rw,nosuid,nodev,noexec,size=192m,uid=1000,gid=1000,mode=0700',
    '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=64m,uid=1000,gid=1000,mode=0700',
    '--workdir', '/work', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--memory', `${memory}m`, '--memory-swap', `${memory}m`, '--pids-limit', '64', '--cpus', '1',
    '--ulimit', 'nofile=256:256', ...environmentKeys.flatMap(key => ['--env', `${key}=`]),
    '--env', 'PATH=/usr/local/bin:/usr/bin:/bin', '--env', 'HOME=/tmp', '--env', 'NODE_OPTIONS=', '--env', 'NODE_PATH=',
    '--entrypoint', 'node', image, '-e', PACKAGE_TEST_LAUNCHER, '--', String(deadline)];
}

/** @description Run fixed Node suites in disposable isolation with current-core defaults and explicit cleanup receipts. */
export class PackageTestSandbox {
  /** @description Reap the exact durable run after controller recovery; refusal preserves occupied capacity. */
  async cleanupExecution(executionId: string): Promise<boolean> {
    return removeSandbox(sandboxName(executionId));
  }

  /** @description Execute one immutable source snapshot and reap its entire container after every outcome. */
  async run(input: PackageTestSandboxInput): Promise<PackageTestSandboxResult> {
    const { payload, memory, name } = await beforeContainer(() => {
      const payload = sandboxPayload(input.files, input.suiteFiles), memory = input.maxMemoryMb ?? 512;
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
    const created = await dockerControl(createArguments(name, image, memory, environmentKeys, deadline), 15000);
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
