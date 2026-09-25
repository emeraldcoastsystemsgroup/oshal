/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Freeze locked-strategy forward bias and grade only later raw same-contract evidence.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Canonicalize object keys so stored JSONB inputs reproduce fingerprints and reference comparisons.
 */
import { createHash } from 'node:crypto';
import { getFuturesRoot, runFuturesBacktest, type BacktestConfig, type FuturesBar, type FuturesReplayObservation } from '@/features/trading';
import type { FuturesResearchConfig } from './trading-futures-research-dispatch';
import type { FuturesResearchMarket } from './trading-futures-research-study';
import { futuresWallTimeUtc } from './trading-futures-prediction-clock';
import { readFuturesClosedBars, type FuturesPredictionSource, type FuturesClosedBar } from './trading-futures-prediction-source';

/** @description All bounded replay inputs needed to reproduce an issued research bias. */
export interface FuturesPredictionSnapshot {
  model: 'locked-strategy-bias-v1';
  root: string;
  contract: string;
  studyFingerprint: string;
  source: FuturesPredictionSource;
  strategy: BacktestConfig;
  chart: FuturesBar[];
  ltf: FuturesBar[];
  daily: FuturesBar[];
  reference: FuturesClosedBar;
  observation: FuturesReplayObservation;
  horizonHours: number;
  gradingToleranceHours: number;
  tickSize: number;
}
/** @description Worker output awaiting database-clock issuance; withholding never fabricates a snapshot. */
export interface FuturesPredictionDraft {
  root: string;
  contract: string;
  status: 'pending' | 'abstained' | 'withheld';
  reason: string | null;
  fingerprint: string;
  snapshot: FuturesPredictionSnapshot | null;
}
/** @description Future-only directional evidence, explicitly separate from trading returns. */
export interface FuturesPredictionOutcome {
  status: 'pending' | 'unavailable' | 'graded';
  reason: string | null;
  bar?: FuturesClosedBar;
  priceChange?: number;
  signedTicks?: number;
  correct?: boolean | null;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]));
  return value;
}
/** @description Reproduce an input fingerprint before or after JSONB serialization; array order remains evidence.
 * @param value - Frozen JSON research evidence. @returns SHA-256 over canonical object-key ordering.
 */
export function fingerprintFuturesEvidence(value: unknown): string { return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'); }

function snapshotFor(config: FuturesResearchConfig, market: FuturesResearchMarket, asOf: number): FuturesPredictionSnapshot {
  const options = config.predictions!;
  const source: FuturesPredictionSource = { dataDir: config.dataDir, contract: options.contracts[market.root], sourceTimeZone: options.sourceTimeZone,
    timeframe: config.timeframe, ltfTimeframe: config.ltfTimeframe, minVolume: config.minVolume };
  const lastWindow = market.report.windows.at(-1);
  if (!lastWindow || futuresWallTimeUtc(new Date(lastWindow.window.oosEnd).toISOString(), source.sourceTimeZone) > asOf) throw new Error('Locked study window is not yet past at issuance');
  const chart = readFuturesClosedBars(source, source.timeframe, asOf, undefined, options.historyBars);
  const ltf = readFuturesClosedBars(source, source.ltfTimeframe, asOf, undefined, Math.min(options.historyBars, 512));
  for (const [name, bars] of [['chart', chart], ['higher timeframe', ltf]] as const) {
    if (bars.length < 64) throw new Error(`Fewer than 64 completed ${name} bars`);
    if (asOf - Date.parse(bars.at(-1)!.closedAt) > options.maxSourceAgeHours * 3_600_000) throw new Error(`Stale ${name} archive at issuance`);
  }
  const strategy = structuredClone(lastWindow.finalConfig);
  const dailyRows = strategy.regimeGate?.enabled ? readFuturesClosedBars(source, '1Day', asOf, undefined, 512) : [];
  if (strategy.regimeGate?.enabled && (dailyRows.length < 64 || asOf - Date.parse(dailyRows.at(-1)!.closedAt) > options.maxSourceAgeHours * 3_600_000)) throw new Error('Daily regime archive is stale or insufficient');
  const daily = dailyRows.map(row => row.bar);
  let reading: FuturesReplayObservation | undefined;
  runFuturesBacktest(chart.map(row => row.bar), ltf.map(row => row.bar), strategy, daily, observation => { reading = observation; });
  if (!reading || reading.barIndex !== chart.length - 1 || reading.decision.skippedBar) throw new Error('Locked strategy has no warmed completed-bar observation');
  return { model: 'locked-strategy-bias-v1', root: market.root, contract: source.contract, studyFingerprint: market.evidenceFingerprint,
    source, strategy, chart: chart.map(row => row.bar), ltf: ltf.map(row => row.bar), daily, reference: chart.at(-1)!, observation: reading,
    horizonHours: options.horizonHours, gradingToleranceHours: options.gradingToleranceHours, tickSize: getFuturesRoot(market.root)!.tickSize };
}

/** @description Construct research-only calls without inventing issuance dates or probabilities.
 * @param config - Validated explicit opt-in. @param markets - The owned run's completed locked studies.
 * @param asOf - True UTC observation cutoff supplied by the worker clock.
 * @returns One immutable input draft per configured root, including visible withholding receipts.
 */
export function buildFuturesPredictionDrafts(config: FuturesResearchConfig, markets: FuturesResearchMarket[], asOf: number): FuturesPredictionDraft[] {
  if (!config.predictions?.enabled) return [];
  return config.roots.map(root => {
    const contract = config.predictions!.contracts[root];
    try {
      const market = markets.find(candidate => candidate.root === root);
      if (!market) throw new Error('No completed locked study for this root');
      const snapshot = snapshotFor(config, market, asOf);
      return { root, contract, snapshot, fingerprint: fingerprintFuturesEvidence(snapshot), status: snapshot.observation.bias ? 'pending' : 'abstained',
        reason: snapshot.observation.bias ? null : 'Locked replay has no directional bias; excluded from accuracy scoring' };
    } catch (error) {
      // Keep local paths and filesystem error details out of user-visible receipts.
      const reason = error instanceof Error && !('code' in error) ? error.message : 'Configured contract archive could not be read';
      return { root, contract, status: 'withheld', snapshot: null, fingerprint: fingerprintFuturesEvidence({ root, contract, config: config.predictions, reason }), reason };
    }
  });
}

/** @description Grade a frozen bias against later unadjusted same-contract bars, never against the stitched study.
 * @param snapshot - Persisted frozen input evidence. @param issuedAt - Actual durable UTC issuance.
 * @param now - True UTC observation time; future bars never qualify.
 * @returns A directional-change result, not trade P&L; unavailable evidence remains explicitly unscored.
 */
export function gradeFuturesPrediction(snapshot: FuturesPredictionSnapshot, issuedAt: string, now: number): FuturesPredictionOutcome {
  const target = Date.parse(issuedAt) + snapshot.horizonHours * 3_600_000;
  if (now < target) return { status: 'pending', reason: null };
  try {
    if (!snapshot.observation.bias || Date.parse(snapshot.reference.closedAt) > Date.parse(issuedAt)) throw new Error('Invalid frozen prediction issuance or direction');
    const bars = readFuturesClosedBars(snapshot.source, snapshot.source.timeframe,
      Math.min(now, target + snapshot.gradingToleranceHours * 3_600_000), snapshot.reference.bar.t);
    const reference = bars.find(row => row.bar.t === snapshot.reference.bar.t);
    if (!reference || fingerprintFuturesEvidence(reference) !== fingerprintFuturesEvidence(snapshot.reference)) throw new Error('Frozen reference bar is missing or revised; outcome is not scored');
    const bar = bars.find(row => Date.parse(row.closedAt) >= target && Date.parse(row.closedAt) <= target + snapshot.gradingToleranceHours * 3_600_000);
    if (!bar) return { status: now > target + snapshot.gradingToleranceHours * 3_600_000 ? 'unavailable' : 'pending', reason: 'No completed same-contract bar in the target tolerance window' };
    const priceChange = bar.bar.c - snapshot.reference.bar.c;
    const signedTicks = priceChange / snapshot.tickSize * (snapshot.observation.bias === 'long' ? 1 : -1);
    return { status: 'graded', reason: null, bar, priceChange, signedTicks, correct: signedTicks === 0 ? null : signedTicks > 0 };
  } catch (error) {
    return { status: 'unavailable', reason: error instanceof Error && !('code' in error) ? error.message : 'Configured outcome archive could not be read' };
  }
}
