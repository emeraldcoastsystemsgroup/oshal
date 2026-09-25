/**
 * ADR-116 study worker entry: the optimizer never runs on the API event loop.
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Carry trusted process-fenced evidence into the isolated worker.
 */
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { executeFuturesStudy, type FuturesResearchMarket } from './trading-futures-research-study';
import type { FuturesResearchConfig } from './trading-futures-research-dispatch';
import type { FuturesStudyReuse } from './trading-futures-research-reuse';

export const futuresResearchWorkerEntry = __filename;
export type FuturesResearchWorkerOutput = { markets: FuturesResearchMarket[] };

const port = parentPort;
if (!isMainThread && port) {
  const input = workerData as { config: FuturesResearchConfig; reuse: FuturesStudyReuse };
  void executeFuturesStudy(input.config, input.reuse)
    .then((markets) => port.postMessage({ markets } satisfies FuturesResearchWorkerOutput));
}
