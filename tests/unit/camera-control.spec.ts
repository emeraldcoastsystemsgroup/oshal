/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — Camera Ops coverage:
 *                     |                             | validator coercion (XSS-safe captures), the sim engine's
 *                     |                             | record/photo/SD/battery state machine, the fleet plane
 *                     |                             | (heartbeat mint/liveness/staleness/id guards), the service
 *                     |                             | destructive-op confirm gate, and the real GoPro adapter
 *                     |                             | driven against an injected fetch (endpoint + capture proof).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added route-level regression coverage so /api/camera/status exposes real browser, GoPro node, and provider fallback paths instead of leaving the UI at Mock Camera only.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Removed the route-integration block (createCameraRoutes) — Camera Ops re-carved to the oshal-applications store; route-boundary coverage now lives in the package's tests/camera-routes.spec.ts. The engine coverage (validators, sim state machine, fleet, service, GoPro adapter) stays here.
 */

import { describe, expect, it } from 'vitest';
import {
  CameraCommandError,
  CameraConfirmationRequiredError,
  CameraFleet,
  CameraService,
  GoProCameraProvider,
  SimCameraProvider,
  goproUsbBaseUrl,
  normalizeCameraCapture,
  normalizeCameraCommand,
  normalizeCameraSettings,
  type CameraFetch,
  type CameraNodeHeartbeat,
  type CameraTelemetry,
} from '@/features/camera';

/** A controllable clock for deterministic sim/fleet timing. */
function fakeClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

function telemetry(over: Partial<CameraTelemetry> = {}): CameraTelemetry {
  return {
    cameraId: 'gopro-1', status: 'connected', connected: true, recording: false, mode: 'video',
    model: 'HERO9 Black', recordElapsedS: 0, previewActive: false, settings: {}, lastCaptureSeq: 0, ...over,
  };
}

// ── validator ────────────────────────────────────────────────────────────────

describe('normalizeCameraCommand', () => {
  it('accepts a bare op', () => {
    expect(normalizeCameraCommand({ op: 'record' }).command).toEqual({ op: 'record' });
  });
  it('rejects an unknown op', () => {
    const { command, errors } = normalizeCameraCommand({ op: 'explode' });
    expect(command).toBeNull();
    expect(errors[0]).toMatch(/unknown camera op/);
  });
  it('requires a valid mode for setMode', () => {
    expect(normalizeCameraCommand({ op: 'setMode', mode: 'photo' }).command).toEqual({ op: 'setMode', mode: 'photo' });
    expect(normalizeCameraCommand({ op: 'setMode', mode: 'x' }).command).toBeNull();
  });
  it('requires setting + option for setSetting', () => {
    expect(normalizeCameraCommand({ op: 'setSetting', setting: 2, option: 9 }).command).toEqual({ op: 'setSetting', setting: 2, option: 9 });
    expect(normalizeCameraCommand({ op: 'setSetting', setting: 2 }).command).toBeNull();
  });
});

describe('normalizeCameraCapture (untrusted node input)', () => {
  it('coerces a valid capture', () => {
    const cap = normalizeCameraCapture({ seq: 3, ts: 5, kind: 'video', path: '100GOPRO/GX010003.MP4', durationS: 12 });
    expect(cap).toMatchObject({ seq: 3, kind: 'video', path: '100GOPRO/GX010003.MP4', durationS: 12 });
  });
  it('rejects a path containing markup (XSS-safe)', () => {
    expect(normalizeCameraCapture({ seq: 1, kind: 'photo', path: '<img src=x onerror=alert(1)>' })).toBeNull();
  });
  it('drops a non-http thumbUrl but keeps the capture', () => {
    const cap = normalizeCameraCapture({ seq: 1, kind: 'photo', path: '100GOPRO/GOPR0001.JPG', thumbUrl: 'javascript:alert(1)' });
    expect(cap?.thumbUrl).toBeUndefined();
    const ok = normalizeCameraCapture({ seq: 1, kind: 'photo', path: '100GOPRO/GOPR0001.JPG', thumbUrl: 'http://n/t.jpg' });
    expect(ok?.thumbUrl).toBe('http://n/t.jpg');
  });
  it('rejects an unknown kind', () => {
    expect(normalizeCameraCapture({ seq: 1, kind: 'gif', path: 'a/b' })).toBeNull();
  });
});

describe('normalizeCameraSettings', () => {
  it('keeps primitives and drops objects/arrays', () => {
    const s = normalizeCameraSettings({ resolution: '1080p', fps: 60, bad: { x: 1 }, arr: [1] });
    expect(s).toEqual({ resolution: '1080p', fps: 60 });
  });
});

// ── SimCameraProvider ──────────────────────────────────────────────────────────

describe('SimCameraProvider', () => {
  it('starts connected and idle', () => {
    const cam = new SimCameraProvider({ cameraId: 'sim-1' });
    const t = cam.getTelemetry();
    expect(t.status).toBe('connected');
    expect(t.connected).toBe(true);
    expect(t.recording).toBe(false);
  });

  it('records a clip whose duration reflects the clock', async () => {
    const clk = fakeClock();
    const cam = new SimCameraProvider({ cameraId: 'sim-1', clock: clk.now });
    await cam.startRecording();
    expect(cam.getTelemetry().status).toBe('recording');
    clk.advance(3_000);
    await cam.stopRecording();
    const caps = cam.getCaptures(0);
    expect(caps).toHaveLength(1);
    expect(caps[0].kind).toBe('video');
    expect(caps[0].durationS).toBeCloseTo(3, 1);
  });

  it('rejects stop when not recording', async () => {
    const cam = new SimCameraProvider({ cameraId: 'sim-1' });
    await expect(cam.stopRecording()).rejects.toBeInstanceOf(CameraCommandError);
  });

  it('takes a photo, switches to photo mode, and consumes SD headroom', async () => {
    const cam = new SimCameraProvider({ cameraId: 'sim-1' });
    const before = cam.getTelemetry().sdRemainingPhotos!;
    await cam.capturePhoto();
    const t = cam.getTelemetry();
    expect(t.mode).toBe('photo');
    expect(cam.getCaptures(0)).toHaveLength(1);
    expect(t.sdRemainingPhotos).toBe(before - 1);
  });

  it('deleteAll clears captures and refuses commands once disconnected', async () => {
    const cam = new SimCameraProvider({ cameraId: 'sim-1' });
    await cam.capturePhoto();
    await cam.deleteAll();
    expect(cam.getCaptures(0)).toHaveLength(0);
    await cam.disconnect();
    expect(cam.getTelemetry().status).toBe('disconnected');
    await expect(cam.startRecording()).rejects.toBeInstanceOf(CameraCommandError);
  });
});

// ── CameraFleet ────────────────────────────────────────────────────────────────

describe('CameraFleet', () => {
  function heartbeat(over: Partial<CameraNodeHeartbeat> = {}): CameraNodeHeartbeat {
    return { cameraId: 'gopro-1', endpointUrl: 'http://127.0.0.1:4200', engine: 'gopro', telemetry: telemetry(), events: [], ...over };
  }

  it('resolves a local provider and rejects an unknown id', () => {
    const fleet = new CameraFleet();
    fleet.registerLocal('sim-1', new SimCameraProvider({ cameraId: 'sim-1' }));
    expect(fleet.get('sim-1').cameraId).toBe('sim-1');
    expect(() => fleet.get('nope')).toThrow(CameraCommandError);
  });

  it('mints a remote on heartbeat and marks it offline once stale', () => {
    const clk = fakeClock();
    const fleet = new CameraFleet({ clock: clk.now });
    fleet.ingestHeartbeat(heartbeat());
    expect(fleet.isOnline('gopro-1')).toBe(true);
    expect(fleet.list().find((c) => c.cameraId === 'gopro-1')?.online).toBe(true);
    clk.advance(20_000);
    expect(fleet.isOnline('gopro-1')).toBe(false);
    expect(() => fleet.get('gopro-1')).toThrow(/offline/);
  });

  it('rejects a malformed id and a node claiming a local id', () => {
    const fleet = new CameraFleet();
    expect(() => fleet.ingestHeartbeat(heartbeat({ cameraId: 'bad id!' }))).toThrow(CameraCommandError);
    fleet.registerLocal('sim-1', new SimCameraProvider({ cameraId: 'sim-1' }));
    expect(() => fleet.ingestHeartbeat(heartbeat({ cameraId: 'sim-1' }))).toThrow(/local camera/);
  });
});

// ── CameraService (destructive-op confirm gate) ─────────────────────────────────

describe('CameraService', () => {
  it('exposes the default embedded sim and executes commands', async () => {
    const svc = new CameraService({ embeddedSims: ['sim-1'] });
    expect(svc.list().map((c) => c.cameraId)).toContain('sim-1');
    const t = await svc.execute('sim-1', { op: 'record' });
    expect(t.recording).toBe(true);
  });

  it('gates deleteAll behind an explicit confirmation', async () => {
    const svc = new CameraService({ embeddedSims: ['sim-1'] });
    await expect(svc.execute('sim-1', { op: 'deleteAll' })).rejects.toBeInstanceOf(CameraConfirmationRequiredError);
    await expect(svc.execute('sim-1', { op: 'deleteAll' }, { confirmed: true })).resolves.toBeTruthy();
  });
});

// ── GoProCameraProvider (real HTTP control over an injected fetch) ──────────────

describe('GoProCameraProvider', () => {
  function mockFetch(over: Record<string, { ok?: boolean; status?: number; body?: unknown }> = {}): { fetch: CameraFetch; calls: string[] } {
    const calls: string[] = [];
    const fetch: CameraFetch = async (url) => {
      const path = url.replace(/^https?:\/\/[^/]+/, '');
      calls.push(path);
      const key = Object.keys(over).find((k) => path.startsWith(k));
      const cfg = key ? over[key] : {};
      const ok = cfg.ok ?? true;
      const status = cfg.status ?? (ok ? 200 : 409);
      const body = cfg.body ?? (path.includes('/info') ? { model_name: 'HERO9 Black', firmware_version: 'H9.01', serial_number: 'C3331234567890' }
        : path.includes('/state') ? { status: { 8: 0, 10: 0, 34: 1000, 35: 3600, 70: 85 } }
        : path.includes('/last_captured') ? { folder: '100GOPRO', file: 'GX010001.MP4' } : {});
      return { ok, status, json: async () => body, text: async () => JSON.stringify(body) };
    };
    return { fetch, calls };
  }

  it('derives the USB base URL from a serial', () => {
    expect(goproUsbBaseUrl('C333178')).toBe('http://172.21.178.51:8080');
  });

  it('connects over USB: enables wired control, claims control, reads info+state', async () => {
    const m = mockFetch();
    const cam = new GoProCameraProvider({ cameraId: 'gopro-1', link: 'usb', baseUrl: 'http://172.21.178.51:8080', fetchImpl: m.fetch });
    await cam.connect();
    expect(m.calls.some((c) => c.includes('/gopro/camera/control/wired_usb'))).toBe(true);
    expect(m.calls.some((c) => c.includes('/set_ui_controller'))).toBe(true);
    expect(m.calls).toContain('/gopro/camera/info');
    expect(m.calls).toContain('/gopro/camera/state');
    const t = cam.getTelemetry();
    expect(t.connected).toBe(true);
    expect(t.model).toBe('HERO9 Black');
    expect(t.batteryPct).toBe(85);
  });

  it('drives the shutter and records the captured clip', async () => {
    const m = mockFetch();
    const cam = new GoProCameraProvider({ cameraId: 'gopro-1', link: 'usb', baseUrl: 'http://x:8080', fetchImpl: m.fetch });
    await cam.connect();
    await cam.startRecording();
    expect(m.calls).toContain('/gopro/camera/shutter/start');
    expect(cam.getTelemetry().recording).toBe(true);
    await cam.stopRecording();
    expect(m.calls).toContain('/gopro/camera/shutter/stop');
    const caps = cam.getCaptures(0);
    expect(caps).toHaveLength(1);
    expect(caps[0].path).toBe('100GOPRO/GX010001.MP4');
  });

  it('surfaces a camera rejection as CameraCommandError', async () => {
    const m = mockFetch({ '/gopro/camera/shutter/start': { ok: false, status: 409, body: { error: 'busy' } } });
    const cam = new GoProCameraProvider({ cameraId: 'gopro-1', link: 'usb', baseUrl: 'http://x:8080', fetchImpl: m.fetch });
    await cam.connect();
    await expect(cam.startRecording()).rejects.toBeInstanceOf(CameraCommandError);
  });
});
