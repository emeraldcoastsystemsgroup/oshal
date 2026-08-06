/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial ADR-065 connector-spec route mounting with caller-scoped credential resolution.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Replace boot-time per-provider mounts with two stable lazy routes that consult current deployment and per-user enablement before spec or credential loading, return a non-enumerating 404 while disabled, and evict disabled providers from the route cache.
 *
 * Connector spec routes (ADR-065/067).
 *
 * The route table has constant size regardless of catalog size. A provider spec is parsed only
 * after an authenticated request passes the current marketplace deployment and per-user gates.
 * Credentials remain request-scoped through the ADR-056 broker.
 *
 * Read-tier credential resolution retains the declarative auth contract: OAuth uses the caller's
 * brokered bearer token, API-key specs may use their configured operator-key fallback, and basic
 * auth uses its configured user/password source. Resolution happens after the live gate and on
 * every provider call, so credentials are never retained in the route cache. The entire surface
 * remains gated by `CONNECTOR_SPEC_ROUTES=on` in server.ts and is additive to bespoke routes.
 *
 * @module routes/connector-spec-routes
 */

import { existsSync } from 'fs';
import path from 'path';
import type { Express, Request, RequestHandler, Response } from 'express';
import { createChildLogger } from '@/shared/logger';
import {
  describeConnectorAction,
  invokeSpecResource,
  loadConnectorSpec,
  type BuildSpecOptions,
  type ConnectorSpec,
} from '../connectors/runtime';
import { resolveConnectorSpecCreds } from '@/app/connectors/runtime/spec-tools';

const logger = createChildLogger({ module: 'connector-spec-routes' });
const SPEC_DIR = path.join(process.cwd(), 'swarm-apps/connectors');
const DEFAULT_IMPORTED_SPEC_DIR = path.join(process.cwd(), 'output/connectors/imported-openapi');
const PROVIDER_SLUG = /^[a-z0-9][a-z0-9-]*$/;
const ROUTE_NOT_FOUND = { ok: false, error: 'connector route not found' } as const;

/**
 * @description Live provider gate used by the stable connector route delegate. The optional user
 * method preserves caller-specific disablement in addition to deployment enablement.
 */
export interface ConnectorSpecProviderGate {
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

/** @description Options for stable, lazy connector-spec route registration. */
export interface ConnectorSpecMountOptions {
  /** Current marketplace gate; omitted only by isolated callers outside marketplace mode. */
  providerGate?: ConnectorSpecProviderGate;
  /** Exact spec directories, primarily for isolated runtime verification. */
  specDirs?: string[];
  /** Injectable parser used by focused tests to prove no eager catalog parsing occurs. */
  loadSpec?: (file: string) => ConnectorSpec;
}

/** @description Read-only diagnostics for the stable delegate's active parsed-spec footprint. */
export interface ConnectorSpecRouteDelegate {
  /**
   * @description Counts active parsed specs without exposing their contents or credentials.
   * @returns Number of provider specs currently retained by the route delegate.
   */
  cachedProviderCount(): number;
  /**
   * @description Lists active parsed provider identities for footprint diagnostics.
   * @returns Sorted provider slugs currently retained by the route delegate.
   */
  cachedProviders(): string[];
}

interface ConnectorSpecRouteState {
  pool: unknown;
  gate?: ConnectorSpecProviderGate;
  dirs: string[];
  loadSpec: (file: string) => ConnectorSpec;
  cache: Map<string, ConnectorSpec>;
}

type ConnectorSpecAccess =
  | { ok: true; provider: string; spec: ConnectorSpec; userSub: string }
  | { ok: false; provider: string; status: 401 | 404; error: string };

/** The authenticated caller's OIDC sub (matches the bespoke connector routes). */
function callerSub(req: Request): string | undefined {
  const oidc = (req as { oidc?: { isAuthenticated?: () => boolean; user?: { sub?: string; oid?: string } } }).oidc;
  if (oidc?.isAuthenticated?.()) return oidc.user?.sub || oidc.user?.oid;
  return (req as { userSub?: string }).userSub;
}

/** Resolve read-tier credentials for the authenticated caller after every availability gate. */
async function resolveCreds(spec: ConnectorSpec, pool: unknown, userSub: string): Promise<BuildSpecOptions> {
  return resolveConnectorSpecCreds(spec, pool, userSub);
}

function resolveSpecDirs(configured?: string[]): string[] {
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

function loadProviderSpec(state: ConnectorSpecRouteState, provider: string): ConnectorSpec | undefined {
  const cached = state.cache.get(provider);
  if (cached) return cached;
  for (const dir of state.dirs) {
    for (const extension of ['yaml', 'yml']) {
      const file = path.join(dir, `${provider}.${extension}`);
      if (!existsSync(file)) continue;
      try {
        const spec = state.loadSpec(file);
        if (spec.provider !== provider) {
          logger.error({ file, provider, declaredProvider: spec.provider }, 'connector spec provider does not match requested route');
          return undefined;
        }
        state.cache.set(provider, spec);
        return spec;
      } catch (err) {
        logger.error({ err, stack: err instanceof Error ? err.stack : undefined, file }, 'connector spec not loadable for route call');
        return undefined;
      }
    }
  }
  return undefined;
}

async function providerEnabled(state: ConnectorSpecRouteState, userSub: string, provider: string): Promise<boolean> {
  if (!state.gate) return true;
  if (state.gate.enabledProviderSet && !state.gate.enabledProviderSet().has(provider)) return false;
  if (!state.gate.isProviderEnabled(provider)) return false;
  return state.gate.isEnabledForUser
    ? state.gate.isEnabledForUser(userSub, provider)
    : true;
}

async function resolveActiveSpec(state: ConnectorSpecRouteState, req: Request): Promise<ConnectorSpecAccess> {
  const provider = String(req.params.provider);
  const userSub = callerSub(req);
  if (!userSub) {
    return { ok: false, provider, status: 401, error: 'authenticated caller identity required for connector routes' };
  }
  if (!PROVIDER_SLUG.test(provider) || !(await providerEnabled(state, userSub, provider))) {
    state.cache.delete(provider);
    return { ok: false, provider, status: 404, error: ROUTE_NOT_FOUND.error };
  }
  const spec = loadProviderSpec(state, provider);
  if (!spec) return { ok: false, provider, status: 404, error: ROUTE_NOT_FOUND.error };
  return { ok: true, provider, spec, userSub };
}

function inputsFrom(req: Request): Record<string, unknown> {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? req.body as Record<string, unknown>
    : {};
  return { ...(req.query as Record<string, unknown>), ...body };
}

function resourcesHandler(state: ConnectorSpecRouteState): RequestHandler {
  return async (req: Request, res: Response) => {
    const started = Date.now();
    logger.info({ provider: String(req.params.provider) }, 'connector resource catalog requested');
    try {
      const access = await resolveActiveSpec(state, req);
      if (!access.ok) {
        logger.info({ provider: access.provider, status: access.status, ms: Date.now() - started }, 'connector resource catalog completed');
        res.status(access.status).json({ ok: false, error: access.error });
        return;
      }
      const resources = access.spec.resources.map((resource) => describeConnectorAction(access.spec, resource));
      logger.info({ provider: access.provider, status: 200, resourceCount: resources.length, ms: Date.now() - started }, 'connector resource catalog completed');
      res.json({ provider: access.spec.provider, displayName: access.spec.displayName, resources });
    } catch (err) {
      logger.error({ err, stack: err instanceof Error ? err.stack : undefined, ms: Date.now() - started }, 'connector resource catalog route failed');
      res.status(503).json({ ok: false, error: 'connector route unavailable' });
    }
  };
}

function resourceCallHandler(state: ConnectorSpecRouteState): RequestHandler {
  return async (req: Request, res: Response) => {
    const started = Date.now();
    const resource = String(req.params.resource);
    logger.info({ provider: String(req.params.provider), resource }, 'connector resource requested');
    try {
      const access = await resolveActiveSpec(state, req);
      if (!access.ok) {
        logger.info({ provider: access.provider, resource, status: access.status, ms: Date.now() - started }, 'connector resource completed');
        res.status(access.status).json({ ok: false, error: access.error });
        return;
      }
      const creds = await resolveCreds(access.spec, state.pool, access.userSub);
      const result = await invokeSpecResource(access.spec, creds, resource, inputsFrom(req));
      logger.info({ provider: access.provider, resource, status: result.status, ok: result.body.ok, ms: Date.now() - started }, 'connector resource completed');
      res.status(result.status).json(result.body);
    } catch (err) {
      logger.error({ err, stack: err instanceof Error ? err.stack : undefined, resource, ms: Date.now() - started }, 'connector resource route failed');
      res.status(503).json({ ok: false, error: 'connector route unavailable' });
    }
  };
}

/**
 * @description Registers two constant-size authenticated connector routes. Provider specs are
 * resolved lazily only after the current deployment and caller gates pass.
 * @param app Express application receiving the stable routes.
 * @param ctx Application context carrying the caller credential broker pool.
 * @param requiresAuth Authentication middleware; connector routes are never anonymous.
 * @param options Current provider gate plus optional isolated-test resolver overrides.
 * @returns Diagnostics exposing only the delegate's active parsed-spec cache.
 */
export function mountConnectorSpecRoutes(
  app: Express,
  ctx: { pool: unknown },
  requiresAuth: unknown,
  options: ConnectorSpecMountOptions = {},
): ConnectorSpecRouteDelegate {
  const state: ConnectorSpecRouteState = {
    pool: ctx.pool,
    gate: options.providerGate,
    dirs: resolveSpecDirs(options.specDirs),
    loadSpec: options.loadSpec ?? loadConnectorSpec,
    cache: new Map(),
  };
  app.get('/api/connectors/:provider/_resources', requiresAuth as never, resourcesHandler(state));
  app.post('/api/connectors/:provider/:resource', requiresAuth as never, resourceCallHandler(state));
  logger.info({ routeCount: 2, specDirCount: state.dirs.length }, 'lazy connector spec delegate mounted');
  return {
    cachedProviderCount: () => state.cache.size,
    cachedProviders: () => Array.from(state.cache.keys()).sort(),
  };
}
