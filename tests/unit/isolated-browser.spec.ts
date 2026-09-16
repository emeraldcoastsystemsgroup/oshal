/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove bounded fixture cleanup reports forced ownership and refuses crashes, missing exit evidence and shutdown errors.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Guard the one exit budget: an owned browser that finishes its exit long after the graceful and kill deadlines still passes, one that never exits still fails loudly and names the budget, the budget is settable, every suite that owns a fixture browser gives its hooks at least that budget, and a REAL headless Chromium proves both the receipt and the loud deadline against the actual Playwright server.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chromium, type BrowserServer } from 'playwright';
import { EventEmitter } from 'node:events';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import {
  BROWSER_EXIT_BUDGET_MS, BROWSER_HOOK_TIMEOUT_MS, closeOwnedBrowser, launchIsolatedBrowser,
  observeBrowserExit, resolveExitBudgetMs,
} from '../fixtures/isolated-browser';

vi.setConfig({ testTimeout: BROWSER_HOOK_TIMEOUT_MS, hookTimeout: BROWSER_HOOK_TIMEOUT_MS });

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

/** @description Model only owned lifecycle handles; no real processes or browsers are launched. */
function server(close: () => Promise<void>, kill = async () => {}) {
  const value = { process: () => ({ pid: 12345 }), close: vi.fn(close), kill: vi.fn(kill) };
  return { value, handle: value as unknown as BrowserServer };
}

/** @description A cleanup step that never settles — the shape a loaded box produces. */
function never<T>(): Promise<T> { return new Promise<T>(() => {}); }

it('accepts normal zero exit without forced cleanup', async () => {
  const s = server(async () => {});
  const result = await closeOwnedBrowser(s.handle, Promise.resolve({ code: 0, signal: null, premature: false }));
  expect(result).toMatchObject({ graceful: true, forced: false, exitVerified: true, pid: 12345 });
  expect(s.value.kill).not.toHaveBeenCalled();
});

it('terminates only the supplied owned server after a real deadline and reports the fallback', async () => {
  vi.useFakeTimers(); const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  let finish!: (value: { code: number; signal: null; premature: boolean; afterKill: boolean }) => void;
  const exit = new Promise<{ code: number; signal: null; premature: boolean; afterKill: boolean }>(resolve => { finish = resolve; });
  const s = server(never, async () => { finish({ code: 1, signal: null, premature: false, afterKill: true }); });
  const result = closeOwnedBrowser(s.handle, exit);
  await vi.advanceTimersByTimeAsync(4999); expect(s.value.kill).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(await result).toMatchObject({ forced: true, graceful: false, exitVerified: true, code: 1 });
  expect(s.value.kill).toHaveBeenCalledOnce(); expect(warning).toHaveBeenCalledOnce();
});

// The 2026-09-15 failure shape: both five-second deadlines elapsed while two lanes ran, the suite was failed,
// and the pid had exited when it was checked a minute later. The exit event, not kill() resolving, ends cleanup.
it('passes a slow box whose owned browser exits long after the graceful and kill deadlines', async () => {
  vi.useFakeTimers(); const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const exit = new Promise<{ code: number; signal: null; premature: boolean; afterKill: boolean }>(resolve => {
    setTimeout(() => resolve({ code: 1, signal: null, premature: false, afterKill: true }), 20_000);
  });
  const s = server(never, never);
  const result = closeOwnedBrowser(s.handle, exit);
  await vi.advanceTimersByTimeAsync(19_999);
  await vi.advanceTimersByTimeAsync(1);
  expect(await result).toMatchObject({ forced: true, graceful: false, exitVerified: true, durationMs: 20_000 });
  expect(s.value.kill).toHaveBeenCalledOnce(); expect(warning).toHaveBeenCalledOnce();
});

it('still fails loudly, naming the budget, when the owned browser never exits', async () => {
  vi.useFakeTimers(); const s = server(never, never);
  const result = expect(closeOwnedBrowser(s.handle, never())).rejects
    .toThrow(`Owned fixture browser 12345 did not exit within ${BROWSER_EXIT_BUDGET_MS} ms of explicit cleanup.`);
  await vi.advanceTimersByTimeAsync(BROWSER_EXIT_BUDGET_MS); await result;
  expect(s.value.kill).toHaveBeenCalledOnce();
});

it('reports a refused scoped kill in the deadline it caused', async () => {
  vi.useFakeTimers();
  const s = server(never, async () => { throw new Error('synthetic kill refused'); });
  const result = expect(closeOwnedBrowser(s.handle, never())).rejects.toThrow('Scoped kill reported: Error: synthetic kill refused');
  await vi.advanceTimersByTimeAsync(BROWSER_EXIT_BUDGET_MS); await result;
});

it.each([{ code: 0, premature: true }, { code: 1, premature: false }])('refuses unexpected exit evidence %j', async exit => {
  const s = server(async () => {});
  await expect(closeOwnedBrowser(s.handle, Promise.resolve({ ...exit, signal: null }))).rejects.toThrow('exited unexpectedly');
  expect(s.value.kill).not.toHaveBeenCalled();
});

it('does not swallow a graceful shutdown error', async () => {
  const s = server(async () => { throw new Error('synthetic shutdown rejected'); });
  await expect(closeOwnedBrowser(s.handle, Promise.resolve({ code: 0, signal: null, premature: false })))
    .rejects.toThrow('synthetic shutdown rejected');
});

it('remembers premature exit even if cleanup begins later', async () => {
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null }); let closing = false;
  const result = observeBrowserExit(child as ChildProcess, () => closing);
  child.emit('exit', 0, null); closing = true;
  expect(await result).toEqual({ code: 0, signal: null, premature: true, afterKill: false });
});

it('captures a child that already exited before its listener could be attached', async () => {
  const child = Object.assign(new EventEmitter(), { exitCode: 1, signalCode: null });
  expect(await observeBrowserExit(child as ChildProcess, () => false)).toEqual({ code: 1, signal: null, premature: true, afterKill: false });
  expect(child.listenerCount('exit')).toBe(0);
});

it('does not reclassify a crash during stalled graceful cleanup as a successful forced shutdown', async () => {
  vi.useFakeTimers(); const s = server(never);
  const exit = Promise.resolve({ code: 1, signal: null, premature: false, afterKill: false });
  const result = expect(closeOwnedBrowser(s.handle, exit)).rejects.toThrow('exited unexpectedly');
  await vi.advanceTimersByTimeAsync(5000); await result;
});

it.each([
  [undefined, BROWSER_EXIT_BUDGET_MS], ['', BROWSER_EXIT_BUDGET_MS], ['nonsense', BROWSER_EXIT_BUDGET_MS],
  ['0', BROWSER_EXIT_BUDGET_MS], ['-1', BROWSER_EXIT_BUDGET_MS], ['90000', 90_000],
])('resolves the exit budget from %j', (value, expected) => {
  expect(resolveExitBudgetMs(value === undefined ? {} : { OSHAL_FIXTURE_BROWSER_EXIT_TIMEOUT_MS: value })).toBe(expected);
});

// A longer fixture budget only moves the failure to the runner's hook deadline unless the suites that own a
// browser give their hooks at least as much room, so that pairing is checked against the real spec files.
it('every suite that owns a fixture browser gives its hooks the fixture cleanup budget', () => {
  const dir = path.resolve('tests/unit');
  const owners = readdirSync(dir).filter(name => name.endsWith('.spec.ts'))
    .map(name => ({ name, text: readFileSync(path.join(dir, name), 'utf8') }))
    .filter(spec => spec.text.includes('launchIsolatedBrowser'));
  expect(owners.length, 'no suite was read; the discovery, not the suites, is broken').toBeGreaterThanOrEqual(11);
  for (const { name, text } of owners) {
    const setting = /hookTimeout:\s*(BROWSER_HOOK_TIMEOUT_MS|[\d_]+)/.exec(text);
    expect(setting, `${name} owns a fixture browser but gives its hooks no budget`).not.toBeNull();
    const declared = setting![1];
    if (declared === 'BROWSER_HOOK_TIMEOUT_MS') {
      expect(text, `${name} must import the budget it names`).toMatch(/BROWSER_HOOK_TIMEOUT_MS[\s\S]*?from '\.\.\/fixtures\/isolated-browser'/);
    } else {
      expect(Number(declared.replace(/_/g, '')), `${name} hook budget`).toBeGreaterThanOrEqual(BROWSER_HOOK_TIMEOUT_MS);
    }
  }
});

// Real boundary: an actual headless Chromium behind the real Playwright BrowserServer, because the deadline
// arithmetic above is the only part a double can prove. Nothing in this block is mocked.
describe('against a real headless Chromium', () => {
  it('confirms a real owned browser exited, inside the budget', async () => {
    const owned = await launchIsolatedBrowser();
    expect(owned.browser.isConnected()).toBe(true);
    const receipt = await owned.close();
    expect(receipt).toMatchObject({ exitVerified: true, premature: false });
    expect(receipt.durationMs).toBeLessThan(BROWSER_EXIT_BUDGET_MS);
  });

  it('fails loudly on a real server whose exit is not confirmed inside the budget', async () => {
    const real = await chromium.launchServer({ host: '127.0.0.1', headless: true });
    try {
      await expect(closeOwnedBrowser(real, never(), () => {}, 250)).rejects.toThrow(/did not exit within 250 ms of explicit cleanup/);
    } finally { await real.kill(); }
  });
});
