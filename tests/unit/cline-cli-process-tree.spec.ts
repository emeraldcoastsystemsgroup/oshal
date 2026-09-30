/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard complete Cline process-tree termination for streaming and batch timeouts on POSIX and Windows.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Guard the persisted Cline auto-update opt-out while preserving unrelated global settings.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Guard auto-update suppression before availability and version probes, which can otherwise update Cline themselves.
 */

/**
 * @description
 * Regression coverage for shell-backed Cline processes. A timeout must terminate
 * the real CLI descendant, not only the shell returned by child_process.spawn().
 */

import { EventEmitter } from 'events';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const require_ = createRequire(import.meta.url);
const ClineCLIWrapper = require_('../../any-bot/server/services/codebase/ClineCLIWrapper');

class FakeChild extends EventEmitter {
  pid = 4242;
  killed = true; // Deliberately true: this does not mean the tree has exited.
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { write: vi.fn(), end: vi.fn() };
  kill = vi.fn(() => true);
}

function wrapper(): any {
  return Object.create(ClineCLIWrapper.prototype);
}

function activityTracker() {
  return {
    touch: vi.fn(),
    touchStderr: vi.fn(),
    resetWarning: vi.fn(),
    shouldWarn: vi.fn(() => false),
    isStalled: vi.fn(() => false),
    getStats: vi.fn(() => ({
      totalMessages: 0,
      toolUseCount: 0,
      silenceFormatted: '0s',
      elapsedFormatted: '1s',
      thinkingCount: 0,
      completionCount: 0,
      errorCount: 0,
      stderrLines: 0,
    })),
  };
}

function executionWrapper(child: FakeChild): any {
  const instance = wrapper();
  Object.assign(instance, {
    clineCommand: 'cline-test',
    defaultTimeout: 1,
    defaultInactivityTimeout: 999,
    defaultKillOnInactivity: false,
    homeDir: process.cwd(),
    _ensureModelConfig: vi.fn(),
    _createActivityTracker: vi.fn(() => activityTracker()),
    _spawnManagedProcess: vi.fn(() => child),
    _terminateProcessTree: vi.fn(),
    getEnhancedPath: vi.fn(() => process.env.PATH || ''),
  });
  return instance;
}

const savedDemoMode = process.env.DEMO_MODE;
const savedOperatorSubs = process.env.OSHAL_OPERATOR_SUBS;

beforeEach(() => {
  process.env.DEMO_MODE = 'true';
  process.env.OSHAL_OPERATOR_SUBS = 'process-tree-test-operator';
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (savedDemoMode === undefined) delete process.env.DEMO_MODE;
  else process.env.DEMO_MODE = savedDemoMode;
  if (savedOperatorSubs === undefined) delete process.env.OSHAL_OPERATOR_SUBS;
  else process.env.OSHAL_OPERATOR_SUBS = savedOperatorSubs;
});

describe('Cline CLI process-tree termination', () => {
  it('signals the POSIX process group instead of only the shell child', () => {
    const instance = wrapper();
    instance._processPlatform = () => 'linux';
    const processKill = vi.spyOn(process, 'kill').mockReturnValue(true);
    const child = new FakeChild();

    expect(instance._signalProcessTree(child, 'SIGTERM', 'unit timeout')).toBe(true);

    expect(processKill).toHaveBeenCalledWith(-child.pid, 'SIGTERM');
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('uses an immediate forced Windows tree kill and observes its completion', () => {
    const instance = wrapper();
    const killer = new EventEmitter() as EventEmitter & { unref: ReturnType<typeof vi.fn> };
    killer.unref = vi.fn();
    instance._processPlatform = () => 'win32';
    instance._spawnWindowsTreeKiller = vi.fn(() => killer);
    const child = new FakeChild();

    expect(instance._signalProcessTree(child, 'SIGTERM', 'unit timeout')).toBe(true);

    expect(instance._spawnWindowsTreeKiller).toHaveBeenCalledWith([
      '/PID', String(child.pid), '/T', '/F',
    ]);
    expect(killer.listenerCount('error')).toBe(1);
    expect(killer.listenerCount('close')).toBe(1);
    expect(killer.unref).toHaveBeenCalledOnce();
    killer.emit('close', 0);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('bounds a hung Windows taskkill and falls back to forced root termination', async () => {
    vi.useFakeTimers();
    const instance = wrapper();
    const killer = new EventEmitter() as EventEmitter & {
      kill: ReturnType<typeof vi.fn>;
      unref: ReturnType<typeof vi.fn>;
    };
    killer.kill = vi.fn(() => true);
    killer.unref = vi.fn();
    instance._processPlatform = () => 'win32';
    instance._windowsTreeKillTimeoutMs = () => 50;
    instance._spawnWindowsTreeKiller = vi.fn(() => killer);
    const child = new FakeChild();

    expect(instance._signalProcessTree(child, 'SIGTERM', 'hung taskkill')).toBe(true);
    await vi.advanceTimersByTimeAsync(50);

    expect(killer.kill).toHaveBeenCalledWith('SIGKILL');
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('escalates once even when ChildProcess.killed is already true', async () => {
    vi.useFakeTimers();
    const instance = wrapper();
    instance._processPlatform = () => 'linux';
    instance._processTreeKillGraceMs = () => 50;
    instance._signalProcessTree = vi.fn(() => true);
    const child = new FakeChild();

    const first = instance._terminateProcessTree(child, 'hard timeout');
    const duplicate = instance._terminateProcessTree(child, 'inactivity timeout');

    expect(duplicate).toBe(first);
    expect(instance._signalProcessTree).toHaveBeenCalledTimes(1);
    expect(instance._signalProcessTree).toHaveBeenNthCalledWith(1, child, 'SIGTERM', 'hard timeout');

    await vi.advanceTimersByTimeAsync(50);

    expect(instance._signalProcessTree).toHaveBeenCalledTimes(2);
    expect(instance._signalProcessTree).toHaveBeenNthCalledWith(
      2, child, 'SIGKILL', 'hard timeout escalation',
    );
  });

  it('routes a batch hard timeout through process-tree termination and settles', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const instance = executionWrapper(child);

    const pending = instance._executeViaSpawn('read-only test', process.cwd(), {
      timeout: 1,
      inactivityTimeout: 999,
      extraEnv: { OSHAL_USER_SUB: 'process-tree-test-operator' },
    });
    await vi.advanceTimersByTimeAsync(1000);

    expect(instance._terminateProcessTree).toHaveBeenCalledWith(child, 'batch hard timeout');
    child.emit('close', null);
    await expect(pending).rejects.toThrow('Cline CLI hard timeout after 1s');
  });

  it('routes a streaming hard timeout through process-tree termination and settles', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const instance = executionWrapper(child);

    const pending = instance._executeTaskStreamingInternal('read-only test', process.cwd(), {
      timeout: 1,
      inactivityTimeout: 999,
      extraEnv: { OSHAL_USER_SUB: 'process-tree-test-operator' },
    });
    await vi.advanceTimersByTimeAsync(1000);

    expect(instance._terminateProcessTree).toHaveBeenCalledWith(child, 'streaming hard timeout');
    child.emit('close', null, 'SIGTERM');
    await expect(pending).resolves.toMatchObject({
      success: false,
      timedOut: true,
      signal: 'SIGTERM',
    });
  });

  it('kills a real parent and grandchild and allows the close promise to settle', async () => {
    const instance = wrapper();
    instance._processTreeKillGraceMs = () => 100;

    const leaf = Buffer.from(
      "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)",
      'utf8',
    ).toString('base64');
    const rootScript = [
      "const {spawn}=require('child_process')",
      `const code=Buffer.from('${leaf}','base64').toString('utf8')`,
      "const leaf=spawn(process.execPath,['-e',code],{stdio:'ignore'})",
      "process.stdout.write(String(leaf.pid)+'\\n')",
      "process.on('SIGTERM',()=>{})",
      'setInterval(()=>{},1000)',
    ].join(';');

    const child = instance._spawnManagedProcess(process.execPath, ['-e', rootScript], {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let grandchildPid = 0;

    try {
      grandchildPid = await new Promise<number>((resolve, reject) => {
        let output = '';
        const timer = setTimeout(() => reject(new Error('grandchild pid was not reported')), 3000);
        child.stdout.on('data', (chunk: Buffer) => {
          output += chunk.toString();
          if (!output.includes('\n')) return;
          clearTimeout(timer);
          resolve(Number(output.trim()));
        });
      });
      expect(grandchildPid).toBeGreaterThan(0);

      const closed = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('managed process did not close')), 5000);
        child.once('close', () => {
          clearTimeout(timer);
          resolve();
        });
      });
      instance._terminateProcessTree(child, 'real descendant regression');
      await closed;

      const isAlive = (pid: number) => {
        try { process.kill(pid, 0); return true; } catch (_error) { return false; }
      };
      const deadline = Date.now() + 3000;
      while ((isAlive(child.pid as number) || isAlive(grandchildPid)) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(isAlive(child.pid as number)).toBe(false);
      expect(isAlive(grandchildPid)).toBe(false);
    } finally {
      for (const pid of [child.pid, grandchildPid]) {
        if (!pid) continue;
        try { process.kill(pid, 'SIGKILL'); } catch (_error) { /* already gone */ }
      }
    }
  });

  it('preserves global Cline settings while disabling runtime self-updates', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'oshal-cline-settings-'));
    const settingsDir = join(homeDir, '.cline', 'data', 'settings');
    const settingsPath = join(settingsDir, 'global-settings.json');
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({
      autoUpdateEnabled: true,
      theme: 'dark',
      featureFlags: { keepMe: true },
    }), 'utf8');

    try {
      const instance = wrapper();
      instance.homeDir = homeDir;
      instance._resolveBackingProvider = () => ({ provider: 'gemini', model: 'gemini-test' });

      instance._ensureModelConfig();

      expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual({
        autoUpdateEnabled: false,
        theme: 'dark',
        featureFlags: { keepMe: true },
      });
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('creates the persisted auto-update opt-out when Cline settings do not exist', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'oshal-cline-settings-new-'));
    const settingsPath = join(homeDir, '.cline', 'data', 'settings', 'global-settings.json');

    try {
      const instance = wrapper();
      instance.homeDir = homeDir;
      instance._resolveBackingProvider = () => ({ provider: 'gemini', model: 'gemini-test' });

      instance._ensureModelConfig();

      expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual({ autoUpdateEnabled: false });
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('disables self-updates before spawning the availability version probe', async () => {
    const instance = wrapper();
    const child = new FakeChild();
    const order: string[] = [];
    instance.clineCommand = 'cline-test';
    instance.getEnhancedPath = () => process.env.PATH || '';
    instance._ensureAutoUpdateDisabled = vi.fn(() => order.push('disable-updates'));
    instance._spawnManagedProcess = vi.fn(() => {
      order.push('spawn');
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from('3.0.65\n'));
        child.exitCode = 0;
        child.emit('close', 0);
      });
      return child;
    });

    await expect(instance.isAvailable()).resolves.toBe(true);

    expect(order).toEqual(['disable-updates', 'spawn']);
    expect(instance._ensureAutoUpdateDisabled).toHaveBeenCalledOnce();
    expect(instance._spawnManagedProcess).toHaveBeenCalledOnce();
  });

  it('disables self-updates before spawning the explicit version probe', async () => {
    const instance = wrapper();
    const child = new FakeChild();
    const order: string[] = [];
    instance.clineCommand = 'cline-test';
    instance.getEnhancedPath = () => process.env.PATH || '';
    instance._ensureAutoUpdateDisabled = vi.fn(() => order.push('disable-updates'));
    instance._spawnManagedProcess = vi.fn(() => {
      order.push('spawn');
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from('Cline CLI version: 3.0.65\n'));
        child.exitCode = 0;
        child.emit('close', 0);
      });
      return child;
    });

    await expect(instance.getVersion()).resolves.toBe('3.0.65');

    expect(order).toEqual(['disable-updates', 'spawn']);
    expect(instance._ensureAutoUpdateDisabled).toHaveBeenCalledOnce();
    expect(instance._spawnManagedProcess).toHaveBeenCalledOnce();
  });
});
