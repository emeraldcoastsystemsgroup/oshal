/**
 * Weather model — a probability distribution over Kalshi's temperature buckets.
 *
 * THE MECHANISM (why this could have an edge at all — the test every strategy here must pass):
 * The market already prices the NWS point forecast; reading it is worth nothing (verified
 * 2026-07-13: NWS said 94°F and Kalshi's modal bucket was 94–95° at 46%). What the market must
 * ALSO price is the forecast's UNCERTAINTY — the spread of realized highs around the forecast.
 * That is a genuinely harder object, it is not published, and it is where a real edge could live:
 *
 *     P(high lands in bucket B) = ∫_B  Normal(µ = NWS forecast, σ = forecast error) dx
 *
 * σ (and any bias in µ) come from the EMPIRICAL forecast-error distribution — collected forward,
 * per city, per lead time, conditioned on ENSO phase (see enso.ts for why ENSO belongs on the
 * ERROR and not on the forecast). Until enough pairs are logged, σ falls back to NWS's published
 * day-1 verification skill and the model is deliberately UNCONFIDENT — it must not trade on a
 * spread it hasn't measured.
 *
 * HONEST STATUS: the edge is UNPROVEN. This module makes a falsifiable, pre-registered claim; the
 * forward test grades it against settlements. If the market's implied spread is already correct,
 * this strategy earns nothing and should be retired — which is a perfectly good outcome.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — NWS station/grid map for Kalshi's high-temp cities, forecast fetch, Gaussian bucket distribution with an ENSO-conditioned error model (prior-backed until forward-collected pairs exist), and observed-high lookup for grading.
 *
 * @module prediction-markets/weather-model
 */

import { createChildLogger } from '@/shared/logger';
import type { EnsoPhase } from './enso';

const log = createChildLogger({ module: 'weather-model' });

/** NWS requires a contactable User-Agent; anonymous calls are rejected. */
const UA = process.env.NWS_USER_AGENT || 'OSHAL (maintainer@emeraldcoastsystemsgroup.com)';

/**
 * Kalshi high-temp series → the STATION the market actually settles on, with that station's real
 * coordinates.
 *
 * COORDINATES, NOT GRID CELLS (bug caught live 2026-07-13): an earlier version hard-coded NWS
 * grid indices. They were hand-guessed, and every one except NYC was WRONG — the "Los Angeles"
 * cell pointed inland and returned 86°F for a market that settles on coastal LAX (July highs
 * 76–77°F, exactly where the market priced it). That fabricated a +95¢ "edge" out of my own error.
 * Grid cells are now resolved from these coordinates by NWS itself, so there is no magic number
 * left to get wrong. The settling station matters absolutely: a market resolves on ONE thermometer
 * (Kalshi's settlement source is that station's NWS Climatological Report), so the forecast, the
 * grading, and the error model must all use that same station.
 */
export const WEATHER_CITIES: Record<string, { city: string; station: string; lat: number; lon: number }> = {
  KXHIGHNY:   { city: 'New York (Central Park)', station: 'KNYC', lat: 40.7789, lon: -73.9692 },
  KXHIGHCHI:  { city: 'Chicago (Midway)',        station: 'KMDW', lat: 41.7842, lon: -87.7553 },
  KXHIGHAUS:  { city: 'Austin (Camp Mabry)',     station: 'KATT', lat: 30.3208, lon: -97.7600 },
  KXHIGHLAX:  { city: 'Los Angeles (LAX)',       station: 'KLAX', lat: 33.9425, lon: -118.4081 },
  KXHIGHMIA:  { city: 'Miami (MIA)',             station: 'KMIA', lat: 25.7906, lon: -80.3164 },
  KXHIGHPHIL: { city: 'Philadelphia (PHL)',      station: 'KPHL', lat: 39.8721, lon: -75.2411 },
  KXHIGHOU:   { city: 'Houston (IAH)',           station: 'KIAH', lat: 29.9844, lon: -95.3414 },
  KXHIGHTBOS: { city: 'Boston (Logan)',          station: 'KBOS', lat: 42.3606, lon: -71.0097 },
  KXHIGHTPHX: { city: 'Phoenix (Sky Harbor)',    station: 'KPHX', lat: 33.4278, lon: -112.0039 },
  KXHIGHTSEA: { city: 'Seattle (SeaTac)',        station: 'KSEA', lat: 47.4444, lon: -122.3139 },
  KXHIGHTLV:  { city: 'Las Vegas (Harry Reid)',  station: 'KLAS', lat: 36.0800, lon: -115.1522 },
  KXHIGHTSATX:{ city: 'San Antonio',             station: 'KSAT', lat: 29.5337, lon: -98.4698 },
  KXHIGHTOKC: { city: 'Oklahoma City',           station: 'KOKC', lat: 35.3889, lon: -97.6008 },
};

/** Grid cells resolved by NWS from the station coordinates — never hand-entered. */
const gridCache = new Map<string, { office: string; gridX: number; gridY: number }>();

/**
 * @description Resolve a station's NWS forecast grid from its real coordinates (cached). This is
 * the authoritative mapping — hand-written grid indices are exactly the bug this replaces.
 * @param seriesTicker - Kalshi series.
 * @returns The NWS office + grid cell, or null when the city isn't mapped.
 */
export async function resolveGrid(seriesTicker: string): Promise<{ office: string; gridX: number; gridY: number } | null> {
  const c = WEATHER_CITIES[seriesTicker];
  if (!c) return null;
  const hit = gridCache.get(seriesTicker);
  if (hit) return hit;
  const res = await fetch(`https://api.weather.gov/points/${c.lat},${c.lon}`, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`NWS points lookup failed for ${seriesTicker}: HTTP ${res.status}`);
  const body = await res.json() as { properties?: { gridId?: string; gridX?: number; gridY?: number } };
  const p = body.properties || {};
  if (!p.gridId || typeof p.gridX !== 'number' || typeof p.gridY !== 'number') {
    throw new Error(`NWS points lookup returned no grid for ${seriesTicker}`);
  }
  const grid = { office: p.gridId, gridX: p.gridX, gridY: p.gridY };
  gridCache.set(seriesTicker, grid);
  log.info({ seriesTicker, station: c.station, ...grid }, 'NWS grid resolved from station coordinates');
  return grid;
}

/**
 * Prior forecast-error σ (°F) by lead time, from NWS's published max-temperature verification
 * skill. Used ONLY until enough forward-collected (forecast, actual) pairs exist to measure the
 * real thing per city + ENSO phase. Deliberately WIDE — an overconfident σ manufactures edge out
 * of thin air, which is the failure mode this whole project keeps catching.
 */
const PRIOR_SIGMA_F: Record<number, number> = { 0: 2.0, 1: 2.6, 2: 3.4, 3: 4.2 };

/** A measured error distribution for one (city, lead, ENSO phase) cell. */
export interface ErrorModel {
  /** Mean signed error (actual − forecast), °F. Non-zero = the forecast is biased. */
  bias: number;
  /** Standard deviation of the error, °F. */
  sigma: number;
  /** Forward-collected observations behind this cell. */
  n: number;
  /** True when this is the untested prior rather than a measured distribution. */
  isPrior: boolean;
  ensoPhase: EnsoPhase;
}

/** One (forecast, actual) observation — the raw material of the error model. */
export interface ForecastErrorSample {
  seriesTicker: string;
  leadDays: number;
  ensoPhase: EnsoPhase;
  forecastF: number;
  actualF: number;
}

/**
 * @description Build the forecast-error model for a (city, lead, ENSO) cell from
 * forward-collected samples, shrinking toward the prior when evidence is thin. With no samples it
 * returns the prior with `isPrior: true` — callers MUST treat that as "spread unmeasured" and
 * refuse to size a bet on it.
 * @param samples - All collected samples (filtered internally).
 * @param seriesTicker - Kalshi series, e.g. KXHIGHNY.
 * @param leadDays - Days between forecast and target date.
 * @param phase - Current ENSO phase.
 * @param minN - Samples required before the measured σ is trusted at all.
 * @returns The error model for that cell.
 */
export function buildErrorModel(
  samples: ForecastErrorSample[], seriesTicker: string, leadDays: number, phase: EnsoPhase, minN = 30,
): ErrorModel {
  const prior = PRIOR_SIGMA_F[leadDays] ?? 4.5;
  const cell = samples.filter((s) => s.seriesTicker === seriesTicker && s.leadDays === leadDays && s.ensoPhase === phase);
  if (cell.length < minN) {
    return { bias: 0, sigma: prior, n: cell.length, isPrior: true, ensoPhase: phase };
  }
  const errs = cell.map((s) => s.actualF - s.forecastF);
  const bias = errs.reduce((a, b) => a + b, 0) / errs.length;
  const variance = errs.reduce((a, e) => a + (e - bias) ** 2, 0) / (errs.length - 1);
  const measured = Math.sqrt(variance);
  // Shrink toward the prior so a thin-but-passing cell can't produce an absurdly tight σ.
  const w = cell.length / (cell.length + minN);
  return {
    bias: bias * w,
    sigma: measured * w + prior * (1 - w),
    n: cell.length,
    isPrior: false,
    ensoPhase: phase,
  };
}

/** Standard normal CDF (Abramowitz–Stegun 7.1.26 via erf). */
function normalCdf(x: number, mu: number, sigma: number): number {
  if (sigma <= 0) return x >= mu ? 1 : 0;
  const z = (x - mu) / (sigma * Math.SQRT2);
  // erf approximation, |ε| < 1.5e-7
  const t = 1 / (1 + 0.3275911 * Math.abs(z));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  const erf = z >= 0 ? y : -y;
  return 0.5 * (1 + erf);
}

/**
 * @description Probability that the realized high lands in [loF, hiF], under the model's Gaussian.
 * Kalshi buckets are INTEGER degrees ("94° to 95°"), so the continuity correction (±0.5°F) is
 * applied — without it every bucket probability is systematically wrong.
 * @param loF - Bucket lower bound in °F (inclusive), or null for an open lower end.
 * @param hiF - Bucket upper bound in °F (inclusive), or null for an open upper end.
 * @param forecastF - NWS forecast high.
 * @param model - The error model.
 * @returns Probability mass in the bucket.
 */
export function bucketProbability(loF: number | null, hiF: number | null, forecastF: number, model: ErrorModel): number {
  const mu = forecastF + model.bias;
  const lo = loF === null ? -Infinity : loF - 0.5;
  const hi = hiF === null ? Infinity : hiF + 0.5;
  const pLo = lo === -Infinity ? 0 : normalCdf(lo, mu, model.sigma);
  const pHi = hi === Infinity ? 1 : normalCdf(hi, mu, model.sigma);
  return Math.max(0, Math.min(1, pHi - pLo));
}

/**
 * @description The NWS forecast high (°F) for a city on a target date, plus the lead time.
 * Returns null when the date isn't in the forecast window.
 * @param seriesTicker - Kalshi series (must be in WEATHER_CITIES).
 * @param targetDateIso - Target calendar date, 'YYYY-MM-DD' in the city's local sense.
 * @returns Forecast + lead days, or null.
 */
export async function getForecastHigh(seriesTicker: string, targetDateIso: string): Promise<{ forecastF: number; leadDays: number } | null> {
  const grid = await resolveGrid(seriesTicker);
  if (!grid) return null;
  const res = await fetch(`https://api.weather.gov/gridpoints/${grid.office}/${grid.gridX},${grid.gridY}/forecast`, {
    headers: { 'User-Agent': UA },
  });
  if (!res.ok) throw new Error(`NWS forecast ${seriesTicker} failed: HTTP ${res.status}`);
  const body = await res.json() as { properties?: { periods?: { startTime?: string; isDaytime?: boolean; temperature?: number }[] } };
  // Daytime period on the target date == that date's forecast HIGH (what these markets settle on).
  const period = (body.properties?.periods || []).find(
    (p) => p.isDaytime && typeof p.startTime === 'string' && p.startTime.slice(0, 10) === targetDateIso,
  );
  if (!period || typeof period.temperature !== 'number') return null;
  const leadDays = Math.max(0, Math.round(
    (Date.parse(`${targetDateIso}T12:00:00Z`) - Date.now()) / 86_400_000,
  ));
  return { forecastF: period.temperature, leadDays };
}

/**
 * @description The OBSERVED high (°F) at the market's settling station for a date — the ground
 * truth for grading and for growing the error model. Reads the station's observation history and
 * takes the max over the local calendar day.
 * @param seriesTicker - Kalshi series.
 * @param dateIso - Calendar date 'YYYY-MM-DD'.
 * @returns Observed high in °F, or null when observations are unavailable.
 */
export async function getObservedHigh(seriesTicker: string, dateIso: string): Promise<number | null> {
  const c = WEATHER_CITIES[seriesTicker];
  if (!c) return null;
  const start = `${dateIso}T00:00:00Z`;
  const end = `${dateIso}T23:59:59Z`;
  const res = await fetch(
    `https://api.weather.gov/stations/${c.station}/observations?start=${start}&end=${end}&limit=200`,
    { headers: { 'User-Agent': UA } },
  );
  if (!res.ok) {
    log.error({ seriesTicker, dateIso, status: res.status }, 'NWS observation fetch failed');
    return null;
  }
  const body = await res.json() as { features?: { properties?: { temperature?: { value?: number | null } } }[] };
  const tempsF = (body.features || [])
    .map((f) => f.properties?.temperature?.value)
    .filter((v): v is number => typeof v === 'number')
    .map((c2) => (c2 * 9) / 5 + 32);
  if (!tempsF.length) return null;
  return Math.max(...tempsF);
}
