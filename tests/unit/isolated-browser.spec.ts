/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove bounded fixture cleanup reports forced ownership and refuses crashes, missing exit evidence and shutdown errors.
 */
import { afterEach, expect, it, vi } from 'vitest';
import type { BrowserServer } from 'playwright';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { closeOwnedBrowser, observeBrowserExit } from '../fixtures/isolated-browser';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

/** @description Model only owned lifecycle handles; no real processes or browsers are launched. */
function server(close: () => Promise<void>, kill = async () => {}) {
  const value = { process: () => ({ pid: 12345 }), close: vi.fn(close), kill: vi.fn(kill) };
  return { value, handle: value as unknown as BrowserServer };
}

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
  const s = server(() => new Promise(() => {}), async () => { finish({ code: 1, signal: null, premature: false, afterKill: true }); });
  const result = closeOwnedBrowser(s.handle, exit);
  await vi.advanceTimersByTimeAsync(4999); expect(s.value.kill).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(await result).toMatchObject({ forced: true, graceful: false, exitVerified: true, code: 1 });
  expect(s.value.kill).toHaveBeenCalledOnce(); expect(warning).toHaveBeenCalledOnce();
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

it('refuses success when process exit cannot be confirmed', async () => {
  vi.useFakeTimers(); const s = server(async () => {});
  const result = expect(closeOwnedBrowser(s.handle, new Promise(() => {}))).rejects.toThrow('exit was not confirmed');
  await vi.advanceTimersByTimeAsync(5000); await result;
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
  vi.useFakeTimers(); const s = server(() => new Promise(() => {}));
  const exit = Promise.resolve({ code: 1, signal: null, premature: false, afterKill: false });
  const result = expect(closeOwnedBrowser(s.handle, exit)).rejects.toThrow('exited unexpectedly');
  await vi.advanceTimersByTimeAsync(5000); await result;
});
