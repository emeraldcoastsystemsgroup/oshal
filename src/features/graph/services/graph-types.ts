/**
 * Graph domain types — the engine-agnostic contract (ADR-045).
 *
 * Bots/surfaces only ever touch these; the concrete engine (ArangoDB today) lives behind the
 * adapter. Swapping engines means a new adapter, not a change here or in any caller.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-045 — engine-agnostic graph types: GraphNode/GraphEdge + the GraphHandle interface every adapter implements.
 *
 * @module graph-types
 */

/** A node in a graph. `id` is the caller's stable identity (e.g. a service/incident id). */
export interface GraphNode {
  id: string;
  /** Optional type tags (e.g. ['service'], ['incident']) for filtering/queries. */
  labels?: string[];
  /** Arbitrary properties stored on the node. */
  props?: Record<string, unknown>;
}

/** A directed, typed edge between two node ids. */
export interface GraphEdge {
  from: string;
  to: string;
  /** Relationship type (e.g. 'depends_on', 'caused', 'runs_on'). */
  type: string;
  props?: Record<string, unknown>;
}

/**
 * A handle to ONE isolated graph (one person's, or one tenant's). All operations are scoped to
 * that graph — there is no cross-graph access through this interface. Engine-agnostic.
 */
export interface GraphHandle {
  /** Insert-or-update nodes by id. Returns the count written. */
  upsertNodes(nodes: GraphNode[]): Promise<number>;
  /** Insert-or-update edges by (from,to,type). Endpoints are created if missing. Returns count. */
  upsertEdges(edges: GraphEdge[]): Promise<number>;
  /** Nodes within `depth` hops of `nodeId` in any direction (blast radius / neighborhood). */
  neighbors(nodeId: string, depth?: number): Promise<GraphNode[]>;
  /** The shortest path of nodes between two ids ([] if none). */
  shortestPath(fromId: string, toId: string): Promise<GraphNode[]>;
  /** Escape hatch: run a raw engine query with bind vars. The NL→query layer uses this. */
  rawQuery(query: string, bindVars?: Record<string, unknown>): Promise<unknown[]>;
}

/** Config for the connector — where the engine lives + its root credential. */
export interface GraphConnectorConfig {
  /** Engine base URL (e.g. http://oshal-arangodb:8529). */
  url: string;
  /** Root user (provisions per-graph databases). */
  rootUser: string;
  /** Root password. */
  rootPassword: string;
}
