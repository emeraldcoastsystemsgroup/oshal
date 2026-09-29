/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 L7: the capture anchor. The picking, pure: the origin is the most accurate fix (the earliest of equals), the heading is the first the phone reported, the footprint is how far the fixes spread inside the configured floor and cap, a client clock ahead of the server is clamped, and a session with no GPS fix yields nothing. The reader, over real files under a temporary scans root: it reads the owner's own sidecar, drops a line that does not parse, a line that fails validation and a line naming another session, answers nothing for a missing sidecar or a malformed session id, and never reads another owner's sidecar. The footprint bounds come from the environment, with a malformed value defaulted and a cap below the floor raised to it. Synthetic coordinates only.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CAPTURE_ANCHOR_DEFAULTS, captureAnchorFromRecords, captureTelemetryPath, readCaptureAnchor, resolveCaptureAnchorLimits,
  type CaptureTelemetryRecord,
} from '@/features/spatial-mapping';
import { EARTH_RADIUS_M } from '@/shared/utils/geo';

const SPOT = { lat: -12.34567, lon: -31.98765 };
const DEG_PER_M = 180 / (Math.PI * EARTH_RADIUS_M);
const north = (metres: number): { lat: number; lon: number } => ({ lat: SPOT.lat + metres * DEG_PER_M, lon: SPOT.lon });
const NOW = Date.parse('2026-09-03T12:00:00.000Z');
const LIMITS = { footprintMinM: 10, footprintMaxM: 500 };
const SESSION = randomUUID();

function reading(over: Partial<CaptureTelemetryRecord> & { ts: number }): CaptureTelemetryRecord {
  return { sessionId: SESSION, step: 0, headingDeg: null, sweepDeg: null, steps: null, gps: null, ...over };
}

describe('captureAnchorFromRecords', () => {
  it('takes the most accurate fix as the origin, the first heading, and the spread as the footprint', () => {
    const anchor = captureAnchorFromRecords([
      reading({ ts: NOW - 9000 }),
      reading({ ts: NOW - 8000, headingDeg: 271.5, gps: { ...north(30), accuracyM: 25 } }),
      reading({ ts: NOW - 6000, headingDeg: 10, gps: { ...SPOT, accuracyM: 5 } }),
      reading({ ts: NOW - 4000, gps: { ...north(-41.5), accuracyM: 9 } }),
    ], LIMITS, NOW);
    expect(anchor).toEqual({
      lat: SPOT.lat, lon: SPOT.lon, accuracyM: 5, headingDeg: 271.5, footprintRadiusM: 42,
      capturedAt: new Date(NOW - 6000).toISOString(), fixCount: 3,
    });
  });

  it('prefers the earliest of equally accurate fixes', () => {
    const anchor = captureAnchorFromRecords([
      reading({ ts: NOW - 3000, gps: { ...north(8), accuracyM: 7 } }),
      reading({ ts: NOW - 5000, gps: { ...SPOT, accuracyM: 7 } }),
    ], LIMITS, NOW);
    expect(anchor).toMatchObject({ lat: SPOT.lat, capturedAt: new Date(NOW - 5000).toISOString() });
  });

  it('floors and caps the footprint, and clamps a client clock that is ahead', () => {
    const still = captureAnchorFromRecords([reading({ ts: NOW + 86_400_000, gps: { ...SPOT, accuracyM: 4 } })], LIMITS, NOW);
    expect(still).toMatchObject({ footprintRadiusM: 10, capturedAt: new Date(NOW).toISOString(), headingDeg: null });
    const stray = captureAnchorFromRecords([
      reading({ ts: NOW - 2000, gps: { ...SPOT, accuracyM: 4 } }),
      reading({ ts: NOW - 1000, gps: { ...north(9000), accuracyM: 60 } }),
    ], LIMITS, NOW);
    expect(stray?.footprintRadiusM).toBe(500);
  });

  it('yields nothing for a session that recorded no GPS fix', () => {
    expect(captureAnchorFromRecords([reading({ ts: NOW, headingDeg: 12 })], LIMITS, NOW)).toBeNull();
    expect(captureAnchorFromRecords([], LIMITS, NOW)).toBeNull();
  });
});

describe('resolveCaptureAnchorLimits', () => {
  it('reads the floor and the cap, defaults a malformed value, and never caps below the floor', () => {
    expect(resolveCaptureAnchorLimits({})).toEqual({ ...CAPTURE_ANCHOR_DEFAULTS });
    expect(resolveCaptureAnchorLimits({ OSHAL_SPACES_CAPTURE_FOOTPRINT_MIN_M: '25', OSHAL_SPACES_CAPTURE_FOOTPRINT_MAX_M: '120' }))
      .toEqual({ footprintMinM: 25, footprintMaxM: 120 });
    expect(resolveCaptureAnchorLimits({ OSHAL_SPACES_CAPTURE_FOOTPRINT_MIN_M: 'wide', OSHAL_SPACES_CAPTURE_FOOTPRINT_MAX_M: '-3' }))
      .toEqual({ ...CAPTURE_ANCHOR_DEFAULTS });
    expect(resolveCaptureAnchorLimits({ OSHAL_SPACES_CAPTURE_FOOTPRINT_MIN_M: '800' })).toEqual({ footprintMinM: 800, footprintMaxM: 800 });
  });
});

describe('readCaptureAnchor', () => {
  const saved = process.env.OSHAL_SPACES_ROOT;
  let root = '';

  async function sidecar(sub: string, sessionId: string, lines: string[]): Promise<void> {
    const file = captureTelemetryPath(sub, sessionId);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, lines.join('\n').concat('\n'));
  }

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oshal-capture-anchor-'));
    process.env.OSHAL_SPACES_ROOT = root;
  });

  afterAll(async () => {
    if (saved === undefined) delete process.env.OSHAL_SPACES_ROOT; else process.env.OSHAL_SPACES_ROOT = saved;
    await fs.rm(root, { recursive: true, force: true });
  });

  it('reads the owner\'s own sidecar and drops every line it cannot trust', async () => {
    const ts = Date.now() - 60_000;
    await sidecar('capturer-a', SESSION, [
      JSON.stringify(reading({ ts, headingDeg: 90, gps: { ...north(11.5), accuracyM: 14 } })),
      '{ not json',
      JSON.stringify({ ...reading({ ts: ts + 1000, gps: { ...north(300), accuracyM: 3 } }), sessionId: randomUUID() }),
      JSON.stringify({ ...reading({ ts: ts + 2000, gps: { ...north(200), accuracyM: 1 } }), step: -1 }),
      JSON.stringify(reading({ ts: ts + 3000, gps: { ...SPOT, accuracyM: 6 } })),
    ]);
    const anchor = await readCaptureAnchor('capturer-a', SESSION);
    expect(anchor).toMatchObject({ lat: SPOT.lat, lon: SPOT.lon, accuracyM: 6, headingDeg: 90, fixCount: 2, footprintRadiusM: 12 });
    expect(anchor?.capturedAt).toBe(new Date(ts + 3000).toISOString());
  });

  it('answers nothing for a missing sidecar, a malformed session id, or another owner\'s session', async () => {
    expect(await readCaptureAnchor('capturer-a', randomUUID())).toBeNull();
    expect(await readCaptureAnchor('capturer-a', '../capture-sessions/x')).toBeNull();
    expect(await readCaptureAnchor('', SESSION)).toBeNull();
    expect(await readCaptureAnchor('capturer-b', SESSION)).toBeNull();
  });
});
