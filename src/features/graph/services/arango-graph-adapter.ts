/**
 * ArangoDB adapter — the one engine implementation of GraphHandle (ADR-045).
 *
 * Operates on a single arangojs Database that is ALREADY scoped to one isolated graph (one
 * person's or one tenant's). It assumes the `nodes`/`edges` collections exist — the connector
 * provisions them before handing the handle out. This is the only file that knows AQL; swapping
 * engines means writing a sibling adapter, nothing else.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-045 — ArangoDB GraphHandle: upsert nodes/edges, neighbors traversal, shortest path, raw AQL. Node ids mapped to safe _keys; edges keyed by (from,type,to).
 *
 * @module arango-graph-adapter
 */
import type { Database } from 'arangojs';
import { createChildLogger } from '@/shared/logger';
import type { GraphEdge, GraphHandle, GraphNode } from './graph-types';
import { nodeKey } from './graph-keys';

const logger = createChildLogger({ module: 'arango-graph-adapter' });

/** Collection names inside every graph database. */
export const NODES = 'nodes';
export const EDGES = 'edges';

/** GraphHandle backed by one isolated ArangoDB database. */
export class ArangoGraphAdapter implements GraphHandle {
  /** @param db - an arangojs Database already scoped to this graph's isolated database. */
  constructor(private readonly db: Database) {}

  /** @description Insert-or-update nodes by id. @param nodes - nodes to write. @returns count written. */
  async upsertNodes(nodes: GraphNode[]): Promise<number> {
    if (!nodes.length) return 0;
    const docs = nodes.map((n) => ({ _key: nodeKey(n.id), id: n.id, labels: n.labels ?? [], props: n.props ?? {} }));
    await this.db.query(
      'FOR n IN @docs UPSERT { _key: n._key } INSERT n UPDATE n IN ' + NODES,
      { docs },
    );
    logger.debug({ count: docs.length }, 'upserted nodes');
    return docs.length;
  }

  /** @description Insert-or-update edges by (from,type,to). @param edges - edges to write. @returns count. */
  async upsertEdges(edges: GraphEdge[]): Promise<number> {
    if (!edges.length) return 0;
    const docs = edges.map((e) => ({
      _key: nodeKey(`${e.from}__${e.type}__${e.to}`),
      _from: `${NODES}/${nodeKey(e.from)}`,
      _to: `${NODES}/${nodeKey(e.to)}`,
      type: e.type,
      props: e.props ?? {},
    }));
    await this.db.query(
      'FOR e IN @docs UPSERT { _from: e._from, _to: e._to, type: e.type } INSERT e UPDATE e IN ' + EDGES,
      { docs },
    );
    logger.debug({ count: docs.length }, 'upserted edges');
    return docs.length;
  }

  /** @description Nodes within `depth` hops of a node, any direction. @param nodeId - start. @param depth - hops (default 1). @returns neighbor nodes. */
  async neighbors(nodeId: string, depth = 1): Promise<GraphNode[]> {
    const start = `${NODES}/${nodeKey(nodeId)}`;
    const cursor = await this.db.query(
      `FOR v IN 1..@depth ANY @start ${EDGES} OPTIONS { uniqueVertices: 'global', order: 'bfs' } ` +
        'RETURN DISTINCT { id: v.id, labels: v.labels, props: v.props }',
      { start, depth: Math.max(1, Math.min(depth, 6)) },
    );
    return (await cursor.all()) as GraphNode[];
  }

  /** @description Shortest path of nodes between two ids. @param fromId - source. @param toId - target. @returns path nodes ([] if none). */
  async shortestPath(fromId: string, toId: string): Promise<GraphNode[]> {
    const from = `${NODES}/${nodeKey(fromId)}`;
    const to = `${NODES}/${nodeKey(toId)}`;
    const cursor = await this.db.query(
      `FOR v IN ANY SHORTEST_PATH @from TO @to ${EDGES} RETURN { id: v.id, labels: v.labels, props: v.props }`,
      { from, to },
    );
    return (await cursor.all()) as GraphNode[];
  }

  /** @description Run a raw AQL query (the NL→query layer's escape hatch). @param query - AQL. @param bindVars - binds. @returns rows. */
  async rawQuery(query: string, bindVars: Record<string, unknown> = {}): Promise<unknown[]> {
    const cursor = await this.db.query(query, bindVars);
    return cursor.all();
  }
}
