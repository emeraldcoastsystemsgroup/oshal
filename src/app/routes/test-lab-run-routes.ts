/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Expose same-origin asynchronous package Run, Cancel and exact-owner history endpoints.
 */
import { Router, type Request, type Response } from 'express';
import type { TestLabRunService } from './test-lab-run-service';
import type { TestLabRunContext } from './test-lab-run-types';

export interface TestLabRunRouteOptions {
  runService?: TestLabRunService;
  runContext?: (req: Request) => Promise<TestLabRunContext>;
}

function mutation(req: Request): void {
  const origin = `${req.protocol}://${req.get('host')}`;
  if (req.get('origin') !== origin || req.get('x-oshal-test-lab') !== '1' || !req.is('application/json')) {
    throw Object.assign(new Error('Run requests must come from this Test Lab page.'), { status: 403 });
  }
}

/** @description Bind durable runner endpoints without changing legacy scenario execution.
 * @param options Server-owned run service and fresh exact-caller authority.
 * @returns Router for asynchronous package runs and current-owner evidence.
 */
export function createTestLabRunRoutes(options: TestLabRunRouteOptions): Router {
  const router = Router();
  const handler = (action: (req: Request, service: TestLabRunService, context: () => Promise<TestLabRunContext>) => Promise<unknown>, status = 200) =>
    async (req: Request, res: Response) => {
      res.set('Cache-Control','private, no-store');
      try {
        if (!options.runService || !options.runContext) { res.status(503).json({ error: 'Package execution history is unavailable.' }); return; }
        if (req.method !== 'GET') mutation(req);
        const result = await action(req,options.runService,() => options.runContext!(req));
        res.status(status).json(result);
      } catch (error: any) {
        const code = Number(error?.status);
        res.status([400,401,403,404,409].includes(code) ? code : 503)
          .json({ error: [400,401,403,404,409].includes(code) ? error.message : 'Package execution is temporarily unavailable.' });
      }
    };
  router.post('/runs',handler(async (req,service,context) => ({ run: await service.start(req.body,context) }),202));
  router.get('/runs',handler(async (req,service,context) => ({ runs: await service.history(context,typeof req.query.app === 'string' ? req.query.app : undefined) })));
  router.get('/runs/:id',handler(async (req,service,context) => ({ run: await service.read(String(req.params.id),context) })));
  router.post('/runs/:id/cancel',handler(async (req,service,context) => {
    if (!req.body || Object.keys(req.body).length) throw Object.assign(new Error('Cancellation accepts only the run identifier.'), { status: 400 });
    return { run: await service.cancel(String(req.params.id),context) };
  }));
  return router;
}
