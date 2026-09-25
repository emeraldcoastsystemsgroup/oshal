/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Keep archive parsing and locked replay off the API event loop with finite heap and time budgets.
 */
import { dirname, resolve } from 'node:path';
import { isMainThread, parentPort, workerData, Worker } from 'node:worker_threads';
import type { FuturesResearchConfig } from './trading-futures-research-dispatch';
import type { FuturesResearchMarket } from './trading-futures-research-study';
import { buildFuturesPredictionDrafts, gradeFuturesPrediction, type FuturesPredictionDraft, type FuturesPredictionOutcome, type FuturesPredictionSnapshot } from './trading-futures-prediction-evidence';

/** @description Owner-filtered immutable receipts supplied by the ledger, never by a browser. */
export interface FuturesPredictionWork {
  config: FuturesResearchConfig;
  markets: FuturesResearchMarket[];
  pending: Array<{ predictionId: string; issuedAt: string; snapshot: FuturesPredictionSnapshot }>;
}
/** @description Deterministic research results; issuance remains the database's clock, not a worker argument. */
export interface FuturesPredictionWorkResult {
  drafts: FuturesPredictionDraft[];
  grades: Array<{ predictionId: string; outcome: FuturesPredictionOutcome }>;
}

if (!isMainThread && workerData.futuresPredictionWork && parentPort) {
  const work = workerData.futuresPredictionWork as FuturesPredictionWork;
  const now = Date.now();
  parentPort.postMessage({ drafts: buildFuturesPredictionDrafts(work.config, work.markets, now),
    grades: work.pending.map(row => ({ predictionId: row.predictionId, outcome: gradeFuturesPrediction(row.snapshot, row.issuedAt, now) })) });
}

/** @description Run one bounded owner cycle on an isolated worker using the production parser and strategy.
 * @param work - Frozen owner-scoped inputs. @returns Drafts and grades, or an explicit worker failure.
 */
export function executeFuturesPredictionsOffLoop(work: FuturesPredictionWork): Promise<FuturesPredictionWorkResult> {
  return new Promise((resolveWork, rejectWork) => {
    const entry = __filename;
    const preload = entry.endsWith('.ts') ? require.resolve('tsx/cjs') : null;
    const worker = new Worker([
      "const { workerData } = require('node:worker_threads');",
      "require('tsconfig-paths').register({ baseUrl: workerData.root, paths: { '@/*': ['*'] } });",
      'if (workerData.preload) require(workerData.preload);', 'require(workerData.entry);',
    ].join('\n'), { eval: true, workerData: { futuresPredictionWork: work, entry, preload, root: resolve(dirname(entry), '..') }, resourceLimits: { maxOldGenerationSizeMb: 512 } });
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true; clearTimeout(timer); action(); void worker.terminate();
    };
    const timer = setTimeout(() => finish(() => rejectWork(new Error('Futures prediction worker exceeded five minutes'))), 300_000);
    worker.once('message', (result: FuturesPredictionWorkResult) => finish(() => resolveWork(result)));
    worker.once('error', error => finish(() => rejectWork(error)));
    worker.once('exit', code => finish(() => rejectWork(new Error(`Futures prediction worker exited ${code} before results`))));
  });
}
