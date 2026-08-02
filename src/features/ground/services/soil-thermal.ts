/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — ground slice: the harmonic solution to
 *                     |                             | the 1-D heat equation in a semi-infinite solid. Two waves
 *                     |                             | superpose, each with its OWN damping depth, and each
 *                     |                             | carries a phase lag equal to its attenuation exponent.
 *                     |                             | That coupling (same z/d in the envelope and in the phase)
 *                     |                             | is what makes deep soil run a season behind the surface,
 *                     |                             | and it — not the geothermal gradient — is the resource.
 */

import type { SoilProfile } from '../model/ground-types';

/** @description Period of the annual surface temperature wave, seconds (365.25 d). */
export const ANNUAL_PERIOD_S = 31_557_600;

/** @description Period of the diurnal surface temperature wave, seconds. */
export const DIURNAL_PERIOD_S = 86_400;

/**
 * @description Continental average geothermal gradient, K/m (25 K/km). Applied when a
 * {@link SoilProfile} omits its own. Present so the model is complete, and provably negligible at
 * the depths a probe can reach — see the slice's tests, which assert the 3 m figure is under 0.1 K.
 */
export const DEFAULT_GEOTHERMAL_GRADIENT_KM = 0.025;

/**
 * @description Damping depth d = √(2α/ω) — the depth at which a temperature wave has decayed to
 * 1/e of its surface amplitude AND lags the surface by exactly one radian. Both facts fall out of
 * the same z/d, which is why depth selection is simultaneously an amplitude and a timing decision.
 *
 * The two periods land in completely different regimes: at α = 0.5e-6 m²/s the annual wave damps
 * over ~2.24 m while the diurnal wave damps over ~0.117 m — a factor of √365 apart, because d goes
 * as √period. A probe at 1 m is effectively deaf to the day/night cycle and fully inside the
 * annual one, and that separation is what lets one unit host two independent harvest schedules.
 * @param thermalDiffusivityM2S - Soil thermal diffusivity α, m²/s. Must be positive.
 * @param periodS - Wave period, seconds. Must be positive.
 * @returns Damping depth, m.
 * @throws If either argument is non-positive — √ of a negative would return NaN and quietly
 * poison every downstream temperature instead of failing where the bad parameter entered.
 */
export function dampingDepthM(thermalDiffusivityM2S: number, periodS: number): number {
  if (!(thermalDiffusivityM2S > 0)) throw new Error(`thermal diffusivity must be positive, got ${thermalDiffusivityM2S}`);
  if (!(periodS > 0)) throw new Error(`wave period must be positive, got ${periodS}`);
  const omega = (2 * Math.PI) / periodS;
  return Math.sqrt((2 * thermalDiffusivityM2S) / omega);
}

/**
 * @description One harmonic wave's contribution at depth z: A·e^(−z/d)·cos(ωt − z/d − φ). The
 * SAME z/d appears in the envelope and inside the cosine — attenuation and lag are not two
 * independent effects, they are one, which is why you cannot buy amplitude back by going deeper.
 * @param amplitudeC - Surface amplitude of this wave, °C.
 * @param dampingM - This wave's damping depth, m.
 * @param depthM - Depth below surface, m.
 * @param periodS - This wave's period, seconds.
 * @param tSeconds - Seconds since the phase epoch.
 * @param phaseDeg - Surface phase lag, degrees.
 * @returns Signed temperature contribution, °C.
 */
function waveTermC(
  amplitudeC: number,
  dampingM: number,
  depthM: number,
  periodS: number,
  tSeconds: number,
  phaseDeg: number,
): number {
  const zOverD = depthM / dampingM;
  const omega = (2 * Math.PI) / periodS;
  return amplitudeC * Math.exp(-zOverD) * Math.cos(omega * tSeconds - zOverD - (phaseDeg * Math.PI) / 180);
}

/**
 * @description Soil temperature at depth z and time t: the deep mean, plus the geothermal gradient,
 * plus the annual and diurnal waves superposed. Superposition is exact here because the heat
 * equation is linear — the two waves genuinely do not interact, they simply add, each with its own
 * damping depth.
 *
 * Depths are measured DOWN from the surface, so z is positive; t=0 is the surface annual maximum
 * unless the profile carries a phase.
 * @param soil - Site soil model.
 * @param depthM - Depth below surface, m.
 * @param tSeconds - Seconds since the phase epoch.
 * @returns Soil temperature, °C.
 */
export function soilTempC(soil: SoilProfile, depthM: number, tSeconds: number): number {
  const alpha = soil.thermalDiffusivityM2S;
  const annual = waveTermC(
    soil.annualAmplitudeC,
    dampingDepthM(alpha, ANNUAL_PERIOD_S),
    depthM,
    ANNUAL_PERIOD_S,
    tSeconds,
    soil.annualPhaseDeg ?? 0,
  );
  const diurnal = waveTermC(
    soil.diurnalAmplitudeC,
    dampingDepthM(alpha, DIURNAL_PERIOD_S),
    depthM,
    DIURNAL_PERIOD_S,
    tSeconds,
    soil.diurnalPhaseDeg ?? 0,
  );
  const geothermal = (soil.geothermalGradientKM ?? DEFAULT_GEOTHERMAL_GRADIENT_KM) * depthM;
  return soil.meanTempC + geothermal + annual + diurnal;
}

/**
 * @description Signed temperature difference between two buried junctions, K (a difference of
 * Celsius temperatures is already Kelvin). This is the entire harvestable resource, and it exists
 * only because the two depths are at different points of the SAME wave: the deep junction is
 * running the surface's schedule late. Take two depths with the same z/d and the difference is
 * identically zero no matter how hot the site is.
 *
 * The sign reverses twice per period of whichever wave dominates the pair; callers rectify.
 * @param soil - Site soil model.
 * @param hotDepthM - Depth of the nominally warm junction, m.
 * @param coldDepthM - Depth of the nominally cool junction, m.
 * @param tSeconds - Seconds since the phase epoch.
 * @returns Signed ΔT = T(hot) − T(cold), K.
 */
export function junctionDeltaTK(soil: SoilProfile, hotDepthM: number, coldDepthM: number, tSeconds: number): number {
  return soilTempC(soil, hotDepthM, tSeconds) - soilTempC(soil, coldDepthM, tSeconds);
}

/**
 * @description Illustrative temperate loam — the mid-range site this slice's defaults describe.
 * NOT survey data: α, k and both surface amplitudes vary with moisture, season and compaction, and
 * a real design replaces every number here with logged borehole temperatures before any verdict is
 * treated as site-specific.
 */
export const DEFAULT_SOIL: SoilProfile = {
  name: 'illustrative-temperate-loam',
  thermalDiffusivityM2S: 0.5e-6,
  thermalConductivityWmK: 1.0,
  meanTempC: 12,
  annualAmplitudeC: 12,
  diurnalAmplitudeC: 8,
  geothermalGradientKM: DEFAULT_GEOTHERMAL_GRADIENT_KM,
};

/**
 * @description Illustrative dry sand: the ΔT trap. Low diffusivity keeps the waves shallow and the
 * surface swings are large, so it shows the BEST temperature differences of the three fixtures —
 * and its low conductivity throttles the heat flow that those differences are supposed to drive.
 * A site picked on ΔT alone picks this one. Same caveat as {@link DEFAULT_SOIL}.
 */
export const DRY_SAND_SOIL: SoilProfile = {
  name: 'illustrative-dry-sand',
  thermalDiffusivityM2S: 0.24e-6,
  thermalConductivityWmK: 0.5,
  meanTempC: 20,
  annualAmplitudeC: 15,
  diurnalAmplitudeC: 14,
  geothermalGradientKM: DEFAULT_GEOTHERMAL_GRADIENT_KM,
};

/**
 * @description Illustrative saturated clay: the mirror image. High diffusivity spreads the wave
 * deep and flattens the ΔT between any two depths, while high conductivity moves heat readily once
 * a difference exists. Same caveat as {@link DEFAULT_SOIL}.
 */
export const WET_CLAY_SOIL: SoilProfile = {
  name: 'illustrative-wet-clay',
  thermalDiffusivityM2S: 0.9e-6,
  thermalConductivityWmK: 1.8,
  meanTempC: 10,
  annualAmplitudeC: 9,
  diurnalAmplitudeC: 4,
  geothermalGradientKM: DEFAULT_GEOTHERMAL_GRADIENT_KM,
};
