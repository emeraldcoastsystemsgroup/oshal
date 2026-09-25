/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Data-model explorer API. GET / returns the snapshot (every Postgres table and view with columns, keys and RLS row scope; owners; shared objects; the app integration map); GET /stores returns the ArangoDB / ChromaDB / Redis inventories. Read-only. Mounted in server.ts behind requiresAuth + requiresOperator: the payload names every installed app's tables and policies, which is operator knowledge.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | GET /drift: the schema-digest comparison - what moved since the stored baseline, and whether that difference is an alarm or an explained/settling/first-run reading. `?capture=1` is the only thing that advances the baseline, so an operator opening the page never silently acknowledges a change. It answers 200 with `available:false` and a named reason when migration 139 is not applied, and 409 (never 500) when the current catalog read is partial - a failed read must not look like a dropped schema.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Expose detector status and confirmed, fingerprint-checked baseline recording behind the existing operator mount.
 */

import express, { type Request, type Response, type Router } from 'express';
import { createChildLogger } from '@/shared/logger';
import { DATA_MODEL_NO_DATABASE, SCHEMA_DIGEST_INVALID, SCHEMA_DIGEST_PARTIAL, type DataModelService } from '@/features/data-model';
import type { SchemaDriftMonitor } from '../schema-drift-runtime';

const logger = createChildLogger({ module: 'data-model-routes' });

/**
 * @description Answer one explorer read, logging entry/exit with duration and turning a failure
 * into a logged 5xx (503 when the platform database is absent, 500 otherwise).
 * @param req - request (`?refresh=1` forces a rebuild)
 * @param res - response
 * @param label - route label for the logs
 * @param read - the service call
 * @returns nothing; writes the response
 */
async function answer(req: Request, res: Response, label: string, read: (refresh: boolean) => Promise<unknown>): Promise<void> {
  const started = Date.now();
  const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
  logger.info({ route: label, refresh }, 'data-model read: start');
  try {
    const body = await read(refresh);
    res.json(body);
    logger.info({ route: label, refresh, ms: Date.now() - started }, 'data-model read: done');
  } catch (err) {
    const noDatabase = (err as { code?: string } | null)?.code === DATA_MODEL_NO_DATABASE;
    logger.error({ err, route: label, ms: Date.now() - started }, 'data-model read: failed');
    res.status(noDatabase ? 503 : 500).json({ error: noDatabase ? (err as Error).message : 'The data model could not be read. See the server log.' });
  }
}

/**
 * @description Answer the drift read. A partial catalog read and an uncomparable digest are
 * CLIENT-visible conditions with their own status, not 500s: the whole point of the classifier is
 * that a bad reading must never be presented as a schema change.
 * @param req - request (`?capture=1` records the baseline, `?refresh=1` rebuilds the snapshot)
 * @param res - response
 * @param service - the data-model service
 * @param monitor - Optional read-only detector status.
 * @returns nothing; writes the response
 */
async function answerDrift(req: Request, res: Response, service: DataModelService, monitor?: SchemaDriftMonitor | null): Promise<void> {
  const started = Date.now();
  const route = `${req.method} /api/admin/data-model/drift${req.method === 'POST' ? '/baseline' : ''}`;
  const capture = req.method === 'POST' || req.query.capture === '1' || req.query.capture === 'true';
  const refresh = req.method === 'POST' || req.query.refresh === '1' || req.query.refresh === 'true';
  const expectedFingerprint = req.method === 'POST' ? req.body?.fingerprint : undefined;
  if (req.method === 'POST' && (req.body?.confirmed !== true || typeof expectedFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(expectedFingerprint))) {
    res.status(400).json({ error: 'Confirm the reviewed schema fingerprint before recording a baseline.' });
    return;
  }
  logger.info({ route, capture, refresh }, 'data-model drift: start');
  try {
    const outcome = await service.drift({ capture, refresh, ...(expectedFingerprint ? { expectedFingerprint } : {}) });
    res.json({ ...outcome, captureSupported: true, monitor: monitor?.status() ?? null });
    logger.info({ route, state: outcome.report?.state ?? 'unavailable', alarm: outcome.report?.alarm ?? false, ms: Date.now() - started }, 'data-model drift: done');
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    logger.error({ err, code, ms: Date.now() - started }, 'data-model drift: failed');
    if (code === SCHEMA_DIGEST_PARTIAL || code === SCHEMA_DIGEST_INVALID) {
      res.status(409).json({ error: (err as Error).message, code, drift: 'refused' });
      return;
    }
    if (code === DATA_MODEL_NO_DATABASE) {
      res.status(503).json({ error: (err as Error).message });
      return;
    }
    res.status(500).json({ error: 'Schema drift could not be read. See the server log.' });
  }
}

/**
 * @description Build the explorer router. Mount it behind requiresAuth + requiresOperator.
 * @param service - the data-model service
 * @param monitor - Optional detector whose status accompanies comparison reads.
 * @returns Snapshot/store/drift reads and confirmed reviewed-baseline recording.
 */
export function createDataModelRoutes(service: DataModelService, monitor?: SchemaDriftMonitor | null): Router {
  const router = express.Router();
  router.get('/', (req, res) => answer(req, res, 'GET /api/admin/data-model', (refresh) => service.snapshot(refresh)));
  router.get('/stores', (req, res) => answer(req, res, 'GET /api/admin/data-model/stores', (refresh) => service.stores(refresh)));
  router.get('/drift', (req, res) => answerDrift(req, res, service, monitor));
  router.post('/drift/baseline', express.json({ limit: '2kb' }), (req, res) => answerDrift(req, res, service, monitor));
  return router;
}
