/**
 * Graph routes — the caller-scoped HTTP face of the graph connector (ADR-045 #2).
 *
 * Replaces the retired external Memgraph graph endpoint. Every endpoint resolves to the
 * CALLER'S OWN person graph via the connector — isolation is enforced by `callerSub`, so a request
 * can only ever read/write the requester's graph. This is what the RCA bots (graph-analyst, …) call
 * in place of that retired external graph API. Mount under `requiresAuth`.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-045 #2 — caller-scoped /api/graph: query (AQL), neighbors, path, node/edge upsert; backed by the graph connector; 503 when the engine isn't configured.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-081: bots can act for their ticket's user — callerSub honors the trusted-service headers (X-Service-Secret + X-OSHAL-User-Sub, same pattern as /api/trading and /api/vids) so a bot-node curl reaches the RIGHT person graph under real OIDC, not just under MOCK_OIDC. Mount switched to serviceSecretOr(requiresAuth) in server.ts.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Graceful-degradation sweep: RUNTIME engine failure now degrades. callerGraph awaits getPersonGraph inside a try/catch — when ARANGO_URL is SET but the engine is unreachable (connection refused / provisioning listDatabases rejects), the rejection was previously unhandled inside the async route (→ 500 / hung request). It now logs at ERROR and returns a clear 503 graph_engine_unreachable, matching the ARANGO_URL-unset 503 shape. Query-time failures after the handle resolves keep their per-route 502.
 *
 * @module graph-routes
 */
import { Router, type Request, type Response } from 'express';
import { createChildLogger } from '@/shared/logger';
import { getTrustedServiceUserSub } from '@/shared/middleware/authz';
import { createGraphConnector, type GraphConnector, type GraphEdge, type GraphNode } from '@/features/graph';

const logger = createChildLogger({ module: 'graph-routes' });

/** Acting user: a service-secret caller's forwarded sub first (bot-node acting for its
 *  ticket's owner), else the signed-in OIDC sub. */
function callerSub(req: Request): string | null {
  const trusted = getTrustedServiceUserSub(req);
  if (trusted) return trusted;
  const u = (req as { oidc?: { user?: { sub?: string } } }).oidc?.user;
  return u?.sub ? String(u.sub) : null;
}

/**
 * @description Builds the caller-scoped graph router (mount at /api/graph, requiresAuth). The graph
 * connector is created once from the environment; when the engine isn't configured every route
 * returns 503 rather than crashing.
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

  /** POST /query — run a raw AQL read against the caller's graph. Body: { aql, bindVars? }. */
  router.post('/query', async (req: Request, res: Response) => {
    const g = await callerGraph(req, res); if (!g) return;
    const { aql, bindVars } = req.body as { aql?: string; bindVars?: Record<string, unknown> };
    if (!aql) { res.status(400).json({ error: 'aql required' }); return; }
    try { res.json({ rows: await g.rawQuery(aql, bindVars || {}) }); }
    catch (err) { logger.error({ err }, 'graph query failed'); res.status(502).json({ error: (err as Error).message }); }
  });

  /** GET /neighbors?id=&depth= — nodes within `depth` hops of a node (blast radius). */
  router.get('/neighbors', async (req: Request, res: Response) => {
    const g = await callerGraph(req, res); if (!g) return;
    const id = String(req.query.id || '');
    if (!id) { res.status(400).json({ error: 'id required' }); return; }
    const depth = Math.max(1, Math.min(Number(req.query.depth) || 1, 6));
    try { res.json({ nodes: await g.neighbors(id, depth) }); }
    catch (err) { logger.error({ err }, 'graph neighbors failed'); res.status(502).json({ error: (err as Error).message }); }
  });

  /** GET /path?from=&to= — shortest path of nodes between two ids. */
  router.get('/path', async (req: Request, res: Response) => {
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
