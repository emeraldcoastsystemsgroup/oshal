/**
 * Connector write-action route (connector-writes tier).
 *
 * POST /api/connectors/:id/actions/:action — the single caller-scoped entry point for the opt-in
 * write tier on top of the deliberately GET-only 306-connector catalog. Request body:
 *   { params: {...}, confirm?: true }
 * Pipeline (all inside runConnectorAction): params validated against the action's declared
 * paramsSchema BEFORE any credential/HTTP work; riskLevel medium/high or approvalRequired routes
 * through the risky-write confirm rail (428 confirmation_required until confirm:true); credentials
 * resolve LAZILY after those gates via resolveConnectorActionCreds — broker-only, the CALLER's own
 * connection (ADR-056/065 — never raw secrets, never a CONNECTOR_* operator env key: no connection
 * means an audited 401 not_connected, and a resolver failure is an audited 401, not a 500); an
 * 'attempt' row must land in connector_action_audit (migration 083) before the provider call
 * (503 audit_unavailable otherwise) and a terminal row records the outcome.
 *
 * Mount order note: the marketplace router (/api/connectors/marketplace/*) and the per-provider
 * spec routers (POST /api/connectors/<provider>/:resource — single segment) never match the
 * two-segment /actions/:action path, so this route is additive with zero overlap.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — auth-gated write-action route over the connector action executor; spec resolution mirrors connector-spec-routes (same dirs, same broker creds resolver, same provider gate).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Review fixes: swap the read-tier resolveConnectorSpecCreds (which falls back to operator CONNECTOR_* env keys) for the broker-only resolveConnectorActionCreds, passed LAZILY into runConnectorAction so validation + the 428 confirm gate run before any broker read/token refresh and resolver failures are audited instead of 500ing unaudited.
 *
 * @module routes/connector-action-routes
 */

import { existsSync } from 'fs';
import path from 'path';
import type { Express, Request, Response } from 'express';
import { createChildLogger } from '@/shared/logger';
import { loadConnectorSpec, resolveConnectorActionCreds, runConnectorAction, type ConnectorActionAuditPool, type ConnectorSpec } from '../connectors/runtime';
import { getValidAccessToken } from './connectors-routes';

const logger = createChildLogger({ module: 'connector-action-routes' });
const SPEC_DIR = path.join(process.cwd(), 'swarm-apps/connectors');
const DEFAULT_IMPORTED_SPEC_DIR = path.join(process.cwd(), 'output/connectors/imported-openapi');
const PROVIDER_SLUG = /^[a-z0-9][a-z0-9-]*$/;

/** @description Optional gates for mounting — mirrors ConnectorSpecMountOptions (ADR-067 marketplace). */
export interface ConnectorActionMountOptions {
  providerGate?: {
    isProviderEnabled(provider: string): boolean;
  };
}

/** The authenticated caller's OIDC sub (same read as connector-spec-routes / the bespoke routes). */
function callerSub(req: Request): string | undefined {
  const oidc = (req as { oidc?: { isAuthenticated?: () => boolean; user?: { sub?: string; oid?: string } } }).oidc;
  if (oidc?.isAuthenticated?.()) return oidc.user?.sub || oidc.user?.oid;
  return (req as { userSub?: string }).userSub;
}

/** Spec directories, in precedence order (mirrors connector-spec-routes / spec-tools). */
function specDirs(): string[] {
  const dirs = [
    SPEC_DIR,
    ...(process.env.CONNECTOR_SPEC_DIRS || '').split(/[;,]/g).map((item) => item.trim()).filter(Boolean),
  ];
  if (!process.env.CONNECTOR_SPEC_DIRS && existsSync(DEFAULT_IMPORTED_SPEC_DIR)) {
    dirs.push(DEFAULT_IMPORTED_SPEC_DIR);
  }
  return Array.from(new Set(dirs.map((dir) => path.resolve(dir))));
}

/**
 * @description Loads (and caches) the connector spec for a provider slug. The slug is
 * pattern-checked before touching the filesystem so `:id` can never traverse paths.
 * @param provider The `:id` route segment.
 * @param cache Process-lifetime spec cache (specs are baked files; bounce to reload, same as spec routes).
 * @returns The parsed spec, or undefined when no readable `<provider>.yaml` exists.
 */
function findConnectorSpec(provider: string, cache: Map<string, ConnectorSpec>): ConnectorSpec | undefined {
  if (!PROVIDER_SLUG.test(provider)) return undefined;
  const cached = cache.get(provider);
  if (cached) return cached;
  for (const dir of specDirs()) {
    const file = path.join(dir, `${provider}.yaml`);
    if (!existsSync(file)) continue;
    try {
      const spec = loadConnectorSpec(file);
      cache.set(provider, spec);
      return spec;
    } catch (err) {
      logger.error({ err, stack: err instanceof Error ? err.stack : undefined, file }, 'connector spec not loadable for action call');
      return undefined;
    }
  }
  return undefined;
}

/**
 * @description Mounts POST /api/connectors/:id/actions/:action behind requiresAuth. Additive: only
 * connectors that DECLARE an `actions` block gain any write surface; every other connector 404s
 * here exactly as before. Wire next to mountConnectorSpecRoutes in server.ts (same CONNECTOR_SPEC_ROUTES
 * gate + marketplace provider gate).
 * @param app The Express app.
 * @param ctx App context carrying the pg pool (broker + audit trail).
 * @param requiresAuth The OIDC auth middleware — this surface is never anonymous-callable.
 * @param options Optional ADR-067 marketplace provider gate.
 */
export function mountConnectorActionRoutes(
  app: Express,
  ctx: { pool: unknown },
  requiresAuth: unknown,
  options: ConnectorActionMountOptions = {},
): void {
  const specCache = new Map<string, ConnectorSpec>();

  app.post('/api/connectors/:id/actions/:action', requiresAuth as never, async (req: Request, res: Response) => {
    const started = Date.now();
    const provider = String(req.params.id);
    const actionName = String(req.params.action);
    const sub = callerSub(req);
    logger.info({ provider, action: actionName, hasSub: Boolean(sub) }, 'connector action requested');
    if (!sub) {
      res.status(401).json({ ok: false, error: 'authenticated caller identity required for connector actions' });
      return;
    }
    const spec = findConnectorSpec(provider, specCache);
    if (!spec) {
      res.status(404).json({ ok: false, error: `unknown connector '${provider}'` });
      return;
    }
    if (options.providerGate && !options.providerGate.isProviderEnabled(spec.provider)) {
      res.status(403).json({ ok: false, error: `connector '${provider}' is not enabled on this deployment` });
      return;
    }
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const params = (body.params && typeof body.params === 'object' ? body.params : {}) as Record<string, unknown>;
      const result = await runConnectorAction({
        pool: ctx.pool as ConnectorActionAuditPool,
        spec,
        resolveCreds: () => resolveConnectorActionCreds(spec, ctx.pool, sub, getValidAccessToken),
        userSub: sub,
        actionName,
        params,
        requestBody: body,
      });
      logger.info({ provider, action: actionName, status: result.status, ok: result.body.ok, ms: Date.now() - started }, 'connector action completed');
      res.status(result.status).json(result.body);
    } catch (err) {
      logger.error({ err, stack: err instanceof Error ? err.stack : undefined, provider, action: actionName, ms: Date.now() - started }, 'connector action route failed');
      res.status(500).json({ ok: false, error: 'connector action failed' });
    }
  });

  logger.info('connector write-action route mounted at POST /api/connectors/:id/actions/:action');
}
