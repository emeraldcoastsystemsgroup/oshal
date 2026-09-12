/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Expose same-origin exact-owner local schedule controls without accepting caller identity or execution commands.
 */
import { Router, type Request, type Response } from 'express';
import type { TestLabRunContext } from './test-lab-run-types';
import type { TestLabScheduleService } from './test-lab-schedule-service';

export interface TestLabScheduleRouteOptions {
  scheduleService?: TestLabScheduleService;
  runContext?: (req: Request) => Promise<TestLabRunContext>;
}
function mutation(req: Request): void {
  if (req.get('origin') !== `${req.protocol}://${req.get('host')}` || req.get('x-oshal-test-lab') !== '1' || !req.is('application/json')) {
    throw Object.assign(new Error('Schedule changes must come from this Test Lab page.'),{ status: 403 });
  }
}

/** @description Mount schedule controls alongside the existing authenticated durable run routes.
 * @param options Trusted service and fresh actor resolver. @returns Local schedule router. */
export function createTestLabScheduleRoutes(options: TestLabScheduleRouteOptions): Router {
  const router = Router();
  const handler = (action: (req: Request,service: TestLabScheduleService,resolve: () => Promise<TestLabRunContext>) => Promise<unknown>, status = 200) =>
    async (req: Request,res: Response) => {
      res.set('Cache-Control','private, no-store');
      try {
        if (!options.scheduleService || !options.runContext) { res.status(503).json({ error: 'Local scheduling is unavailable.' }); return; }
        if (req.method !== 'GET') mutation(req);
        res.status(status).json(await action(req,options.scheduleService,() => options.runContext!(req)));
      } catch (error: any) {
        const known = [400,401,403,404,409].includes(Number(error.status));
        res.status(known ? Number(error.status) : 503).json({ error: known ? error.message : 'Local scheduling is temporarily unavailable.' });
      }
    };
  router.get('/schedules',handler((_req,service,resolve) => service.list(resolve)));
  router.post('/schedules',handler(async (req,service,resolve) => ({ schedule: await service.create(req.body,resolve) }),201));
  router.patch('/schedules/:id',handler(async (req,service,resolve) => ({ schedule: await service.update(String(req.params.id),req.body,resolve) })));
  router.post('/schedules/:id/run-now',handler(async (req,service,resolve) => ({ batch: await service.runNow(String(req.params.id),req.body,resolve) }),202));
  router.get('/schedules/:id/history',handler(async (req,service,resolve) => ({ batches: await service.history(String(req.params.id),resolve) })));
  return router;
}
