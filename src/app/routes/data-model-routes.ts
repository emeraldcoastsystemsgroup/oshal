/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Data-model explorer API. GET / returns the snapshot (every Postgres table and view with columns, keys and RLS row scope; owners; shared objects; the app integration map); GET /stores returns the ArangoDB / ChromaDB / Redis inventories. Read-only. Mounted in server.ts behind requiresAuth + requiresOperator: the payload names every installed app's tables and policies, which is operator knowledge.
 */

import express, { type Request, type Response, type Router } from 'express';
import { createChildLogger } from '@/shared/logger';
import { DATA_MODEL_NO_DATABASE, type DataModelService } from '@/features/data-model';

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
 * @description Build the explorer router. Mount it behind requiresAuth + requiresOperator.
 * @param service - the data-model service
 * @returns an Express router with GET / and GET /stores
 */
export function createDataModelRoutes(service: DataModelService): Router {
  const router = express.Router();
  router.get('/', (req, res) => answer(req, res, 'GET /api/admin/data-model', (refresh) => service.snapshot(refresh)));
  router.get('/stores', (req, res) => answer(req, res, 'GET /api/admin/data-model/stores', (refresh) => service.stores(refresh)));
  return router;
}
