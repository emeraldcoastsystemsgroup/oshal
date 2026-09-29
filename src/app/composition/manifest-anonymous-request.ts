/**
 * CHANGE LOG
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Confine anonymous dispatch to an identity-free request view and restore the original request on fallthrough or completion.
 */
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { createChildLogger } from '@/shared/logger';
const logger = createChildLogger({ module: 'manifest-anonymous-request' });

// Session storage is not rewritten: response-time session middleware must keep its original
// bookkeeping. Package caller helpers use these projections, not the backing cookie session.
const REQUEST_IDENTITY_FIELDS = ['oidc', 'oshalCallerSub'];
const ACCESS_LOCALS = ['applicationAuthorization', 'oshalAppAccess'];
const identityHeader = (name: string): boolean =>
  /^(authorization|cookie|x-service-secret|x-oshal-.*|x-mock-oidc-.*)$/i.test(name);

/** Capture descriptors, not just values: absent properties and upstream accessors must restore exactly. */
function mask(target: object, values: Record<string, unknown>, restores: Array<() => void>): void {
  for (const [key, value] of Object.entries(values)) {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    Object.defineProperty(target, key, { configurable: true, enumerable: descriptor?.enumerable ?? true,
      writable: true, value });
    restores.push(() => {
      if (descriptor) Object.defineProperty(target, key, descriptor);
      else if (!Reflect.deleteProperty(target, key)) throw new Error('Anonymous request field could not be removed');
    });
  }
}

/**
 * @description Hide the request identity rails used by package caller helpers only during the opted-in handler.
 * The existing request is restored before another handler can run; no global auth middleware changes.
 * @param req Actual Express request; headers unrelated to authentication (including Range) are preserved.
 * @param res Response with potentially inherited app-access decisions.
 * @param handler This exact anonymous handler.
 * @param next Fallthrough/error continuation, entered only after restoration.
 * @returns Nothing; async handlers keep the mask until next, finish or close; failed restoration refuses continuation.
 */
export function invokeAnonymousPackageHandler(req: Request, res: Response, handler: RequestHandler, next: NextFunction): void {
  const restores: Array<() => void> = [];
  let restoration: 'pending' | 'complete' | 'failed' = 'pending';
  let continued = false;
  const restore = (): boolean => {
    if (restoration !== 'pending') return restoration === 'complete';
    restoration = 'complete'; res.removeListener('finish', restore); res.removeListener('close', restore);
    for (const undo of restores.reverse()) {
      try { undo(); }
      catch (error) {
        restoration = 'failed';
        logger.error({ err: error }, 'Anonymous package request restoration failed');
      }
    }
    if (restoration === 'failed') {
      // Never pass a partially restored request to another package or error middleware.
      if (!res.headersSent) res.status(503).json({ error: 'anonymous_request_scope_unavailable' });
      else if (!res.writableEnded) res.destroy();
      return false;
    }
    return true;
  };
  const resume = (error?: unknown): void => {
    if (continued) return;
    continued = true;
    if (restore()) next(error);
  };
  try {
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([name]) => !identityHeader(name)));
    const rawHeaders = req.rawHeaders.filter((_value, index, entries) => !identityHeader(entries[index - index % 2]));
    // The mounter strips url inside the handler; errors and fallthrough must restore it too.
    mask(req, { url: req.url, ...Object.fromEntries(REQUEST_IDENTITY_FIELDS.map(key => [key, undefined])), headers, rawHeaders }, restores);
    mask(res.locals, Object.fromEntries(ACCESS_LOCALS.map(key => [key, undefined])), restores);
    res.once('finish', restore); res.once('close', restore);
    const result: unknown = handler(req, res, resume);
    if (result && typeof (result as Promise<unknown>).then === 'function') {
      void Promise.resolve(result).catch(error => {
        logger.error({ err: error }, 'Anonymous package handler failed'); resume(error);
      });
    }
  } catch (error) {
    logger.error({ err: error }, 'Anonymous package request scope failed'); resume(error);
  }
}
