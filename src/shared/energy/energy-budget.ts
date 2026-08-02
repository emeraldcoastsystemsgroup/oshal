/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — the closed-loop energy budget lifted out
 *                     |                             | of the marine slice with its arithmetic untouched. The
 *                     |                             | integration order, the pre-efficiency curtailment term and
 *                     |                             | the binary-search tolerance are all load-bearing: they are
 *                     |                             | what make "perpetual" a simulated verdict rather than a
 *                     |                             | mean-power hand-wave that passes designs which die at the
 *                     |                             | first lull.
 */

import { createChildLogger } from '@/shared/logger';
import type {
  EnergyBudgetDesign,
  EnergyBudgetSample,
  EnergyBudgetVerdict,
  PowerLoad,
  StorageConfig,
} from './energy-types';

const logger = createChildLogger({ module: 'shared:energy-budget' });

/** @description Default run: 30 days, long enough to contain a full multi-day environmental cycle. */
export const DEFAULT_DURATION_HOURS = 720;

/**
 * @description Options for {@link simulateEnergyBudget}.
 */
export interface EnergyBudgetOptions {
  /** Simulated span, hours. Default 720. Too short a span cannot see the environment's worst stretch. */
  durationHours?: number;
  /** Integration step, seconds. Default 60. */
  stepSeconds?: number;
  /** Retain one plot sample per this many minutes. Default 30. */
  sampleEveryMinutes?: number;
}

/**
 * @description Verdict plus the retained timeseries behind it.
 */
export interface EnergyBudgetResult {
  /** The scalar verdict. */
  verdict: EnergyBudgetVerdict;
  /** Downsampled timeseries for plotting the harvest envelope. */
  samples: EnergyBudgetSample[];
}

/**
 * @description Duty-cycle-weighted mean draw of a load set.
 * @param loads - Every electrical load on the unit.
 * @returns Mean total draw, W.
 */
export function totalDrawW(loads: PowerLoad[]): number {
  return loads.reduce((sum, l) => sum + l.watts * l.dutyCycle, 0);
}

/** @description Mutable accumulator threaded through the integration loop. */
interface BudgetState {
  socWh: number;
  harvestedWh: number;
  consumedWh: number;
  curtailedWh: number;
  brownoutSeconds: number;
  minSocWh: number;
  minSocAtSeconds: number;
}

/**
 * @description Advance the store by one timestep. Charge pays the round-trip efficiency;
 * discharge does not (standard single-sided model). Energy that cannot be stored — pack full
 * or harvester clamped — is counted as curtailed, which is the signal that the harvester is
 * oversized relative to the store rather than the environment being generous.
 * @param state - Accumulator, mutated in place.
 * @param storage - Store model.
 * @param netWh - Harvest minus draw for this step, Wh (signed).
 * @param floorWh - Absolute store level treated as empty.
 * @param stepSeconds - Step length, seconds.
 * @returns Nothing; `state` is mutated.
 */
function stepStore(state: BudgetState, storage: StorageConfig, netWh: number, floorWh: number, stepSeconds: number): void {
  const { capacityWh, roundTripEfficiency } = storage;
  if (netWh >= 0) {
    const room = capacityWh - state.socWh;
    const stored = Math.min(netWh * roundTripEfficiency, room);
    state.socWh += stored;
    state.curtailedWh += netWh - stored / roundTripEfficiency;
  } else {
    const deficit = -netWh;
    const available = Math.max(0, state.socWh - floorWh);
    const drawn = Math.min(deficit, available);
    state.socWh -= drawn;
    if (drawn < deficit) state.brownoutSeconds += stepSeconds;
  }
}

/**
 * @description Simulate a persistent node's energy over a full environmental cycle and return
 * whether the design actually closes. This is the honest form of "it runs forever": the run must
 * never brown out AND must end at or above its starting charge, so a design that merely drains
 * slowly is correctly rejected.
 * @param design - Label, harvest sampler, loads and store.
 * @param options - Span, step and sampling.
 * @returns Verdict plus the retained timeseries.
 */
export function simulateEnergyBudget(design: EnergyBudgetDesign, options: EnergyBudgetOptions = {}): EnergyBudgetResult {
  const durationHours = options.durationHours ?? DEFAULT_DURATION_HOURS;
  const stepSeconds = options.stepSeconds ?? 60;
  const sampleEvery = Math.max(1, Math.round(((options.sampleEveryMinutes ?? 30) * 60) / stepSeconds));
  const { capacityWh, initialSocFraction, usableDepthOfDischarge } = design.storage;
  const floorWh = capacityWh * (1 - usableDepthOfDischarge);
  const startSocWh = capacityWh * initialSocFraction;
  const drawW = totalDrawW(design.loads);
  const dtHours = stepSeconds / 3600;
  const steps = Math.ceil((durationHours * 3600) / stepSeconds);

  const state: BudgetState = {
    socWh: startSocWh,
    harvestedWh: 0,
    consumedWh: 0,
    curtailedWh: 0,
    brownoutSeconds: 0,
    minSocWh: startSocWh,
    minSocAtSeconds: 0,
  };
  const samples: EnergyBudgetSample[] = [];

  for (let i = 0; i < steps; i += 1) {
    const t = i * stepSeconds;
    const harvestW = design.harvestAt(t);
    state.harvestedWh += harvestW * dtHours;
    state.consumedWh += drawW * dtHours;
    stepStore(state, design.storage, (harvestW - drawW) * dtHours, floorWh, stepSeconds);
    if (state.socWh < state.minSocWh) {
      state.minSocWh = state.socWh;
      state.minSocAtSeconds = t;
    }
    if (i % sampleEvery === 0) {
      samples.push({ tHours: t / 3600, harvestW, drawW, socWh: state.socWh, socFraction: state.socWh / capacityWh });
    }
  }

  const verdict = buildVerdict(design.label, capacityWh, state, durationHours, startSocWh);
  logger.info(
    { label: verdict.label, perpetual: verdict.perpetual, marginRatio: verdict.marginRatio, minSocFraction: verdict.minSocFraction },
    'energy budget simulated',
  );
  return { verdict, samples };
}

/**
 * @description Collapse the accumulator into the scalar verdict.
 * @param label - Design label.
 * @param capacityWh - Store nameplate, the denominator for every SoC fraction.
 * @param state - Accumulator after the run.
 * @param durationHours - Simulated span.
 * @param startSocWh - Store level at t=0.
 * @returns The verdict.
 */
function buildVerdict(
  label: string,
  capacityWh: number,
  state: BudgetState,
  durationHours: number,
  startSocWh: number,
): EnergyBudgetVerdict {
  return {
    perpetual: state.brownoutSeconds === 0 && state.socWh >= startSocWh,
    label,
    durationHours,
    minSocFraction: state.minSocWh / capacityWh,
    minSocAtHours: state.minSocAtSeconds / 3600,
    brownoutHours: state.brownoutSeconds / 3600,
    harvestedWh: state.harvestedWh,
    consumedWh: state.consumedWh,
    curtailedWh: state.curtailedWh,
    marginRatio: state.consumedWh > 0 ? state.harvestedWh / state.consumedWh : Infinity,
    meanHarvestW: state.harvestedWh / durationHours,
    meanDrawW: state.consumedWh / durationHours,
  };
}

/**
 * @description Smallest store, in Wh, that makes a design perpetual — the answer to "how big
 * does the battery have to be". Binary search over capacity, starting each trial full.
 * Returns null when no capacity works, which means the harvest itself is short (marginRatio
 * below 1) and more battery cannot fix it.
 * @param design - Unit design; its `storage.capacityWh` is overridden per trial. `harvestAt` is a
 * pure function of time, so it rides through the per-trial spread unchanged.
 * @param options - Passed through to the simulation. Use ≥ 720 h.
 * @param maxCapacityWh - Upper bound for the search, Wh. Default 100 kWh.
 * @returns Minimum viable capacity in Wh, or null if the design can never close.
 */
export function recommendStorageWh(
  design: EnergyBudgetDesign,
  options: EnergyBudgetOptions = {},
  maxCapacityWh = 100_000,
): number | null {
  const trial = (capacityWh: number): boolean =>
    simulateEnergyBudget({ ...design, storage: { ...design.storage, capacityWh, initialSocFraction: 1 } }, options).verdict.perpetual;

  if (!trial(maxCapacityWh)) {
    logger.warn({ label: design.label, maxCapacityWh }, 'no store size closes this design — harvest is short of load');
    return null;
  }
  let lo = 0;
  let hi = maxCapacityWh;
  for (let i = 0; i < 40 && hi - lo > 0.5; i += 1) {
    const mid = (lo + hi) / 2;
    if (trial(mid)) hi = mid;
    else lo = mid;
  }
  logger.info({ label: design.label, recommendedWh: hi }, 'minimum viable store computed');
  return hi;
}
