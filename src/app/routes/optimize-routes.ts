/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Add Change Log header; docs/ path references updated in the 2026-07-04 docs consolidation
 */
/**
 * Model Optimize Routes — OSHAL app API (native migration of the standalone ai-optimize :8799).
 *
 * Phase 1 (catalog + configs): the signed-in user builds a per-user roster of
 * provider/model/harness "configs" to race a prompt across. The catalog is the live OSHAL
 * provider registry (the same one the cockpit model dropdown uses) — no vendored copy. The
 * roster persists per user_sub in Postgres (optimize_configs). Provider keys are NOT handled
 * here; they reuse the per-user oshal_connections store (ADR-042). The live race, judge,
 * report, history, and batch sweep are later phases (see docs/apps/ai-optimize-native-migration-plan.md).
 *
 * All routes are owner-scoped via the OIDC sub and MUST be mounted behind requiresAuth.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                          | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Initial Model Optimize routes — Phase 1: GET /catalog (provider registry), GET/POST /configs (per-user roster), surface serving.
 *
 * @module optimize-routes
 */
import { Router, type Request, type Response, type RequestHandler } from 'express';
import path from 'path';
import { createChildLogger } from '@/shared/logger';
import type { AppContext } from '@/app/composition/app-context';
import { ProviderRegistry, type ProviderInfo } from '@/features/llm-provider';

const logger = createChildLogger({ module: 'optimize-routes' });
const TOOL_DIR = path.resolve(process.cwd(), 'any-bot', 'server', 'services', 'tools', 'optimize');
const TENANT = 'default'; // single-tenant now; reserved everywhere a user is scoped.
const registry = new ProviderRegistry();

/** OIDC subject of the signed-in user — the per-user data scope. */
function callerSub(req: Request): string | null {
  const u = (req as { oidc?: { user?: { sub?: string } } }).oidc?.user;
  return u?.sub ? String(u.sub) : null;
}

/**
 * @description Maps an OSHAL provider id to its default execution harness. Mirrors the legacy
 * ai-optimize engine mapping but in OSHAL harness terms: the dedicated CLI-spawn harnesses for
 * the first-party vendors, and `cline` as the universal fallback for everything else.
 * @param providerId - Registry provider id.
 * @returns The default harness id for that provider.
 */
function deriveHarness(providerId: string): string {
  switch (providerId) {
    case 'claude-code':
    case 'anthropic':
      return 'claude-code';
    case 'openai-codex':
      return 'codex-cli';
    case 'gemini':
      return 'gemini-cli';
    default:
      return 'cline';
  }
}

/** One catalog entry the configs picker renders. */
interface CatalogProvider {
  id: string;
  label: string;
  harness: string;
  requiresApiKey: boolean;
  defaultModelId: string;
  models: Array<{ id: string; name: string }>;
}

/**
 * @description Shapes the live provider registry into the catalog the picker needs: each provider
 * with its model list and the harness it will race under.
 * @returns The provider catalog.
 */
function buildCatalog(): CatalogProvider[] {
  return (registry.getAll() as ProviderInfo[]).map((p) => ({
    id: p.id,
    label: p.displayName || p.id,
    harness: deriveHarness(p.id),
    requiresApiKey: !!p.requiresApiKey,
    defaultModelId: p.defaultModelId || (p.models?.[0]?.id ?? ''),
    models: (p.models ?? []).map((m) => ({ id: m.id, name: m.name || m.id })),
  }));
}

/** A config row as stored/returned. */
interface ConfigRow {
  id: string;
  provider: string;
  model: string;
  harness: string;
  label: string | null;
  args: string[] | null;
  enabled: boolean;
}

/** An inbound config from the surface (pre-validation). */
interface ConfigInput {
  provider?: unknown;
  model?: unknown;
  harness?: unknown;
  label?: unknown;
  args?: unknown;
  enabled?: unknown;
}

function serveFile(fileName: string): RequestHandler {
  return (_req: Request, res: Response) => {
    res.sendFile(path.join(TOOL_DIR, fileName), (err: unknown) => {
      if (err) { logger.error({ err, fileName }, 'serve failed'); res.status(404).send('Not found'); }
    });
  };
}

/**
 * @description Validates one inbound config against the live catalog and normalizes it. Returns
 * null when the provider is unknown or the model is missing (the surface should never send these,
 * but the server never trusts the client).
 * @param raw - The inbound config object.
 * @param catalogById - Catalog providers indexed by id.
 * @returns A normalized config (no id yet) or null when invalid.
 */
function normalizeConfig(
  raw: ConfigInput,
  catalogById: Map<string, CatalogProvider>,
): Omit<ConfigRow, 'id'> | null {
  const provider = String(raw.provider ?? '').trim();
  const model = String(raw.model ?? '').trim();
  const cat = catalogById.get(provider);
  if (!cat || !model) return null;
  const harness = String(raw.harness ?? '').trim() || cat.harness;
  const args = Array.isArray(raw.args) ? raw.args.map((a) => String(a)) : null;
  const label = raw.label != null && String(raw.label).trim() ? String(raw.label).trim() : null;
  return { provider, model, harness, label, args, enabled: raw.enabled !== false };
}

/** GET /catalog — the live provider registry shaped for the configs picker. */
function handleCatalog(): RequestHandler {
  return (_req: Request, res: Response): void => {
    res.json({ providers: buildCatalog() });
  };
}

/** GET /configs — the signed-in user's saved race roster. */
function handleGetConfigs(ctx: AppContext): RequestHandler {
  return async (req: Request, res: Response): Promise<void> => {
    const userSub = callerSub(req);
    if (!userSub) { res.status(401).json({ error: 'Not authenticated' }); return; }
    try {
      const rows = (await ctx.pool.query(
        `SELECT id, provider, model, harness, label, args, enabled
           FROM optimize_configs WHERE tenant_id=$1 AND user_sub=$2 ORDER BY sort_order, created_at`,
        [TENANT, userSub],
      )).rows as Array<Record<string, unknown>>;
      const configs: ConfigRow[] = rows.map((r) => ({
        id: String(r.id),
        provider: String(r.provider),
        model: String(r.model),
        harness: String(r.harness),
        label: r.label == null ? null : String(r.label),
        args: r.args == null ? null : safeArgs(String(r.args)),
        enabled: r.enabled !== false,
      }));
      res.json({ configs });
    } catch (err) {
      logger.error({ err, userSub }, 'Failed to read optimize configs');
      res.status(500).json({ error: 'Failed to read configs' });
    }
  };
}

/** Parse a stored JSON args string, tolerating bad data. */
function safeArgs(raw: string): string[] | null {
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v.map((a) => String(a)) : null; }
  catch { return null; }
}

/** POST /configs — replace the signed-in user's roster with the posted set (transactional). */
function handleSaveConfigs(ctx: AppContext): RequestHandler {
  return async (req: Request, res: Response): Promise<void> => {
    const userSub = callerSub(req);
    if (!userSub) { res.status(401).json({ error: 'Not authenticated' }); return; }
    const incoming = Array.isArray((req.body as { configs?: unknown })?.configs)
      ? (req.body as { configs: ConfigInput[] }).configs : [];
    const catalogById = new Map(buildCatalog().map((p) => [p.id, p]));
    const normalized = incoming
      .map((c) => normalizeConfig(c, catalogById))
      .filter((c): c is Omit<ConfigRow, 'id'> => c !== null);
    const client = await ctx.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM optimize_configs WHERE tenant_id=$1 AND user_sub=$2', [TENANT, userSub]);
      for (let i = 0; i < normalized.length; i++) {
        const c = normalized[i];
        await client.query(
          `INSERT INTO optimize_configs (tenant_id, user_sub, provider, model, harness, label, args, enabled, sort_order)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (tenant_id, user_sub, provider, model, harness)
             DO UPDATE SET label=EXCLUDED.label, args=EXCLUDED.args, enabled=EXCLUDED.enabled,
                           sort_order=EXCLUDED.sort_order, updated_at=NOW()`,
          [TENANT, userSub, c.provider, c.model, c.harness, c.label, c.args ? JSON.stringify(c.args) : null, c.enabled, i],
        );
      }
      await client.query('COMMIT');
      res.json({ ok: true, saved: normalized.length });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      logger.error({ err, userSub }, 'Failed to save optimize configs');
      res.status(500).json({ error: 'Failed to save configs' });
    } finally {
      client.release();
    }
  };
}

/**
 * @description Creates the Model Optimize app routes. Phase 1: provider catalog + per-user roster
 * (configs) + the configs surface. Must be mounted behind requiresAuth by the caller.
 * @param ctx - The application context (provides the Postgres pool).
 * @returns Router mounted at /api/optimize.
 */
export function createOptimizeRoutes(ctx: AppContext): Router {
  const router = Router();
  router.get('/catalog', handleCatalog());
  router.get('/configs', handleGetConfigs(ctx));
  router.post('/configs', handleSaveConfigs(ctx));
  router.get('/static/:file', (req: Request, res: Response) => {
    const file = path.basename(String(req.params.file));
    res.sendFile(path.join(TOOL_DIR, file), (err: unknown) => {
      if (err) { res.status(404).send('Not found'); }
    });
  });
  router.get('/', serveFile('optimize-configs.html'));
  router.get('/configs-ui', serveFile('optimize-configs.html'));
  logger.info('Model Optimize routes registered');
  return router;
}
