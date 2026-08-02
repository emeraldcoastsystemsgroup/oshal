/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — ground slice: types for a subterranean
 *                     |                             | thermal-harvesting node. The soil is modelled as a
 *                     |                             | semi-infinite solid carrying two superposed harmonic
 *                     |                             | waves, because the usable resource is the PHASE LAG
 *                     |                             | between two depths, not the geothermal gradient — a
 *                     |                             | distinction the parameter names here make unavoidable.
 */

import type { PowerLoad, StorageConfig } from '@/shared/energy';

export type { PowerLoad, StorageConfig } from '@/shared/energy';

/**
 * @description The thermal properties of the ground at a site. Diffusivity and conductivity are
 * INDEPENDENT levers and pull in opposite directions, which is the central design tension of a
 * buried harvester: diffusivity α sets how deep the temperature wave penetrates (bigger α → the
 * two junctions see more similar temperatures → less ΔT), while conductivity k sets how much heat
 * can actually flow through the collector path (bigger k → more heat crosses the module → more
 * power). Dry sand has small α and small k; wet clay has large α and large k. Neither is
 * uniformly better, so both are shipped as fixtures.
 */
export interface SoilProfile {
  /** Human label for logs and reports. */
  name: string;
  /**
   * Thermal diffusivity α, m²/s. Real soils span roughly 0.2e-6 (dry sand) to 1.0e-6 (saturated
   * clay); 0.5e-6 is a temperate-loam default. Sets the damping depth, hence the phase lag.
   */
  thermalDiffusivityM2S: number;
  /**
   * Thermal conductivity k, W/m/K. Roughly 0.5 (dry sand) to 2.0 (saturated clay), default 1.0.
   * Appears ONLY in the conduction resistance — it has no effect on the temperature field here,
   * which is exactly why a site can have plenty of ΔT and still deliver almost no power.
   */
  thermalConductivityWmK: number;
  /** Undisturbed deep-soil mean temperature, °C. Close to local mean annual air temperature. */
  meanTempC: number;
  /** Surface amplitude of the annual wave, °C (half its peak-to-peak swing). */
  annualAmplitudeC: number;
  /** Surface amplitude of the diurnal wave, °C (half its peak-to-peak swing). */
  diurnalAmplitudeC: number;
  /**
   * Geothermal gradient, K/m. Default 0.025 (25 K/km continental average). Included for
   * completeness and provably NEGLIGIBLE at probe scale — a 3 m probe sees 0.075 K against
   * several K of harmonic swing. Documented finding, not an omission.
   */
  geothermalGradientKM?: number;
  /**
   * Phase lag of the annual wave at the surface, degrees. Default 0, which DEFINES t=0 as the
   * instant of the surface annual maximum. A positive value moves that maximum later.
   */
  annualPhaseDeg?: number;
  /** Phase lag of the diurnal wave at the surface, degrees. Default 0. Same convention. */
  diurnalPhaseDeg?: number;
}

/**
 * @description One thermoelectric generator module plus the collector plates that couple it to the
 * soil. `moduleResistanceKW` is the design lever this whole slice exists to expose: power peaks
 * when it EQUALS the soil conduction resistance, so a module chosen for its ΔT rating rather than
 * its thermal impedance can be an order of magnitude off optimum on an otherwise identical site.
 */
export interface TegModuleConfig {
  /** Area of the collector plate at each junction, m². Larger plates lower the soil resistance. */
  collectorAreaM2: number;
  /**
   * Thermal resistance of the module itself, K/W. Match it to the soil path
   * (see matchedModuleResistanceKW) for maximum power transfer.
   */
  moduleResistanceKW: number;
  /**
   * Dimensionless figure of merit ZT̄, averaged over the operating range. 0.9 for commercial
   * Bi₂Te₃ near ambient; the exotic materials that claim 2+ are not ambient-temperature parts.
   */
  ztBar: number;
  /** Electrical clamp, W. Output above this is curtailed by the converter. */
  ratedPowerW: number;
  /**
   * Below this electrical power the converter cannot start, W. Not a rounding detail: a
   * boost converter harvesting tens of millivolts has a real cold-start threshold, and it is
   * what turns the seasonal ΔT zero-crossing into a multi-WEEK outage rather than an instant.
   */
  cutInPowerW: number;
}

/**
 * @description Two buried junctions and the module bridging them. Which depth is "hot" is a
 * naming convention only — the sign of ΔT reverses every half period of whichever wave drives the
 * pair, and the converter rectifies it, so the pair produces on both polarities.
 */
export interface JunctionPair {
  /** Human label for logs and reports. */
  name: string;
  /** Depth of the nominally warm junction, m. */
  hotDepthM: number;
  /** Depth of the nominally cool junction, m. */
  coldDepthM: number;
  /** The module and collector bridging the two depths. */
  module: TegModuleConfig;
}

/**
 * @description A complete buried-node design: the ground it sits in, every junction pair it
 * harvests with, what it spends and what it stores. Multiple pairs is the point — a pair tuned to
 * the annual wave and a pair tuned to the diurnal wave null at unrelated times, so the combined
 * harvester has no long outage even though each pair alone does.
 */
export interface GroundUnitConfig {
  /** Site soil model. */
  soil: SoilProfile;
  /** Every junction pair on the unit. Their outputs sum after per-pair rectification. */
  pairs: JunctionPair[];
  /** Every electrical load on the unit. */
  loads: PowerLoad[];
  /** Energy store. */
  storage: StorageConfig;
}
