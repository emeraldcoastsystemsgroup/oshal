/**
 * CHANGE LOG
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Apply dynamic application permissions to hard-mounted package paths.
 */
import type { RequestHandler } from 'express';
import type { SwarmAppService } from '@/features/swarm-apps';
import type { ApplicationAuthorizationRuntime } from '@/app/composition/application-authorization-runtime';

/** Run after the existing status/coarse tier gate; dynamic routers also invoke the same runtime. */
export function createApplicationAuthorizationGate(apps: SwarmAppService, runtime: ApplicationAuthorizationRuntime): RequestHandler {
  return async (req, res, next) => {
    const owner = apps.ownerOf(req.path);
    if (!owner) { next(); return; }
    await runtime.guard(owner.appName, req, res, next);
  };
}
