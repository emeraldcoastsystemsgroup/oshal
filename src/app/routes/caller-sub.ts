/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085 Wave 3 (career-hunter carve): callerSub extracted from career-hunter-routes — it is a generic OIDC-subject resolver with nothing career-specific, and apply-operator-routes + notify-routes (both core) imported it from the carving module. Kernel-shared now; the packaged career routes import it via this alias.
 */

import type { Request } from 'express';

/** @description OIDC subject of the signed-in user — the per-user data scope. Null for anonymous/service callers. */
export function callerSub(req: Request): string | null {
  const u = (req as { oidc?: { user?: { sub?: string } } }).oidc?.user;
  return u?.sub ? String(u.sub) : null;
}
