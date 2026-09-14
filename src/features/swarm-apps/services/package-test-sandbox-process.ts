/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Bound Docker control calls and reap named test containers after exit, cancellation or output exhaustion.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Reap only the immutable container with the expected durable run labels before releasing run capacity.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Spend the same output budget on a head AND a tail window and report truncation instead of rewriting a green exit code into a failure, so a loud but passing suite keeps the evidence its verdict rests on.
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

/** Total bytes of runner output the controller ever holds. Bounding capture is deliberate and stays. */
export const OUTPUT_CAPTURE_BYTES = 64 * 1024;
/** Share of that budget spent on the start of the stream; the remainder holds its end. */
const OUTPUT_HEAD_BYTES = 48 * 1024;
const OUTPUT_TAIL_BYTES = OUTPUT_CAPTURE_BYTES - OUTPUT_HEAD_BYTES;
/** A producer this loud has already destroyed its own evidence, so stop it rather than let it hold the VM to
 * its deadline. The run is then reported as truncated, never as a failure it did not actually suffer. */
const OUTPUT_RUNAWAY_BYTES = 64 * 1024 * 1024;

/** @description Result of one attached Node process before the final container absence check.
 * `truncated` says the capture window dropped bytes, which is why a caller must not read a missing
 * TAP summary as a failed run. */
export interface AttachedTestResult { exitCode: number | null; output: string; timedOut: boolean; cancelled: boolean; truncated: boolean }

/** @description Bounded head-and-tail capture window over one run's combined stdout and stderr.
 * Every runner reports its TAP plan and summary LAST, so a head-only bound silently discards the only
 * evidence a verdict can rest on and turns a noisy green run into an unparseable one. This spends the
 * same total byte budget on both ends of the stream and states how much of the middle it dropped.
 * @returns A window that absorbs chunks, reports whether it dropped anything, and renders the capture.
 */
export function createOutputWindow() {
  const head: Buffer[] = [], tail: Buffer[] = [];
  let headBytes = 0, tailBytes = 0, total = 0;
  const trimTail = (): void => {
    while (tail.length > 1 && tailBytes - tail[0].length >= OUTPUT_TAIL_BYTES) { tailBytes -= tail[0].length; tail.shift(); }
    if (tailBytes > OUTPUT_TAIL_BYTES) { const drop = tailBytes - OUTPUT_TAIL_BYTES; tail[0] = tail[0].subarray(drop); tailBytes -= drop; }
  };
  return {
    /** @description Absorb one chunk, dropping only from the middle of the stream. */
    add(value: Buffer): void {
      total += value.length;
      let rest = value;
      if (headBytes < OUTPUT_HEAD_BYTES) {
        const part = rest.subarray(0, OUTPUT_HEAD_BYTES - headBytes);
        head.push(part); headBytes += part.length; rest = rest.subarray(part.length);
      }
      if (!rest.length) return;
      tail.push(rest); tailBytes += rest.length; trimTail();
    },
    /** @description Total bytes the run emitted, including the bytes this window could not keep. */
    emitted: (): number => total,
    /** @description Whether any bytes were dropped, which makes an absent summary unknown rather than failed. */
    truncated: (): boolean => total > headBytes + tailBytes,
    /** @description Render the capture, naming the gap so a spliced line can never read as a real one. */
    text(): string {
      const omitted = total - headBytes - tailBytes;
      if (omitted <= 0) return Buffer.concat([...head, ...tail]).toString('utf8');
      const gap = `\n... ${omitted} bytes of package test output omitted; the capture bound is ${OUTPUT_CAPTURE_BYTES} bytes ...\n`;
      return Buffer.concat(head).toString('utf8') + gap + Buffer.concat(tail).toString('utf8');
    },
  };
}

/** @description Start only an already created container so cancellation cannot race a later container creation. */
export function runAttachedSandbox(name: string, payload: string, timeoutMs: number, signal?: AbortSignal): Promise<AttachedTestResult> {
  return new Promise(resolve => {
    const child = spawn('docker', ['start', '-a', '-i', name], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const window = createOutputWindow();
    let timedOut = false, cancelled = false, stopped = false, finished = false, runaway = false;
    let cleanup: Promise<boolean> | undefined;
    const stop = (): void => { if (stopped) return; stopped = true; cleanup = removeSandbox(name); child.stdin.destroy(); };
    const finish = async (exitCode: number | null): Promise<void> => {
      if (finished) return; finished = true; clearTimeout(timer); clearTimeout(lastResort);
      signal?.removeEventListener('abort', abort);
      await cleanup; resolve({ exitCode, output: window.text(), timedOut, cancelled, truncated: window.truncated() });
    };
    const abort = (): void => { cancelled = true; stop(); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, Math.max(1, timeoutMs));
    const lastResort = setTimeout(() => { timedOut = true; stop(); child.kill('SIGKILL'); void finish(null); }, Math.max(1, timeoutMs) + 35000);
    const chunk = (value: Buffer): void => {
      // Keep draining past the capture bound: a suite reports its TAP summary LAST, and reaping the
      // container here is what turned a passing noisy run into an unparseable one. Memory stays bounded
      // by the window, and wall clock stays bounded by the deadline this run already has.
      window.add(value);
      if (window.emitted() > OUTPUT_RUNAWAY_BYTES && !runaway) { runaway = true; stop(); }
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
