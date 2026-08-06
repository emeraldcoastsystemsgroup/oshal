/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added a fail-closed middleware that replaces the broad service-secret operator database stamp with the specifically asserted user identity before a user-bound router reads or writes owner-scoped data.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Document canonical X-Oshal-User-Sub-B64 attribution; the shared resolver retains a non-normalizing legacy plain-header rollout path.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Keep an independently authenticated browser or PAT principal authoritative even when a stale or injected legacy service-secret header is also present.
 */

import type { NextFunction, Request, Response } from 'express';
import {
  getTrustedServiceUserSub,
  hasAuthenticatedUserIdentity,
  hasValidServiceSecret,
} from './authz';
import { runWithRequestIdentity } from '@/shared/services/database/request-identity';

/**
 * @description Narrows a valid service-secret request to its trusted user-sub header before
 * downstream owner-scoped work begins. Kernel callers use canonical `X-Oshal-User-Sub-B64` so
 * subject case and whitespace survive HTTP exactly; the shared resolver temporarily accepts a
 * constrained legacy `X-Oshal-User-Sub` during rollout. The global request middleware treats the
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
  if (hasAuthenticatedUserIdentity(req)) {
    next();
    return;
  }
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
