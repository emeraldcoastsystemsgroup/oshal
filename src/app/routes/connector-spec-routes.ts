/**
 * Connector spec-routes mount (ADR-065 — the "go live" wiring).
 *
 * Auto-discovers every swarm-apps/connectors/*.yaml and serves it at /api/connectors/<provider>,
 * resolving credentials per-request by the spec's auth type:
 *   - oauth2  → bearer token via the ADR-056 broker (getValidAccessToken(pool, callerSub, provider))
 *   - apiKey* → operator key from env CONNECTOR_<PROVIDER>_KEY (tmdb falls back to TMDB_API_KEY)
 *   - basic   → CONNECTOR_<PROVIDER>_USER / _PASS
 * "Drop a connector.yaml" is now enough to get a live, broker-backed endpoint — no per-connector code.
 *
 * Gated by CONNECTOR_SPEC_ROUTES (default OFF); additive and parallel to the bespoke routes
 * (/api/spotify etc.), which are unaffected.
 *
 * @module routes/connector-spec-routes
 */

import { existsSync, readdirSync } from 'fs';
import path from 'path';
import type { Express, Request } from 'express';
import { createChildLogger } from '@/shared/logger';
import { createConnectorSpecRouter, loadConnectorSpec, type BuildSpecOptions, type ConnectorSpec } from '../connectors/runtime';
import { resolveConnectorSpecCreds } from '@/app/connectors/runtime/spec-tools';

const logger = createChildLogger({ module: 'connector-spec-routes' });
const SPEC_DIR = path.join(process.cwd(), 'swarm-apps/connectors');
const DEFAULT_IMPORTED_SPEC_DIR = path.join(process.cwd(), 'output/connectors/imported-openapi');

export interface ConnectorSpecMountOptions {
  providerGate?: {
    isProviderEnabled(provider: string): boolean;
  };
}

/** The authenticated caller's OIDC sub (matches how the bespoke routes read it). */
function callerSub(req: Request): string | undefined {
  const oidc = (req as { oidc?: { isAuthenticated?: () => boolean; user?: { sub?: string; oid?: string } } }).oidc;
  if (oidc?.isAuthenticated?.()) return oidc.user?.sub || oidc.user?.oid;
  return (req as { userSub?: string }).userSub;
}

/**
 * Resolve build-time creds for a request, by the spec's declared auth shape. The caller's
 * broker-stored token (per-user paste/OAuth, ADR-056) WINS; an operator env token is the fallback.
 */
async function resolveCreds(spec: ConnectorSpec, pool: unknown, req: Request): Promise<BuildSpecOptions> {
  return resolveConnectorSpecCreds(spec, pool, callerSub(req));
}

/**
 * Mount /api/connectors/<provider> for every connector.yaml. Returns the providers mounted.
 * Safe to call unconditionally; the caller gates it behind CONNECTOR_SPEC_ROUTES.
 */
export function mountConnectorSpecRoutes(
  app: Express,
  ctx: { pool: unknown },
  requiresAuth: unknown,
  options: ConnectorSpecMountOptions = {},
): string[] {
  const files = connectorSpecFiles();
  if (files.length === 0) {
    logger.warn({ SPEC_DIR }, 'connector spec dirs not readable or empty; nothing mounted');
    return [];
  }
  const mounted: string[] = [];
  for (const file of files) {
    let spec: ConnectorSpec;
    try {
      spec = loadConnectorSpec(file);
    } catch (err) {
      logger.warn({ err, file }, 'connector spec not loadable; skipping');
      continue;
    }
    if (options.providerGate && !options.providerGate.isProviderEnabled(spec.provider)) {
      logger.info({ provider: spec.provider }, 'connector spec route not mounted because provider is not enabled');
      continue;
    }
    const router = createConnectorSpecRouter(spec, { resolveCreds: (req) => resolveCreds(spec, ctx.pool, req) });
    app.use(`/api/connectors/${spec.provider}`, requiresAuth as never, router);
    mounted.push(spec.provider);
  }
  logger.info({ mounted }, 'ADR-065 connector spec-routes mounted at /api/connectors/<provider>');
  return mounted;
}

function connectorSpecFiles(): string[] {
  const dirs = Array.from(new Set([
    SPEC_DIR,
    ...((process.env.CONNECTOR_SPEC_DIRS || '').split(/[;,]/g).map((item) => item.trim()).filter(Boolean)),
  ].map((dir) => path.resolve(dir))));
  if (!process.env.CONNECTOR_SPEC_DIRS && existsSync(DEFAULT_IMPORTED_SPEC_DIR)) {
    dirs.push(path.resolve(DEFAULT_IMPORTED_SPEC_DIR));
  }
  const files: string[] = [];
  for (const dir of dirs) {
    try {
      for (const file of readdirSync(dir)) {
        if (file.endsWith('.yaml') || file.endsWith('.yml')) files.push(path.join(dir, file));
      }
    } catch (err) {
      logger.warn({ err, dir }, 'connector spec dir not readable; skipping');
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}
