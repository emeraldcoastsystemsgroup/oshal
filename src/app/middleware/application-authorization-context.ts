/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Carry verified request actors into protected controller execution.
 */
/** Carry authenticated actor evidence to typed tool and inline execution boundaries. */
import type { Request, RequestHandler } from 'express';
import type { AuthorizationActor } from '@/shared/application-authorization';
import { runWithApplicationAuthorizationActor } from '@/shared/application-authorization-context';

export function createApplicationActorContext(resolve: (request: Request) => Promise<AuthorizationActor>): RequestHandler {
  return async (req, _res, next) => {
    try { runWithApplicationAuthorizationActor(await resolve(req), next); }
    catch { next(); } // Missing evidence is never a system actor; protected execution refuses it.
  };
}
