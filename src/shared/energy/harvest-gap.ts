/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — the worst-case harvest-gap scan lifted out
 *                     |                             | of the marine slice's longestSlackHours. Kept deliberately
 *                     |                             | unit-agnostic (it only ever asks "sampler below threshold?"),
 *                     |                             | which is what lets the marine wrapper keep scanning in m/s
 *                     |                             | against a cut-in SPEED while a watt-domain caller scans in W.
 */

import type { HarvestSampler } from './energy-types';

/**
 * @description Length of the longest continuous stretch in which a sampler stays below a
 * threshold. THIS is the number that sizes the battery: it is the gap the node must ride
 * through on stored energy alone, and at a marginal site it can run for days — not the short
 * lull an intuition based on a single environmental cycle suggests.
 *
 * The comparison is the only arithmetic here (`harvestAt(t) < cutInW`), so the function is
 * unit-agnostic: **the sampler and the threshold merely have to share units.** Callers scanning
 * in watts pass a power sampler and a cut-in power; the marine slice deliberately passes
 * `|current speed|` against a cut-in SPEED, because thresholding the pre-cube speed is both
 * cheaper and exactly equivalent to thresholding the watts it produces.
 * @param harvestAt - Sampler over time. Units must match `cutInW`.
 * @param cutInW - Threshold below which harvest is treated as zero. Units must match the sampler.
 * @param spanHours - Window to search. Use a full environmental cycle (≥ 30 days for tides).
 * @param stepSeconds - Sample step. Default 60.
 * @returns Longest sub-threshold stretch in hours.
 */
export function longestGapHours(harvestAt: HarvestSampler, cutInW: number, spanHours: number, stepSeconds = 60): number {
  const steps = Math.ceil((spanHours * 3600) / stepSeconds);
  let longest = 0;
  let run = 0;
  for (let i = 0; i < steps; i += 1) {
    const below = harvestAt(i * stepSeconds) < cutInW;
    run = below ? run + stepSeconds : 0;
    if (run > longest) longest = run;
  }
  return longest / 3600;
}
