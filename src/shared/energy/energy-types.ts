/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — extracted verbatim from the marine slice.
 *                     |                             | A load set, a store and a closed-loop verdict say nothing
 *                     |                             | about tides: the only thing that made the marine budget
 *                     |                             | marine was where the watts came from. Naming that seam
 *                     |                             | (HarvestSampler) lets a second harvest domain reuse the
 *                     |                             | engine instead of copying its arithmetic and drifting.
 */

/**
 * @description One electrical load. Averaged by duty cycle — correct for loads that cycle far
 * faster than the harvest environment varies (a modem burst, a sensor sweep), which is the usual
 * case for the always-on nodes this engine sizes.
 */
export interface PowerLoad {
  /** Human label — appears in the budget breakdown. */
  name: string;
  /** Draw while active, W. */
  watts: number;
  /** Fraction of wall-clock time active, 0..1. */
  dutyCycle: number;
}

/**
 * @description The energy store that carries a node through the stretches where harvest is below
 * load. Sizing this off AVERAGE power is the classic error: the binding constraint is the longest
 * harvest-starved stretch, which is a property of the environment's schedule, not of its mean.
 */
export interface StorageConfig {
  /** Nameplate capacity, Wh. */
  capacityWh: number;
  /** State of charge at t=0, 0..1 of nameplate. */
  initialSocFraction: number;
  /** Round-trip efficiency, 0..1. Applied on charge. */
  roundTripEfficiency: number;
  /** Usable fraction of nameplate before the pack is considered browned out, 0..1. */
  usableDepthOfDischarge: number;
}

/**
 * @description Harvested electrical power at a point in time — the ONLY coupling between this
 * engine and a physical environment. A tidal slice closes over a site's harmonics and a rotor
 * curve; a thermal slice closes over a borehole ΔT and an ORC curve; the budget cannot tell the
 * difference, which is exactly why it is shared.
 * @param tSeconds - Seconds since the run's epoch.
 * @returns Harvested electrical power at that instant, W.
 */
export type HarvestSampler = (tSeconds: number) => number;

/**
 * @description A complete harvest-agnostic power design: what it is called, what it harvests,
 * what it spends, and what it stores. Domain slices build this from their own site/harvester
 * models and hand it over; nothing downstream of here knows the domain.
 */
export interface EnergyBudgetDesign {
  /** Human label for logs and reports — usually the site or unit name. */
  label: string;
  /** Harvested power as a function of time. */
  harvestAt: HarvestSampler;
  /** Every electrical load on the unit. */
  loads: PowerLoad[];
  /** Energy store. */
  storage: StorageConfig;
}

/**
 * @description One timestep of the simulated budget. Retained so a caller can plot the harvest
 * envelope rather than trusting a scalar.
 */
export interface EnergyBudgetSample {
  /** Hours since t=0. */
  tHours: number;
  /** Harvested electrical power, W. */
  harvestW: number;
  /** Total load draw, W. */
  drawW: number;
  /** Absolute energy in the store, Wh. */
  socWh: number;
  /** Store level as a fraction of nameplate, 0..1. */
  socFraction: number;
}

/**
 * @description The verdict on a design over a simulated run. `perpetual` is the headline:
 * it requires BOTH that the pack never browned out AND that the run closed at or above its
 * starting charge — a design that limps downhill for 30 days is not perpetual, it is slow.
 */
export interface EnergyBudgetVerdict {
  /** True when the node never browned out and ended no worse charged than it started. */
  perpetual: boolean;
  /** Design label for reports. */
  label: string;
  /** Simulated span, hours. */
  durationHours: number;
  /** Deepest store level reached, fraction of nameplate. */
  minSocFraction: number;
  /** When that minimum fell, hours since t=0 — expect this at the environment's worst stretch. */
  minSocAtHours: number;
  /** Cumulative hours spent browned out (store at floor with an unmet deficit). */
  brownoutHours: number;
  /** Total energy harvested, Wh. */
  harvestedWh: number;
  /** Total energy consumed by loads, Wh. */
  consumedWh: number;
  /** Energy discarded because the store was full or the harvester was clamped, Wh. */
  curtailedWh: number;
  /** harvested / consumed. Below 1.0 cannot be perpetual at any store size. */
  marginRatio: number;
  /** Mean harvested power, W. */
  meanHarvestW: number;
  /** Mean load draw, W. */
  meanDrawW: number;
}
