/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Expose a fixed internal current-rights challenge endpoint requiring machine and signed dispatch proof.
 */
import express, { type Request, type Response, type NextFunction, type RequestHandler, type ErrorRequestHandler } from 'express';
import { REMOTE_EXECUTION_PATH, type ApplicationRemoteExecutionAuthority } from '@/shared/application-remote-execution';
import { RemoteExecutionError } from '@/features/application-remote-execution';

const invalidBody: ErrorRequestHandler = (_error, _req, res, _next) => { res.status(400).json({ error: 'remote_execution_request_invalid' }); };

/** @description Mount the one internal route; its service independently validates the original signed token.
 * @param authority Controller authority. @param requiresMachine Existing service authentication middleware.
 * @returns Router mounted at application root, with a fixed absolute path and bounded body.
 */
export function createApplicationRemoteExecutionRoutes(authority: ApplicationRemoteExecutionAuthority, requiresMachine: RequestHandler) {
  const router = express.Router();
  router.post(REMOTE_EXECUTION_PATH, (_req: Request, res: Response, next: NextFunction) => { res.setHeader('Cache-Control', 'no-store'); next(); },
    requiresMachine, express.json({ limit: '32kb' }), async (req: Request, res: Response) => {
      try { res.json(await authority.revalidate(req.body)); }
      catch (error) {
        const status = error instanceof RemoteExecutionError ? error.status : 503;
        res.status(status).json({ error: error instanceof RemoteExecutionError ? error.code : 'remote_execution_unavailable' });
      }
    }, invalidBody);
  return router;
}
