/**
 * ENSO (El Niño / La Niña) phase — from NOAA's official Oceanic Niño Index.
 *
 * WHERE ENSO DOES *NOT* BELONG (operator ask 2026-07-13, and the honest answer):
 * ENSO is a SEASONAL boundary condition. It shifts multi-month climate distributions; it does not
 * predict tomorrow's high temperature. A 24–48h NWS forecast is dominated by synoptic-scale
 * dynamics the model already resolves, and whatever ENSO has done to the atmosphere is ALREADY
 * embedded in the observed initial state the forecast is built from. Adding an ENSO term on top of
 * a next-day point forecast would double-count it and inject noise — the exact "edge with no
 * mechanism" that this project keeps falsifying.
 *
 * WHERE IT *DOES* BELONG (what this module is for):
 * The tradeable question is not "what will the temperature be" (the market already prices the NWS
 * forecast — verified 2026-07-13: NWS 94°F vs Kalshi's modal 94–95° bucket at 46%). It is "HOW
 * WRONG is the forecast, and is that error biased right now?" ENSO is a legitimate CONDITIONING
 * VARIABLE on the forecast-error distribution: forecast bias and spread can differ systematically
 * between El Niño, Neutral, and La Niña regimes. That is a testable mechanism — so ENSO enters the
 * model here, as a key into the error model, never as an additive fudge on the forecast itself.
 *
 * Source: NOAA CPC ONI (3-month running mean of ERSST anomalies in the Niño 3.4 region).
 * Convention: ONI ≥ +0.5 = El Niño, ≤ −0.5 = La Niña, otherwise Neutral.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — ONI fetch + phase classification, cached daily. Documents why ENSO conditions the ERROR model rather than the point forecast.
 *
 * @module prediction-markets/enso
 */

import { createChildLogger } from '@/shared/logger';

const log = createChildLogger({ module: 'enso' });

const ONI_URL = 'https://www.cpc.ncep.noaa.gov/data/indices/oni.ascii.txt';
/** NOAA's own thresholds for the index. */
const EL_NINO_THRESHOLD = 0.5;
const LA_NINA_THRESHOLD = -0.5;

/** ENSO regime — the key the forecast-error model is conditioned on. */
export type EnsoPhase = 'el-nino' | 'neutral' | 'la-nina';

/** The current index reading and the regime it implies. */
export interface EnsoState {
  phase: EnsoPhase;
  /** Latest ONI value (°C anomaly in the Niño 3.4 region). */
  oni: number;
  /** The 3-month season the reading covers, e.g. 'AMJ'. */
  season: string;
  year: number;
}

let cache: { at: number; state: EnsoState } | null = null;
/** ONI updates monthly — a day's cache is generous. */
const TTL_MS = 24 * 60 * 60 * 1000;

/**
 * @description Classify an ONI value into its NOAA regime.
 * @param oni - Oceanic Niño Index value.
 * @returns The ENSO phase.
 */
export function classifyOni(oni: number): EnsoPhase {
  if (oni >= EL_NINO_THRESHOLD) return 'el-nino';
  if (oni <= LA_NINA_THRESHOLD) return 'la-nina';
  return 'neutral';
}

/**
 * @description Current ENSO state from NOAA's ONI feed (cached daily). On any fetch/parse failure
 * this returns NEUTRAL rather than throwing: an unavailable climate index must degrade the error
 * model to its unconditioned form, never take the trading loop down.
 * @returns The current ENSO state.
 */
export async function getEnsoState(): Promise<EnsoState> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.state;
  try {
    const res = await fetch(ONI_URL);
    if (!res.ok) throw new Error(`ONI fetch failed: HTTP ${res.status}`);
    const text = await res.text();
    // Columns: SEAS YR TOTAL ANOM  — the last data row is the most recent season.
    const rows = text.trim().split('\n').slice(1)
      .map((l) => l.trim().split(/\s+/))
      .filter((c) => c.length >= 4 && Number.isFinite(parseFloat(c[3])));
    const last = rows[rows.length - 1];
    if (!last) throw new Error('ONI feed had no parseable rows');
    const oni = parseFloat(last[3]);
    const state: EnsoState = { phase: classifyOni(oni), oni, season: last[0], year: parseInt(last[1], 10) };
    cache = { at: Date.now(), state };
    log.info({ phase: state.phase, oni, season: state.season, year: state.year }, 'ENSO state resolved');
    return state;
  } catch (err) {
    log.error({ err }, 'ENSO fetch failed — falling back to neutral (error model runs unconditioned)');
    return { phase: 'neutral', oni: 0, season: 'unknown', year: new Date().getUTCFullYear() };
  }
}
