/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                  | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Read-only query API over the personal knowledge graph (ADR-066)
 */

/**
 * @module routes/personal-graph-routes
 * @description Read-only HTTP query surface over a personal-graph `GraphStore` (ADR-066).
 *
 * NOTE on naming: the ADR-045 caller-scoped graph already owns `graph-routes.ts` /
 * `createGraphRoutes()` (zero-arg, ArangoDB-backed) mounted at `/api/graph` in server.ts. This is a
 * SEPARATE, additive surface for the ADR-066 user-owned knowledge graph, so it lives in its own file
 * to avoid colliding with that live route. It is off by default — the orchestrator adds the
 * flag-gated `app.use(...)` in server.ts; this module only builds the Router.
 *
 * The store is the user's own knowledge graph (built by the ADR-066 ingest service from ADR-065
 * connectors). These routes only READ it — there is no mutation endpoint; writes happen on the
 * ingest path.
 *
 * Endpoints:
 *  - GET /stats                  node + edge counts, broken down by type
 *  - GET /nodes?type=&limit=     list nodes (optionally of one NodeType), capped by limit
 *  - GET /node/:id               a single node by id
 *  - GET /node/:id/neighbors     edges incident to a node (?direction=out|in|both)
 */

import { Router } from 'express';
import type { GraphStore, EdgeType, GraphNode, NodeType } from '@/features/personal-graph';

/** The known node types, used to validate the ?type= filter. */
const NODE_TYPES: NodeType[] = [
  'Person',
  'Org',
  'Event',
  'Place',
  'Activity',
  'Document',
  'Message',
  'Transaction',
  'Repo',
  'Media',
];

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

/** Parse + clamp a numeric `limit` query param. */
function parseLimit(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

/** Tally items by a string-valued key. */
function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    const k = key(item);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

/**
 * Build the read-only personal-graph query router (ADR-066).
 * @param deps.store - the user's GraphStore to read from.
 * @returns an Express Router; the orchestrator mounts it flag-gated.
 */
export function createGraphRoutes(deps: { store: GraphStore }): Router {
  const { store } = deps;
  const router = Router();

  // GET /stats — node/edge totals and per-type breakdowns.
  router.get('/stats', (_req, res) => {
    try {
      const nodes = store.allNodes();
      const edges = store.allEdges();
      res.json({
        nodes: { total: nodes.length, byType: countBy(nodes, (n) => n.type) },
        edges: { total: edges.length, byType: countBy(edges, (e) => e.type as EdgeType) },
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /nodes?type=&limit= — list nodes, optionally filtered to one NodeType.
  router.get('/nodes', (req, res) => {
    try {
      const typeRaw = req.query.type;
      const limit = parseLimit(req.query.limit);
      let nodes: GraphNode[];
      if (typeRaw !== undefined && typeRaw !== '') {
        const type = String(typeRaw) as NodeType;
        if (!NODE_TYPES.includes(type)) {
          res.status(400).json({ error: `unknown node type '${typeRaw}'` });
          return;
        }
        nodes = store.nodesByType(type);
      } else {
        nodes = store.allNodes();
      }
      res.json({
        count: Math.min(nodes.length, limit),
        total: nodes.length,
        nodes: nodes.slice(0, limit),
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /node/:id — a single node.
  router.get('/node/:id', (req, res) => {
    try {
      const node = store.getNode(req.params.id);
      if (!node) {
        res.status(404).json({ error: `node not found: ${req.params.id}` });
        return;
      }
      res.json({ node });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /node/:id/neighbors?direction=out|in|both — edges incident to a node.
  router.get('/node/:id/neighbors', (req, res) => {
    try {
      const id = req.params.id;
      if (!store.getNode(id)) {
        res.status(404).json({ error: `node not found: ${id}` });
        return;
      }
      const dirRaw = req.query.direction;
      let direction: 'out' | 'in' | 'both' = 'both';
      if (dirRaw === 'out' || dirRaw === 'in' || dirRaw === 'both') direction = dirRaw;
      else if (dirRaw !== undefined && dirRaw !== '') {
        res.status(400).json({ error: `invalid direction '${dirRaw}' (out|in|both)` });
        return;
      }
      const edges = store.neighbors(id, { direction });
      res.json({ id, direction, count: edges.length, edges });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
