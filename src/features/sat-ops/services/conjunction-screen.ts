/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — Sat-Ops (ADR-102) W3:
 *                     |                             | pairwise SGP4 conjunction screening for the fleet
 *                     |                             | plane. Coarse sweep propagates each sat ONCE per
 *                     |                             | epoch (positions cached across pairs — N·samples SGP4
 *                     |                             | evals, not N²·samples), pairwise range is vector math,
 *                     |                             | golden-section refines each local minimum to sub-second
 *                     |                             | TCA. Deterministic (caller supplies startUtcMs) and
 *                     |                             | bounded (SCREEN_LIMITS). This is a screening aid for a
 *                     |                             | SIM fleet — not an operational CA product; no covariance,
 *                     |                             | no Pc, TEME point geometry only.
 */

import * as satellite from 'satellite.js';
import { createChildLogger } from '@/shared/logger';
import type { ConjunctionEvent, ConjunctionOptions, ConjunctionReport } from '../model/orbit-types';
import type { ParsedTle } from './tle-parse';
import { PropagationError } from './pass-windows';

const logger = createChildLogger({ module: 'sat-ops:conjunction' });

const GOLDEN = (Math.sqrt(5) - 1) / 2;
const REFINE_TOL_S = 0.5;
const MAX_UTC_MS = 4_102_444_800_000; // year-2100 guard

/** Defaults applied when {@link ConjunctionOptions} omit a field. */
export const SCREEN_DEFAULTS = { horizonHours: 24, stepSeconds: 60, thresholdKm: 25 } as const;

/** Hard input limits — the CPU-DoS defense. Relaxing any of these is a reviewed change. */
export const SCREEN_LIMITS = {
  horizonHoursMax: 72,
  stepSecondsMin: 5,
  stepSecondsMax: 300,
  maxEntries: 16,
  maxCoarseSamples: 5_000,
  maxEventsPerPair: 10,
} as const;

interface Vec3Km { x: number; y: number; z: number }

/** One screened element set. */
export interface ScreenEntry {
  id: string;
  tle: ParsedTle;
}

/** Validate + resolve options. Throws plain Error → 400 at the route. */
function resolveScreenOptions(entries: ScreenEntry[], opts: ConjunctionOptions): { horizonS: number; stepS: number; thresholdKm: number; horizonHours: number } {
  if (entries.length < 2) throw new Error(`conjunction screening needs at least 2 entries, got ${entries.length}`);
  if (entries.length > SCREEN_LIMITS.maxEntries) throw new Error(`at most ${SCREEN_LIMITS.maxEntries} entries per screening, got ${entries.length}`);
  const ids = new Set(entries.map((e) => e.id));
  if (ids.size !== entries.length) throw new Error('duplicate entry ids in screening set');
  if (!(Number.isFinite(opts.startUtcMs) && opts.startUtcMs >= 0 && opts.startUtcMs <= MAX_UTC_MS)) {
    throw new Error(`startUtcMs out of range: ${opts.startUtcMs}`);
  }
  const horizonHours = opts.horizonHours ?? SCREEN_DEFAULTS.horizonHours;
  if (!(horizonHours > 0 && horizonHours <= SCREEN_LIMITS.horizonHoursMax)) {
    throw new Error(`horizonHours must be in (0, ${SCREEN_LIMITS.horizonHoursMax}], got ${horizonHours}`);
  }
  const reqStep = opts.stepSeconds ?? SCREEN_DEFAULTS.stepSeconds;
  if (!(reqStep >= SCREEN_LIMITS.stepSecondsMin && reqStep <= SCREEN_LIMITS.stepSecondsMax)) {
    throw new Error(`stepSeconds must be in [${SCREEN_LIMITS.stepSecondsMin}, ${SCREEN_LIMITS.stepSecondsMax}], got ${reqStep}`);
  }
  const thresholdKm = opts.thresholdKm ?? SCREEN_DEFAULTS.thresholdKm;
  if (!(thresholdKm > 0 && thresholdKm <= 1000)) throw new Error(`thresholdKm must be in (0, 1000], got ${thresholdKm}`);
  const horizonS = horizonHours * 3600;
  const stepS = Math.max(reqStep, horizonS / SCREEN_LIMITS.maxCoarseSamples);
  return { horizonS, stepS, thresholdKm, horizonHours };
}

/** Propagate one satrec to an epoch (km, TEME). Throws {@link PropagationError} on failure. */
function positionAt(satrec: satellite.SatRec, id: string, tUtcMs: number): Vec3Km {
  const pv = satellite.propagate(satrec, new Date(tUtcMs));
  if (!pv || pv.position === false || typeof pv.position === 'boolean' || satrec.error !== 0) {
    throw new PropagationError(`SGP4 failed for "${id}" at ${new Date(tUtcMs).toISOString()} (satrec.error=${satrec.error})`);
  }
  return pv.position;
}

function rangeKm(a: Vec3Km, b: Vec3Km): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** Golden-section minimize pair range on [loS, hiS] (seconds past start); returns argmin. */
function refineTca(range: (tS: number) => number, loS: number, hiS: number): number {
  let a = loS;
  let b = hiS;
  let c = b - GOLDEN * (b - a);
  let d = a + GOLDEN * (b - a);
  let fc = range(c);
  let fd = range(d);
  while (b - a > REFINE_TOL_S) {
    if (fc <= fd) {
      b = d; d = c; fd = fc;
      c = b - GOLDEN * (b - a); fc = range(c);
    } else {
      a = c; c = d; fc = fd;
      d = a + GOLDEN * (b - a); fd = range(d);
    }
  }
  return (a + b) / 2;
}

/**
 * @description Screen every pair in a fleet element-set list for close approaches inside the
 * horizon. Coarse sweep with per-epoch position caching (N·samples SGP4 evaluations, pairwise
 * distances are vector math), then golden-section TCA refinement of each local range minimum;
 * events keep only refined misses at or under the threshold, capped per pair and sorted by
 * miss distance. Deterministic and bounded ({@link SCREEN_LIMITS}). Screening aid for the SIM
 * fleet — point geometry in TEME, no covariance, no collision probability.
 * @param entries - The {id, tle} sets to screen (2–16).
 * @param opts - Horizon + cadence + threshold; `startUtcMs` is required.
 * @returns The report, events ascending by missKm.
 */
export function screenConjunctions(entries: ScreenEntry[], opts: ConjunctionOptions): ConjunctionReport {
  const { horizonS, stepS, thresholdKm, horizonHours } = resolveScreenOptions(entries, opts);
  const satrecs = entries.map((e) => {
    const satrec = satellite.twoline2satrec(e.tle.line1, e.tle.line2);
    if (satrec.error !== 0) throw new PropagationError(`satellite.js rejected the element set for "${e.id}" (satrec.error=${satrec.error})`);
    return satrec;
  });

  // Coarse sweep: one propagation per sat per epoch, shared across every pair.
  const epochs: number[] = [];
  for (let t = 0; t <= horizonS + 1e-9; t += stepS) epochs.push(Math.min(t, horizonS));
  const positions: Vec3Km[][] = entries.map((e, i) => epochs.map((tS) => positionAt(satrecs[i], e.id, opts.startUtcMs + tS * 1000)));

  const events: ConjunctionEvent[] = [];
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const ranges = epochs.map((_, k) => rangeKm(positions[i][k], positions[j][k]));
      const pairRange = (tS: number): number =>
        rangeKm(positionAt(satrecs[i], entries[i].id, opts.startUtcMs + tS * 1000), positionAt(satrecs[j], entries[j].id, opts.startUtcMs + tS * 1000));
      let pairEvents = 0;
      for (let k = 1; k < ranges.length - 1 && pairEvents < SCREEN_LIMITS.maxEventsPerPair; k++) {
        const isLocalMin = ranges[k] <= ranges[k - 1] && ranges[k] <= ranges[k + 1];
        // Only refine minima that could plausibly dip under threshold: the range can change by
        // at most ~2·v_rel·step between samples; 16 km/s relative is the LEO worst case.
        const couldDip = ranges[k] <= thresholdKm + 2 * 16 * stepS;
        if (!isLocalMin || !couldDip) continue;
        const tcaS = refineTca(pairRange, epochs[k - 1], epochs[k + 1]);
        const missKm = pairRange(tcaS);
        if (missKm > thresholdKm) continue;
        // Radial range-rate vanishes at TCA by definition — measure the relative SPEED from
        // the relative-position delta across ±1 s.
        const dtS = 1;
        const pA1 = positionAt(satrecs[i], entries[i].id, opts.startUtcMs + (tcaS - dtS) * 1000);
        const pB1 = positionAt(satrecs[j], entries[j].id, opts.startUtcMs + (tcaS - dtS) * 1000);
        const pA2 = positionAt(satrecs[i], entries[i].id, opts.startUtcMs + (tcaS + dtS) * 1000);
        const pB2 = positionAt(satrecs[j], entries[j].id, opts.startUtcMs + (tcaS + dtS) * 1000);
        const rel1 = { x: pA1.x - pB1.x, y: pA1.y - pB1.y, z: pA1.z - pB1.z };
        const rel2 = { x: pA2.x - pB2.x, y: pA2.y - pB2.y, z: pA2.z - pB2.z };
        const relSpeedKmS = Math.hypot(rel2.x - rel1.x, rel2.y - rel1.y, rel2.z - rel1.z) / (2 * dtS);
        events.push({
          aId: entries[i].id,
          bId: entries[j].id,
          tcaUtcMs: opts.startUtcMs + tcaS * 1000,
          missKm,
          relSpeedKmS,
        });
        pairEvents++;
      }
    }
  }
  events.sort((a, b) => a.missKm - b.missKm);
  logger.info({ entries: entries.length, epochs: epochs.length, events: events.length }, 'conjunction screening done');
  return {
    startUtcMs: opts.startUtcMs,
    horizonHours,
    stepSeconds: stepS,
    thresholdKm,
    screenedIds: entries.map((e) => e.id),
    events,
  };
}
