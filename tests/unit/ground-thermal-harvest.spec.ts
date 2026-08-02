/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — proofs for the ground slice: the two
 *                     |                             | damping depths that are the model's signature, the 1/e-and-
 *                     |                             | one-radian coupling, the seasonal inversion at pi*d, the
 *                     |                             | negligible-but-wired geothermal term, thermal impedance
 *                     |                             | matching as THE design lever, and the equinox null — the
 *                     |                             | multi-week outage an annual-only harvester cannot avoid and
 *                     |                             | a second shallow pair erases.
 */

import { describe, expect, it } from 'vitest';
import {
  ANNUAL_PERIOD_S,
  DEFAULT_GEOTHERMAL_GRADIENT_KM,
  DEFAULT_GROUND_DURATION_HOURS,
  DEFAULT_SOIL,
  DIURNAL_PERIOD_S,
  DRY_SAND_SOIL,
  WET_CLAY_SOIL,
  dampingDepthM,
  groundHarvestW,
  junctionDeltaTK,
  longestHarvestGapHours,
  matchedModuleResistanceKW,
  recommendGroundStorageWh,
  simulateGroundBudget,
  soilTempC,
  tegPowerW,
  type GroundUnitConfig,
  type JunctionPair,
  type SoilProfile,
  type TegModuleConfig,
} from '@/features/ground';

/** Collector plate area shared by every fixture module, m². */
const AREA_M2 = 0.25;

/** Converter cold-start threshold shared by every fixture module, W (50 µW — a real LTC3108-class figure). */
const CUT_IN_W = 5e-5;

/** Two-year scan window, hours. One year can land its endpoints inside the null it is meant to measure. */
const TWO_YEAR_SPAN_H = (2 * ANNUAL_PERIOD_S) / 3600;

/**
 * @description Build a module. Defaults are deliberately non-limiting (huge rated clamp, no
 * cut-in) so a test measuring the resistance network never accidentally measures a clamp instead.
 * @param moduleResistanceKW - Module thermal resistance, K/W.
 * @param ratedPowerW - Electrical clamp, W.
 * @param cutInPowerW - Converter cold-start threshold, W.
 * @returns A module config.
 */
function teg(moduleResistanceKW: number, ratedPowerW = 1e9, cutInPowerW = 0): TegModuleConfig {
  return { collectorAreaM2: AREA_M2, moduleResistanceKW, ztBar: 0.9, ratedPowerW, cutInPowerW };
}

/**
 * @description A single-wave soil used to isolate one harmonic. Zero diurnal amplitude and zero
 * geothermal term mean every reading is the annual wave and nothing else, which is what makes the
 * 1/e and one-radian assertions exact rather than approximate.
 * @param annualAmplitudeC - Surface amplitude of the annual wave, °C.
 * @returns A soil profile carrying only that wave.
 */
function annualOnlySoil(annualAmplitudeC: number): SoilProfile {
  return {
    name: 'probe-annual-only',
    thermalDiffusivityM2S: 0.5e-6,
    thermalConductivityWmK: 1.0,
    meanTempC: 12,
    annualAmplitudeC,
    diurnalAmplitudeC: 0,
    geothermalGradientKM: 0,
  };
}

/** Deep pair, 1 m ↔ 3 m: far below the diurnal damping depth, so it is driven by the annual wave alone. */
const DEEP_PAIR: JunctionPair = {
  name: 'annual-deep',
  hotDepthM: 1.0,
  coldDepthM: 3.0,
  module: teg(matchedModuleResistanceKW(DEFAULT_SOIL, 1.0, 3.0, AREA_M2), 0.005, CUT_IN_W),
};

/** Shallow pair, 0.02 m ↔ 0.30 m: straddles the diurnal damping depth, so the day/night wave dominates it. */
const SHALLOW_PAIR: JunctionPair = {
  name: 'diurnal-shallow',
  hotDepthM: 0.02,
  coldDepthM: 0.3,
  module: teg(matchedModuleResistanceKW(DEFAULT_SOIL, 0.02, 0.3, AREA_M2), 0.02, CUT_IN_W),
};

/**
 * @description Assemble a buried-node design for a test.
 * @param pairs - Junction pairs on the unit.
 * @param loadW - Continuous load, W.
 * @param capacityWh - Store nameplate, Wh.
 * @returns A complete config in DEFAULT_SOIL.
 */
function unit(pairs: JunctionPair[], loadW: number, capacityWh: number): GroundUnitConfig {
  return {
    soil: DEFAULT_SOIL,
    pairs,
    loads: [{ name: 'sensor', watts: loadW, dutyCycle: 1 }],
    storage: { capacityWh, initialSocFraction: 1, roundTripEfficiency: 0.9, usableDepthOfDischarge: 0.8 },
  };
}

/**
 * @description Fraction of a span a unit spends below a power threshold. The worst single gap sizes
 * the store; this total is what says whether a design is starved or merely interrupted, and it is
 * the metric on which a dual-pair harvester beats its own shallow pair.
 * @param config - Unit design.
 * @param thresholdW - Power below which the node is unpowered, W.
 * @param spanSeconds - Window to scan, seconds.
 * @returns Fraction of samples below threshold, 0..1.
 */
function outageFraction(config: GroundUnitConfig, thresholdW: number, spanSeconds: number): number {
  let below = 0;
  let total = 0;
  for (let t = 0; t < spanSeconds; t += 600) {
    total += 1;
    if (groundHarvestW(config, t) < thresholdW) below += 1;
  }
  return below / total;
}

describe('soil thermal wave', () => {
  it('damps the annual wave over ~2.24 m and the diurnal wave over ~0.117 m', () => {
    // The signature of the model: same soil, same equation, damping depths a factor of 19 apart.
    expect(dampingDepthM(0.5e-6, ANNUAL_PERIOD_S)).toBeCloseTo(2.24, 2);
    expect(dampingDepthM(0.5e-6, DIURNAL_PERIOD_S)).toBeCloseTo(0.117, 3);
    expect(ANNUAL_PERIOD_S).toBe(31_557_600);
    expect(DIURNAL_PERIOD_S).toBe(86_400);
  });

  it('scales damping depth as sqrt(period), so the depth ratio is sqrt(365.25)', () => {
    const ratio = dampingDepthM(0.5e-6, ANNUAL_PERIOD_S) / dampingDepthM(0.5e-6, DIURNAL_PERIOD_S);
    expect(ratio).toBeCloseTo(Math.sqrt(365.25), 9);
    expect(ratio).toBeCloseTo(19.1115, 4);
    // Diffusivity moves both depths together — it cannot be used to separate the two waves.
    expect(dampingDepthM(2e-6, ANNUAL_PERIOD_S) / dampingDepthM(0.5e-6, ANNUAL_PERIOD_S)).toBeCloseTo(2, 12);
  });

  it('rejects a non-positive diffusivity or period instead of returning NaN', () => {
    expect(() => dampingDepthM(0, ANNUAL_PERIOD_S)).toThrow(/thermal diffusivity must be positive/);
    expect(() => dampingDepthM(-1e-6, ANNUAL_PERIOD_S)).toThrow(/thermal diffusivity must be positive/);
    expect(() => dampingDepthM(0.5e-6, 0)).toThrow(/wave period must be positive/);
  });

  it('attenuates to exactly 1/e at one damping depth', () => {
    const soil = annualOnlySoil(12);
    const d = dampingDepthM(soil.thermalDiffusivityM2S, ANNUAL_PERIOD_S);
    // At t = period/(2*pi) the phase term omega*t - z/d is exactly zero at z = d, so the reading
    // IS the envelope: whatever is left of the surface amplitude at that depth.
    const atDepth = soilTempC(soil, d, ANNUAL_PERIOD_S / (2 * Math.PI)) - soil.meanTempC;
    expect(atDepth).toBeCloseTo(12 / Math.E, 12);
    expect(atDepth / 12).toBeCloseTo(0.36787944117144233, 12);
    // Two damping depths is 1/e^2, not 1/2 of 1/e — the decay is exponential, not linear in depth.
    const atTwo = soilTempC(soil, 2 * d, (2 * ANNUAL_PERIOD_S) / (2 * Math.PI)) - soil.meanTempC;
    expect(atTwo / 12).toBeCloseTo(Math.E ** -2, 12);
  });

  it('lags the surface by exactly one radian at one damping depth — 58.13 days for the annual wave', () => {
    const soil = annualOnlySoil(12);
    const d = dampingDepthM(soil.thermalDiffusivityM2S, ANNUAL_PERIOD_S);
    const oneRadianS = ANNUAL_PERIOD_S / (2 * Math.PI);
    // The surface peaks at t=0 (phase 0 is defined that way); the depth-d peak arrives one radian
    // of the annual cycle later, which is nearly two months. THAT lag is the harvestable resource.
    expect(oneRadianS / 86400).toBeCloseTo(58.131, 3);
    let peakAt = 0;
    let peak = -Infinity;
    for (let t = 0; t < ANNUAL_PERIOD_S; t += 600) {
      const v = soilTempC(soil, d, t);
      if (v > peak) {
        peak = v;
        peakAt = t;
      }
    }
    expect(Math.abs(peakAt - oneRadianS)).toBeLessThan(600);
    expect(peak).toBeCloseTo(soil.meanTempC + 12 / Math.E, 9);
    // Attenuation and lag are the SAME z/d — the surface is at its own peak when the depth is not.
    expect(soilTempC(soil, 0, 0) - soil.meanTempC).toBeCloseTo(12, 9);
  });

  it('runs seasonally INVERTED at pi damping depths — deep soil is warmest in winter', () => {
    const soil = annualOnlySoil(12);
    const d = dampingDepthM(soil.thermalDiffusivityM2S, ANNUAL_PERIOD_S);
    const surface = soilTempC(soil, 0, 0) - soil.meanTempC;
    const deep = soilTempC(soil, Math.PI * d, 0) - soil.meanTempC;
    expect(surface).toBeGreaterThan(0);
    expect(deep).toBeLessThan(0);
    expect(surface * deep).toBeLessThan(0);
    // Half a year later the sign flip reverses — an inversion, not a constant offset.
    expect(soilTempC(soil, Math.PI * d, ANNUAL_PERIOD_S / 2) - soil.meanTempC).toBeGreaterThan(0);
    // The inverted lobe is e^-pi of the surface swing: 4.3%, at 7.04 m in this soil.
    expect(deep / surface).toBeCloseTo(-(Math.E ** -Math.PI), 12);
    expect(deep / surface).toBeCloseTo(-0.0432139, 6);
    expect(Math.PI * d).toBeCloseTo(7.0406, 4);
  });

  it('superposes the two waves without them interacting', () => {
    const both = DEFAULT_SOIL;
    const annual: SoilProfile = { ...both, diurnalAmplitudeC: 0 };
    const diurnal: SoilProfile = { ...both, annualAmplitudeC: 0 };
    const t = 1234567;
    const z = 0.05;
    expect(soilTempC(both, z, t)).toBeCloseTo(soilTempC(annual, z, t) + soilTempC(diurnal, z, t) - both.meanTempC - 0.025 * z, 9);
  });

  it('yields zero deltaT between two depths that are the same depth', () => {
    expect(junctionDeltaTK(DEFAULT_SOIL, 1.5, 1.5, 987654)).toBe(0);
  });

  it('reverses the sign of deltaT when the junctions are swapped', () => {
    const t = 0.35 * ANNUAL_PERIOD_S;
    expect(junctionDeltaTK(DEFAULT_SOIL, 1, 3, t)).toBeCloseTo(-junctionDeltaTK(DEFAULT_SOIL, 3, 1, t), 12);
    expect(junctionDeltaTK(DEFAULT_SOIL, 1, 3, t)).toBeCloseTo(-3.494274, 6);
  });
});

describe('geothermal gradient', () => {
  it('is present but NEGLIGIBLE at probe scale — a 3 m probe sees 0.075 K', () => {
    const withGradient = soilTempC(DEFAULT_SOIL, 3, 0);
    const without = soilTempC({ ...DEFAULT_SOIL, geothermalGradientKM: 0 }, 3, 0);
    expect(DEFAULT_GEOTHERMAL_GRADIENT_KM).toBe(0.025);
    expect(withGradient - without).toBeCloseTo(0.075, 9);
    expect(withGradient - without).toBeLessThan(0.1);
    // Against the annual swing the same probe sees, it is under 2% — this is why a buried
    // harvester runs on the phase lag and not on "geothermal energy".
    const annualSwing = Math.abs(junctionDeltaTK({ ...DEFAULT_SOIL, geothermalGradientKM: 0 }, 1, 3, 0));
    expect((withGradient - without) / annualSwing).toBeLessThan(0.02);
  });

  it('defaults to the continental average when a profile omits it', () => {
    const omitted: SoilProfile = { ...DEFAULT_SOIL };
    delete omitted.geothermalGradientKM;
    expect(soilTempC(omitted, 3, 0)).toBeCloseTo(soilTempC(DEFAULT_SOIL, 3, 0), 12);
  });

  it('is genuinely wired in — 100x the gradient measurably moves deep temperature', () => {
    const base = soilTempC({ ...DEFAULT_SOIL, geothermalGradientKM: 0 }, 3, 0);
    const hot = soilTempC({ ...DEFAULT_SOIL, geothermalGradientKM: 2.5 }, 3, 0);
    expect(hot - base).toBeCloseTo(7.5, 9);
    // Linear in depth, so it cancels almost entirely between two nearby junctions.
    expect(junctionDeltaTK({ ...DEFAULT_SOIL, geothermalGradientKM: 0.025 }, 1, 3, 0)).toBeCloseTo(
      junctionDeltaTK({ ...DEFAULT_SOIL, geothermalGradientKM: 0 }, 1, 3, 0) - 0.05,
      9,
    );
  });
});

describe('TEG resistance network', () => {
  it('produces nothing at zero deltaT, however warm the ground is', () => {
    const isothermal: SoilProfile = { ...DEFAULT_SOIL, meanTempC: 60, annualAmplitudeC: 0, diurnalAmplitudeC: 0, geothermalGradientKM: 0 };
    expect(junctionDeltaTK(isothermal, 1, 3, 12345)).toBe(0);
    expect(tegPowerW(isothermal, { ...DEEP_PAIR, module: teg(8) }, 12345)).toBe(0);
  });

  it('rises monotonically with |deltaT| and lands just under a square law', () => {
    const pair: JunctionPair = { name: 'q', hotDepthM: 1, coldDepthM: 3, module: teg(8) };
    let previous = -1;
    for (let amplitudeC = 0; amplitudeC <= 20; amplitudeC += 0.5) {
      const p = tegPowerW(annualOnlySoil(amplitudeC), pair, 0);
      expect(p).toBeGreaterThan(previous);
      previous = p;
    }
    // Both the heat flow AND the efficiency are proportional to deltaT, so power is quadratic —
    // the ground analogue of the marine cube law, and the reason depth separation pays twice.
    const ratio = (a: number) => tegPowerW(annualOnlySoil(2 * a), pair, 0) / tegPowerW(annualOnlySoil(a), pair, 0);
    expect(ratio(6)).toBeCloseTo(3.9718, 3);
    expect(ratio(3)).toBeCloseTo(3.9859, 3);
    // Strictly BELOW 4, and further below as deltaT grows: the hot face climbs with the load, so
    // the Carnot denominator grows too. A pure quadratic would overstate a large-deltaT design.
    expect(ratio(3)).toBeLessThan(4);
    expect(ratio(12)).toBeLessThan(ratio(3));
    expect(ratio(12)).toBeCloseTo(3.9445, 3);
  });

  it('is sign-agnostic — the converter bridges the seasonal polarity reversal', () => {
    const t = 0.35 * ANNUAL_PERIOD_S;
    const forward = tegPowerW(DEFAULT_SOIL, DEEP_PAIR, t);
    const reversed = tegPowerW(DEFAULT_SOIL, { ...DEEP_PAIR, hotDepthM: 3.0, coldDepthM: 1.0 }, t);
    expect(junctionDeltaTK(DEFAULT_SOIL, 1, 3, t)).toBeLessThan(0);
    expect(forward).toBeGreaterThan(0);
    expect(reversed).toBe(forward);
  });

  it('produces nothing below the converter cut-in and clamps at rated', () => {
    const pair: JunctionPair = { name: 'c', hotDepthM: 1, coldDepthM: 3, module: teg(8, 1e-4, 2e-4) };
    const strong = 0; // t=0 is the annual peak deltaT for this depth pair
    expect(tegPowerW(DEFAULT_SOIL, pair, strong)).toBe(1e-4);
    // Same instant, a cut-in above what the pair can ever make: nothing at all.
    const unstartable: JunctionPair = { ...pair, module: teg(8, 1e9, 1) };
    expect(tegPowerW(DEFAULT_SOIL, unstartable, strong)).toBe(0);
  });

  it('starts a converter sitting EXACTLY on its cut-in threshold', () => {
    const t = 0.35 * ANNUAL_PERIOD_S;
    const free: JunctionPair = { name: 'b', hotDepthM: 1, coldDepthM: 3, module: teg(8) };
    const exact = tegPowerW(DEFAULT_SOIL, free, t);
    expect(exact).toBeGreaterThan(0);
    // Threshold set to the exact power produced: a strict `<` starts, a `<=` would not. No
    // amount of sampling over real soil would ever land on this boundary, so it is asserted.
    expect(tegPowerW(DEFAULT_SOIL, { ...free, module: teg(8, 1e9, exact) }, t)).toBe(exact);
    expect(tegPowerW(DEFAULT_SOIL, { ...free, module: teg(8, 1e9, exact * (1 + 1e-12)) }, t)).toBe(0);
  });

  it('refuses a soil profile that resolves a face below absolute zero', () => {
    const impossible: SoilProfile = { ...DEFAULT_SOIL, meanTempC: -300 };
    expect(() => tegPowerW(impossible, { ...DEEP_PAIR, module: teg(8) }, 0)).toThrow(/below absolute zero/);
  });

  it('derives the matched resistance as L/(k*A) and refuses co-located junctions', () => {
    expect(matchedModuleResistanceKW(DEFAULT_SOIL, 1.0, 3.0, 0.25)).toBeCloseTo(8, 12);
    expect(matchedModuleResistanceKW(DEFAULT_SOIL, 3.0, 1.0, 0.25)).toBeCloseTo(8, 12);
    expect(matchedModuleResistanceKW(DEFAULT_SOIL, 1.0, 3.0, 0.5)).toBeCloseTo(4, 12);
    expect(matchedModuleResistanceKW(WET_CLAY_SOIL, 1.0, 3.0, 0.25)).toBeCloseTo(2 / (1.8 * 0.25), 12);
    expect(() => matchedModuleResistanceKW(DEFAULT_SOIL, 2, 2, 0.25)).toThrow(/junction depths must differ/);
    expect(() => matchedModuleResistanceKW(DEFAULT_SOIL, 1, 3, 0)).toThrow(/collector area must be positive/);
  });

  it('MAXIMUM POWER TRANSFER: output peaks exactly at the matched module resistance', () => {
    const t = 0.35 * ANNUAL_PERIOD_S;
    const matched = matchedModuleResistanceKW(DEFAULT_SOIL, 1.0, 3.0, AREA_M2);
    let bestR = 0;
    let bestP = -1;
    for (let r = 0.2; r <= 40; r += 0.02) {
      const p = tegPowerW(DEFAULT_SOIL, { ...DEEP_PAIR, module: teg(r) }, t);
      if (p > bestP) {
        bestP = p;
        bestR = r;
      }
    }
    expect(matched).toBeCloseTo(8, 12);
    expect(bestR).toBeCloseTo(matched, 1);
    expect(bestP).toBeCloseTo(2.125e-4, 6);
    // Both mismatch directions cost the same 36%, for opposite reasons: too low a module
    // resistance passes the heat but drops no temperature; too high drops the temperature but
    // blocks the heat. Impedance MATCHING is the lever — not deltaT, not module count.
    const at = (r: number) => tegPowerW(DEFAULT_SOIL, { ...DEEP_PAIR, module: teg(r) }, t);
    expect(at(4 * matched) / at(matched)).toBeCloseTo(0.64, 3);
    expect(at(matched / 4) / at(matched)).toBeCloseTo(0.64, 3);
  });

  it('moves the optimum when the collector area changes — a bigger plate is a re-specification', () => {
    const t = 0.35 * ANNUAL_PERIOD_S;
    const bigArea = 0.5;
    const matched = matchedModuleResistanceKW(DEFAULT_SOIL, 1.0, 3.0, bigArea);
    expect(matched).toBeCloseTo(4, 12);
    const big = (r: number) =>
      tegPowerW(DEFAULT_SOIL, { ...DEEP_PAIR, module: { ...teg(r), collectorAreaM2: bigArea } }, t);
    let bestR = 0;
    let bestP = -1;
    for (let r = 0.2; r <= 40; r += 0.02) {
      const p = big(r);
      if (p > bestP) {
        bestP = p;
        bestR = r;
      }
    }
    expect(bestR).toBeCloseTo(matched, 1);
    // The module that was optimal at 0.25 m² now sits at TWICE the matched resistance and gives
    // up 11% (the 4*r/(1+r)^2 mismatch penalty at r=2 is 8/9). Doubling the plate is not a free
    // win — it re-specifies the module, and keeping the old one spends part of the gain undoing
    // the mismatch the bigger plate just created.
    expect(big(8) / big(matched)).toBeCloseTo(0.8887, 3);
    expect(big(8) / big(matched)).toBeLessThan(1);
  });

  it('THE deltaT TRAP: dry sand shows the MOST deltaT and delivers the LEAST power', () => {
    const meanOver = (soil: SoilProfile) => {
      const module = teg(matchedModuleResistanceKW(soil, 1.0, 3.0, AREA_M2));
      const pair: JunctionPair = { name: soil.name, hotDepthM: 1.0, coldDepthM: 3.0, module };
      let sumP = 0;
      let maxDt = 0;
      let n = 0;
      for (let t = 0; t < ANNUAL_PERIOD_S; t += 3600) {
        maxDt = Math.max(maxDt, Math.abs(junctionDeltaTK(soil, 1, 3, t)));
        sumP += tegPowerW(soil, pair, t);
        n += 1;
      }
      return { maxDt, meanP: sumP / n };
    };
    const sand = meanOver(DRY_SAND_SOIL);
    const loam = meanOver(DEFAULT_SOIL);
    const clay = meanOver(WET_CLAY_SOIL);
    // Sand wins on the number a naive survey measures...
    expect(sand.maxDt).toBeGreaterThan(loam.maxDt);
    expect(loam.maxDt).toBeGreaterThan(clay.maxDt);
    expect(sand.maxDt).toBeCloseTo(7.615, 3);
    // ...and loses on the number that matters, because its conductivity throttles the heat flow.
    expect(sand.meanP).toBeLessThan(loam.meanP);
    expect(sand.meanP).toBeLessThan(clay.meanP);
    expect(sand.meanP).toBeCloseTo(2.4248e-4, 7);
    expect(loam.meanP).toBeCloseTo(3.3605e-4, 7);
    expect(clay.meanP).toBeCloseTo(2.9964e-4, 7);
  });
});

describe('THE EQUINOX NULL', () => {
  const annualOnly = unit([DEEP_PAIR], 0.001, 1);
  const diurnalOnly = unit([SHALLOW_PAIR], 0.001, 1);
  const dual = unit([DEEP_PAIR, SHALLOW_PAIR], 0.001, 1);

  it('strands an annual-only pair below cut-in for WEEKS, not hours', () => {
    const gapH = longestHarvestGapHours(annualOnly, CUT_IN_W, TWO_YEAR_SPAN_H);
    // deltaT crosses zero twice a year; near each crossing the power (quadratic in deltaT) sits
    // under the converter's cold-start threshold for over a month.
    expect(gapH).toBeGreaterThan(14 * 24);
    expect(gapH / 24).toBeCloseTo(32.31, 1);
    expect(gapH).toBeCloseTo(775.5, 1);
    // Two such windows a year: 64 days of the year unpowered.
    expect(outageFraction(annualOnly, CUT_IN_W, ANNUAL_PERIOD_S) * 365.25).toBeCloseTo(64.26, 1);
  });

  it('nulls a shallow diurnal pair on a 24 h cycle instead — gaps measured in HOURS', () => {
    const gapH = longestHarvestGapHours(diurnalOnly, CUT_IN_W, TWO_YEAR_SPAN_H);
    expect(gapH).toBeLessThan(24);
    expect(gapH).toBeCloseTo(0.833, 2);
    // It nulls far more OFTEN (twice a day, every day) yet loses only 5.7% of the year to it.
    expect(outageFraction(diurnalOnly, CUT_IN_W, ANNUAL_PERIOD_S)).toBeCloseTo(0.057, 3);
  });

  it('collapses the worst-case gap when both pairs run: the two nulls cannot coincide for long', () => {
    const annualGapH = longestHarvestGapHours(annualOnly, CUT_IN_W, TWO_YEAR_SPAN_H);
    const diurnalGapH = longestHarvestGapHours(diurnalOnly, CUT_IN_W, TWO_YEAR_SPAN_H);
    const dualGapH = longestHarvestGapHours(dual, CUT_IN_W, TWO_YEAR_SPAN_H);
    expect(dualGapH).toBeLessThan(annualGapH / 500);
    expect(dualGapH).toBeCloseTo(0.833, 2);
    // The worst gap equals the shallow pair's, and only during the annual null — for the rest of
    // the year the deep pair covers the nightly crossings outright, which is where the real win
    // shows: total time unpowered falls to a fifth of the shallow pair alone.
    expect(dualGapH).toBeLessThanOrEqual(diurnalGapH);
    const dualOutage = outageFraction(dual, CUT_IN_W, ANNUAL_PERIOD_S);
    expect(dualOutage).toBeCloseTo(0.01004, 5);
    expect(dualOutage).toBeLessThan(outageFraction(diurnalOnly, CUT_IN_W, ANNUAL_PERIOD_S) / 4);
    expect(dualOutage).toBeLessThan(outageFraction(annualOnly, CUT_IN_W, ANNUAL_PERIOD_S) / 15);
  });

  it('sums the pairs after each has rectified and cut in, so a nulled pair contributes a clean zero', () => {
    const deepMean = simulateGroundBudget(unit([DEEP_PAIR], 0.001, 1)).verdict.meanHarvestW;
    const shallowMean = simulateGroundBudget(unit([SHALLOW_PAIR], 0.001, 1)).verdict.meanHarvestW;
    const dualMean = simulateGroundBudget(dual).verdict.meanHarvestW;
    expect(deepMean).toBeCloseTo(3.3308e-4, 8);
    expect(shallowMean).toBeCloseTo(3.4806e-3, 7);
    expect(dualMean).toBeCloseTo(deepMean + shallowMean, 12);
    expect(dualMean).toBeCloseTo(3.8136e-3, 7);
  });
});

describe('closed-loop budget for a buried node', () => {
  it('defaults to a full year, because a 30-day run cannot see the equinox null', () => {
    expect(DEFAULT_GROUND_DURATION_HOURS).toBe(8766);
    expect(simulateGroundBudget(unit([DEEP_PAIR, SHALLOW_PAIR], 0.001, 1)).verdict.durationHours).toBe(8766);
  });

  it('closes a dual-pair design against a 1 mW load', () => {
    const { verdict, samples } = simulateGroundBudget(unit([DEEP_PAIR, SHALLOW_PAIR], 0.001, 1));
    expect(verdict.perpetual).toBe(true);
    expect(verdict.brownoutHours).toBe(0);
    expect(verdict.meanHarvestW).toBeCloseTo(0.0038136, 7);
    expect(verdict.marginRatio).toBeCloseTo(3.8136, 4);
    expect(verdict.minSocFraction).toBeCloseTo(0.99787, 5);
    expect(samples.length).toBe(1461);
    // A 1 Wh pack is 470x more than this node needs — most of the harvest is thrown away.
    expect(verdict.curtailedWh).toBeGreaterThan(verdict.consumedWh);
  });

  it('cannot close the same harvester against a 50 mW load, at any store size', () => {
    const heavy = unit([DEEP_PAIR, SHALLOW_PAIR], 0.05, 1);
    const { verdict } = simulateGroundBudget(heavy);
    expect(verdict.perpetual).toBe(false);
    expect(verdict.marginRatio).toBeCloseTo(0.0763, 4);
    expect(verdict.marginRatio).toBeLessThan(1);
    expect(verdict.brownoutHours).toBeGreaterThan(0);
    // marginRatio below 1 is unfixable by storage — the physics, not the pack, is short.
    expect(recommendGroundStorageWh(heavy)).toBeNull();
  });

  it('recommends 2.67 mWh — over 3x the single-gap rule of thumb', () => {
    const dual = unit([DEEP_PAIR, SHALLOW_PAIR], 0.001, 1);
    const recommended = recommendGroundStorageWh(dual);
    expect(recommended).not.toBeNull();
    expect(recommended as number).toBeCloseTo(0.00267, 5);
    // "Load times the worst gap" is the intuitive answer and it is 3.2x too small: the annual
    // null does not merely interrupt the shallow pair, it removes the deep pair's contribution
    // for a month, so several nightly deficits accumulate before the store is topped up again.
    const oneGapWh = 0.001 * longestHarvestGapHours(dual, CUT_IN_W, TWO_YEAR_SPAN_H);
    expect(oneGapWh).toBeCloseTo(0.000833, 6);
    expect(recommended as number).toBeGreaterThan(oneGapWh * 3);
  });

  it('resolves the recommendation below the shared core 0.5 Wh search tolerance, and one notch smaller fails', () => {
    const dual = unit([DEEP_PAIR, SHALLOW_PAIR], 0.001, 1);
    const recommended = recommendGroundStorageWh(dual) as number;
    // Without the milliwatt rescale the shared binary search would bottom out at ~0.5 Wh — 190x
    // the answer. The scale-invariance of the budget arithmetic is what makes the rescale exact.
    expect(recommended).toBeLessThan(0.5);
    const perpetualAt = (capacityWh: number) =>
      simulateGroundBudget({ ...dual, storage: { ...dual.storage, capacityWh } }).verdict.perpetual;
    expect(perpetualAt(recommended)).toBe(true);
    expect(perpetualAt(recommended * 0.9)).toBe(false);
  });

  it('marks up the raw drawdown by the usable depth of discharge', () => {
    const dual = unit([DEEP_PAIR, SHALLOW_PAIR], 0.001, 1);
    const { verdict } = simulateGroundBudget(dual);
    const drawdownWh = (1 - verdict.minSocFraction) * dual.storage.capacityWh;
    const recommended = recommendGroundStorageWh(dual) as number;
    // 80% usable depth means the pack must be 1/0.8 of the energy actually cycled — the store is
    // sized by the deepest excursion, then inflated by the fraction you refuse to touch.
    expect(recommended / (drawdownWh / dual.storage.usableDepthOfDischarge)).toBeCloseTo(1, 2);
  });
});
