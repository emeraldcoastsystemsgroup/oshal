/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the crash-guard parity fix. server.ts had process-level handlers; bot-node-server.ts — the runtime that owns ALL LLM execution across every bot container — had none, so a stray rejection killed a bot node with no log line and the restart policy hid it. Tests the installer's behaviour AND the parity itself: a new long-running entrypoint that forgets the guards goes red here rather than in production.
 */

import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  installProcessCrashGuards,
  resetProcessCrashGuardsForTest,
} from '../../src/shared/services/process-crash-guards';

const REPO_ROOT = resolve(__dirname, '../..');

describe('process crash guards', () => {
  let addedRejection: Array<(reason: unknown, promise: unknown) => void>;
  let addedException: Array<(error: Error, origin: unknown) => void>;
  let onSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetProcessCrashGuardsForTest();
    addedRejection = [];
    addedException = [];
    // Capture handlers instead of registering them — a real handler would outlive the test and
    // swallow rejections from every later spec in this worker.
    onSpy = vi.spyOn(process, 'on').mockImplementation(((event: string, handler: never) => {
      if (event === 'unhandledRejection') addedRejection.push(handler);
      if (event === 'uncaughtException') addedException.push(handler);
      return process;
    }) as never);
  });

  afterEach(() => {
    onSpy.mockRestore();
    resetProcessCrashGuardsForTest();
    vi.useRealTimers();
  });

  it('registers both handlers', () => {
    installProcessCrashGuards('test-runtime');
    expect(addedRejection).toHaveLength(1);
    expect(addedException).toHaveLength(1);
  });

  it('is idempotent, so an imported entrypoint cannot stack duplicates', () => {
    installProcessCrashGuards('test-runtime');
    installProcessCrashGuards('test-runtime');
    installProcessCrashGuards('test-runtime');
    expect(addedRejection).toHaveLength(1);
    expect(addedException).toHaveLength(1);
  });

  it('KEEPS THE PROCESS ALIVE on an unhandled rejection', () => {
    // The whole point: one orphaned promise must not drop in-flight work.
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    installProcessCrashGuards('test-runtime');

    addedRejection[0]?.(new Error('stray'), Promise.resolve());

    expect(exit).not.toHaveBeenCalled();
    exit.mockRestore();
  });

  it('handles a non-Error rejection reason without throwing inside the handler', () => {
    // A handler that throws on `reject("some string")` would defeat the guard at the moment it is
    // needed most.
    installProcessCrashGuards('test-runtime');
    expect(() => addedRejection[0]?.('a bare string', Promise.resolve())).not.toThrow();
    expect(() => addedRejection[0]?.(undefined, Promise.resolve())).not.toThrow();
  });

  it('exits non-zero on an uncaught exception, after a flush delay', () => {
    vi.useFakeTimers();
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    installProcessCrashGuards('test-runtime');

    addedException[0]?.(new Error('fatal'), 'uncaughtException');

    // Not immediately — a diagnostic that dies with the process is worth nothing.
    expect(exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(250);
    expect(exit).toHaveBeenCalledWith(1);

    exit.mockRestore();
  });
});

/**
 * The parity check. The bug was not that the installer was wrong — it was that one runtime never
 * got it, and nothing said so. This asserts the property directly, so the next long-running
 * entrypoint that forgets goes red here instead of dying silently in a container.
 */
describe('every long-running entrypoint installs the crash guards', () => {
  const ENTRYPOINTS = [
    'src/app/server.ts',
    'src/app/bot-node-server.ts',
    'src/app/sat-node-server.ts',
    'src/app/drone-node-server.ts',
    'src/app/camera-node-server.ts',
  ];

  it.each(ENTRYPOINTS)('%s installs them', (rel) => {
    const src = readFileSync(join(REPO_ROOT, rel), 'utf8');
    expect(src, `${rel} runs unguarded — a stray rejection kills it with no log line`)
      .toContain('installProcessCrashGuards(');
  });

  it('nobody hand-rolls the handlers instead of using the shared installer', () => {
    // Two definitions drift. The controller's inline copy is what made the gap invisible: it
    // looked handled everywhere, because the one file people read was.
    for (const rel of ENTRYPOINTS) {
      const src = readFileSync(join(REPO_ROOT, rel), 'utf8');
      expect(src, `${rel} should call installProcessCrashGuards, not register its own handler`)
        .not.toMatch(/process\.on\(\s*['"]unhandledRejection['"]/);
    }
  });
});
