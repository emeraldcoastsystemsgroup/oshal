/**
 * Graph routes — the caller-scoped HTTP face of the graph connector (ADR-045 #2).
 *
 * Replaces the retired external Memgraph graph endpoint. Every endpoint resolves to the
 * CALLER'S OWN person graph via the connector — isolation is enforced by `callerSub`, so a request
 * can only ever read/write the requester's graph. This is what the incident/capture personas
 * (rca-specialist, capture-coordinator) call in place of that retired external graph API. The
 * outer mount accepts user auth or the legacy fleet credential, but SEC-01 rejects the latter on
 * every read before any forwarded subject is resolved.
 *
 * THE TENANT TIER IS DELIBERATELY NOT REACHABLE FROM HTTP. `getTenantGraph` exists on the
 * connector and is used IN-PROCESS only (the swarm operational graph, the world tier). No route
 * here takes a tenant parameter, because the connector enforces graph isolation and NOT tenant
 * membership — the membership check the connector's own doc comment defers "upstream" does not
 * exist yet, and it is unnecessary precisely because no HTTP path reaches that tier. Adding a
 * `?tenant=` here without first building that check would hand any authenticated caller another
 * tenant's shared graph. tests/unit/graph-route-tenant-boundary.spec.ts fails if it happens.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-045 #2 — caller-scoped /api/graph: query (AQL), neighbors, path, node/edge upsert; backed by the graph connector; 503 when the engine isn't configured.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-081: bots can act for their ticket's user — callerSub honors the trusted-service headers (X-Service-Secret + X-OSHAL-User-Sub, same pattern as /api/trading and /api/vids) so a bot-node curl reaches the RIGHT person graph under real OIDC, not just under MOCK_OIDC. Mount switched to serviceSecretOr(requiresAuth) in server.ts.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Graceful-degradation sweep: RUNTIME engine failure now degrades. callerGraph awaits getPersonGraph inside a try/catch — when ARANGO_URL is SET but the engine is unreachable (connection refused / provisioning listDatabases rejects), the rejection was previously unhandled inside the async route (→ 500 / hung request). It now logs at ERROR and returns a clear 503 graph_engine_unreachable, matching the ARANGO_URL-unset 503 shape. Query-time failures after the handle resolves keep their per-route 502.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | ADR-045 closure: POST /query now goes through GraphHandle.readQuery, which asks the ENGINE to plan the query and refuses a data-modifying one (400 graph_read_only). The endpoint documented itself as "run a raw AQL read" while calling rawQuery, so a REMOVE/INSERT went straight through — caller-scoped, so never a cross-tenant hole, but a contract the code contradicted, and a bot that mis-writes its own topology poisons the next investigation. Also documented WHY no route may take a tenant parameter (the tenant tier is in-process only and there is no upstream membership check), pinned by graph-route-tenant-boundary.spec.ts.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | SEC-01 containment: refuse fleet-wide service-secret identity on every graph read operation, keep OIDC/PAT authoritative under mixed headers, and retain legacy machine access only for the existing write operations pending durable delegation tokens.
 *
 * @module graph-routes
 */
import { Router, type Request, type Response } from 'express';
import { createChildLogger } from '@/shared/logger';
import { getTrustedServiceUserSub } from '@/shared/middleware/authz';
import { rejectLegacyServiceIdentityForUserRead } from '@/features/security';
import {
  createGraphConnector,
  GRAPH_READ_ONLY_CODE,
  type GraphConnector,
  type GraphEdge,
  type GraphNode,
} from '@/features/graph';

const logger = createChildLogger({ module: 'graph-routes' });

/** Acting user: an independently authenticated browser/PAT identity first, else the temporarily
 * retained service-secret subject used only by graph writes during containment. */
function callerSub(req: Request): string | null {
  const u = (req as { oidc?: { user?: { sub?: string } } }).oidc?.user;
  if (u?.sub) return String(u.sub);
  return getTrustedServiceUserSub(req);
}

/**
 * @description Builds the caller-scoped graph router. OIDC/PAT reads are authoritative; legacy
 * machine reads are refused while graph writes retain temporary compatibility. The graph connector
 * is created once; when the engine is not configured every admitted route returns 503.
 * @returns an Express Router for the graph API
 */
export function createGraphRoutes(): Router {
  const router = Router();
  const connector: GraphConnector | null = createGraphConnector();

  /** Resolve the caller's own graph, or write the right error and return null. */
  async function callerGraph(req: Request, res: Response) {
    const sub = callerSub(req);
    if (!sub) { res.status(401).json({ error: 'not_authenticated' }); return null; }
    if (!connector) { res.status(503).json({ error: 'graph_engine_unavailable', message: 'ARANGO_URL not configured' }); return null; }
    // ARANGO_URL is SET, but the engine can still be unreachable at runtime (connection refused,
    // or the lazy provisioning listDatabases round-trip rejects). Awaiting inside a try is what
    // turns that rejection into a clean 503 instead of an unhandled rejection surfacing as a 500.
    try {
      return await connector.getPersonGraph(sub);
    } catch (err) {
      logger.error({ err }, 'graph engine unreachable — person graph resolution failed');
      res.status(503).json({ error: 'graph_engine_unreachable', message: 'graph engine is not reachable' });
      return null;
    }
  }

  /**
   * POST /query — run an AQL READ against the caller's graph. Body: { aql, bindVars? }.
   * Reads only: `readQuery` has the engine plan the query first and refuses a data-modifying one
   * with 400 graph_read_only. Writes go through POST /nodes and POST /edges.
   */
  router.post('/query', rejectLegacyServiceIdentityForUserRead('/api/graph/query'), async (req: Request, res: Response) => {
    const g = await callerGraph(req, res); if (!g) return;
    const { aql, bindVars } = req.body as { aql?: string; bindVars?: Record<string, unknown> };
    if (!aql) { res.status(400).json({ error: 'aql required' }); return; }
    try { res.json({ rows: await g.readQuery(aql, bindVars || {}) }); }
    catch (err) {
      // A refused WRITE is the caller's mistake (400), not an engine failure (502) — the caller
      // must be able to tell "your query is not allowed here" from "the graph is broken".
      if ((err as { code?: string }).code === GRAPH_READ_ONLY_CODE) {
        logger.warn({ err }, 'graph query refused — write attempted on the read-only endpoint');
        res.status(400).json({ error: GRAPH_READ_ONLY_CODE, message: (err as Error).message });
        return;
      }
      logger.error({ err }, 'graph query failed'); res.status(502).json({ error: (err as Error).message });
    }
  });

  /** GET /neighbors?id=&depth= — nodes within `depth` hops of a node (blast radius). */
  router.get('/neighbors', rejectLegacyServiceIdentityForUserRead('/api/graph/neighbors'), async (req: Request, res: Response) => {
    const g = await callerGraph(req, res); if (!g) return;
    const id = String(req.query.id || '');
    if (!id) { res.status(400).json({ error: 'id required' }); return; }
    const depth = Math.max(1, Math.min(Number(req.query.depth) || 1, 6));
    try { res.json({ nodes: await g.neighbors(id, depth) }); }
    catch (err) { logger.error({ err }, 'graph neighbors failed'); res.status(502).json({ error: (err as Error).message }); }
  });

  /** GET /path?from=&to= — shortest path of nodes between two ids. */
  router.get('/path', rejectLegacyServiceIdentityForUserRead('/api/graph/path'), async (req: Request, res: Response) => {
    const g = await callerGraph(req, res); if (!g) return;
    const from = String(req.query.from || ''); const to = String(req.query.to || '');
    if (!from || !to) { res.status(400).json({ error: 'from and to required' }); return; }
    try { res.json({ nodes: await g.shortestPath(from, to) }); }
    catch (err) { logger.error({ err }, 'graph path failed'); res.status(502).json({ error: (err as Error).message }); }
  });

  /** POST /nodes — upsert nodes. Body: { nodes: [{ id, labels?, props? }] }. */
  router.post('/nodes', async (req: Request, res: Response) => {
    const g = await callerGraph(req, res); if (!g) return;
    const nodes = (req.body as { nodes?: GraphNode[] }).nodes;
    if (!Array.isArray(nodes)) { res.status(400).json({ error: 'nodes[] required' }); return; }
    try { res.json({ written: await g.upsertNodes(nodes) }); }
    catch (err) { logger.error({ err }, 'graph upsert nodes failed'); res.status(502).json({ error: (err as Error).message }); }
  });

  /** POST /edges — upsert edges. Body: { edges: [{ from, to, type, props? }] }. */
  router.post('/edges', async (req: Request, res: Response) => {
    const g = await callerGraph(req, res); if (!g) return;
    const edges = (req.body as { edges?: GraphEdge[] }).edges;
    if (!Array.isArray(edges)) { res.status(400).json({ error: 'edges[] required' }); return; }
    try { res.json({ written: await g.upsertEdges(edges) }); }
    catch (err) { logger.error({ err }, 'graph upsert edges failed'); res.status(502).json({ error: (err as Error).message }); }
  });

  return router;
}
