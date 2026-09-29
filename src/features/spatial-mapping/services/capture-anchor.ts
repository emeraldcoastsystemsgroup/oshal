/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 L7 (the ADR-111 amendment): capture GPS joined to the scan it produced. A guided-capture session posts phone telemetry to an owner-scoped JSONL sidecar keyed by the session id; a scan now names that session (spatial_scans.capture_session_id), and this module turns the session's readings into the scan's geodetic anchor: the most accurate GPS fix as the origin, the heading the capture began with, and a footprint from how far the fixes spread, floored and capped by configuration (OSHAL_SPACES_CAPTURE_FOOTPRINT_MIN_M, default 10 m; OSHAL_SPACES_CAPTURE_FOOTPRINT_MAX_M, default 500 m). The picking is a pure function over sanitized records; the reader re-validates every line and drops any that names another session. A session with no GPS fix yields no anchor. Nothing here logs a coordinate.
 */

import { promises as fs } from 'fs';
import { createChildLogger } from '@/shared/logger';
import { haversineM } from '@/shared/utils/geo';
import { CAPTURE_SESSION_ID_RE, sanitizeCaptureTelemetry, type CaptureTelemetryRecord } from './capture-telemetry';
import { captureTelemetryPath } from './scan-paths';

const logger = createChildLogger({ module: 'capture-anchor' });

/** @description Environment variable names the resolver reads. */
export const CAPTURE_ANCHOR_ENV = {
  footprintMinM: 'OSHAL_SPACES_CAPTURE_FOOTPRINT_MIN_M',
  footprintMaxM: 'OSHAL_SPACES_CAPTURE_FOOTPRINT_MAX_M',
} as const;

/** @description Defaults when the environment is silent: a room-scale floor and a cap against a stray fix. */
export const CAPTURE_ANCHOR_DEFAULTS = {
  footprintMinM: 10,
  footprintMaxM: 500,
} as const;

/** @description The resolved footprint bounds, metres. */
export interface CaptureAnchorLimits {
  footprintMinM: number;
  footprintMaxM: number;
}

/**
 * @description A scan's geodetic anchor as its capture session recorded it. Held in memory and
 * handed to the location kernel skill's anchorMap, which minimises it before anything is stored.
 */
export interface CaptureAnchor {
  /** Latitude of the most accurate fix, degrees. */
  lat: number;
  /** Longitude of the most accurate fix, degrees. */
  lon: number;
  /** That fix's reported accuracy, metres. */
  accuracyM: number;
  /** The compass heading the capture began with, degrees, or null when the phone reported none. */
  headingDeg: number | null;
  /** How far the capture extends from the origin, metres. */
  footprintRadiusM: number;
  /** When the origin fix was taken (never later than the server clock); ISO time. */
  capturedAt: string;
  /** How many GPS fixes the session recorded. */
  fixCount: number;
}

/**
 * @description Parse one positive-number knob; a missing value is the default, a malformed one is logged and defaulted.
 * @param name - The variable's name.
 * @param raw - Its raw value.
 * @param fallback - The default.
 * @returns The value in metres.
 */
function positiveMetres(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    logger.warn({ name, fallback }, 'ignoring a non-positive capture footprint bound; using the default');
    return fallback;
  }
  return value;
}

/**
 * @description Resolve the footprint bounds from the environment, read at the point of use. A cap
 * below the floor is raised to the floor.
 * @param env - The environment to read (defaults to process.env; tests pass an explicit object)
 * @returns The floor and the cap, metres
 */
export function resolveCaptureAnchorLimits(env: NodeJS.ProcessEnv = process.env): CaptureAnchorLimits {
  const footprintMinM = positiveMetres(CAPTURE_ANCHOR_ENV.footprintMinM, env[CAPTURE_ANCHOR_ENV.footprintMinM], CAPTURE_ANCHOR_DEFAULTS.footprintMinM);
  const cap = positiveMetres(CAPTURE_ANCHOR_ENV.footprintMaxM, env[CAPTURE_ANCHOR_ENV.footprintMaxM], CAPTURE_ANCHOR_DEFAULTS.footprintMaxM);
  return { footprintMinM, footprintMaxM: Math.max(cap, footprintMinM) };
}

/**
 * @description Turn a capture session's readings into the scan's anchor. The origin is the fix with
 * the smallest reported accuracy radius (the earliest of equals); the heading is the first one the
 * phone reported; the footprint is the farthest any fix lies from the origin, inside the bounds.
 * @param records - The session's sanitized readings, in the order they were recorded
 * @param limits - The footprint floor and cap
 * @param nowMs - The server clock; a client timestamp ahead of it is clamped to it
 * @returns The anchor, or null when the session recorded no GPS fix
 */
export function captureAnchorFromRecords(
  records: readonly CaptureTelemetryRecord[],
  limits: CaptureAnchorLimits = resolveCaptureAnchorLimits(),
  nowMs: number = Date.now(),
): CaptureAnchor | null {
  const fixes = records.filter((r) => r.gps !== null);
  if (fixes.length === 0) return null;
  const best = fixes.reduce((a, b) => {
    const [ga, gb] = [a.gps as NonNullable<CaptureTelemetryRecord['gps']>, b.gps as NonNullable<CaptureTelemetryRecord['gps']>];
    if (gb.accuracyM !== ga.accuracyM) return gb.accuracyM < ga.accuracyM ? b : a;
    return b.ts < a.ts ? b : a;
  });
  const origin = best.gps as NonNullable<CaptureTelemetryRecord['gps']>;
  const spread = fixes.reduce((far, r) => Math.max(far, haversineM(origin, r.gps as NonNullable<CaptureTelemetryRecord['gps']>)), 0);
  const heading = records.find((r) => r.headingDeg !== null)?.headingDeg ?? null;
  return {
    lat: origin.lat,
    lon: origin.lon,
    accuracyM: origin.accuracyM,
    headingDeg: heading,
    footprintRadiusM: Math.ceil(Math.min(limits.footprintMaxM, Math.max(limits.footprintMinM, spread))),
    capturedAt: new Date(Math.min(best.ts, nowMs)).toISOString(),
    fixCount: fixes.length,
  };
}

/**
 * @description Parse a session sidecar: one JSON reading per line, each re-validated, none from
 * another session. A line that does not parse is skipped.
 * @param text - The sidecar's content
 * @param sessionId - The session the sidecar belongs to
 * @returns The readings, in file order
 */
function parseSidecar(text: string, sessionId: string): CaptureTelemetryRecord[] {
  const out: CaptureTelemetryRecord[] = [];
  let skipped = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      skipped += 1;
      continue;
    }
    const record = sanitizeCaptureTelemetry(raw);
    if (record && record.sessionId === sessionId) out.push(record);
    else skipped += 1;
  }
  if (skipped > 0) logger.warn({ sessionId, skipped }, 'capture telemetry sidecar had unusable lines');
  return out;
}

/**
 * @description Read a capture session's anchor from its owner-scoped telemetry sidecar. The path is
 * keyed by the owner, so a session id names only that person's own session.
 * @param userSub - The capturer's sub
 * @param sessionId - The capture session id
 * @returns The anchor, or null when the id is malformed, the session left no sidecar or it holds no GPS fix
 */
export async function readCaptureAnchor(userSub: string, sessionId: string): Promise<CaptureAnchor | null> {
  if (!userSub || typeof sessionId !== 'string' || !CAPTURE_SESSION_ID_RE.test(sessionId)) return null;
  let text: string;
  try {
    text = await fs.readFile(captureTelemetryPath(userSub, sessionId), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      logger.debug({ sessionId }, 'capture session left no telemetry sidecar');
      return null;
    }
    logger.error({ err, sessionId }, 'capture telemetry sidecar could not be read');
    throw err;
  }
  const anchor = captureAnchorFromRecords(parseSidecar(text, sessionId));
  logger.info({ sessionId, fixCount: anchor?.fixCount ?? 0, anchored: anchor !== null }, 'capture session read for its anchor');
  return anchor;
}
