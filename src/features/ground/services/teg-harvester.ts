/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — ground slice: thermal resistance network
 *                     |                             | plus the figure-of-merit TEG efficiency. Modelled as a
 *                     |                             | network rather than "ΔT × a constant" because heat has to
 *                     |                             | FLOW to be converted: a module whose thermal impedance is
 *                     |                             | mismatched to the soil path either starves itself of heat
 *                     |                             | or drops no temperature across itself, and both failures
 *                     |                             | are invisible to a ΔT-only model.
 */

import {
  longestGapHours,
  recommendStorageWh,
  simulateEnergyBudget,
  type EnergyBudgetDesign,
  type EnergyBudgetOptions,
  type EnergyBudgetResult,
} from '@/shared/energy';
import { createChildLogger } from '@/shared/logger';
import type { GroundUnitConfig, JunctionPair, SoilProfile } from '../model/ground-types';
import { ANNUAL_PERIOD_S, soilTempC } from './soil-thermal';

const logger = createChildLogger({ module: 'ground:teg-harvester' });

/** @description Celsius-to-Kelvin offset. The efficiency expression is ABSOLUTE-temperature-only. */
const KELVIN_OFFSET = 273.15;

/**
 * @description Default run for a buried node: one full year. The marine default of 720 h is
 * actively misleading here — a 30-day window can miss the equinox null entirely and certify a
 * design that dies twice a year. The binding constraint is annual, so the default span is annual.
 */
export const DEFAULT_GROUND_DURATION_HOURS = ANNUAL_PERIOD_S / 3600;

/**
 * @description Conduction resistance of the soil path between two junctions, R = L/(k·A) — and,
 * by the maximum-power-transfer result, the module thermal resistance that maximises electrical
 * output on that path. Power goes as R_teg/(R_soil+R_teg)², whose maximum is exactly at
 * R_teg = R_soil; both limits produce nothing, for opposite reasons. A module far below match
 * passes heat freely but drops almost no temperature across itself (η → 0); far above match it
 * drops the whole ΔT but blocks the heat that would have been converted (Q → 0).
 *
 * This makes thermal impedance the primary design lever. Doubling the collector area halves the
 * soil resistance and moves the optimum module — a bigger plate is not a free win, it is a
 * re-specification of the module.
 * @param soil - Site soil model; only its conductivity is used.
 * @param hotDepthM - Depth of the warm junction, m.
 * @param coldDepthM - Depth of the cool junction, m.
 * @param collectorAreaM2 - Collector plate area, m².
 * @returns Matched module thermal resistance, K/W.
 * @throws If the junctions are co-located, or area/conductivity are non-positive — each would
 * yield a zero or infinite resistance that silently produces a nonsense power.
 */
export function matchedModuleResistanceKW(
  soil: SoilProfile,
  hotDepthM: number,
  coldDepthM: number,
  collectorAreaM2: number,
): number {
  const separationM = Math.abs(hotDepthM - coldDepthM);
  if (!(separationM > 0)) throw new Error('junction depths must differ — co-located junctions can carry no heat flow');
  if (!(collectorAreaM2 > 0)) throw new Error(`collector area must be positive, got ${collectorAreaM2}`);
  if (!(soil.thermalConductivityWmK > 0)) throw new Error(`soil conductivity must be positive, got ${soil.thermalConductivityWmK}`);
  return separationM / (soil.thermalConductivityWmK * collectorAreaM2);
}

/** @description The module's thermal operating point at one instant — what the network resolves to. */
interface ThermalOperatingPoint {
  /** Heat crossing the series path, W. Zero heat flow means zero power however large ΔT is. */
  heatFlowW: number;
  /** The share of ΔT that actually falls across the module, K. */
  moduleDeltaTK: number;
  /** Absolute temperature of the module's warm face, K. */
  hotFaceK: number;
  /** Absolute temperature of the module's cool face, K. */
  coldFaceK: number;
}

/**
 * @description Resolve the series thermal network at one instant. The soil drop is split evenly
 * between the two junctions, which is the only symmetric choice for two identical buried collectors
 * and keeps the face temperatures straddling the soil pair instead of pinning one face to soil.
 * Rectified: the warm face is whichever junction is currently warmer, so the result is unchanged
 * when the season flips the sign of ΔT.
 * @param soil - Site soil model.
 * @param pair - Junction pair and its module.
 * @param tSeconds - Seconds since the phase epoch.
 * @returns The operating point.
 * @throws If the resolved hot face is at or below absolute zero — an impossible soil profile that
 * would otherwise return a plausible-looking negative efficiency.
 */
function operatingPoint(soil: SoilProfile, pair: JunctionPair, tSeconds: number): ThermalOperatingPoint {
  const { module } = pair;
  const hotSoilC = soilTempC(soil, pair.hotDepthM, tSeconds);
  const coldSoilC = soilTempC(soil, pair.coldDepthM, tSeconds);
  const soilResistanceKW = matchedModuleResistanceKW(soil, pair.hotDepthM, pair.coldDepthM, module.collectorAreaM2);
  const heatFlowW = Math.abs(hotSoilC - coldSoilC) / (soilResistanceKW + module.moduleResistanceKW);
  const halfSoilDropK = (heatFlowW * soilResistanceKW) / 2;
  const hotFaceK = Math.max(hotSoilC, coldSoilC) + KELVIN_OFFSET - halfSoilDropK;
  if (!(hotFaceK > 0)) throw new Error(`soil profile '${soil.name}' resolved a hot face at ${hotFaceK} K — below absolute zero`);
  return {
    heatFlowW,
    moduleDeltaTK: heatFlowW * module.moduleResistanceKW,
    hotFaceK,
    coldFaceK: Math.min(hotSoilC, coldSoilC) + KELVIN_OFFSET + halfSoilDropK,
  };
}

/**
 * @description Thermoelectric conversion efficiency: the Carnot factor ΔT/T_hot scaled by the
 * material's figure-of-merit term. The second factor is the brutal one — at ZT̄ = 0.9 it is about
 * 0.16, so a buried harvester keeps roughly a sixth of an already tiny Carnot fraction and lands
 * near 0.2% overall. That is not a defect in the model; it is why these nodes are budgeted in
 * milliwatts and why the store, not the harvester, decides whether the design closes.
 * @param point - Resolved thermal operating point.
 * @param ztBar - Dimensionless figure of merit, averaged over the operating range.
 * @returns Conversion efficiency, 0..1.
 */
function tegEfficiency(point: ThermalOperatingPoint, ztBar: number): number {
  const root = Math.sqrt(1 + ztBar);
  return (point.moduleDeltaTK / point.hotFaceK) * ((root - 1) / (root + point.coldFaceK / point.hotFaceK));
}

/**
 * @description Electrical power from one junction pair at one instant. Sign-agnostic by
 * construction — the converter bridges the polarity reversal that arrives every half period — and
 * zero below the converter's cold-start threshold, which is what turns a ΔT zero-crossing into a
 * genuine outage rather than a momentary dip. A converter sitting exactly ON its threshold starts
 * — the comparison is strict — because a `<=` there would make the boundary case unpowered and no
 * realistic sampling would ever notice.
 *
 * Needs no zero-ΔT special case: at ΔT = 0 the heat flow is zero, so the module drop is zero and
 * the efficiency is zero, and the expression returns 0 on its own. An explicit short-circuit here
 * would be untestable code that only ever agreed with the arithmetic it was guarding.
 * @param soil - Site soil model.
 * @param pair - Junction pair and its module.
 * @param tSeconds - Seconds since the phase epoch.
 * @returns Electrical power, W.
 */
export function tegPowerW(soil: SoilProfile, pair: JunctionPair, tSeconds: number): number {
  const point = operatingPoint(soil, pair, tSeconds);
  const raw = tegEfficiency(point, pair.module.ztBar) * point.heatFlowW;
  if (raw < pair.module.cutInPowerW) return 0;
  return Math.min(raw, pair.module.ratedPowerW);
}

/**
 * @description Total electrical power from every junction pair on a unit at one instant. Each pair
 * rectifies and cuts in independently BEFORE the sum, which is the whole reason a mixed-depth
 * harvester works: a pair sitting in its seasonal null contributes a clean zero rather than
 * dragging the combined output below the system threshold.
 * @param config - Unit design.
 * @param tSeconds - Seconds since the phase epoch.
 * @returns Combined electrical power, W.
 */
export function groundHarvestW(config: GroundUnitConfig, tSeconds: number): number {
  let total = 0;
  for (const pair of config.pairs) total += tegPowerW(config.soil, pair, tSeconds);
  return total;
}

/**
 * @description Collapse a ground design onto the generic energy design the shared core consumes.
 * This adapter is the ground slice's entire contribution to the budget: the soil harmonics and the
 * resistance network compose into one `(t) => watts` closure, and everything downstream is
 * domain-free.
 * @param config - Soil, pairs, loads and store.
 * @returns The same design expressed as a harvest sampler plus loads and store.
 */
function toEnergyDesign(config: GroundUnitConfig): EnergyBudgetDesign {
  return {
    label: config.soil.name,
    harvestAt: (t) => groundHarvestW(config, t),
    loads: config.loads,
    storage: config.storage,
  };
}

/**
 * @description Fill in the ground slice's defaults without letting an explicitly-undefined field
 * fall through to the core's marine-era 720 h default.
 * @param options - Caller options, possibly partial.
 * @returns Fully specified options.
 */
function groundOptions(options: EnergyBudgetOptions): Required<EnergyBudgetOptions> {
  return {
    durationHours: options.durationHours ?? DEFAULT_GROUND_DURATION_HOURS,
    stepSeconds: options.stepSeconds ?? 600,
    sampleEveryMinutes: options.sampleEveryMinutes ?? 360,
  };
}

/**
 * @description Simulate a buried node's energy over a full year and return whether the design
 * actually closes. Defaults to an annual span deliberately: the failure mode this slice exists to
 * surface is the equinox null, which a month-long run cannot see, so a shorter default would make
 * the function certify exactly the designs it is meant to reject.
 * @param config - Soil, pairs, loads and store.
 * @param options - Span, step and sampling. Defaults: one year, 600 s step, 6 h sampling.
 * @returns Verdict plus the retained timeseries.
 */
export function simulateGroundBudget(config: GroundUnitConfig, options: EnergyBudgetOptions = {}): EnergyBudgetResult {
  const result = simulateEnergyBudget(toEnergyDesign(config), groundOptions(options));
  logger.info(
    { soil: config.soil.name, pairs: config.pairs.length, perpetual: result.verdict.perpetual, meanHarvestW: result.verdict.meanHarvestW },
    'ground energy budget simulated',
  );
  return result;
}

/**
 * @description Scale factor applied before handing a ground design to the shared store search.
 * The core's binary search stops once its capacity bracket is under 0.5 Wh, which is coarser than
 * the ENTIRE store a milliwatt-scale buried node needs. Every term in the budget integration is
 * linear in power and energy, so scaling harvest, load and capacity together is an exact
 * transformation of the same problem — it buys three decimal places of resolution and changes no
 * verdict. This is the one place the ground slice compensates for a shared default rather than
 * inheriting it.
 */
const MILLIWATT_SEARCH_GAIN = 1000;

/**
 * @description Smallest store, in Wh, that makes a buried design perpetual. Returns null when no
 * capacity works, which means the harvest itself is short of the load and more battery cannot fix
 * it — the common outcome here, because a thermal harvester's mean output is fixed by soil
 * physics and cannot be bought back with storage.
 * @param config - Unit design; its `storage.capacityWh` is overridden per trial.
 * @param options - Passed through to the simulation. Defaults to a full year.
 * @returns Minimum viable capacity in Wh, or null if the design can never close.
 */
export function recommendGroundStorageWh(config: GroundUnitConfig, options: EnergyBudgetOptions = {}): number | null {
  const design = toEnergyDesign(config);
  // Only harvest and load are rescaled: the search overrides `storage.capacityWh` on every trial,
  // so scaling the incoming capacity would be code that can never be reached or observed.
  const scaled: EnergyBudgetDesign = {
    ...design,
    harvestAt: (t) => design.harvestAt(t) * MILLIWATT_SEARCH_GAIN,
    loads: design.loads.map((l) => ({ ...l, watts: l.watts * MILLIWATT_SEARCH_GAIN })),
  };
  const found = recommendStorageWh(scaled, groundOptions(options), 100 * MILLIWATT_SEARCH_GAIN);
  const recommendedWh = found === null ? null : found / MILLIWATT_SEARCH_GAIN;
  logger.info({ soil: config.soil.name, recommendedWh }, 'minimum viable buried-node store computed');
  return recommendedWh;
}

/**
 * @description Length of the longest continuous stretch in which a unit's combined harvest stays
 * below a threshold — THE number that sizes a buried node's store. It is also the finding this
 * slice exists to publish: a pair driven by the annual wave alone spends WEEKS below cut-in either
 * side of each ΔT sign reversal, because the wave that drives it turns over twice a year rather
 * than twice a day. Adding a shallow pair whose nulls fall on a 24 h cycle collapses that gap,
 * since the two schedules are unrelated and cannot null together for long.
 *
 * Scans in watts, so the threshold is a power. Span a full year at minimum; two years is safer,
 * because a one-year window can land its endpoints inside the null it is supposed to measure.
 * @param config - Unit design.
 * @param cutInW - Power below which the node is considered unpowered, W.
 * @param spanHours - Window to search. Use ≥ 8766 h.
 * @param stepSeconds - Sample step. Default 600 — fine enough for a 24 h diurnal null.
 * @returns Longest sub-threshold stretch in hours.
 */
export function longestHarvestGapHours(
  config: GroundUnitConfig,
  cutInW: number,
  spanHours: number,
  stepSeconds = 600,
): number {
  const hours = longestGapHours((t) => groundHarvestW(config, t), cutInW, spanHours, stepSeconds);
  logger.debug({ soil: config.soil.name, cutInW, spanHours, longestHarvestGapHours: hours }, 'longest sub-cut-in stretch computed');
  return hours;
}
