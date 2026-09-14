/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation: re-enter the caller's RLS request identity when a multipart body parser (multer) completes. The body streams on the socket's own async context, so a parser that finishes on a later socket chunk calls next() with the AsyncLocalStorage identity gone and the post-upload handler reaches the GUC pool as anonymous non-operator (refused under OSHAL_DB_GUC_STRICT=deny and by owner RLS). Same capture-and-re-enter shape the spaces store package proved in 0.7.1. Guarded by tests/unit/multipart-request-identity-postgres.spec.ts.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { getRequestIdentity, runWithRequestIdentity } from '@/shared/services/database/request-identity';

/**
 * @description Wraps a streaming body parser — in practice a multer middleware such as
 * `upload.single('file')` — so the continuation it calls runs inside the request identity that
 * was in scope BEFORE the body streamed.
 *
 * Why this exists: the server's identity middleware binds the caller with AsyncLocalStorage and
 * calls `next()` inside that store. Multer (busboy) consumes the request body from socket `data`
 * events, which fire on the connection's async context, not the request's. A body that fits the
 * first socket chunk finishes while the store is still active; a larger or slower one finishes on
 * a later chunk, and the parser's callback then runs with NO identity. Every database call after
 * the upload is stamped anonymous non-operator by the GUC pool, so an owner-scoped write is
 * refused by row-level security. The defect looks size-dependent and intermittent because it is a
 * race between body size, network pacing and the parser.
 *
 * Capturing the identity before the stream and re-entering it around the continuation restores
 * the RLS contract for the handler and everything it awaits. Parser errors are forwarded
 * unchanged, so a route's own multer error handling keeps its shape. When no identity was in
 * scope (the GUC wrapper disabled), the parser's callback is passed through untouched.
 *
 * @param parser - The multer middleware (or any body parser that completes asynchronously).
 * @returns Middleware with the parser's contract whose `next` runs inside the caller's identity.
 */
export function preserveRequestIdentity(parser: RequestHandler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const identity = getRequestIdentity();
    parser(req, res, (err?: unknown) => {
      if (identity === undefined) {
        next(err);
        return;
      }
      runWithRequestIdentity(identity, () => next(err));
    });
  };
}
