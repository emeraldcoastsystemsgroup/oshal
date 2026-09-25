/** ADR-116 study worker entry: the optimizer never runs on the API event loop. */
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { executeFuturesStudy, type FuturesResearchMarket } from './trading-futures-research-study';
import type { FuturesResearchConfig } from './trading-futures-research-dispatch';

export const futuresResearchWorkerEntry = __filename;
export type FuturesResearchWorkerOutput = { markets: FuturesResearchMarket[] };

const port = parentPort;
if (!isMainThread && port) {
  void executeFuturesStudy((workerData as { config: FuturesResearchConfig }).config)
    .then((markets) => port.postMessage({ markets } satisfies FuturesResearchWorkerOutput));
}
