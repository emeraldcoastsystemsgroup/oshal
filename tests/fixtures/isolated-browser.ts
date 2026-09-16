/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Bound fixture browser shutdown and verify exit of only the exact Playwright-owned process; report forced cleanup without hiding crashes.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Give the owned browser ONE configurable exit budget instead of three stacked 5 s bounds. The graceful deadline now only escalates to the scoped kill, and the scoped kill is raced against the real exit event rather than claiming a second deadline, so a loaded box that finishes the exit late still passes while a browser that never exits fails loudly at the budget.
 */
import { chromium, type BrowserServer } from 'playwright';
import type { ChildProcess } from 'node:child_process';

/** Missing this only escalates to the scoped kill; it is never on its own a verdict about the suite. */
const GRACEFUL_ESCALATE_MS = 5000;
/** A shared, oversubscribed box can take far longer than the escalation window to schedule the exit. */
const DEFAULT_EXIT_BUDGET_MS = 45000;
type Exit = { code: number | null; signal: string | null; premature: boolean; afterKill?: boolean };

/** @description Resolve the total wall clock an owned browser gets to be confirmed exited, so a slower host
 * can raise it without editing the fixture. An absent, unparsable or non-positive setting keeps the default.
 * @param env Environment to read `OSHAL_FIXTURE_BROWSER_EXIT_TIMEOUT_MS` from. @returns Budget in milliseconds. */
export function resolveExitBudgetMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.OSHAL_FIXTURE_BROWSER_EXIT_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_EXIT_BUDGET_MS;
}

/** Total wall clock this process allows an owned browser to be confirmed exited. */
export const BROWSER_EXIT_BUDGET_MS = resolveExitBudgetMs();
/** What a suite owning a fixture browser must give its hooks, so the runner's own hook deadline can never
 *  fire before the fixture reaches its verdict — the failure would otherwise just move, not go away. */
export const BROWSER_HOOK_TIMEOUT_MS = BROWSER_EXIT_BUDGET_MS + 15000;

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
 * @param work Owned cleanup operation. @param ms Deadline for this step. @returns Its result or an explicit timeout. */
async function bounded<T>(work: Promise<T>, ms: number): Promise<{ timedOut: true } | { timedOut: false; value: T }> {
  let timer!: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([work.then(value => ({ timedOut: false as const, value })),
      new Promise<{ timedOut: true }>(resolve => { timer = setTimeout(() => resolve({ timedOut: true }), ms); })]);
  } finally { clearTimeout(timer); }
}

/** @description Close this server's child process only, checking the real exit event before reporting cleanup.
 * @param server Exact owned Playwright server. @param exited Its process exit event.
 * @param markKill Record the exact kill invocation. @param budgetMs Total wall clock allowed for the exit.
 * @returns Explicit shutdown evidence. */
export async function closeOwnedBrowser(server: BrowserServer, exited: Promise<Exit>, markKill = () => {}, budgetMs = BROWSER_EXIT_BUDGET_MS) {
  const started = Date.now(), pid = server.process().pid;
  const graceful = await bounded(server.close(), Math.min(GRACEFUL_ESCALATE_MS, budgetMs));
  let killError: unknown;
  if (graceful.timedOut) {
    // Playwright kills the process tree rooted at this launch's exact child handle, never a process-name search.
    markKill();
    // The evidence that ends cleanup is the process exit event, not kill() resolving, so the kill shares the one
    // budget instead of consuming a deadline of its own and failing a browser that was merely slow to be scheduled.
    void server.kill().catch((error: unknown) => { killError = error; });
  }
  const result = await bounded(exited, Math.max(0, budgetMs - (Date.now() - started)));
  if (result.timedOut) {
    throw new Error(`Owned fixture browser ${pid} did not exit within ${budgetMs} ms of explicit cleanup.`
      + (killError === undefined ? '' : ` Scoped kill reported: ${String(killError)}`));
  }
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
    void server.kill().catch(() => {});
    if ((await bounded(exited, BROWSER_EXIT_BUDGET_MS)).timedOut) {
      throw new Error('Fixture browser connection failed and its owned exit was not confirmed.');
    }
    throw error;
  }
}
