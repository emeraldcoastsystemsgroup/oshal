/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-111 live guided capture v1 — the phone-sensor telemetry contract. During a guided capture session the phone posts periodic readings (compass heading, cumulative pan sweep, detected steps, optional GPS) keyed by a client-minted session UUID; the server appends them to an owner-scoped JSONL sidecar. This is the sensor data path the operator asked for — and the record shape is deliberately actuator-agnostic: heading + translation progress + position is exactly the state a drone's companion computer would report into the same guidance loop later. Pure sanitizer (untrusted body -> typed record or null) so the route stays thin and the validation is unit-guarded.
 */

/** One phone-sensor reading posted during a live guided capture session. */
export interface CaptureTelemetryRecord {
  /** Client-minted session UUID (also the sidecar file key — strictly validated). */
  sessionId: string;
  /** Which capture-plan step was active (0-based). */
  step: number;
  /** Compass heading, degrees 0-360 (deviceorientation alpha, best-effort). */
  headingDeg: number | null;
  /** Cumulative pan sweep this step, degrees. */
  sweepDeg: number | null;
  /** Steps detected this plan-step (devicemotion peak counting). */
  steps: number | null;
  /** Optional GPS fix — honest note: useless indoors (±5-20 m); outdoor facades only. */
  gps: { lat: number; lon: number; accuracyM: number } | null;
  /** Client timestamp, ms epoch. */
  ts: number;
}

/** Strict UUID gate — the session id becomes part of a filename, so nothing else passes. */
export const CAPTURE_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Cap per-session sidecar growth (a reading every ~2s for an hour is ~350KB). */
export const CAPTURE_TELEMETRY_MAX_BYTES = 1024 * 1024;

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * @description Validate an untrusted telemetry body into a typed record, or null.
 * Every numeric field must be finite (the RF-overlay NaN lesson applies here too);
 * the session id must be a strict UUID because it keys an on-disk filename.
 * @param raw - The request body
 * @returns The sanitized record, or null when unusable
 */
export function sanitizeCaptureTelemetry(raw: unknown): CaptureTelemetryRecord | null {
  const b = raw as Partial<CaptureTelemetryRecord> | null;
  if (!b || typeof b !== 'object') return null;
  if (typeof b.sessionId !== 'string' || !CAPTURE_SESSION_ID_RE.test(b.sessionId)) return null;
  if (!num(b.step) || !Number.isInteger(b.step) || b.step < 0 || b.step > 999) return null;
  if (!num(b.ts) || b.ts <= 0) return null;
  const heading = num(b.headingDeg) && b.headingDeg >= 0 && b.headingDeg < 360 ? b.headingDeg : null;
  const sweep = num(b.sweepDeg) && b.sweepDeg >= 0 && b.sweepDeg < 100_000 ? b.sweepDeg : null;
  const steps = num(b.steps) && Number.isInteger(b.steps) && b.steps >= 0 && b.steps < 100_000 ? b.steps : null;
  let gps: CaptureTelemetryRecord['gps'] = null;
  const g = b.gps as { lat?: unknown; lon?: unknown; accuracyM?: unknown } | null | undefined;
  if (g && typeof g === 'object' && num(g.lat) && num(g.lon) && num(g.accuracyM)
      && Math.abs(g.lat) <= 90 && Math.abs(g.lon) <= 180 && g.accuracyM >= 0) {
    gps = { lat: g.lat, lon: g.lon, accuracyM: g.accuracyM };
  }
  return { sessionId: b.sessionId, step: b.step, headingDeg: heading, sweepDeg: sweep, steps, gps, ts: b.ts };
}
