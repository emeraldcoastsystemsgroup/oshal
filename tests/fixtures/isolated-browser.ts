/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Bound fixture browser shutdown and verify exit of only the exact Playwright-owned process; report forced cleanup without hiding crashes.
 */
import { chromium, type BrowserServer } from 'playwright';
import type { ChildProcess } from 'node:child_process';

const CLOSE_TIMEOUT_MS = 5000;
type Exit = { code: number | null; signal: string | null; premature: boolean; afterKill?: boolean };

/** @description Capture both an already-exited child and future exit before cleanup can change its classification.
 * @param child Exact owned process handle. @param isClosing Cleanup lifecycle getter.
 * @param isKilling Exact kill-invocation lifecycle getter. @returns Immutable exit evidence. */
export function observeBrowserExit(child: ChildProcess, isClosing: () => boolean, isKilling = () => false): Promise<Exit> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode, premature: !isClosing(), afterKill: isKilling() });
  }
  return new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal, premature: !isClosing(), afterKill: isKilling() })));
}

/** @description Bound a cleanup operation without losing the original rejection.
 * @param work Owned cleanup operation. @returns Its result or an explicit timeout. */
async function bounded<T>(work: Promise<T>): Promise<{ timedOut: true } | { timedOut: false; value: T }> {
  let timer!: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([work.then(value => ({ timedOut: false as const, value })),
      new Promise<{ timedOut: true }>(resolve => { timer = setTimeout(() => resolve({ timedOut: true }), CLOSE_TIMEOUT_MS); })]);
  } finally { clearTimeout(timer); }
}

/** @description Close this server's child process only, checking the real exit event before reporting cleanup.
 * @param server Exact owned Playwright server. @param exited Its process exit event.
 * @param markKill Record the exact kill invocation. @returns Explicit shutdown evidence. */
export async function closeOwnedBrowser(server: BrowserServer, exited: Promise<Exit>, markKill = () => {}) {
  const started = Date.now(), pid = server.process().pid;
  const graceful = await bounded(server.close());
  if (graceful.timedOut) {
    // Playwright kills the process tree rooted at this launch's exact child handle, never a process-name search.
    markKill();
    const killed = await bounded(server.kill());
    if (killed.timedOut) throw new Error(`Owned fixture browser ${pid} did not terminate after explicit cleanup.`);
  }
  const result = await bounded(exited);
  if (result.timedOut) throw new Error(`Owned fixture browser ${pid} exit was not confirmed.`);
  if (result.value.premature || (result.value.code !== 0 && !result.value.afterKill)) {
    throw new Error(`Owned fixture browser ${pid} exited unexpectedly; cleanup cannot turn a crash into a pass.`);
  }
  const receipt = { pid, graceful: !graceful.timedOut, forced: graceful.timedOut, exitVerified: true,
    durationMs: Date.now() - started, ...result.value };
  if (receipt.forced) console.warn('Fixture browser required scoped forced cleanup:', JSON.stringify(receipt));
  return receipt;
}

/** @description Start a headless browser with an explicit owned process handle and loopback-only connection.
 * @param options Ordinary fixture launch options such as synthetic media input. @returns Browser and bounded cleanup. */
export async function launchIsolatedBrowser(options: Parameters<typeof chromium.launchServer>[0] = {}) {
  const server = await chromium.launchServer({ ...options, host: '127.0.0.1', headless: true });
  let closing = false, killing = false;
  const exited = observeBrowserExit(server.process(), () => closing, () => killing);
  try {
    const browser = await chromium.connect(server.wsEndpoint());
    return { browser, close: async () => { closing = true; return closeOwnedBrowser(server, exited, () => { killing = true; }); } };
  } catch (error) {
    closing = true;
    killing = true;
    const killed = await bounded(server.kill());
    if (killed.timedOut) throw new Error('Fixture browser connection failed and its owned cleanup did not finish.');
    if ((await bounded(exited)).timedOut) throw new Error('Fixture browser connection failed and its owned exit was not confirmed.');
    throw error;
  }
}
