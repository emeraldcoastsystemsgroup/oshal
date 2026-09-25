/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Parse bounded import previews off the event loop without database or inference work in the worker.
 */
import { dirname, resolve } from 'node:path';
import { isMainThread, parentPort, workerData, Worker } from 'node:worker_threads';
import type { FuturesArchiveConfig } from './trading-futures-archive-config';
import { prepareFuturesArchive, type FuturesArchivePrepared } from './trading-futures-archive-source';

if (!isMainThread && workerData.futuresArchive && parentPort) {
  void prepareFuturesArchive(workerData.futuresArchive.config, workerData.futuresArchive.includeBars)
    .then(result => parentPort!.postMessage(result));
}

/** @description Bound real archive parsing to one finite worker; database admission limits concurrency across processes.
 * @param config - Frozen owner-approved envelope. @param includeBars - Internal confirmed import mode. @returns Prepared evidence.
 */
export function executeFuturesArchiveOffLoop(config: FuturesArchiveConfig, includeBars: boolean): Promise<FuturesArchivePrepared> {
  return new Promise((resolveWork, rejectWork) => {
    const entry = __filename, preload = entry.endsWith('.ts') ? require.resolve('tsx/cjs') : null;
    const worker = new Worker([
      "const { workerData } = require('node:worker_threads');",
      "require('tsconfig-paths').register({ baseUrl: workerData.root, paths: { '@/*': ['*'] } });",
      'if (workerData.preload) require(workerData.preload);', 'require(workerData.entry);',
    ].join('\n'), { eval: true, workerData: { futuresArchive: { config, includeBars }, entry, preload, root: resolve(dirname(entry), '..') }, resourceLimits: { maxOldGenerationSizeMb: 1024 } });
    let settled = false;
    const finish = (action: () => void): void => { if (!settled) { settled = true; clearTimeout(timer); action(); void worker.terminate(); } };
    const timer = setTimeout(() => finish(() => rejectWork(new Error('Futures archive worker exceeded ten minutes'))), 600_000);
    worker.once('message', (result: FuturesArchivePrepared) => finish(() => resolveWork(result)));
    worker.once('error', error => finish(() => rejectWork(error)));
    worker.once('exit', code => finish(() => rejectWork(new Error(`Futures archive worker exited ${code} before results`))));
  });
}
