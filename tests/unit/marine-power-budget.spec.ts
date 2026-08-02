/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — proofs for the marine slice: cube law,
 *                     |                             | the 4/(3π) mean-cube result, the emergent spring/neap
 *                     |                             | beat, and the design trap that a mean-power budget
 *                     |                             | passes but a simulated neap kills.
 */

import { describe, expect, it } from 'vitest';
import {
  MODERATE_INLET_SITE,
  SINUSOID_MEAN_CUBE_FACTOR,
  STANDARD_CONSTITUENT_PERIODS_H,
  STRONG_CHANNEL_SITE,
  constituent,
  currentSpeedAt,
  longestSlackHours,
  recommendStorageWh,
  simulatePowerBudget,
  totalDrawW,
  turbinePowerW,
  type MarineUnitConfig,
  type TurbineConfig,
} from '@/features/marine';

const M2_PERIOD_H = STANDARD_CONSTITUENT_PERIODS_H.M2;

const IDEAL_TURBINE: TurbineConfig = {
  sweptAreaM2: 0.5,
  powerCoefficient: 0.4,
  drivetrainEfficiency: 0.8,
  cutInSpeedMs: 0,
  ratedPowerW: 1e9,
};

const REAL_TURBINE: TurbineConfig = {
  sweptAreaM2: 0.5,
  powerCoefficient: 0.4,
  drivetrainEfficiency: 0.8,
  cutInSpeedMs: 0.35,
  ratedPowerW: 120,
};

/**
 * @description Assemble a unit design for a test.
 * @param site - Site model.
 * @param turbine - Harvester model.
 * @param capacityWh - Store nameplate.
 * @param loadW - Continuous load, W.
 * @returns A complete config.
 */
function unit(site: MarineUnitConfig['site'], turbine: TurbineConfig, capacityWh: number, loadW: number): MarineUnitConfig {
  return {
    site,
    turbine,
    loads: [{ name: 'avionics', watts: loadW, dutyCycle: 1 }],
    storage: { capacityWh, initialSocFraction: 1, roundTripEfficiency: 0.9, usableDepthOfDischarge: 0.8 },
  };
}

describe('tidal harmonic model', () => {
  it('carries the astronomical constituent periods, not tuned values', () => {
    expect(STANDARD_CONSTITUENT_PERIODS_H.M2).toBeCloseTo(12.4206012, 6);
    expect(STANDARD_CONSTITUENT_PERIODS_H.S2).toBe(12);
    expect(STANDARD_CONSTITUENT_PERIODS_H.K1).toBeCloseTo(23.9344696, 6);
  });

  it('rejects an unknown constituent rather than silently defaulting a period', () => {
    expect(() => constituent('M3', 1)).toThrow(/unknown tidal constituent/);
  });

  it('repeats exactly one M2 period later — the basis of decades-ahead predictability', () => {
    const site = { name: 't', constituents: [constituent('M2', 1.5, 40)] };
    const a = currentSpeedAt(site, 3600);
    const b = currentSpeedAt(site, 3600 + M2_PERIOD_H * 3600);
    expect(b).toBeCloseTo(a, 9);
  });

  it('produces a spring/neap beat from M2+S2 that no parameter sets', () => {
    const site = { name: 'beat', constituents: [constituent('M2', 1.0), constituent('S2', 0.4)] };
    // Springs at t=0 (in phase, 1.4 m/s); neaps a half-beat later (~177 h, 0.6 m/s).
    const springPeak = Math.abs(currentSpeedAt(site, 0));
    const halfBeatS = 177.2 * 3600;
    let neapPeak = 0;
    for (let t = halfBeatS - 6 * 3600; t <= halfBeatS + 6 * 3600; t += 60) {
      neapPeak = Math.max(neapPeak, Math.abs(currentSpeedAt(site, t)));
    }
    expect(springPeak).toBeCloseTo(1.4, 3);
    expect(neapPeak).toBeLessThan(0.75);
  });
});

describe('turbine harvest', () => {
  it('follows the cube law — double the flow is eight times the power', () => {
    const p1 = turbinePowerW(IDEAL_TURBINE, 1);
    const p2 = turbinePowerW(IDEAL_TURBINE, 2);
    expect(p2 / p1).toBeCloseTo(8, 6);
  });

  it('harvests either flow direction', () => {
    expect(turbinePowerW(IDEAL_TURBINE, -1.4)).toBeCloseTo(turbinePowerW(IDEAL_TURBINE, 1.4), 9);
  });

  it('produces nothing below cut-in and clamps at rated', () => {
    expect(turbinePowerW(REAL_TURBINE, 0.34)).toBe(0);
    expect(turbinePowerW(REAL_TURBINE, 0.36)).toBeGreaterThan(0);
    expect(turbinePowerW(REAL_TURBINE, 5)).toBe(REAL_TURBINE.ratedPowerW);
  });

  it('averages 4/(3pi) of PEAK-speed power over a sinusoid, not the power at mean speed', () => {
    const amplitude = 1.5;
    const site = { name: 'pure-m2', constituents: [constituent('M2', amplitude)] };
    const { verdict } = simulatePowerBudget(unit(site, IDEAL_TURBINE, 1e6, 0), {
      durationHours: M2_PERIOD_H * 40,
      stepSeconds: 10,
    });
    const peakPower = turbinePowerW(IDEAL_TURBINE, amplitude);
    expect(verdict.meanHarvestW / peakPower).toBeCloseTo(SINUSOID_MEAN_CUBE_FACTOR, 3);
    // Jensen: the cube is convex, so mean-of-cubes BEATS cube-of-mean. A budget built on the
    // mean speed understates real harvest by exactly 6/pi^2 — flow variability is a bonus
    // here, not a penalty. Guard the direction as well as the magnitude.
    const naive = turbinePowerW(IDEAL_TURBINE, (2 / Math.PI) * amplitude);
    expect(naive / verdict.meanHarvestW).toBeCloseTo(6 / Math.PI ** 2, 3);
    expect(naive).toBeLessThan(verdict.meanHarvestW);
  });
});

describe('slack water and neap gaps', () => {
  it('finds a sub-cut-in gap far longer than one slack tide at a moderate site', () => {
    const gap = longestSlackHours(MODERATE_INLET_SITE, REAL_TURBINE.cutInSpeedMs, 720);
    // Naive intuition says ~1 h of slack; the neap minimum is what actually sizes the pack.
    expect(gap).toBeGreaterThan(2);
  });

  it('reports a shorter worst-case gap at a strong site than a moderate one', () => {
    const strong = longestSlackHours(STRONG_CHANNEL_SITE, REAL_TURBINE.cutInSpeedMs, 720);
    const moderate = longestSlackHours(MODERATE_INLET_SITE, REAL_TURBINE.cutInSpeedMs, 720);
    expect(strong).toBeLessThan(moderate);
  });
});

describe('perpetual verdict', () => {
  it('passes a real design at a strong site with an adequate store', () => {
    const { verdict } = simulatePowerBudget(unit(STRONG_CHANNEL_SITE, REAL_TURBINE, 500, 3));
    expect(verdict.marginRatio).toBeGreaterThan(1);
    expect(verdict.perpetual).toBe(true);
    expect(verdict.brownoutHours).toBe(0);
  });

  it('THE TRAP: surplus average power still browns out on an undersized store', () => {
    // 18 W of load against ~28 W of mean harvest — comfortably in surplus on paper.
    const design = unit(MODERATE_INLET_SITE, REAL_TURBINE, 5, 18);
    const { verdict } = simulatePowerBudget(design);
    // A mean-power budget signs this off — harvest exceeds load on average...
    expect(verdict.marginRatio).toBeGreaterThan(1);
    // ...and the node is dead anyway, because average power is not a schedule.
    expect(verdict.perpetual).toBe(false);
    expect(verdict.brownoutHours).toBeGreaterThan(0);
  });

  it('sizes the store off the accumulated neap deficit, not off one slack tide', () => {
    const design = unit(MODERATE_INLET_SITE, REAL_TURBINE, 5, 18);
    const oneGapWh = 18 * longestSlackHours(MODERATE_INLET_SITE, REAL_TURBINE.cutInSpeedMs, 720);
    const recommended = recommendStorageWh(design);
    expect(recommended).not.toBeNull();
    // Neaps run a multi-day deficit that no single-gap rule of thumb anticipates.
    expect(recommended as number).toBeGreaterThan(oneGapWh * 2);
  });

  it('rejects a design whose harvest is genuinely short, at any store size', () => {
    expect(recommendStorageWh(unit(MODERATE_INLET_SITE, REAL_TURBINE, 100, 60))).toBeNull();
  });

  it('recommends a store that survives, and proves one notch smaller does not', () => {
    const design = unit(STRONG_CHANNEL_SITE, REAL_TURBINE, 1, 3);
    const recommended = recommendStorageWh(design);
    expect(recommended).not.toBeNull();
    const at = (capacityWh: number) =>
      simulatePowerBudget({ ...design, storage: { ...design.storage, capacityWh } }).verdict.perpetual;
    expect(at(recommended as number)).toBe(true);
    expect(at((recommended as number) * 0.9)).toBe(false);
  });

  it('counts curtailment when the harvester outruns the store', () => {
    const { verdict } = simulatePowerBudget(unit(STRONG_CHANNEL_SITE, REAL_TURBINE, 50, 1));
    expect(verdict.curtailedWh).toBeGreaterThan(0);
  });
});

describe('load model', () => {
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
