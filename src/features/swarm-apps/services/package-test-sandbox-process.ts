/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Bound Docker control calls and reap named test containers after exit, cancellation or output exhaustion.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Reap only the immutable container with the expected durable run labels before releasing run capacity.
 */
import { spawn } from 'node:child_process';

/** @description Bounded local Docker control result; raw errors remain inside the controller. */
export interface DockerControlResult { code: number | null; output: string; timedOut: boolean }

/** @description Execute fixed Docker arguments asynchronously with bounded output and a hard process deadline. */
export function dockerControl(args: string[], timeoutMs = 10000): Promise<DockerControlResult> {
  return new Promise(resolve => {
    const child = spawn('docker', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', timedOut = false, complete = false;
    const finish = (code: number | null): void => {
      if (complete) return; complete = true; clearTimeout(timer); resolve({ code, output, timedOut });
    };
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); finish(null); }, Math.max(1, timeoutMs));
    const chunk = (value: Buffer): void => { output = (output + value.toString('utf8')).slice(0, 8192); };
    child.stdout.on('data', chunk); child.stderr.on('data', chunk);
    child.on('error', () => finish(null)); child.on('close', finish);
  });
}

/** @description Validate the server-generated durable run identifier before using it in a Docker selector. */
export function sandboxName(executionId: string): string {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(executionId)) {
    throw new Error('package_test_execution_id_invalid');
  }
  return `oshal-lab-${executionId.toLowerCase()}`;
}

/** @description Resolve only a positively identified sandbox; failed inspection never means absence. */
async function ownedContainer(name: string): Promise<string | null | false> {
  const listing = await dockerControl(['ps', '-a', '--no-trunc', '--filter', `name=^/${name}$`, '--format', '{{.ID}}'], 2000);
  if (listing.code !== 0) return false;
  const id = listing.output.trim();
  if (!id) return null;
  if (!/^[a-f0-9]{64}$/.test(id)) return false;
  const inspect = await dockerControl(['inspect', '--format', '{{json .Config.Labels}}', id], 2000);
  if (inspect.code !== 0) {
    const absent = await dockerControl(['ps', '-a', '--filter', `name=^/${name}$`, '--format', '{{.ID}}'], 2000);
    return absent.code === 0 && !absent.output.trim() ? null : false;
  }
  try {
    const labels = JSON.parse(inspect.output);
    if (labels?.['oshal.test-lab.sandbox'] !== '1' || labels['oshal.test-lab.run-id'] !== name.slice(10)
      || !/^\d{13}$/.test(labels['oshal.test-lab.deadline'] || '')) return false;
  } catch { return false; }
  return id;
}

/** @description Remove only the run-labeled immutable container and prove its exact name is absent. */
export async function removeSandbox(name: string): Promise<boolean> {
  if (!name.startsWith('oshal-lab-') || sandboxName(name.slice(10)) !== name) return false;
  for (let attempt = 0; attempt < 6; attempt++) {
    const id = await ownedContainer(name);
    if (id === null) return true;
    if (id === false) return false;
    await dockerControl(['rm', '-f', id], 3000);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return await ownedContainer(name) === null;
}

/** @description Result of one attached Node process before the final container absence check. */
export interface AttachedTestResult { exitCode: number | null; output: string; timedOut: boolean; cancelled: boolean }

/** @description Start only an already created container so cancellation cannot race a later container creation. */
export function runAttachedSandbox(name: string, payload: string, timeoutMs: number, signal?: AbortSignal): Promise<AttachedTestResult> {
  return new Promise(resolve => {
    const child = spawn('docker', ['start', '-a', '-i', name], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let bytes = 0, timedOut = false, cancelled = false, stopped = false, finished = false, overflow = false;
    let cleanup: Promise<boolean> | undefined;
    const stop = (): void => { if (stopped) return; stopped = true; cleanup = removeSandbox(name); child.stdin.destroy(); };
    const finish = async (exitCode: number | null): Promise<void> => {
      if (finished) return; finished = true; clearTimeout(timer); clearTimeout(lastResort);
      signal?.removeEventListener('abort', abort);
      const output = Buffer.concat(chunks).toString('utf8') + (overflow ? '\nPackage test output limit exceeded.\n' : '');
      await cleanup; resolve({ exitCode: overflow && exitCode === 0 ? 1 : exitCode, output, timedOut, cancelled });
    };
    const abort = (): void => { cancelled = true; stop(); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, Math.max(1, timeoutMs));
    const lastResort = setTimeout(() => { timedOut = true; stop(); child.kill('SIGKILL'); void finish(null); }, Math.max(1, timeoutMs) + 35000);
    const chunk = (value: Buffer): void => {
      const normalized = Buffer.from(value.toString('utf8'));
      const remaining = 64 * 1024 - bytes;
      if (remaining > 0) chunks.push(normalized.subarray(0, remaining));
      bytes += normalized.length;
      if (bytes > 64 * 1024 && !overflow) { overflow = true; stop(); }
    };
    child.stdout.on('data', chunk); child.stderr.on('data', chunk);
    child.stdin.on('error', () => {});
    child.on('error', () => { stop(); void finish(null); });
    child.on('close', code => { void finish(code); });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    else child.stdin.end(payload);
  });
}
