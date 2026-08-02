/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — marine slice W1: types for a
 *                     |                             | tidal/current-harvesting persistent node. Models the
 *                     |                             | site (harmonic constituents), the harvester, the load
 *                     |                             | set and the store, so "is it perpetual?" becomes a
 *                     |                             | simulated verdict instead of an average-power hand-wave.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Extracted the harvest-agnostic half (PowerLoad, StorageConfig,
 *                     |                             | the sample and verdict shapes) to @/shared/energy. What is
 *                     |                             | left here is what is genuinely tidal — harmonics and a rotor
 *                     |                             | — plus the two marine widenings (currentMs, siteName) that
 *                     |                             | keep this slice's public API byte-compatible.
 */

import type { EnergyBudgetSample, EnergyBudgetVerdict, PowerLoad, StorageConfig } from '@/shared/energy';

export type { PowerLoad, StorageConfig } from '@/shared/energy';

/**
 * @description One astronomical tidal constituent at a site. Period is fixed by orbital
 * mechanics (hence tides are *calculable* decades out, not forecast); amplitude and phase are
 * site-specific and come from a harmonic analysis of local observations — NOAA publishes them
 * per station as "harmonic constants".
 */
export interface TidalConstituent {
  /** Darwin symbol — 'M2', 'S2', 'K1', … See STANDARD_CONSTITUENT_PERIODS_H. */
  name: string;
  /** Period in hours. Astronomically fixed; do not tune per site. */
  periodHours: number;
  /** Peak current speed this constituent contributes, m/s. */
  amplitudeMs: number;
  /** Phase lag at the site, degrees. Sets when slack water falls. */
  phaseDeg: number;
}

/**
 * @description A harvest site: the constituent set plus any steady non-tidal flow.
 * Constituents SUM — the spring/neap beat that dominates endurance is an emergent product of
 * M2 and S2 drifting in and out of phase, never a parameter you set.
 */
export interface TidalSiteConfig {
  /** Human label for logs and reports. */
  name: string;
  /** Constituents present at the site. Two (M2, S2) already produce a realistic spring/neap beat. */
  constituents: TidalConstituent[];
  /** Steady background flow (river discharge, ocean current), m/s. Signed. Default 0. */
  residualMs?: number;
}

/**
 * @description The energy harvester. Power off a flow goes as velocity CUBED, so every
 * parameter here is dominated by `cutInSpeedMs` and the site's speed distribution — not by
 * swept area.
 */
export interface TurbineConfig {
  /** Rotor swept area, m². */
  sweptAreaM2: number;
  /** Coefficient of performance Cp. Betz limit is 16/27 ≈ 0.593; a small real rotor is 0.35–0.45. */
  powerCoefficient: number;
  /** Generator + rectifier + MPPT efficiency, 0..1. Small units land ~0.70–0.85. */
  drivetrainEfficiency: number;
  /** Below this flow speed the rotor produces nothing (bearing drag, cogging), m/s. */
  cutInSpeedMs: number;
  /** Electrical clamp, W. Output above this is curtailed. */
  ratedPowerW: number;
}

/**
 * @description A complete persistent-node power design: where it sits, what it harvests with,
 * what it spends, and what it stores.
 */
export interface MarineUnitConfig {
  /** Site harmonic model. */
  site: TidalSiteConfig;
  /** Harvester model. */
  turbine: TurbineConfig;
  /** Every electrical load on the vehicle. */
  loads: PowerLoad[];
  /** Energy store. */
  storage: StorageConfig;
}

/**
 * @description One timestep of the simulated budget, widened with the flow speed that produced
 * it. Retained so a caller can plot the spring/neap envelope rather than trusting a scalar —
 * and plotting the envelope is precisely why `currentMs` is worth carrying past the generic
 * sample, which knows only watts.
 */
export interface PowerBudgetSample extends EnergyBudgetSample {
  /** Signed flow speed at this instant, m/s. */
  currentMs: number;
}

/**
 * @description The verdict on a design over a simulated run. `perpetual` is the headline:
 * it requires BOTH that the pack never browned out AND that the run closed at or above its
 * starting charge — a design that limps downhill for 30 days is not perpetual, it is slow.
 * Widens the generic verdict with `siteName`, which is the marine name for the same label the
 * core reports; both keys are present and carry the same value.
 */
export interface PowerBudgetVerdict extends EnergyBudgetVerdict {
  /** Site + run label for reports. Mirrors the generic verdict's `label`. */
  siteName: string;
}
