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
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-045 closure: added readQuery + GraphReadOnlyError. POST /api/graph/query documents itself as "run a raw AQL READ", but the route called rawQuery, which hands the string straight to the engine — so a REMOVE/INSERT went through. It is scoped to the caller's own database (not a cross-tenant hole) but it contradicted its own contract, and a bot that mis-writes its own topology silently corrupts the next investigation. readQuery is the enforced read path the HTTP layer uses; rawQuery stays the in-process escape hatch for trusted core callers (the data-lifecycle exporter dumps with it).
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
  /**
   * Run a query the ENGINE has classified as non-modifying. Rejects with GraphReadOnlyError when
   * the engine's own plan says the query writes. This is the path any caller-supplied query string
   * must take (the HTTP layer uses it); `rawQuery` is for trusted in-process callers only.
   */
  readQuery(query: string, bindVars?: Record<string, unknown>): Promise<unknown[]>;
  /**
   * Escape hatch: run a raw engine query with bind vars, reads OR writes. Trusted in-process
   * callers only (e.g. the data-lifecycle exporter's full dump) — never a string off the wire.
   */
  rawQuery(query: string, bindVars?: Record<string, unknown>): Promise<unknown[]>;
}

/** Stable error code for a refused write on the read-only query path (the HTTP layer maps it to 400). */
export const GRAPH_READ_ONLY_CODE = 'graph_read_only';

/**
 * Thrown by `readQuery` when the engine's query plan reports a data-modifying query.
 *
 * Deliberately NOT a keyword denylist: the engine parses and plans the query, and the plan says
 * whether it writes. A denylist over AQL text is bypassable and rots with every language release.
 */
export class GraphReadOnlyError extends Error {
  /** Machine-readable code the route matches on, so the mapping never depends on message text. */
  readonly code = GRAPH_READ_ONLY_CODE;

  /** @param detail - Optional engine-provided reason (e.g. which collections it would write). */
  constructor(detail?: string) {
    super(
      'this endpoint accepts READ queries only — the engine classified this query as data-modifying' +
        (detail ? ` (${detail})` : '') +
        '. Use the node/edge upsert endpoints to write.',
    );
    this.name = 'GraphReadOnlyError';
  }
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
