/**
 * Personal-graph ingest trigger (ADR-066, end-to-end). POST /:provider pulls a connector's list via
 * the ADR-065 spec client (creds resolved per-caller through the broker, env fallback), runs the
 * provider's ingest mapper into the shared GraphStore, then reverberates (cross-source dedup). This
 * is the capstone wiring: Connect -> Pull -> Ingest -> Reverberate -> (query via personal-graph-routes).
 *
 * Read-only providers whose primary list returns full objects the mappers can use are in
 * DEFAULT_INGEST; any other (provider, resource) can be passed in the request body. Mounted only when
 * PERSONAL_GRAPH_ROUTES=on (off by default).
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — ADR-066 end-to-end ingest route.
 * -----------------------------------------------------------------------------
 * @module routes/personal-graph-ingest-routes
 */

import path from 'path';
import { Router, type Request, type Response } from 'express';
import { createChildLogger } from '@/shared/logger';
import { buildClientFromSpec, loadConnectorSpec, type BuildSpecOptions } from '../connectors/runtime';
import { getValidAccessToken } from './connectors-routes';
import { ingestFromConnector, reverberate, type GraphStore } from '@/features/personal-graph';

const logger = createChildLogger({ module: 'personal-graph-ingest-routes' });
const SPEC_DIR = path.join(process.cwd(), 'swarm-apps/connectors');

/** Providers whose primary list resource returns full objects the ingest mappers can use directly. */
const DEFAULT_INGEST: Record<string, { resource: string; inputs?: Record<string, unknown> }> = {
  'google-calendar': { resource: 'list-events', inputs: { calendarId: 'primary' } },
  github: { resource: 'list-repos' },
  strava: { resource: 'activities', inputs: { page: 1 } },
};

function callerSub(req: Request): string | undefined {
  const oidc = (req as { oidc?: { isAuthenticated?: () => boolean; user?: { sub?: string; oid?: string } } }).oidc;
  if (oidc?.isAuthenticated?.()) return oidc.user?.sub || oidc.user?.oid;
  return (req as { userSub?: string }).userSub;
}

const envTok = (provider: string): string => {
  const u = provider.toUpperCase().replace(/-/g, '_');
  return process.env[`CONNECTOR_${u}_TOKEN`] || process.env[`CONNECTOR_${u}_KEY`] || '';
};

/** POST /:provider — ingest the caller's data for one connector into the graph, then reverberate. */
export function createPersonalGraphIngestRoutes(deps: { pool: unknown; store: GraphStore }): Router {
  const router = Router();
  router.post('/:provider', async (req: Request, res: Response) => {
    const provider = String(req.params.provider);
    let spec;
    try {
      spec = loadConnectorSpec(path.join(SPEC_DIR, `${provider}.yaml`));
    } catch {
      res.status(404).json({ ok: false, error: 'unknown connector' });
      return;
    }
    const cfg = DEFAULT_INGEST[provider]
      || (req.body?.resource ? { resource: String(req.body.resource), inputs: (req.body.inputs as Record<string, unknown>) || {} } : null);
    if (!cfg) {
      res.status(400).json({ ok: false, error: `ingest not configured for '${provider}'; pass { resource, inputs } or use one of: ${Object.keys(DEFAULT_INGEST).join(', ')}` });
      return;
    }
    const sub = callerSub(req);
    const credProvider = spec.credProvider || provider;
    const token = (sub ? await getValidAccessToken(deps.pool, sub, credProvider) : null) || envTok(provider);
    if (!token) { res.status(401).json({ ok: false, error: 'not connected (no token)' }); return; }
    const creds: BuildSpecOptions = (spec.auth.type === 'apiKeyHeader' || spec.auth.type === 'apiKeyQuery')
      ? { apiKeyValue: token }
      : { token: async () => token };
    const client = buildClientFromSpec(spec, creds);
    try {
      const result = await ingestFromConnector(deps.store, provider as Parameters<typeof ingestFromConnector>[1], async () => {
        const data = await client.call<any>(cfg.resource, cfg.inputs || {});
        return Array.isArray(data) ? data : (data?.items || data?.data || data?.results || data?.value || []);
      });
      const reverb = reverberate(deps.store);
      res.json({ ok: true, provider, ...result, reverberate: reverb });
    } catch (err) {
      logger.warn({ err, provider }, 'personal-graph ingest failed');
      res.status(502).json({ ok: false, error: (err as Error).message });
    }
  });
  return router;
}
