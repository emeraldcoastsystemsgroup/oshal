/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Automatic audit-trail capture middleware. Records every mutating (POST/PUT/PATCH/DELETE) and sensitive-read /api request to the append-only access_audit_log — actor, action, resource, allow/deny, duration — so traceability is on by default instead of opt-in on a handful of routes. Complements (does not replace) the explicit emitAuditEvent call sites. Non-blocking + non-throwing: records on response finish, never delays or breaks the request. Opt out with OSHAL_AUDIT_AUTOCAPTURE=false.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Wrapped the emitAuditEvent write in runWithSystemIdentity: the append-only audit writer is a trusted system writer (it records ANY actor's row on the FORCE-RLS access_audit_log), and it fires on res.finish/close OUTSIDE the request identity context. Deny-by-default (OSHAL_DB_GUC_STRICT=deny) would otherwise stamp it sub='' non-operator and the insert would fail — an actor could suppress their own audit trail. Stamping system keeps the writer able to record every actor.
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { Pool } from 'pg';
import { getCaller } from '@/shared/middleware/authz';
import { emitAuditEvent } from './audit-emit';
import type { AuditDecision } from './audit-emit';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'governance:audit-capture' });

/** Methods that change state — always recorded. */
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Read (GET) prefixes worth recording anyway — access to privileged/regulated data. */
const SENSITIVE_READ_PREFIXES = [
  '/api/audit', '/api/vault', '/api/privacy', '/api/connect', '/api/credentials',
  '/api/export', '/api/dev-console', '/api/graph',
];

/** Never recorded: health/metrics, high-frequency polling, and audit-log reads (noise/recursion). */
const SKIP_PREFIXES = [
  '/api/health', '/api/healthz', '/api/ready', '/api/livez', '/api/metrics',
  '/api/logs', '/api/heartbeat', '/api/queue-health', '/api/ui', '/api/voice',
  '/api/audit/log', '/api/audit/summary', '/api/mesh',
];

/** Machine liveness endpoints (dynamic id in the path) — noise, not actions. Matched on the path's
 *  final segment so /api/remote-clients/<id>/heartbeat is skipped while action endpoints on the same
 *  prefix (…/tasks) are still recorded. */
const SKIP_SUFFIXES = ['/heartbeat', '/register', '/presence', '/poll', '/ping'];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * @description Map an HTTP method to an audit verb.
 * @param method - upper-cased HTTP method
 * @returns create | update | delete | read
 */
function verbFor(method: string): string {
  switch (method) {
    case 'POST': return 'create';
    case 'PUT':
    case 'PATCH': return 'update';
    case 'DELETE': return 'delete';
    default: return 'read';
  }
}

/**
 * @description Translate a response status into an access decision for the audit row.
 * @param status - HTTP status code
 * @returns 'allow' for 2xx, 'deny' for auth/confirm/limit rejections, else 'info'
 */
export function decisionFor(status: number): AuditDecision {
  if (status >= 200 && status < 300) return 'allow';
  if (status === 401 || status === 403 || status === 428 || status === 429) return 'deny';
  return 'info';
}

/**
 * @description Derive the audit target (resourceType, resourceId, action) from a request path + method.
 * `/api/tickets/<uuid>/status` + PUT → { resourceType: 'tickets', resourceId: '<uuid>', action: 'tickets.update' }.
 * Pure and side-effect-free so it is trivially unit-tested.
 * @param method - upper-cased HTTP method
 * @param pathName - request path (no query string)
 * @returns the resource class, best-effort resource id, and the dotted action label
 */
export function deriveAuditTarget(method: string, pathName: string): { resourceType: string; resourceId: string | null; action: string } {
  const segs = pathName.replace(/^\/+|\/+$/g, '').split('/');
  const after = segs[0] === 'api' ? segs.slice(1) : segs;
  const resourceType = after[0] || 'root';
  const resourceId = after.slice(1).find((s) => UUID_RE.test(s) || /^\d+$/.test(s)) ?? null;
  return { resourceType, resourceId, action: `${resourceType}.${verbFor(method)}` };
}

/**
 * @description Decide whether a request should be recorded to the audit trail: every mutating
 * /api request, plus GETs against the sensitive-read prefixes, minus the skip list. Pure.
 * @param method - upper-cased HTTP method
 * @param pathName - request path (no query string)
 * @returns true if the request should be audited
 */
export function shouldCapture(method: string, pathName: string): boolean {
  if (!pathName.startsWith('/api/')) return false;
  if (SKIP_PREFIXES.some((p) => pathName.startsWith(p))) return false;
  if (SKIP_SUFFIXES.some((s) => pathName.endsWith(s))) return false;
  if (MUTATING_METHODS.has(method)) return true;
  if (method === 'GET') return SENSITIVE_READ_PREFIXES.some((p) => pathName.startsWith(p));
  return false;
}

/**
 * @description Build the automatic audit-capture Express middleware. Mount it once, after the auth
 * middleware (so the actor sub resolves) and before the /api routes. It records the request on
 * response finish via the non-throwing emitAuditEvent, so it never delays or breaks the request.
 * @param pool - Postgres pool used by emitAuditEvent
 * @returns an Express RequestHandler (a pass-through when OSHAL_AUDIT_AUTOCAPTURE=false)
 */
export function createAuditCaptureMiddleware(pool: Pool): RequestHandler {
  if (process.env.OSHAL_AUDIT_AUTOCAPTURE === 'false') {
    logger.info('Audit auto-capture disabled (OSHAL_AUDIT_AUTOCAPTURE=false)');
    return (_req: Request, _res: Response, next: NextFunction): void => next();
  }
  logger.info('Audit auto-capture enabled — recording mutating + sensitive /api requests');

  return (req: Request, res: Response, next: NextFunction): void => {
    const method = (req.method || 'GET').toUpperCase();
    const pathName = req.path || (req.originalUrl || '').split('?')[0];
    if (!shouldCapture(method, pathName)) {
      next();
      return;
    }

    const startedAt = Date.now();
    let recorded = false;
    const record = (): void => {
      if (recorded) return;
      recorded = true;
      try {
        const { sub } = getCaller(req);
        const { resourceType, resourceId, action } = deriveAuditTarget(method, pathName);
        // Fire-and-forget: emitAuditEvent never throws and self-heals its schema.
        // Run under the trusted SYSTEM identity so the FORCE-RLS access_audit_log insert
        // succeeds for ANY actor (this handler fires on res.finish/close, outside the request
        // identity context; under OSHAL_DB_GUC_STRICT=deny an identity-less write would be
        // scoped to sub='' non-operator and rejected — letting an actor drop their own trail).
        void runWithSystemIdentity(() => emitAuditEvent(pool, {
          actorSub: sub ?? null,
          action,
          resourceType,
          resourceId,
          decision: decisionFor(res.statusCode),
          metadata: { method, path: pathName, status: res.statusCode, ms: Date.now() - startedAt, source: 'auto-capture' },
        }));
      } catch (err) {
        // Audit must never affect the request it records.
        logger.error({ err }, 'audit auto-capture failed (swallowed)');
      }
    };

    res.on('finish', record);
    res.on('close', record); // client aborted before the response finished
    next();
  };
}
