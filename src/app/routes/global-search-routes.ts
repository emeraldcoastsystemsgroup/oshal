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
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Composed the three new typed adapters (apps/bots/connectors) so search answers "which app / bot / connection" and not only "which ticket / chat / doc". This route is the FSD seam: a features slice may not import the app-layer swarm registry or SwarmAppService, so the app + bot listers are built HERE and injected — deliberately UNFILTERED, because each adapter owns (and unit-tests) its own visibility rule; two filters would mean neither is provably the one in force. GET /sources now returns {name, kind, deepLink, noSurfaceReason} so a surface renders typed rows and explains an unlinked hit from the API instead of from its own copy of the rules.
 *
 * @module global-search-routes
 */
import { Router, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import type { AppContext } from '@/app/composition/app-context';
import {
  AppsSearchSource,
  BotsSearchSource,
  ChatSearchSource,
  ConnectorsSearchSource,
  GlobalSearchService,
  NO_SURFACE_REASON,
  PersonalDataSearchSource,
  RagSearchSource,
  TicketsSearchSource,
  type SearchableApp,
  type SearchableBot,
  type SearchCallerExtras,
  type SearchHitKind,
  type SearchSource,
} from '@/features/global-search';
import { resolveDisplayOnline } from '@/features/agent-management';
import type { SwarmApplicationSummary } from '@/features/swarm-apps';
import { getActiveRegistry } from '@/app/extensions/swarm/swarm-bot-registry';
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
/**
 * Which result kind each adapter emits. Exposed on GET /sources so a surface groups and labels
 * typed rows from the API rather than from a hardcoded map in HTML that silently drifts.
 */
const SOURCE_KINDS: Readonly<Record<string, SearchHitKind>> = Object.freeze({
  tickets: 'ticket',
  chat: 'chat',
  apps: 'app',
  bots: 'bot',
  connectors: 'connector',
  rag: 'doc',
  personal: 'entity',
});

/**
 * @description Build the UNFILTERED installed-app record list the apps adapter filters itself.
 * `listApps()` is deliberately called with NO caller argument: SwarmAppService would otherwise
 * apply its own visibility pass and the adapter (which owns the tested rule) would receive an
 * already-narrowed list — two filters, neither provably the one in force. One filter, in the
 * adapter, is the auditable arrangement.
 * @param listApps - SwarmAppService.listApps, bound by the composition root.
 * @returns A lister yielding every installed app with its scope + ownerSub.
 */
export function buildAppLister(
  listApps: () => Promise<SwarmApplicationSummary[]>,
): () => Promise<SearchableApp[]> {
  return async () => (await listApps()).map((a) => ({
    name: a.name,
    displayName: a.displayName || a.name,
    description: a.description || '',
    suite: a.suite ?? null,
    scope: a.scope,
    ownerSub: a.ownerSub,
    updatedAt: a.updatedAt || a.loadedAt || null,
  }));
}

/**
 * @description Build the UNFILTERED bot record list the bots adapter role-filters itself.
 * Liveness mirrors bot-registry-routes exactly (resolveDisplayOnline over the Redis heartbeat plus
 * the container, so inline api-hosted bots are not reported dead) and degrades to 'unknown' —
 * never to 'offline' — when the runtime registry is absent or unreachable, because reporting an
 * outage the swarm is not having is worse than admitting the probe failed.
 * @param listRegistrations - Runtime registry lister, when the Redis-backed service is wired.
 * @returns A lister yielding every active-registry bot with its accessRoles.
 */
export function buildBotLister(
  listRegistrations?: () => Promise<Array<{ agentId: string; agentName: string; status?: string }>>,
): () => Promise<SearchableBot[]> {
  return async () => {
    let live: Map<string, boolean> | null = null;
    if (listRegistrations) {
      try {
        const regs = await listRegistrations();
        live = new Map<string, boolean>();
        for (const r of regs) {
          live.set(r.agentId, r.status === 'online');
          live.set(r.agentName, r.status === 'online');
        }
      } catch (err) {
        logger.error(
          { err, stack: (err as Error).stack },
          'runtime registry unreachable - bot liveness reported as unknown',
        );
        live = null;
      }
    }
    return getActiveRegistry()
      .filter((b) => typeof b.agentId === 'string' && b.agentId.trim().length > 0)
      .map((b) => {
        const heartbeat = live ? (live.get(b.agentId as string) ?? live.get(b.name) ?? false) : null;
        const status: SearchableBot['status'] = heartbeat === null
          ? 'unknown'
          : (resolveDisplayOnline(heartbeat, b.container) ? 'online' : 'offline');
        return {
          agentId: b.agentId as string,
          name: b.name,
          role: b.role || '',
          capabilities: b.capabilities || [],
          harnessType: b.harnessType ?? null,
          accessRoles: b.accessRoles,
          status,
        } satisfies SearchableBot;
      });
  };
}

export function createGlobalSearchRoutes(
  ctx: AppContext,
  ragService: RagService,
  apiDir: string,
  deps?: { listApps?: () => Promise<SwarmApplicationSummary[]> },
): Router {
  const router = Router();
  // Annotated as SearchSource[]: an inferred union of the concrete classes makes the later
  // splice() of AppsSearchSource a type error, and the adapter set is only ever used through
  // the interface anyway.
  const sources: SearchSource[] = [
    new TicketsSearchSource(ctx.pool),
    new ChatSearchSource(ctx.pool),
    new ConnectorsSearchSource(ctx.pool),
    new BotsSearchSource(buildBotLister(
      ctx.swarm?.runtimeRegistryService
        ? () => ctx.swarm.runtimeRegistryService!.listAgentRegistrations()
        : undefined,
    )),
    new PersonalDataSearchSource(),
    new RagSearchSource(ragService),
  ];
  // Apps only when the composition root supplies the lister. No lister means no `apps` chip at
  // all, rather than a registered adapter that answers [] forever and reads as an empty catalog.
  if (deps?.listApps) sources.splice(2, 0, new AppsSearchSource(buildAppLister(deps.listApps)));
  const service = new GlobalSearchService(sources);

  /** GET /ui — the search surface (tools iframe target). */
  router.get('/ui', servePage(apiDir, 'global-search.html'));

  /**
   * GET /sources — the registered adapters as {name, kind, deepLink, noSurfaceReason} records.
   * This IS the machine-readable half of the deep-link contract: a surface groups typed rows and
   * explains an unlinked result from the API, never from its own restatement of the rules.
   */
  router.get('/sources', (_req: Request, res: Response) => {
    res.json({
      sources: service.sourceNames().map((name) => {
        const kind = SOURCE_KINDS[name] ?? null;
        return {
          name,
          kind,
          deepLink: kind ? !(kind in NO_SURFACE_REASON) : null,
          noSurfaceReason: kind ? (NO_SURFACE_REASON[kind] ?? null) : null,
        };
      }),
    });
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
