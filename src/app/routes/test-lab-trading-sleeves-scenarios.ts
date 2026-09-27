/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Register the ADR-168 multi-market universe with one credential-free readback of the constant this image carries: every name bucketed, no duplicate, the default universe still its unchanged prefix, no default name in a multi-market bucket, and no overlap with the swing leg's ETFs. A beta-core or operator-hold symbol of THIS node inside the universe is reported as degraded, because the rotation skips core symbols. The step never claims the sleeve's paper proof (ADR-168 D6), which only a soak on an armed paper book can produce.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | The core-symbol check reads only the 41 multi-market names. A default-universe name held as core (the operator's SKHY:0 hold) was already skipped by the rotation before ADR-168, so counting it would have graded every such node degraded for a fact this ADR did not create.
 */
import type { Scenario, StepResult } from './test-lab-scenarios';
import { DEFAULT_UNIVERSE, MULTI_MARKET_UNIVERSE, MULTI_MARKET_BUCKETS, sectorOf } from '@/features/trading';
import { DEFAULT_SWING_UNIVERSE } from '@/app/trading-swing-dispatch';
import { coreConfig } from '@/app/trading-dispatch-core';

const APP = 'intelligent-trades';
const LABEL = 'Multi-market universe on this image (ADR-168)';
const NOT_PROOF = 'A static readback of the constant: no dispatch leg reads it, and it is not the paper proof ADR-168 D6 requires.';

/** What the readback grades — the kernel's own values, injectable so the grading is testable. */
export interface SleeveUniverseInput {
  universe: readonly string[];
  defaultUniverse: readonly string[];
  bucketOf: (symbol: string) => string;
  extensionBuckets: readonly string[];
  swingUniverse: readonly string[];
  coreSymbols: readonly string[];
}

/** The measured facts the step reports as its output. */
export interface SleeveUniverseFacts {
  size: number;
  defaultSize: number;
  defaultIsPrefix: boolean;
  buckets: Record<string, number>;
  unbucketed: string[];
  duplicates: string[];
  defaultInExtensionBucket: string[];
  swingOverlap: string[];
  coreOverlap: string[];
}

/**
 * @description Measure the multi-market universe against the rules ADR-168 D2 states. Pure.
 * @param input - The universe, the default universe, the sector resolver and the exclusion sets.
 * @returns The facts, each list empty when its rule holds.
 */
export function measureSleeveUniverse(input: SleeveUniverseInput): SleeveUniverseFacts {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  const buckets: Record<string, number> = {};
  for (const sym of input.universe) {
    if (seen.has(sym)) duplicates.push(sym);
    seen.add(sym);
    const bucket = input.bucketOf(sym);
    buckets[bucket] = (buckets[bucket] ?? 0) + 1;
  }
  const extension = new Set(input.extensionBuckets);
  const defaults = new Set(input.defaultUniverse);
  return {
    size: input.universe.length,
    defaultSize: input.defaultUniverse.length,
    defaultIsPrefix: input.defaultUniverse.every((sym, i) => input.universe[i] === sym),
    buckets,
    unbucketed: input.universe.filter((sym) => input.bucketOf(sym) === 'other'),
    duplicates,
    defaultInExtensionBucket: input.defaultUniverse.filter((sym) => extension.has(input.bucketOf(sym))),
    swingOverlap: input.swingUniverse.filter((sym) => seen.has(sym.toUpperCase())),
    coreOverlap: input.coreSymbols.filter((sym) => seen.has(sym.toUpperCase()) && !defaults.has(sym.toUpperCase())),
  };
}

/**
 * @description Grade the readback. A broken rule fails; a core/hold symbol of this node among the
 *   41 multi-market names is degraded (the rotation excludes core symbols, so that name would never be
 *   ranked);
 *   otherwise it passes, and the detail still says this is not the paper proof.
 * @param input - The kernel values to grade.
 * @returns The Lab step result, with the measured facts as its output.
 */
export function multiMarketUniverseStep(input: SleeveUniverseInput): StepResult {
  const facts = measureSleeveUniverse(input);
  const base = { app: APP, label: LABEL, output: facts };
  const broken = [
    facts.defaultIsPrefix ? '' : 'DEFAULT_UNIVERSE is no longer its unchanged prefix',
    facts.unbucketed.length ? `unbucketed: ${facts.unbucketed.join(', ')}` : '',
    facts.duplicates.length ? `duplicated: ${facts.duplicates.join(', ')}` : '',
    facts.defaultInExtensionBucket.length ? `default names in a multi-market bucket: ${facts.defaultInExtensionBucket.join(', ')}` : '',
    facts.swingOverlap.length ? `shared with the swing leg: ${facts.swingOverlap.join(', ')}` : '',
  ].filter(Boolean);
  if (broken.length) return { ...base, state: 'fail', detail: `The ADR-168 universe breaks its own rules (${broken.join('; ')}). ${NOT_PROOF}` };
  const summary = `${facts.size} names (${facts.defaultSize} default + ${facts.size - facts.defaultSize} multi-market) across ${Object.keys(facts.buckets).length} buckets, every one bucketed.`;
  if (facts.coreOverlap.length) {
    return { ...base, state: 'degraded', detail: `${summary} This node's TRADING_CORE_SYMBOLS names ${facts.coreOverlap.join(', ')}, which the rotation skips as core. ${NOT_PROOF}` };
  }
  return { ...base, state: 'pass', detail: `${summary} ${NOT_PROOF}` };
}

/** @description The kernel's own values for the readback. @returns The step input built from this image and this node's env. */
function kernelSleeveUniverseInput(): SleeveUniverseInput {
  return {
    universe: MULTI_MARKET_UNIVERSE,
    defaultUniverse: DEFAULT_UNIVERSE,
    bucketOf: sectorOf,
    extensionBuckets: Object.keys(MULTI_MARKET_BUCKETS),
    swingUniverse: DEFAULT_SWING_UNIVERSE,
    coreSymbols: coreConfig().symbols,
  };
}

/** @description Discover the ADR-168 multi-market universe card. @returns One credential-free readback scenario, not a paper proof. */
export const TRADING_SLEEVES_SCENARIOS: Scenario[] = [{
  id: 'trading-sleeves-universe', title: 'Trading sleeves — multi-market universe (ADR-168)', group: 'tool',
  description: 'The ~200-name multi-market universe ADR-168 proposes: DEFAULT_UNIVERSE unchanged plus 41 US-listed instruments in seven new market buckets. The suites prove the list, its sector coverage, that a default-universe book sizes and tilts exactly as before, and that a Strategy Lab rotation or blend can carry it with no new kernel code. The step is a static readback of this image; the sleeve is proven only by the paper soak ADR-168 D6 defines.',
  regressionTests: [
    { level: 'unit', path: 'tests/unit/trading-multi-timeframe.spec.ts' },
    { level: 'unit', path: 'tests/unit/trading-portfolio.spec.ts' },
    { level: 'unit', path: 'tests/unit/trading-sector-tilt.spec.ts' },
    { level: 'unit', path: 'tests/unit/trading-blend.spec.ts' },
    { level: 'unit', path: 'tests/unit/test-lab-trading-sleeves-registration.spec.ts' },
  ],
  steps: [{ id: 'universe-readback', app: APP, label: LABEL, run: async () => multiMarketUniverseStep(kernelSleeveUniverseInput()) }],
}];
