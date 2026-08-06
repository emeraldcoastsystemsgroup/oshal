/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Add immediate SEC-01 containment for legacy shared-secret calls to user-scoped read routes, preserving independently authenticated users while returning a stable 403 and sanitized route/workload telemetry for machine-only attempts.
 */

import type { Request, RequestHandler } from 'express';
import { createChildLogger } from '@/shared/logger';
import {
  hasAuthenticatedUserIdentity,
  hasValidServiceSecret,
} from '@/shared/middleware/authz';

const logger = createChildLogger({ module: 'legacy-service-identity-containment' });
const WORKLOAD_HEADERS = [
  'x-oshal-workload-id',
  'x-oshal-agent-id',
  'x-oshal-client-id',
  'x-remote-client-id',
] as const;

interface WorkloadLogContext {
  workload: string;
  workloadSource: string;
}

/** Convert an untrusted header into a bounded, single-line telemetry label. */
function sanitizedLabel(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string') return null;
  const bounded = raw.trim().slice(0, 96);
  if (!bounded) return null;
  return bounded.replace(/[^A-Za-z0-9._:@/-]/g, '_');
}

/** Resolve only a claimed workload label; it is telemetry and never authorization input. */
function workloadLogContext(req: Request): WorkloadLogContext {
  for (const header of WORKLOAD_HEADERS) {
    const workload = sanitizedLabel(req.headers[header]);
    if (workload) return { workload, workloadSource: header };
  }
  const userAgent = sanitizedLabel(req.headers['user-agent']);
  if (userAgent) return { workload: userAgent, workloadSource: 'user-agent' };
  return { workload: 'unattributed-legacy-service', workloadSource: 'none' };
}

/** Report which subject assertion shape was attempted without logging the subject itself. */
function assertedSubjectHeader(req: Request): 'encoded' | 'plain' | 'missing' {
  if (req.headers['x-oshal-user-sub-b64'] !== undefined) return 'encoded';
  if (req.headers['x-oshal-user-sub'] !== undefined) return 'plain';
  return 'missing';
}

/**
 * @description Builds the immediate SEC-01 read guard. A matching fleet-wide service secret is
 * refused unless a separate user authentication rail has already established the principal.
 * The route label is static, the workload label is bounded and explicitly unverified, and neither
 * the secret nor the asserted victim subject is logged. Invalid credentials continue to the
 * ordinary auth wall, while OIDC and PAT callers remain authoritative.
 * @param route - Stable route template used to aggregate legacy-call telemetry.
 * @returns Express middleware that returns 403 `legacy_service_identity_not_allowed` for a
 * machine-only legacy identity and otherwise continues to the normal route authentication.
 */
export function rejectLegacyServiceIdentityForUserRead(route: string): RequestHandler {
  return (req, res, next): void => {
    if (!hasValidServiceSecret(req) || hasAuthenticatedUserIdentity(req)) {
      next();
      return;
    }
    logger.warn({
      route,
      method: req.method,
      ...workloadLogContext(req),
      workloadAttribution: 'unverified',
      assertedSubjectHeader: assertedSubjectHeader(req),
    }, 'Refused legacy service identity on user-scoped read route');
    res.status(403).json({ error: 'legacy_service_identity_not_allowed' });
  };
}
