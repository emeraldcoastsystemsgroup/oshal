/**
 * ADR-116 study worker entry: the optimizer never runs on the API event loop.
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Carry trusted process-fenced evidence into the isolated worker.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Preserve classified source refusals across the worker boundary.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Supply scoped database identity to captured-bar studies without exposing credentials to the console.
 */
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { Pool } from 'pg';
import { runWithRequestIdentity } from '@/shared/services/database/request-identity';
import { wrapPoolWithGuc } from '@/shared/services/database/guc-pool';
import { executeFuturesStudy, type FuturesResearchMarket } from './trading-futures-research-study';
import type { FuturesResearchConfig } from './trading-futures-research-dispatch';
import type { FuturesStudyReuse } from './trading-futures-research-reuse';
import { FuturesSourceError, type FuturesSourceIssue } from './trading-futures-source-error';

export const futuresResearchWorkerEntry = __filename;
export type FuturesResearchWorkerOutput = { markets: FuturesResearchMarket[] }
  | { error: { message: string; sourceIssue?: FuturesSourceIssue } };

const port = parentPort;
if (!isMainThread && port) {
  const input = workerData as { config: FuturesResearchConfig; reuse: FuturesStudyReuse; ownerSub?: string };
  const study = async (): Promise<FuturesResearchMarket[]> => {
    if (input.config.source !== 'schwab-capture') return executeFuturesStudy(input.config, input.reuse);
    if (!input.ownerSub || !process.env.DATABASE_URL) throw new FuturesSourceError('Schwab captured source is unavailable',
      { code: 'unconfigured', root: input.config.roots[0] });
    const pool = wrapPoolWithGuc(new Pool({ connectionString: process.env.DATABASE_URL, max: 2 }));
    try {
      return await runWithRequestIdentity({ sub: input.ownerSub, isOperator: false },
        () => executeFuturesStudy(input.config, input.reuse, { pool, ownerSub: input.ownerSub! }));
    } finally { await pool.end(); }
  };
  void study()
    .then((markets) => port.postMessage({ markets } satisfies FuturesResearchWorkerOutput))
    .catch((error: unknown) => port.postMessage({ error: { message: error instanceof Error ? error.message : String(error),
      ...(error instanceof FuturesSourceError ? { sourceIssue: error.issue } : {}) } } satisfies FuturesResearchWorkerOutput));
}
