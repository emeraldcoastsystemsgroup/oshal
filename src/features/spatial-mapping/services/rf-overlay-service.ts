/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-111 increment B — the RF/router coverage overlay service. Owner-scoped: given a ready scan's persisted poses + splat and a set of RSSI samples (uploaded, or synthesized in demo mode), it multilaterates the transmitter(s) and paints a coverage overlay = the room splat dimmed + one heat gaussian per sample (red weak -> green strong) + a bright marker at each estimated router. Results are on-disk sidecars (rf-overlay.splat / rf-summary.json / rf-samples.json) next to the scan — no DB column. RF is an OVERLAY on the video/LiDAR geometry, never geometry itself; the honesty note ships in every summary.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Audit fixes: (1) uploaded samples are now validated (finite rssiDbm; position a 3-vector of finite numbers; integer keyframeIndex) — a malformed body NaN-poisoned the LM fit and PERSISTED corrupt sidecars (Math.max(0.1, NaN) is NaN, defeating the distance clamp). (2) Transmitter placement now needs >=4 samples per bssid: the fit solves FOUR unknowns (x,y,z,txPower), so 3 samples is underdetermined — an arbitrary point on a solution manifold reported with rmse~0 false confidence. (3) Expected-input failures throw the typed RfInputError so the route can 400 them without leaking internal error text on real 500s.
 */

import type { Pool } from 'pg';
import { promises as fs, existsSync } from 'fs';
import { createChildLogger } from '@/shared/logger';
import type { ScanPoses } from '../model/pose-types';
import type { RfSample, TransmitterEstimate, RfCoverageStats, RfOverlayResult } from '../model/rf-types';
import { packSplat, type Gaussian } from './splat-format';
import { estimateTransmitter, syntheticRssi, DEAD_ZONE_DBM, DEFAULT_PATH_LOSS_EXP } from './rf-model';
import { SpatialScanStore } from './spatial-scan-store';
import { artifactPath, posesPath, rfOverlayPath, rfSamplesPath, rfSummaryPath } from './scan-paths';

const logger = createChildLogger({ module: 'rf-overlay-service' });
const STRIDE = 32;
const OVERLAY_NOTE =
  'RF coverage is a room-level OVERLAY on the video/LiDAR-built geometry — not geometry itself, and not centimetre-accurate (RSSI ceiling; small rooms defeat ranging via multipath).';

/** The fit solves 4 unknowns (x, y, z, txPower) — fewer samples is underdetermined
 *  and reports an arbitrary point with rmse~0 false confidence. */
export const MIN_TX_SAMPLES = 4;

type Vec3 = [number, number, number];

/**
 * @description Thrown for EXPECTED bad input (unusable samples, missing poses) so
 * the route can 400 with the message; anything else is an internal 500.
 */
export class RfInputError extends Error {}

const isVec3 = (v: unknown): v is Vec3 =>
  Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n));

/**
 * @description Drop malformed uploaded samples (NaN / wrong shapes) BEFORE they
 * can poison the fit or be persisted into the sidecars — Math.max(0.1, NaN) is
 * NaN, so one bad sample would otherwise corrupt every downstream number.
 * @param samples - The untrusted request-body array
 * @returns Only the structurally-valid samples
 */
export function sanitizeRfSamples(samples: unknown[]): RfSample[] {
  const out: RfSample[] = [];
  for (const raw of samples) {
    const s = raw as Partial<RfSample> | null;
    const ok =
      s !== null && typeof s === 'object' &&
      typeof s.rssiDbm === 'number' && Number.isFinite(s.rssiDbm) &&
      (s.position == null || isVec3(s.position)) &&
      (s.keyframeIndex == null || (Number.isInteger(s.keyframeIndex) && (s.keyframeIndex as number) >= 0)) &&
      (s.bssid == null || typeof s.bssid === 'string') &&
      (s.ssid == null || typeof s.ssid === 'string');
    if (ok) out.push(s as RfSample);
  }
  return out;
}

/** @description RSSI (dBm) -> a red(weak)->yellow->green(strong) colour. */
export function coverageColor(rssi: number): [number, number, number] {
  const t = Math.max(0, Math.min(1, (rssi - -85) / (-40 - -85)));
  const lerp = (a: number, b: number, u: number): number => a + (b - a) * u;
  if (t < 0.5) return [lerp(210, 230, t * 2), lerp(60, 200, t * 2), lerp(50, 60, t * 2)];
  return [lerp(230, 70, (t - 0.5) * 2), lerp(200, 200, (t - 0.5) * 2), lerp(60, 100, (t - 0.5) * 2)];
}

/** @description Desaturate + fade a room .splat so the RF layer reads on top of it. */
export function dimSplat(room: Buffer): Buffer {
  const out = Buffer.from(room);
  for (let o = 0; o + STRIDE <= out.length; o += STRIDE) {
    for (let c = 24; c < 27; c++) out[o + c] = Math.round(out[o + c] * 0.4 + 128 * 0.6);
    out[o + 27] = 110; // lower alpha
  }
  return out;
}

/** Small deterministic sphere of offsets so a transmitter marker reads as a blob. */
const MARKER_OFFSETS: Vec3[] = [
  [0, 0, 0], [0.08, 0, 0], [-0.08, 0, 0], [0, 0.08, 0], [0, -0.08, 0],
  [0, 0, 0.08], [0, 0, -0.08], [0.05, 0.05, 0.05], [-0.05, -0.05, 0.05], [0.05, -0.05, -0.05],
];

/**
 * @description Build the overlay .splat: dimmed room + a coverage-coloured heat
 * gaussian per sample + a bright marker cluster at each transmitter.
 * @param room - The scan's room .splat bytes
 * @param pos - Sample positions
 * @param rssi - RSSI at each sample
 * @param transmitters - Estimated transmitter positions
 * @returns The packed overlay buffer + gaussian count
 */
export function buildOverlaySplat(
  room: Buffer, pos: Vec3[], rssi: number[], transmitters: Vec3[],
): { buffer: Buffer; count: number } {
  const heat: Gaussian[] = pos.map((p, i) => ({
    pos: p, scale: [0.07, 0.07, 0.07], color: [...coverageColor(rssi[i]), 235] as [number, number, number, number],
  }));
  const markers: Gaussian[] = transmitters.flatMap((t) =>
    MARKER_OFFSETS.map((d) => ({
      pos: [t[0] + d[0], t[1] + d[1], t[2] + d[2]] as Vec3,
      scale: [0.05, 0.05, 0.05] as Vec3,
      color: [80, 180, 255, 255] as [number, number, number, number],
    })),
  );
  const buffer = Buffer.concat([dimSplat(room), packSplat([...heat, ...markers])]);
  return { buffer, count: Math.floor(buffer.length / STRIDE) };
}

/** One resolved sample: a world position + its reading + which transmitter it belongs to. */
interface Resolved { pos: Vec3; rssi: number; bssid: string; ssid: string | null }

/**
 * @description The spaces-operator's RF overlay domain service. Owner-scoped —
 * every method verifies the caller owns the scan before touching its files.
 */
export class RfOverlayService {
  private readonly store: SpatialScanStore;

  constructor(pool: Pool) {
    this.store = new SpatialScanStore(pool);
  }

  /**
   * @description Compute + persist the RF coverage overlay for a scan.
   * @param userSub - Owning user's sub
   * @param scanId - Scan id
   * @param opts - Uploaded `samples`, or `demo` to synthesize from a placed router
   * @returns The overlay result, or null if the scan isn't ready/owned
   */
  async computeOverlay(
    userSub: string, scanId: string, opts: { samples?: RfSample[]; demo?: boolean },
  ): Promise<RfOverlayResult | null> {
    const scan = await this.store.getById(userSub, scanId);
    if (!scan || scan.status !== 'ready') return null;
    const poses = await this.readPoses(userSub, scanId);
    const rawSamples = opts.demo ? this.demoSamples(poses) : this.sanitize(opts.samples ?? []);
    const resolved = this.resolve(rawSamples, poses);
    if (resolved.length === 0) {
      throw new RfInputError('no valid RF samples with a resolvable position (need finite rssiDbm + explicit [x,y,z] positions, or poses + keyframeIndex)');
    }
    const transmitters = this.localize(resolved);
    const result = this.summarize(scanId, resolved, transmitters);
    const room = await fs.readFile(artifactPath(userSub, scanId));
    const overlay = buildOverlaySplat(
      room, resolved.map((r) => r.pos), resolved.map((r) => r.rssi), transmitters.map((t) => t.position),
    );
    result.gaussianCount = overlay.count;
    await Promise.all([
      fs.writeFile(rfOverlayPath(userSub, scanId), overlay.buffer),
      fs.writeFile(rfSummaryPath(userSub, scanId), JSON.stringify(result)),
      fs.writeFile(rfSamplesPath(userSub, scanId), JSON.stringify(rawSamples)),
    ]);
    logger.info({ scanId, samples: resolved.length, transmitters: transmitters.length }, 'rf overlay computed');
    return result;
  }

  /** The overlay .splat path if the caller owns a ready scan that has one. */
  async getOverlayPath(userSub: string, scanId: string): Promise<string | null> {
    return this.readyFile(userSub, scanId, rfOverlayPath(userSub, scanId));
  }

  /** The overlay summary path if present + owned. */
  async getSummaryPath(userSub: string, scanId: string): Promise<string | null> {
    return this.readyFile(userSub, scanId, rfSummaryPath(userSub, scanId));
  }

  private async readyFile(userSub: string, scanId: string, p: string): Promise<string | null> {
    const scan = await this.store.getById(userSub, scanId);
    if (!scan || scan.status !== 'ready' || !existsSync(p)) return null;
    return p;
  }

  private async readPoses(userSub: string, scanId: string): Promise<ScanPoses | null> {
    const p = posesPath(userSub, scanId);
    if (!existsSync(p)) return null;
    try {
      return JSON.parse(await fs.readFile(p, 'utf8')) as ScanPoses;
    } catch (err) {
      logger.warn({ err, scanId }, 'poses.json unreadable — RF samples must carry explicit positions');
      return null;
    }
  }

  /** Validate uploads via the pure sanitizer, logging what was dropped. */
  private sanitize(samples: unknown[]): RfSample[] {
    const out = sanitizeRfSamples(samples);
    if (out.length < samples.length) {
      logger.warn({ dropped: samples.length - out.length, kept: out.length }, 'rf samples dropped by validation');
    }
    return out;
  }

  /** Resolve each sample to a world position (explicit, or via keyframe index). */
  private resolve(samples: RfSample[], poses: ScanPoses | null): Resolved[] {
    const out: Resolved[] = [];
    for (const s of samples) {
      const pos = s.position ?? (s.keyframeIndex != null ? poses?.keyframes[s.keyframeIndex]?.center : undefined);
      if (!pos) continue;
      out.push({ pos: pos as Vec3, rssi: s.rssiDbm, bssid: s.bssid ?? 'unknown', ssid: s.ssid ?? null });
    }
    return out;
  }

  /** Multilaterate one transmitter per bssid group that has enough samples. */
  private localize(resolved: Resolved[]): TransmitterEstimate[] {
    const groups = new Map<string, Resolved[]>();
    for (const r of resolved) {
      const arr = groups.get(r.bssid);
      if (arr) arr.push(r); else groups.set(r.bssid, [r]);
    }
    const out: TransmitterEstimate[] = [];
    for (const [bssid, g] of groups) {
      if (g.length < MIN_TX_SAMPLES) continue; // 4 unknowns — fewer is underdetermined (rmse~0 lies)
      const fit = estimateTransmitter(g.map((r) => r.pos), g.map((r) => r.rssi), DEFAULT_PATH_LOSS_EXP);
      out.push({
        bssid: bssid === 'unknown' ? null : bssid, ssid: g[0].ssid, position: fit.position,
        txPowerDbm: Math.round(fit.txPowerDbm * 10) / 10, pathLossExp: DEFAULT_PATH_LOSS_EXP,
        sampleCount: g.length, rmseDb: Math.round(fit.rmseDb * 100) / 100,
      });
    }
    return out;
  }

  /** Assemble the coverage stats + result envelope. */
  private summarize(scanId: string, resolved: Resolved[], transmitters: TransmitterEstimate[]): RfOverlayResult {
    const rssi = resolved.map((r) => r.rssi);
    const dead = rssi.filter((v) => v <= DEAD_ZONE_DBM).length;
    const coverage: RfCoverageStats = {
      minDbm: Math.min(...rssi), maxDbm: Math.max(...rssi),
      meanDbm: Math.round((rssi.reduce((a, b) => a + b, 0) / rssi.length) * 10) / 10,
      deadZoneFraction: Math.round((dead / rssi.length) * 100) / 100,
    };
    return { scanId, transmitters, coverage, sampleCount: resolved.length, gaussianCount: 0, note: OVERLAY_NOTE };
  }

  /** Synthesize samples at each keyframe from a router placed above the scene. */
  private demoSamples(poses: ScanPoses | null): RfSample[] {
    if (!poses || poses.keyframes.length === 0) {
      throw new RfInputError('demo mode needs poses — reconstruct with the box (poses.json) or upload explicit-position samples');
    }
    const centers = poses.keyframes.map((k) => k.center);
    const cx = centers.reduce((a, c) => a + c[0], 0) / centers.length;
    const cz = centers.reduce((a, c) => a + c[2], 0) / centers.length;
    const maxY = Math.max(...centers.map((c) => c[1]));
    const tx: Vec3 = [cx + 0.8, maxY + 0.4, cz + 0.8]; // a router up in a corner
    const jitter = (i: number): number => ((i * 2654435761) % 1000) / 1000 * 3 - 1.5; // deterministic +/-1.5 dB
    const rssi = syntheticRssi(centers, tx, -30, DEFAULT_PATH_LOSS_EXP, jitter);
    return centers.map((c, i) => ({ bssid: 'demo-router', ssid: 'OSHAL-Demo', rssiDbm: rssi[i], position: c }));
  }
}
