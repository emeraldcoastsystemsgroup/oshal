/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added native background wake lifecycle, privacy, and platform-boundary coverage
 */

import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  BackgroundWakeService,
  WindowsSystemSpeechWakeDetector,
  buildWakePhrase,
  buildWindowsWakeScript,
  sanitizeAssistantName,
  type WakeDetector,
  type WakeDetectorStartOptions,
} from '../../packages/oshal-chat/src/main/background-wake';

class FakeDetector implements WakeDetector {
  readonly supported = true;
  starts = 0;
  stops = 0;
  options: WakeDetectorStartOptions | null = null;

  async start(options: WakeDetectorStartOptions): Promise<void> {
    this.starts += 1;
    this.options = options;
  }

  async stop(): Promise<void> {
    this.stops += 1;
    this.options = null;
  }

  wake(confidence = 0.91): void {
    this.options?.onWake({
      phrase: this.options.phrase,
      confidence,
      detectedAt: new Date().toISOString(),
    });
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('OSHAL Node native background wake', () => {
  it('requires a verified identity and never starts from the persisted toggle alone', async () => {
    const detector = new FakeDetector();
    const service = new BackgroundWakeService({ detector, onWake: vi.fn() });

    const status = await service.configure({
      enabled: true,
      assistantName: 'Computer',
      identityReady: false,
    });

    expect(status.state).toBe('error');
    expect(status.detail).toMatch(/sign in/i);
    expect(detector.starts).toBe(0);
  });

  it('uses one exact configurable phrase and hands off only a bounded wake event', async () => {
    const detector = new FakeDetector();
    const onWake = vi.fn(async () => undefined);
    const service = new BackgroundWakeService({ detector, onWake });

    const status = await service.configure({
      enabled: true,
      assistantName: 'Enterprise',
      identityReady: true,
    });

    expect(status).toMatchObject({ state: 'listening', phrase: 'Hey Enterprise' });
    expect(detector.options?.phrase).toBe('Hey Enterprise');

    detector.wake(1.5);
    await tick();

    expect(onWake).toHaveBeenCalledTimes(1);
    expect(onWake.mock.calls[0][0]).toEqual({
      phrase: 'Hey Enterprise',
      confidence: 1,
      detectedAt: expect.any(String),
    });
    expect(onWake.mock.calls[0][0]).not.toHaveProperty('audio');
    expect(onWake.mock.calls[0][0]).not.toHaveProperty('transcript');
    expect(service.getStatus().state).toBe('triggered');
    expect(detector.stops).toBe(1);
  });

  it('releases the listener for page mic, push-to-talk, pause, off, and shutdown lifecycles', async () => {
    const detector = new FakeDetector();
    const service = new BackgroundWakeService({ detector, onWake: vi.fn() });
    await service.configure({ enabled: true, assistantName: 'Jarvis', identityReady: true });

    expect((await service.setSurfaceOwnsMicrophone(true)).state).toBe('paused');
    expect((await service.setSurfaceOwnsMicrophone(false)).state).toBe('listening');
    expect((await service.setCaptureOwnsMicrophone(true)).detail).toMatch(/push-to-talk/i);
    expect((await service.setCaptureOwnsMicrophone(false)).state).toBe('listening');
    expect((await service.setUserPaused(true)).state).toBe('paused');
    expect((await service.setUserPaused(false)).state).toBe('listening');
    expect((await service.configure({ enabled: false, assistantName: 'Jarvis', identityReady: true })).state).toBe('off');

    await service.shutdown();
    expect(service.getStatus().state).toBe('off');
    expect(detector.stops).toBeGreaterThanOrEqual(4);
  });

  it('restarts the exact grammar when the configured assistant name changes', async () => {
    const detector = new FakeDetector();
    const service = new BackgroundWakeService({ detector, onWake: vi.fn() });
    await service.configure({ enabled: true, assistantName: 'Jarvis', identityReady: true });
    await service.configure({ enabled: true, assistantName: 'Computer', identityReady: true });

    expect(detector.starts).toBe(2);
    expect(detector.stops).toBe(1);
    expect(detector.options?.phrase).toBe('Hey Computer');
  });

  it('fails closed on platforms without an approved native helper', async () => {
    const detector = new WindowsSystemSpeechWakeDetector('darwin');
    const service = new BackgroundWakeService({ detector, onWake: vi.fn() });

    const status = await service.configure({ enabled: true, assistantName: 'Jarvis', identityReady: true });

    expect(status.state).toBe('unavailable');
    expect(status.detail).toMatch(/signed native helper/i);
  });

  it('builds a local in-memory Windows grammar with no raw-audio, disk, or network output', () => {
    const script = buildWindowsWakeScript('Hey Computer', 'en-US');

    expect(script).toContain("[string[]]@('Hey Computer')");
    expect(script).toContain('SetInputToDefaultAudioDevice');
    expect(script).toContain("type = 'wake'");
    expect(script).not.toMatch(/WriteAllBytes|WriteAllText|Out-File|Set-Content|Invoke-WebRequest|Invoke-RestMethod|HttpClient/i);
    expect(script).not.toMatch(/wave|wav|bytes/i);
  });

  it('sanitizes assistant names before constructing the native grammar', () => {
    expect(sanitizeAssistantName('  Enterprise<script>  ')).toBe('Enterprise script');
    expect(buildWakePhrase('R&D / Computer')).toBe('Hey R D Computer');
  });

  it('is wired into the existing authenticated Jarvis surface rather than a second chat route', () => {
    const main = readFileSync(resolve('packages/oshal-chat/src/main/main.ts'), 'utf8');
    const config = readFileSync(resolve('packages/oshal-chat/src/main/config.ts'), 'utf8');
    const cockpit = readFileSync(resolve('packages/oshal-chat/src/main/cockpit-window.ts'), 'utf8');
    const jarvis = readFileSync(resolve('src/api/jarvis.html'), 'utf8');

    expect(main).toContain('backgroundWakeEnabled: _ignored');
    expect(config).toContain('backgroundWakeEnabled: false');
    expect(config).not.toContain('OSHAL_BACKGROUND_WAKE');
    expect(main).toContain("permission === 'media' && audioOnly && trusted(requestingUrl)");
    expect(main).toContain("ipcMain.handle('identity:signout'");
    expect(cockpit).toContain("new CustomEvent('oshal:native-wake'");
    expect(cockpit).toContain('NATIVE_WAKE_TTL_MS = 15_000');
    expect(jarvis).toContain("window.addEventListener('oshal:native-wake'");
    expect(jarvis).toContain('await startListening()');
    expect(jarvis).toContain('handleInput(text)');
    expect(jarvis).toContain("fetch('/api/jarvis/ask'");
    expect(main).not.toContain("ipcMain.handle('wake:send-command'");
  });
});
