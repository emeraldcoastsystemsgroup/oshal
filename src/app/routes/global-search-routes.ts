/**
 * Global Search Routes — one caller-scoped search box over the caller's OWN swarm data.
 *
 * Mounts the fan-out orchestrator from @/features/global-search (tickets, chat history,
 * personal-data vault, RAG) behind requiresAuth (applied at the mount in server.ts, same shape
 * as /api/rag). Isolation: the sub comes ONLY from the OIDC session; every adapter receives it as
 * the scope handle, and the api pool's GUC/RLS wrapper backstops the Postgres adapters.
 * There is deliberately NO storage-files adapter: the unified file browser (storage-browse.ts,
 * 2026-06-17) browses providers LIVE and keeps no index, and a global search must never walk
 * filesystems or provider APIs per keystroke — that adapter lands when a file index exists.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — GET / (?q=&sources=&limit= JSON search), GET /ui (the tools surface, global-search.html), GET /sources (adapter names for the UI's filter chips). Caller extras (email, operator, tenant + source-ACL groups) mirror rag-routes' ragContextFromRequest so RAG group-granted chunks resolve identically on both surfaces.
 *
 * @module global-search-routes
 */
import { Router, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import type { AppContext } from '@/app/composition/app-context';
import {
  ChatSearchSource,
  GlobalSearchService,
  PersonalDataSearchSource,
  RagSearchSource,
  TicketsSearchSource,
  type SearchCallerExtras,
} from '@/features/global-search';
import { sourceAclGroupsForCaller, type RagService } from '@/features/rag';
import { callerFromRequest, resolveRole, Role } from '@/features/governance';
import { getUserTenantIds } from './connector-tenancy';
import { tenantGroup } from './rag-routes';
import { servePage } from './trading-routes-helpers';

const logger = createChildLogger({ module: 'global-search-routes' });

/** Hard limits: query length keeps ILIKE patterns sane; result cap keeps the fan-out bounded. */
const MAX_QUERY_LENGTH = 200;
const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;

/**
 * @description Build the caller extras the permission-aware adapters need, mirroring
 * ragContextFromRequest in rag-routes.ts: token roles + tenant memberships + source-ACL identity
 * groups become the caller's groups, operator = RBAC admin. Session-derived only.
 * @param req - The Express request carrying the OIDC session.
 * @param pool - Postgres pool for tenant membership lookup.
 * @returns Extras for SearchSource.search.
 */
async function callerExtrasFromRequest(req: Request, pool: Pool | null): Promise<SearchCallerExtras> {
  const caller = callerFromRequest(req);
  const groups = [...(caller.roles ?? [])];
  if (pool && caller.sub) {
    try {
      for (const tenantId of await getUserTenantIds(pool, caller.sub)) groups.push(tenantGroup(tenantId));
    } catch (err) {
      // Tenancy schema unavailable — fail CLOSED to token-role groups only (fewer grants, never more).
      logger.error({ err, stack: (err as Error).stack }, 'tenant membership lookup failed; continuing with token-role groups');
    }
  }
  for (const g of sourceAclGroupsForCaller(caller.email)) groups.push(g);
  return { email: caller.email, isOperator: resolveRole(caller) === Role.Admin, groups };
}

/**
 * @description Build the global-search router (mount at /api/search behind requiresAuth).
 * Composes the adapter set ONCE: tickets + chat over the GUC-wrapped pool, the personal-data
 * vault (clean skip while the PIS is disabled), and permission-aware RAG.
 * @param ctx - App context (Postgres pool).
 * @param ragService - The api's RagService instance (created in server.ts next to /api/rag).
 * @param apiDir - Directory holding global-search.html.
 * @returns Express router.
 */
export function createGlobalSearchRoutes(ctx: AppContext, ragService: RagService, apiDir: string): Router {
  const router = Router();
  const service = new GlobalSearchService([
    new TicketsSearchSource(ctx.pool),
    new ChatSearchSource(ctx.pool),
    new PersonalDataSearchSource(),
    new RagSearchSource(ragService),
  ]);

  /** GET /ui — the search surface (tools iframe target). */
  router.get('/ui', servePage(apiDir, 'global-search.html'));

  /** GET /sources — registered adapter names, for the surface's filter chips. */
  router.get('/sources', (_req: Request, res: Response) => {
    res.json({ sources: service.sourceNames() });
  });

  /** GET /?q=&sources=&limit= — the caller-scoped search. */
  router.get('/', async (req: Request, res: Response) => {
    const started = Date.now();
    const sub = callerFromRequest(req).sub;
    if (!sub) { res.status(401).json({ error: 'authentication required' }); return; }

    const q = String(req.query.q ?? '').trim();
    if (!q) { res.status(400).json({ error: 'q query param required' }); return; }
    if (q.length > MAX_QUERY_LENGTH) { res.status(400).json({ error: `q too long (max ${MAX_QUERY_LENGTH} chars)` }); return; }

    const rawLimit = Number(req.query.limit);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), MAX_LIMIT) : DEFAULT_LIMIT;
    const sources = typeof req.query.sources === 'string' && req.query.sources.trim()
      ? req.query.sources.split(',')
      : undefined;

    logger.info({ sub, queryLength: q.length, limit, sources }, 'GET /api/search — entry');
    try {
      const extras = await callerExtrasFromRequest(req, ctx.pool);
      const result = await service.search(sub, q, limit, sources, extras);
      logger.info(
        { sub, merged: result.hits.length, sourceCounts: result.sourceCounts, durationMs: Date.now() - started },
        'GET /api/search — exit',
      );
      res.json({ query: q, limit, ...result });
    } catch (err) {
      logger.error({ err, stack: (err as Error).stack, sub, durationMs: Date.now() - started }, 'global search failed');
      res.status(500).json({ error: 'search failed' });
    }
  });

  return router;
}
