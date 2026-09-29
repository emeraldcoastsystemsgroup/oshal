/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 L7: what the map specs share. A capture is made the way the product makes one: the guided-capture session's phone telemetry is written to the owner-scoped sidecar under a temporary scans root, the scan is registered through the real SpatialScanStore naming that session (and its group, for a group's scan), the real SpatialMappingService joins the session's GPS to the scan, and the real anchorMap records it. Nothing is doubled: the database is the location fixture's private PostgreSQL with its tables owned by the enforcing runtime role. Synthetic identities and mid-ocean coordinates only.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { anchorMap, type LocationMapAnchorInput, type LocationMapAnchorResult } from '@/features/location';
import { SpatialMappingService, SpatialScanStore, captureTelemetryPath } from '@/features/spatial-mapping';
import { EARTH_RADIUS_M } from '@/shared/utils/geo';
import { FIXTURE_ISSUER, asSession, type FixtureSession } from './location-postgres-fixture';

/** A synthetic point in the South Atlantic, far from any address. */
export const MAP_HOME = { lat: -12.34567, lon: -31.98765 };

const DEG_PER_M = 180 / (Math.PI * EARTH_RADIUS_M);

/** A point `metres` north of another. */
export const northOf = (p: { lat: number; lon: number }, metres: number): { lat: number; lon: number } =>
  ({ lat: p.lat + metres * DEG_PER_M, lon: p.lon });

/** The principal a fixture session signs in as. */
export const principalOf = (who: FixtureSession): { sub: string; principalIssuer: string } =>
  ({ sub: who.sub, principalIssuer: FIXTURE_ISSUER });

/** What a capture is made with. */
export interface CaptureOptions {
  /** The scan's title. */
  title: string;
  /** When the capture happened, epoch ms. */
  whenMs: number;
  /** The owning group of a group's scan. */
  group?: string;
  /** False registers the scan without a capture session. */
  session?: boolean;
}

/** The real store and service over the runtime pool, and the temporary scans root they write under. */
export interface MapWorld {
  app: Pool;
  store: SpatialScanStore;
  service: SpatialMappingService;
  root: string;
  close(): Promise<void>;
}

/**
 * @description Point the spatial-mapping slice at a temporary scans root and build the real store and service.
 * @param app - The GUC-wrapped runtime pool.
 * @returns The world; `close()` removes the root and restores the environment.
 */
export async function openMapWorld(app: Pool): Promise<MapWorld> {
  const saved = process.env.OSHAL_SPACES_ROOT;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oshal-l7-scans-'));
  process.env.OSHAL_SPACES_ROOT = root;
  return {
    app,
    store: new SpatialScanStore(app),
    service: new SpatialMappingService(app),
    root,
    async close(): Promise<void> {
      if (saved === undefined) delete process.env.OSHAL_SPACES_ROOT; else process.env.OSHAL_SPACES_ROOT = saved;
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

/**
 * @description Write a guided-capture session's telemetry sidecar: three readings around a point,
 * the most accurate one exactly on it.
 * @param sub - The capturer.
 * @param sessionId - The session.
 * @param at - Where the capture happened.
 * @param whenMs - When, epoch ms.
 * @returns Nothing.
 */
export async function writeCaptureTelemetry(sub: string, sessionId: string, at: { lat: number; lon: number }, whenMs: number): Promise<void> {
  const file = captureTelemetryPath(sub, sessionId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const reading = (step: number, point: { lat: number; lon: number }, accuracyM: number, offsetMs: number): string => JSON.stringify({
    sessionId, step, ts: whenMs + offsetMs, headingDeg: 40 + step, sweepDeg: 10 * step, steps: step, gps: { ...point, accuracyM },
  });
  await fs.writeFile(file, [
    reading(0, northOf(at, 4), 18, 0),
    reading(1, at, 6, 2000),
    reading(2, northOf(at, -5), 12, 4000),
  ].join('\n').concat('\n'));
}

/**
 * @description Capture a scan the way the product does: telemetry first, then the scan row naming the session.
 * @param world - The real store over the runtime pool.
 * @param who - The capturer.
 * @param at - Where.
 * @param options - Title, time, group and whether a session is recorded.
 * @returns The scan id.
 */
export async function captureScan(world: MapWorld, who: FixtureSession, at: { lat: number; lon: number }, options: CaptureOptions): Promise<string> {
  const id = randomUUID();
  const sessionId = options.session === false ? null : randomUUID();
  if (sessionId) await writeCaptureTelemetry(who.sub, sessionId, at, options.whenMs);
  await asSession(who, () => world.store.insert({
    id, userSub: who.sub, title: options.title, sourceKind: 'model', sourceName: 'capture.ply', sourceRef: '', sourceBytes: 0,
    tenantId: options.group ?? null, captureSessionId: sessionId,
  }));
  return id;
}

/**
 * @description Anchor a scan from its joined capture GPS, as the store's spaces route does.
 * @param world - The real service over the runtime pool.
 * @param who - The caller (the capturer).
 * @param scanId - The scan.
 * @param extra - Group, place or device for the anchor.
 * @returns What anchorMap answered.
 */
export async function anchorFromCapture(
  world: MapWorld, who: FixtureSession, scanId: string, extra: Partial<LocationMapAnchorInput> = {},
): Promise<LocationMapAnchorResult> {
  const capture = await asSession(who, () => world.service.captureAnchorForScan(who.sub, scanId));
  if (!capture) throw new Error('the scan has no joined capture GPS');
  return asSession(who, () => anchorMap(world.app, {
    mapKind: 'spatial-scan',
    mapRef: scanId,
    anchor: { lat: capture.lat, lon: capture.lon, headingDeg: capture.headingDeg, accuracyM: capture.accuracyM },
    footprintRadiusM: capture.footprintRadiusM,
    source: 'capture-gps',
    capturedAt: capture.capturedAt,
    ...extra,
  }));
}

/**
 * @description The name of the error a piece of work threw, or 'resolved'.
 * @param work - The work.
 * @returns The error's name.
 */
export async function refusalOf(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
    return 'resolved';
  } catch (error) {
    return (error as { name?: string }).name ?? 'thrown';
  }
}
