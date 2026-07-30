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
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-045 closure: readQuery — the enforced read-only path for caller-supplied AQL. Enforcement is the ENGINE's, not ours: ArangoDB's explain plan carries isModificationQuery, so we ask it to plan the query and refuse when the plan writes. Deliberately NOT an AQL keyword denylist (bypassable, and it rots with each language release) and deliberately not a streaming read-only transaction (arangojs's trx.step attaches the transaction id to ONE request, so a multi-batch cursor would silently fetch its later batches outside the transaction).
 *
 * @module arango-graph-adapter
 */
import type { Database } from 'arangojs';
import { createChildLogger } from '@/shared/logger';
import { GraphReadOnlyError, type GraphEdge, type GraphHandle, type GraphNode } from './graph-types';
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

  /**
   * @description Run caller-supplied AQL that the ENGINE agrees is a read. The query is planned
   * first (`explain`); ArangoDB's plan reports `isModificationQuery`, so a REMOVE/INSERT/UPDATE/
   * REPLACE/UPSERT is refused before it can touch data. That keeps the HTTP contract ("run a raw
   * AQL read") true without inventing a keyword denylist we would have to maintain against AQL.
   * @param query - AQL text supplied by the caller.
   * @param bindVars - AQL bind variables (planning needs them; a missing bind fails at explain).
   * @returns the query's rows.
   * @throws GraphReadOnlyError when the engine's plan says the query modifies data.
   */
  async readQuery(query: string, bindVars: Record<string, unknown> = {}): Promise<unknown[]> {
    const { plan } = await this.db.explain(query, bindVars);
    if (plan.isModificationQuery) {
      const written = plan.collections.filter((c) => c.type === 'write').map((c) => c.name);
      logger.warn({ written }, 'refused a data-modifying query on the read-only graph path');
      throw new GraphReadOnlyError(written.length ? `would write: ${written.join(', ')}` : undefined);
    }
    return this.rawQuery(query, bindVars);
  }

  /** @description Escape hatch for trusted IN-PROCESS callers: raw AQL, reads or writes. Never hand it a string off the wire — use readQuery. @param query - AQL. @param bindVars - binds. @returns rows. */
  async rawQuery(query: string, bindVars: Record<string, unknown> = {}): Promise<unknown[]> {
    const cursor = await this.db.query(query, bindVars);
    return cursor.all();
  }
}
