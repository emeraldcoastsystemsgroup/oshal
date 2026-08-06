/**
 * Profile Studio Ingest Route — trusted desktop-runtime callback for LinkedIn profile updates.
 *
 * POST /ingest accepts only a short-lived, one-use capability bound in PostgreSQL to the exact
 * owner, immutable dispatch generation, task, selected client, and resolve operation. Callback
 * result JSON is strict and bounded; missing, expired, replayed, mismatched, and stale ABA attempts
 * all lose the same atomic update without falling back to the fleet service secret.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                     | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial desktop-worker profile outcome callback.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Re-enter exact asserted plan-owner identity with non-operator database scope.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Replace reusable service-secret/body identity trust with a one-use generation/task/client/operation-bound capability, strict result validation, replay-safe atomic consume, and workspace cleanup.
 *
 * @module profile-studio-ingest-routes
 */

import { Router, type Request, type Response } from 'express';
import { createChildLogger } from '@/shared/logger';
import type { AppContext } from '@/app/composition/app-context';
import { cleanupProfileDispatchWorkspace } from '@/app/profile-studio-dispatch';
import { runWithRequestIdentity } from '@/shared/services/database/request-identity';
import {
  ProfileCallbackRequestSchema,
  ProfilePlanStore,
  hashProfileDispatchCapability,
  parseProfileDispatchCapability,
  type ProfileCallbackRequest,
} from '@/features/profile-studio';

const logger = createChildLogger({ module: 'profile-studio-ingest-routes' });

/**
 * @description Builds the capability-authenticated profile result router. It remains outside OIDC
 * because the trusted desktop daemon is not a browser session; the one-use grant self-authenticates.
 * @param ctx - App context providing the owner-scoped PostgreSQL pool.
 * @returns Router mounted at /api/profile-studio without requiresAuth.
 */
export function createProfileStudioIngestRoutes(ctx: AppContext): Router {
  const router = Router();
  const store = new ProfilePlanStore(ctx.pool);
  router.post('/ingest', (req: Request, res: Response) => {
    void handleProfileResult(store, req, res);
  });
  return router;
}

/** @description Validates, atomically consumes, and resolves one exact dispatch callback. */
async function handleProfileResult(
  store: ProfilePlanStore,
  req: Request,
  res: Response,
): Promise<void> {
  const capability = parseProfileDispatchCapability(req.header('x-oshal-callback-capability'));
  if (!capability) { res.status(401).json({ error: 'callback capability required' }); return; }
  const parsed = ProfileCallbackRequestSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'invalid callback result' }); return; }
  try {
    const moved = await consumeProfileResult(store, parsed.data, capability);
    if (!moved) { res.status(409).json({ error: 'callback rejected' }); return; }
    await cleanupProfileDispatchWorkspace(parsed.data.taskId);
    logger.info(callbackLog(parsed.data), 'profile plan result capability consumed');
    res.json({ ok: true, result: parsed.data.result.result });
  } catch (error) {
    logger.error({ err: error, taskId: parsed.data.taskId }, 'profile plan callback failed');
    res.status(500).json({ error: 'ingest failed' });
  }
}

/** @description Re-enters exact owner scope before the atomic generation-bound database consume. */
function consumeProfileResult(
  store: ProfilePlanStore,
  request: ProfileCallbackRequest,
  token: string,
): Promise<boolean> {
  const { context, result, taskId } = request;
  return runWithRequestIdentity({ sub: context.userSub, isOperator: false }, () =>
    store.consumeDispatchCallback(
      context.userSub,
      context.generation,
      taskId,
      context.clientId,
      context.operation,
      hashProfileDispatchCapability(token),
      result.result,
      result.note,
    ));
}

/** @description Produces a bounded structured log without capability or result-note content. */
function callbackLog(request: ProfileCallbackRequest): Record<string, unknown> {
  return {
    userSub: request.context.userSub,
    taskId: request.taskId,
    clientId: request.context.clientId,
    generation: request.context.generation,
    result: request.result.result,
  };
}
