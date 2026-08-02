/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — proofs for the extracted @/shared/energy
 *                     |                             | core in isolation, on square-wave harvests whose answers are
 *                     |                             | derivable by hand. The marine spec proves the engine against
 *                     |                             | tides; these prove the four semantics the engine PROMISES
 *                     |                             | (efficiency on charge only, pre-efficiency curtailment, the
 *                     |                             | depth-of-discharge floor, and a two-condition perpetual
 *                     |                             | predicate) which no tidal test isolates. Closes with a
 *                     |                             | bit-exact parity pin on the marine numbers, so an ULP-level
 *                     |                             | regression inside stepStore fails here rather than silently.
 */

import { describe, expect, it } from 'vitest';
import {
  longestGapHours,
  recommendStorageWh,
  simulateEnergyBudget,
  totalDrawW,
  type EnergyBudgetDesign,
  type HarvestSampler,
  type StorageConfig,
} from '@/shared/energy';
import {
  MODERATE_INLET_SITE,
  STRONG_CHANNEL_SITE,
  longestSlackHours,
  recommendStorageWh as recommendMarineStorageWh,
  simulatePowerBudget,
  type MarineUnitConfig,
  type TurbineConfig,
} from '@/features/marine';

/**
 * @description One-hour integration steps, so every quantity in this file is a whole number of
 * watt-hours and each assertion can be derived on paper rather than read off the implementation.
 */
const HOURLY = { stepSeconds: 3600, sampleEveryMinutes: 60 } as const;

/**
 * @description A store with no depth-of-discharge limit — floor at zero — so tests that are
 * about efficiency or curtailment are not also implicitly about the floor.
 * @param capacityWh - Nameplate.
 * @param initialSocFraction - Starting charge, 0..1.
 * @returns Store config with rte 0.9 and full usable depth.
 */
function store(capacityWh: number, initialSocFraction: number): StorageConfig {
  return { capacityWh, initialSocFraction, roundTripEfficiency: 0.9, usableDepthOfDischarge: 1 };
}

/**
 * @description Assemble a generic design from a harvest sampler and a single constant load.
 * @param harvestAt - Harvest sampler, W.
 * @param loadW - Continuous load, W.
 * @param storage - Store config.
 * @returns A complete harvest-agnostic design.
 */
function design(harvestAt: HarvestSampler, loadW: number, storage: StorageConfig): EnergyBudgetDesign {
  return { label: 'probe', harvestAt, loads: [{ name: 'payload', watts: loadW, dutyCycle: 1 }], storage };
}

/** @description Harvest sampler that is dark at every instant — isolates the discharge path. */
const DARK: HarvestSampler = () => 0;

/**
 * @description Twelve hours on at `onW`, twelve hours dark, repeating. Stands in for any
 * environment with a predictable dark stretch; the dark half is what sizes the store.
 * @param onW - Power during the lit half, W.
 * @returns A day/night harvest sampler.
 */
function dayNight(onW: number): HarvestSampler {
  return (t) => (Math.floor(t / 3600) % 24 < 12 ? onW : 0);
}

describe('round-trip efficiency is paid on charge and only on charge', () => {
  it('stores rte x the surplus, not the whole surplus', () => {
    const { samples } = simulateEnergyBudget(design(() => 10, 0, store(1000, 0.5)), { durationHours: 1, ...HOURLY });
    // 10 Wh arrives at the terminals; 0.9 of it lands in the pack. 510 would mean rte was skipped.
    expect(samples[0].socWh).toBe(509);
  });

  it('draws the deficit straight out, without inflating it by rte', () => {
    const { samples } = simulateEnergyBudget(design(DARK, 10, store(1000, 0.5)), { durationHours: 1, ...HOURLY });
    // 500 - 10. A double-sided model would charge 10/0.9 and land on 488.89.
    expect(samples[0].socWh).toBe(490);
  });

  it('loses exactly (1 - rte) over a charge/discharge round trip', () => {
    const oneHourOn: HarvestSampler = (t) => (t < 3600 ? 20 : 0);
    const { samples } = simulateEnergyBudget(design(oneHourOn, 10, store(1000, 0.5)), { durationHours: 2, ...HOURLY });
    expect(samples[0].socWh).toBe(509); // +10 Wh in, 9 Wh kept
    expect(samples[1].socWh).toBe(499); // -10 Wh out, 10 Wh gone
    // The asymmetry IS the round-trip loss: 10 Wh cycled through the pack costs 1 Wh.
    expect(500 - samples[1].socWh).toBe(1);
  });
});

describe('curtailment counts pre-efficiency energy', () => {
  it('discards the whole surplus when the pack has no room', () => {
    const { verdict } = simulateEnergyBudget(design(() => 10, 0, store(100, 1)), { durationHours: 1, ...HOURLY });
    expect(verdict.harvestedWh).toBe(10);
    expect(verdict.curtailedWh).toBe(10);
  });

  it('charges curtailment at the terminals, not at the pack', () => {
    // Room for 5 Wh of stored energy. Filling it consumed 5/0.9 = 5.556 Wh of harvest, so
    // 4.444 Wh of the 10 Wh harvested was thrown away — NOT 5.0, which is what counting the
    // post-efficiency shortfall (netWh - stored) would report.
    const { verdict } = simulateEnergyBudget(design(() => 10, 0, store(10, 0.5)), { durationHours: 1, ...HOURLY });
    expect(verdict.curtailedWh).toBeCloseTo(10 - 5 / 0.9, 12);
    expect(verdict.curtailedWh).toBeCloseTo(4.444444444444445, 12);
    expect(verdict.curtailedWh).not.toBeCloseTo(5, 6);
  });

  it('curtails nothing while the pack still has room', () => {
    const { verdict } = simulateEnergyBudget(design(() => 10, 0, store(1000, 0.5)), { durationHours: 1, ...HOURLY });
    expect(verdict.curtailedWh).toBe(0);
  });
});

describe('the brownout floor comes from depth of discharge', () => {
  it('stops discharging at capacity x (1 - dod) and counts every starved step', () => {
    const storage: StorageConfig = { capacityWh: 100, initialSocFraction: 1, roundTripEfficiency: 0.9, usableDepthOfDischarge: 0.8 };
    const { verdict } = simulateEnergyBudget(design(DARK, 10, storage), { durationHours: 20, ...HOURLY });
    // Floor is 100 x (1 - 0.8) = 20 Wh, so 80 Wh is usable: 8 h of draw, then 12 h starved.
    // Inverting the floor to capacity x dod would put it at 80, drain in 2 h and brown out for 18.
    expect(verdict.minSocFraction).toBeCloseTo(0.2, 12);
    expect(verdict.minSocAtHours).toBe(8);
    expect(verdict.brownoutHours).toBe(12);
  });

  it('counts a partially met deficit as a full browned-out step', () => {
    const storage: StorageConfig = { capacityWh: 100, initialSocFraction: 0.25, roundTripEfficiency: 0.9, usableDepthOfDischarge: 0.8 };
    // 25 Wh in the pack, 20 Wh of it below the floor: the first hour can only serve 5 of its
    // 10 Wh and is still a brownout hour. Two dark hours -> two brownout hours.
    const { verdict } = simulateEnergyBudget(design(DARK, 10, storage), { durationHours: 2, ...HOURLY });
    expect(verdict.brownoutHours).toBe(2);
    expect(verdict.minSocFraction).toBeCloseTo(0.2, 12);
  });
});

describe('perpetual needs BOTH conditions, and each one alone is not enough', () => {
  it('rejects a run that never browned out but ended down on charge', () => {
    const { verdict, samples } = simulateEnergyBudget(design(DARK, 10, store(100, 1)), { durationHours: 5, ...HOURLY });
    // The honest half of the predicate: this node is not perpetual, it is merely slow.
    expect(verdict.brownoutHours).toBe(0);
    expect(samples[4].socWh).toBe(50);
    expect(verdict.perpetual).toBe(false);
  });

  it('rejects a run that ended full but browned out on the way', () => {
    const lateStart: HarvestSampler = (t) => (t < 2 * 3600 ? 0 : 100);
    const storage: StorageConfig = { capacityWh: 100, initialSocFraction: 0.25, roundTripEfficiency: 0.9, usableDepthOfDischarge: 0.8 };
    const { verdict, samples } = simulateEnergyBudget(design(lateStart, 10, storage), { durationHours: 6, ...HOURLY });
    expect(verdict.brownoutHours).toBe(2);
    expect(samples[5].socWh).toBe(100); // ends full, well above the 25 Wh it started with
    expect(verdict.perpetual).toBe(false);
  });

  it('accepts a run that never starved and closed up on charge', () => {
    const { verdict, samples } = simulateEnergyBudget(design(() => 20, 10, store(100, 0.5)), { durationHours: 10, ...HOURLY });
    expect(verdict.brownoutHours).toBe(0);
    expect(samples[9].socWh).toBe(100);
    expect(verdict.perpetual).toBe(true);
  });

  it('overshoots a partial final step rather than truncating the span', () => {
    // 1.5 h at 1 h steps is 2 steps, not 1: the loop rounds the step count UP, so it simulates
    // slightly PAST the nominal span. The mean then divides by the nominal span, not by the
    // simulated one — 2 Wh over a nominal 1.5 h is 1.33 W, and reporting 1.0 W would mean the
    // divisor had quietly become steps x dtHours.
    const { verdict, samples } = simulateEnergyBudget(design(() => 1, 0, store(1000, 0)), {
      durationHours: 1.5,
      ...HOURLY,
    });
    expect(samples).toHaveLength(2);
    expect(verdict.harvestedWh).toBe(2);
    expect(verdict.durationHours).toBe(1.5);
    expect(verdict.meanHarvestW).toBeCloseTo(4 / 3, 12);
  });

  it('reports infinite margin rather than NaN when nothing is consumed', () => {
    const { verdict } = simulateEnergyBudget({ label: 'idle', harvestAt: DARK, loads: [], storage: store(100, 1) }, {
      durationHours: 1,
      ...HOURLY,
    });
    // 0 harvested / 0 consumed is the case that turns a bare division into NaN.
    expect(verdict.consumedWh).toBe(0);
    expect(verdict.marginRatio).toBe(Infinity);
  });
});

describe('recommendStorageWh finds the true critical capacity', () => {
  const NIGHTLY = design(dayNight(30), 10, store(0, 1));

  it('lands on the analytic answer and proves 0.9x of it does not survive', () => {
    // 12 dark hours x 10 W = 120 Wh must come out of the pack. Anything smaller starves.
    const recommended = recommendStorageWh(NIGHTLY, { durationHours: 252, ...HOURLY });
    expect(recommended).not.toBeNull();
    const rec = recommended as number;
    expect(rec).toBeGreaterThanOrEqual(120);
    expect(rec).toBeLessThan(120.5); // the search's 0.5 Wh tolerance, measured against 120

    const at = (capacityWh: number) =>
      simulateEnergyBudget({ ...NIGHTLY, storage: { ...NIGHTLY.storage, capacityWh, initialSocFraction: 1 } }, {
        durationHours: 252,
        ...HOURLY,
      }).verdict.perpetual;
    expect(at(rec)).toBe(true);
    expect(at(rec * 0.9)).toBe(false);
    // And the answer is genuinely critical, not merely sufficient: one Wh under it fails.
    expect(at(rec - 1)).toBe(false);
  });

  it('returns null when the harvest itself is short, at any store size', () => {
    // 12 h x 5 W harvested against 24 h x 10 W drawn — no battery closes a losing budget.
    const starved = design(dayNight(5), 10, store(0, 1));
    expect(recommendStorageWh(starved, { durationHours: 252, ...HOURLY })).toBeNull();
  });
});

describe('longestGapHours', () => {
  it('measures the longest sub-threshold stretch, in hours', () => {
    expect(longestGapHours(dayNight(30), 1, 48, 3600)).toBe(12);
  });

  it('treats a sample exactly at the threshold as harvesting, not as a gap', () => {
    // Strict `<`. Flipping it to `<=` would report the whole span as one gap.
    expect(longestGapHours(() => 5, 5, 10, 3600)).toBe(0);
    expect(longestGapHours(() => 4.999, 5, 10, 3600)).toBe(10);
  });

  it('rounds a partial final step up, matching the budget loop', () => {
    // 2.5 h at 1 h steps is 3 samples, all dark, so the gap reads 3 h. Truncating to 2 steps
    // would under-report the very stretch this function exists to size a battery against.
    expect(longestGapHours(DARK, 1, 2.5, 3600)).toBe(3);
  });

  it('is unit-agnostic — the sampler and the threshold only have to agree', () => {
    // The same schedule expressed in m/s rather than W yields the same gap, which is exactly
    // why the marine wrapper is allowed to scan pre-cube speeds.
    const speeds: HarvestSampler = (t) => (Math.floor(t / 3600) % 24 < 12 ? 1.8 : 0.1);
    expect(longestGapHours(speeds, 0.35, 48, 3600)).toBe(12);
  });
});

describe('totalDrawW', () => {
  it('weights each load by its duty cycle', () => {
    expect(
      totalDrawW([
        { name: 'cpu', watts: 0.2, dutyCycle: 1 },
        { name: 'iridium', watts: 7, dutyCycle: 0.01 },
        { name: 'ctd', watts: 1.5, dutyCycle: 0.1 },
      ]),
    ).toBeCloseTo(0.2 + 0.07 + 0.15, 9);
  });
});

const REAL_TURBINE: TurbineConfig = {
  sweptAreaM2: 0.5,
  powerCoefficient: 0.4,
  drivetrainEfficiency: 0.8,
  cutInSpeedMs: 0.35,
  ratedPowerW: 120,
};

/**
 * @description Assemble the same marine design the marine spec uses, so the parity pins below
 * compare like with like.
 * @param site - Site model.
 * @param capacityWh - Store nameplate.
 * @param loadW - Continuous load, W.
 * @returns A complete marine config.
 */
function marineUnit(site: MarineUnitConfig['site'], capacityWh: number, loadW: number): MarineUnitConfig {
  return {
    site,
    turbine: REAL_TURBINE,
    loads: [{ name: 'avionics', watts: loadW, dutyCycle: 1 }],
    storage: { capacityWh, initialSocFraction: 1, roundTripEfficiency: 0.9, usableDepthOfDischarge: 0.8 },
  };
}

describe('extraction parity — marine is bit-identical after the engine moved to shared', () => {
  // The marine spec's own guards are mostly inequalities (perpetual true/false, curtailed > 0).
  // Those survive an ULP-level drift inside the integration loop; these pins do not. Captured
  // from the marine slice BEFORE the extraction and reproduced exactly after it.
  it('reproduces the strong-site verdict to full double precision', () => {
    const { verdict } = simulatePowerBudget(marineUnit(STRONG_CHANNEL_SITE, 500, 3));
    expect(verdict.harvestedWh).toBe(59506.69547957435);
    expect(verdict.consumedWh).toBe(2159.9999999990923);
    expect(verdict.curtailedWh).toBe(57317.906590660146);
    expect(verdict.minSocFraction).toBe(0.9921999999999982);
    expect(verdict.minSocAtHours).toBe(190.48333333333332);
    expect(verdict.meanHarvestW).toBe(82.64818816607549);
    expect(verdict.brownoutHours).toBe(0);
    expect(verdict.siteName).toBe('illustrative-strong-channel');
    expect(verdict.label).toBe('illustrative-strong-channel');
  });

  it('reproduces the undersized-store trap to full double precision', () => {
    const { verdict } = simulatePowerBudget(marineUnit(MODERATE_INLET_SITE, 5, 18));
    expect(verdict.harvestedWh).toBe(19897.49798935706);
    expect(verdict.consumedWh).toBe(12959.999999991942);
    expect(verdict.curtailedWh).toBe(11795.863527271758);
    expect(verdict.brownoutHours).toBe(345.78333333333336);
    expect(verdict.marginRatio).toBe(1.5353007707846784);
    expect(verdict.minSocFraction).toBe(0.19999999999999996);
  });

  it('reproduces the curtailment total and both gap scans exactly', () => {
    expect(simulatePowerBudget(marineUnit(STRONG_CHANNEL_SITE, 50, 1)).verdict.curtailedWh).toBe(58777.09918324213);
    expect(longestSlackHours(MODERATE_INLET_SITE, REAL_TURBINE.cutInSpeedMs, 720)).toBe(3.05);
    expect(longestSlackHours(STRONG_CHANNEL_SITE, REAL_TURBINE.cutInSpeedMs, 720)).toBe(1.3);
  });

  it('reproduces every store recommendation exactly', () => {
    expect(recommendMarineStorageWh(marineUnit(MODERATE_INLET_SITE, 5, 18))).toBe(1430.8929443359375);
    expect(recommendMarineStorageWh(marineUnit(MODERATE_INLET_SITE, 100, 60))).toBeNull();
    expect(recommendMarineStorageWh(marineUnit(STRONG_CHANNEL_SITE, 1, 3))).toBe(4.9591064453125);
  });

  it('still carries the flow speed on every retained sample', () => {
    const { samples } = simulatePowerBudget(marineUnit(STRONG_CHANNEL_SITE, 500, 3));
    expect(samples.length).toBeGreaterThan(0);
    // currentMs is the marine widening the generic sample cannot carry; it must survive the map.
    expect(samples.every((s) => Number.isFinite(s.currentMs))).toBe(true);
    expect(samples.some((s) => s.currentMs < 0)).toBe(true);
  });
});
