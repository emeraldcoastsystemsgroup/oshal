/**
 * Connector write-action route (connector-writes tier).
 *
 * POST /api/connectors/:id/actions/:action is the caller-scoped entry point for the opt-in write
 * tier. The live marketplace gate runs before spec, credential, audit, or provider work. The
 * executor then validates params, applies confirmation policy, resolves broker-only caller
 * credentials, records the pre-write audit row, and invokes the declared action.
 * Request body: `{ params: {...}, confirm?: true }`.
 *
 * Pipeline details: medium/high risk or `approvalRequired` actions return 428 until explicitly
 * confirmed. Credentials resolve lazily through `resolveConnectorActionCreds`, which is broker-only
 * and caller-owned: this write path never falls back to a `CONNECTOR_*` operator environment key.
 * A missing connection or credential-resolution failure becomes an audited 401. The `attempt` row
 * must land in `connector_action_audit` before provider traffic (503 otherwise), followed by a
 * terminal outcome row.
 *
 * The marketplace router and single-segment spec resource route do not match the two-segment
 * `/actions/:action` suffix, so this route remains additive without route ownership overlap.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — auth-gated write-action route over the connector action executor; spec resolution mirrors connector-spec-routes (same dirs, same broker creds resolver, same provider gate).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Review fixes: swap the read-tier resolveConnectorSpecCreds (which falls back to operator CONNECTOR_* env keys) for the broker-only resolveConnectorActionCreds, passed LAZILY into runConnectorAction so validation + the 428 confirm gate run before any broker read/token refresh and resolver failures are audited instead of 500ing unaudited.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Resolve current deployment and per-user enablement before spec lookup on every request, return a non-enumerating 404 while disabled, and evict disabled providers from the action cache so enable/disable cycles need no restart.
 *
 * @module routes/connector-action-routes
 */

import { existsSync } from 'fs';
import path from 'path';
import type { Express, Request, RequestHandler, Response } from 'express';
import { createChildLogger } from '@/shared/logger';
import {
  loadConnectorSpec,
  resolveConnectorActionCreds,
  runConnectorAction,
  type ConnectorActionAuditPool,
  type ConnectorSpec,
} from '../connectors/runtime';
import { getValidAccessToken } from './connectors-routes';

const logger = createChildLogger({ module: 'connector-action-routes' });
const SPEC_DIR = path.join(process.cwd(), 'swarm-apps/connectors');
const DEFAULT_IMPORTED_SPEC_DIR = path.join(process.cwd(), 'output/connectors/imported-openapi');
const PROVIDER_SLUG = /^[a-z0-9][a-z0-9-]*$/;
const ROUTE_NOT_FOUND = { ok: false, error: 'connector route not found' } as const;

/** @description Live provider gate for the stable connector action route. */
export interface ConnectorActionProviderGate {
  /**
   * @description Reads the current deployment-enabled provider set without catalog activation.
   * @returns Provider slugs currently enabled for the deployment.
   */
  enabledProviderSet?(): Set<string>;
  /**
   * @description Reads the provider's current deployment enablement.
   * @param provider Provider slug being resolved.
   * @returns True only while the provider is deployment-enabled.
   */
  isProviderEnabled(provider: string): boolean;
  /**
   * @description Reads the provider's current effective enablement for one caller.
   * @param userSub Authenticated caller identity.
   * @param provider Provider slug being resolved.
   * @returns True only while the caller may use the deployment-enabled provider.
   */
  isEnabledForUser?(userSub: string, provider: string): Promise<boolean>;
}

/** @description Options for mounting the stable, lazily resolved connector action route. */
export interface ConnectorActionMountOptions {
  /** Current marketplace gate; evaluated before any spec, credential, audit, or provider work. */
  providerGate?: ConnectorActionProviderGate;
  /** Exact spec directories, primarily for isolated runtime verification. */
  specDirs?: string[];
  /** Injectable parser used by focused tests to prove disabled routes do not load specs. */
  loadSpec?: (file: string) => ConnectorSpec;
}

interface ConnectorActionRouteState {
  pool: unknown;
  gate?: ConnectorActionProviderGate;
  dirs: string[];
  loadSpec: (file: string) => ConnectorSpec;
  cache: Map<string, ConnectorSpec>;
}

/** The authenticated caller's OIDC sub (same identity contract as connector-spec-routes). */
function callerSub(req: Request): string | undefined {
  const oidc = (req as { oidc?: { isAuthenticated?: () => boolean; user?: { sub?: string; oid?: string } } }).oidc;
  if (oidc?.isAuthenticated?.()) return oidc.user?.sub || oidc.user?.oid;
  return (req as { userSub?: string }).userSub;
}

/** Spec directories, in precedence order. Explicit directories isolate tests and private catalogs. */
function specDirs(configured?: string[]): string[] {
  if (configured?.length) return Array.from(new Set(configured.map((dir) => path.resolve(dir))));
  const dirs = [
    SPEC_DIR,
    ...(process.env.CONNECTOR_SPEC_DIRS ?? '').split(/[;,]/g).map((item) => item.trim()).filter(Boolean),
  ];
  if (!process.env.CONNECTOR_SPEC_DIRS && existsSync(DEFAULT_IMPORTED_SPEC_DIR)) {
    dirs.push(DEFAULT_IMPORTED_SPEC_DIR);
  }
  return Array.from(new Set(dirs.map((dir) => path.resolve(dir))));
}

/**
 * @description Loads and caches one exact provider spec after its live marketplace gate passes.
 * @param provider Route provider slug.
 * @param cache Process-lifetime cache of currently active provider specs.
 * @param dirs Ordered directories that may contain the provider spec.
 * @param loader Connector spec parser.
 * @returns Parsed matching spec, or undefined when no safe readable spec exists.
 */
function findConnectorSpec(
  provider: string,
  cache: Map<string, ConnectorSpec>,
  dirs: string[],
  loader: (file: string) => ConnectorSpec,
): ConnectorSpec | undefined {
  const cached = cache.get(provider);
  if (cached) return cached;
  for (const dir of dirs) {
    for (const extension of ['yaml', 'yml']) {
      const file = path.join(dir, `${provider}.${extension}`);
      if (!existsSync(file)) continue;
      try {
        const spec = loader(file);
        if (spec.provider !== provider) {
          logger.error({ file, provider, declaredProvider: spec.provider }, 'connector spec provider does not match requested action route');
          return undefined;
        }
        cache.set(provider, spec);
        return spec;
      } catch (err) {
        logger.error({ err, stack: err instanceof Error ? err.stack : undefined, file }, 'connector spec not loadable for action call');
        return undefined;
      }
    }
  }
  return undefined;
}

async function providerEnabled(
  gate: ConnectorActionProviderGate | undefined,
  userSub: string,
  provider: string,
): Promise<boolean> {
  if (!gate) return true;
  if (gate.enabledProviderSet && !gate.enabledProviderSet().has(provider)) return false;
  if (!gate.isProviderEnabled(provider)) return false;
  return gate.isEnabledForUser ? gate.isEnabledForUser(userSub, provider) : true;
}

function actionHandler(state: ConnectorActionRouteState): RequestHandler {
  return async (req: Request, res: Response) => {
    const started = Date.now();
    const provider = String(req.params.id);
    const actionName = String(req.params.action);
    const sub = callerSub(req);
    logger.info({ provider, action: actionName, hasSub: Boolean(sub) }, 'connector action requested');
    if (!sub) {
      logger.info({ provider, action: actionName, status: 401, ms: Date.now() - started }, 'connector action completed');
      res.status(401).json({ ok: false, error: 'authenticated caller identity required for connector actions' });
      return;
    }
    try {
      if (!PROVIDER_SLUG.test(provider) || !(await providerEnabled(state.gate, sub, provider))) {
        state.cache.delete(provider);
        logger.info({ provider, action: actionName, status: 404, ms: Date.now() - started }, 'connector action completed');
        res.status(404).json(ROUTE_NOT_FOUND);
        return;
      }
      const spec = findConnectorSpec(provider, state.cache, state.dirs, state.loadSpec);
      if (!spec) {
        logger.info({ provider, action: actionName, status: 404, ms: Date.now() - started }, 'connector action completed');
        res.status(404).json(ROUTE_NOT_FOUND);
        return;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const params = (body.params && typeof body.params === 'object' ? body.params : {}) as Record<string, unknown>;
      const result = await runConnectorAction({
        pool: state.pool as ConnectorActionAuditPool,
        spec,
        resolveCreds: () => resolveConnectorActionCreds(spec, state.pool, sub, getValidAccessToken),
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
  };
}

/**
 * @description Mounts the stable authenticated connector action route. A connector gains a write
 * surface only when its current marketplace gate passes and its spec declares the requested action.
 * @param app Express application receiving the action route.
 * @param ctx Application context carrying the broker and action-audit pool.
 * @param requiresAuth OIDC authentication middleware; this surface is never anonymous.
 * @param options Current marketplace gate and optional isolated-test resolver overrides.
 * @returns Nothing; the route remains stable while its provider gate changes live.
 */
export function mountConnectorActionRoutes(
  app: Express,
  ctx: { pool: unknown },
  requiresAuth: unknown,
  options: ConnectorActionMountOptions = {},
): void {
  const state: ConnectorActionRouteState = {
    pool: ctx.pool,
    gate: options.providerGate,
    dirs: specDirs(options.specDirs),
    loadSpec: options.loadSpec ?? loadConnectorSpec,
    cache: new Map(),
  };
  app.post('/api/connectors/:id/actions/:action', requiresAuth as never, actionHandler(state));
  logger.info({ specDirCount: state.dirs.length }, 'lazy connector write-action route mounted');
}
