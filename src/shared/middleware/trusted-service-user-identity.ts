/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added a fail-closed middleware that replaces the broad service-secret operator database stamp with the specifically asserted user identity before a user-bound router reads or writes owner-scoped data.
 */

import type { NextFunction, Request, Response } from 'express';
import { getTrustedServiceUserSub, hasValidServiceSecret } from './authz';
import { runWithRequestIdentity } from '@/shared/services/database/request-identity';

/**
 * @description Narrows a valid service-secret request to its trusted `X-OSHAL-User-Sub` before
 * downstream owner-scoped work begins. The global request middleware deliberately treats the
 * shared secret as operator-level system traffic for compatibility; leaving that ambient stamp in
 * place lets one machine caller cross every tenant boundary. User-bound routers mount this helper
 * first so their database calls instead carry `{ sub, isOperator: false }`.
 *
 * Ordinary OIDC/PAT requests are passed through untouched because their established request
 * identity is already authoritative. A valid service secret without a user binding is refused:
 * authentication proves which machine called, not which person's rows it may access.
 *
 * @param req - Express request carrying either an ordinary session or trusted service headers.
 * @param res - Express response used for the fail-closed attribution error.
 * @param next - Next router middleware, invoked inside the narrowed async identity context.
 * @returns Nothing; the function either sends a refusal or delegates to the next middleware.
 */
export function requireTrustedServiceUserIdentity(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!hasValidServiceSecret(req)) {
    next();
    return;
  }
  const sub = getTrustedServiceUserSub(req);
  if (!sub) {
    res.status(403).json({ error: 'trusted_service_user_sub_required' });
    return;
  }
  runWithRequestIdentity({ sub, isOperator: false }, () => next());
}
