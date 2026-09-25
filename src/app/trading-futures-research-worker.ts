/**
 * ADR-116 study worker entry: the optimizer never runs on the API event loop.
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Carry trusted process-fenced evidence into the isolated worker.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Preserve classified source refusals across the worker boundary.
 */
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { executeFuturesStudy, type FuturesResearchMarket } from './trading-futures-research-study';
import type { FuturesResearchConfig } from './trading-futures-research-dispatch';
import type { FuturesStudyReuse } from './trading-futures-research-reuse';
import { FuturesSourceError, type FuturesSourceIssue } from './trading-futures-source-error';

export const futuresResearchWorkerEntry = __filename;
export type FuturesResearchWorkerOutput = { markets: FuturesResearchMarket[] }
  | { error: { message: string; sourceIssue?: FuturesSourceIssue } };

const port = parentPort;
if (!isMainThread && port) {
  const input = workerData as { config: FuturesResearchConfig; reuse: FuturesStudyReuse };
  void executeFuturesStudy(input.config, input.reuse)
    .then((markets) => port.postMessage({ markets } satisfies FuturesResearchWorkerOutput))
    .catch((error: unknown) => port.postMessage({ error: { message: error instanceof Error ? error.message : String(error),
      ...(error instanceof FuturesSourceError ? { sourceIssue: error.issue } : {}) } } satisfies FuturesResearchWorkerOutput));
}
