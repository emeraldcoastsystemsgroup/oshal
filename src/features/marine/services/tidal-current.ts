/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — marine slice W1: harmonic tidal
 *                     |                             | current model. Constituent periods are astronomical
 *                     |                             | constants, which is the whole reason a tidal node can be
 *                     |                             | designed to a worst case: the neap minimum is CALCULABLE
 *                     |                             | decades ahead, unlike any solar or wind minimum.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | longestSlackHours is now a thin wrapper over the extracted
 *                     |                             | @/shared/energy longestGapHours. It keeps scanning in m/s
 *                     |                             | against a cut-in SPEED — the scan is unit-agnostic, and
 *                     |                             | thresholding the pre-cube speed is exactly equivalent to
 *                     |                             | thresholding the watts it produces, but far cheaper.
 */

import { longestGapHours } from '@/shared/energy';
import { createChildLogger } from '@/shared/logger';
import type { TidalConstituent, TidalSiteConfig } from '../model/marine-types';

const logger = createChildLogger({ module: 'marine:tidal-current' });

/**
 * @description Periods of the standard tidal constituents, hours. These are fixed by the
 * Earth–Moon–Sun geometry and are identical at every site on the planet; only amplitude and
 * phase are local. The spring/neap cycle is not in this table — it EMERGES from M2 and S2
 * beating against each other (1/(1/12.0 − 1/12.4206) ≈ 354.4 h ≈ 14.77 days).
 */
export const STANDARD_CONSTITUENT_PERIODS_H: Readonly<Record<string, number>> = Object.freeze({
  /** Principal lunar semidiurnal — the dominant term almost everywhere. */
  M2: 12.4206012,
  /** Principal solar semidiurnal — beats against M2 to make springs and neaps. */
  S2: 12.0,
  /** Larger lunar elliptic semidiurnal — perigee/apogee modulation. */
  N2: 12.6583475,
  /** Lunisolar declinational diurnal. */
  K1: 23.9344696,
  /** Principal lunar diurnal. */
  O1: 25.8193417,
  /** Lunisolar semidiurnal. */
  K2: 11.9672348,
  /** Principal solar diurnal. */
  P1: 24.0658902,
  /** Shallow-water lunar overtide — significant in constricted channels. */
  M4: 6.2103006,
});

/**
 * @description Mean of |cos θ|³ over a full cycle = 4/(3π). The single most useful number in
 * tidal-turbine sizing: because harvested power goes as v³ and the flow is sinusoidal, mean
 * power is 42.44% of PEAK-speed power — it is emphatically NOT the power at mean speed, which
 * a naive budget computes and overstates by roughly 2×.
 */
export const SINUSOID_MEAN_CUBE_FACTOR = 4 / (3 * Math.PI);

/**
 * @description Build a constituent from the standard table so callers cannot typo a period.
 * @param name - Darwin symbol present in STANDARD_CONSTITUENT_PERIODS_H (e.g. 'M2').
 * @param amplitudeMs - Peak current this constituent contributes, m/s.
 * @param phaseDeg - Site phase lag, degrees. Default 0.
 * @returns A fully specified constituent.
 * @throws If `name` is not a known constituent — a silent default would corrupt the beat period.
 */
export function constituent(name: string, amplitudeMs: number, phaseDeg = 0): TidalConstituent {
  const periodHours = STANDARD_CONSTITUENT_PERIODS_H[name];
  if (periodHours === undefined) {
    throw new Error(`unknown tidal constituent '${name}' — known: ${Object.keys(STANDARD_CONSTITUENT_PERIODS_H).join(', ')}`);
  }
  return { name, periodHours, amplitudeMs, phaseDeg };
}

/**
 * @description Signed current speed at a site at time t, as the sum of its constituents plus
 * any steady residual. Sign carries flow direction; a turbine harvests either way, so callers
 * take |u| before the cube.
 * @param site - Site harmonic model.
 * @param tSeconds - Seconds since the phase epoch.
 * @returns Signed flow speed, m/s.
 */
export function currentSpeedAt(site: TidalSiteConfig, tSeconds: number): number {
  let u = site.residualMs ?? 0;
  for (const c of site.constituents) {
    const omega = (2 * Math.PI) / (c.periodHours * 3600);
    u += c.amplitudeMs * Math.cos(omega * tSeconds - (c.phaseDeg * Math.PI) / 180);
  }
  return u;
}

/**
 * @description Peak possible speed at a site — every constituent aligned, plus residual. The
 * upper bound used to size a rotor's rated clamp, never the design point for energy.
 * @param site - Site harmonic model.
 * @returns Maximum attainable |flow|, m/s.
 */
export function peakSpeedMs(site: TidalSiteConfig): number {
  const tidal = site.constituents.reduce((sum, c) => sum + Math.abs(c.amplitudeMs), 0);
  return tidal + Math.abs(site.residualMs ?? 0);
}

/**
 * @description Length of the longest continuous stretch in which |flow| stays below a
 * threshold. THIS is the number that sizes the battery: it is the gap the node must ride
 * through on stored energy alone, and at a marginal site it falls at neap tide and runs for
 * days — not the ~1 hour of slack water an intuition based on a single tide cycle suggests.
 *
 * Scans in SPEED, not watts: the generic scan only ever asks "sampler below threshold?", so
 * passing |current| against the rotor's cut-in speed is exactly equivalent to passing watts
 * against a cut-in power — and it skips the cube for every sample.
 * @param site - Site harmonic model.
 * @param thresholdMs - Speed below which harvest is zero (the turbine's cut-in), m/s.
 * @param spanHours - Window to search. Use ≥ 30 days to include a full spring/neap beat.
 * @param stepSeconds - Sample step. Default 60.
 * @returns Longest sub-threshold stretch in hours.
 */
export function longestSlackHours(site: TidalSiteConfig, thresholdMs: number, spanHours: number, stepSeconds = 60): number {
  const hours = longestGapHours((t) => Math.abs(currentSpeedAt(site, t)), thresholdMs, spanHours, stepSeconds);
  logger.debug({ site: site.name, thresholdMs, spanHours, longestSlackHours: hours }, 'longest sub-cut-in stretch computed');
  return hours;
}

/**
 * @description Illustrative parameter set for a strong constricted channel — the kind of site
 * tidal energy actually targets (headlands, narrows, inlets). NOT survey data: replace the
 * amplitudes and phases with the published harmonic constants for your station before
 * treating any verdict as site-specific.
 */
export const STRONG_CHANNEL_SITE: TidalSiteConfig = {
  name: 'illustrative-strong-channel',
  constituents: [constituent('M2', 1.9, 0), constituent('S2', 0.6, 25), constituent('N2', 0.35, 12), constituent('K1', 0.15, 80)],
  residualMs: 0.1,
};

/**
 * @description Illustrative parameter set for a moderate coastal inlet — a realistic site for
 * a small opportunistic node rather than a utility project. Same caveat as
 * {@link STRONG_CHANNEL_SITE}: these are plausible parameters, not a survey.
 */
export const MODERATE_INLET_SITE: TidalSiteConfig = {
  name: 'illustrative-moderate-inlet',
  constituents: [constituent('M2', 0.85, 0), constituent('S2', 0.28, 30), constituent('K1', 0.12, 95)],
  residualMs: 0.05,
};
