/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                  | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Postgres-backed GraphStore (ADR-066). Additive, off by default.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-076 Phase 2 owner threading: the store is now constructed FOR one owner (required ownerSub, rejected when blank — fail closed) and every query carries user_sub — INSERT column lists, the ON CONFLICT target (now the composite (user_sub, id) PK from migration 094, so deterministic node ids no longer collide across users) and every SELECT WHERE. Complements the RLS policies 094 adds on personal_graph_nodes/edges: the app-layer filter and the DB policy scope to the same owner.
 */

/**
 * @module features/personal-graph/pg-graph-store
 * @description Postgres persistence for the personal knowledge graph (ADR-066, ADR-057: the user
 * owns their store). This mirrors {@link InMemoryGraphStore}'s contract exactly, but durably:
 *  - upserting a node by id MERGES — sources accumulate (deduped by provider+externalId), props are
 *    shallow-merged with the new non-null values winning, the newest non-empty label wins.
 *  - upserting an edge by id MERGES its sources (and props) the same way.
 * That UPSERT semantics (INSERT ... ON CONFLICT (user_sub, id) DO UPDATE with jsonb merge) is what
 * makes re-ingesting the same source item idempotent — per owner: the store is constructed for a
 * single ownerSub and every query is scoped to it (ADR-076 Phase 2, migration 094).
 *
 * The DB access is injected as a `query` function (compatible with pg `Pool.query`) so this module
 * unit-tests offline against a faithful in-memory fake — no live database required (the same
 * decoupling pattern as ADR-065's `dbSeenStore`). Because every method round-trips to the DB, the
 * store implements the async mirror {@link AsyncGraphStore} of the synchronous `GraphStore` interface.
 */

import type { GraphNode, GraphEdge, NodeType, SourceRef } from './graph-types';

/** Minimal async query interface (pg `Pool.query(sql, params)` is compatible). */
export type QueryFn = (sql: string, params: unknown[]) => Promise<{ rows: any[] }>;

/**
 * Async mirror of `GraphStore` (graph-store.ts). Identical method names + semantics; every method
 * returns a Promise because a Postgres-backed store must round-trip to the database. A persistence
 * engine cannot satisfy the synchronous `GraphStore` signatures, so this is the durable counterpart.
 */
export interface AsyncGraphStore {
  /** Insert or merge a node by id. Resolves to the resulting (merged) node. */
  upsertNode(node: GraphNode): Promise<GraphNode>;
  /** Insert or merge an edge by id. Resolves to the resulting edge. */
  upsertEdge(edge: GraphEdge): Promise<GraphEdge>;
  /** Fetch a node by id, or undefined. */
  getNode(id: string): Promise<GraphNode | undefined>;
  /** All edges incident to a node (both directions by default). */
  neighbors(id: string, opts?: { direction?: 'out' | 'in' | 'both' }): Promise<GraphEdge[]>;
  /** All nodes of a given type. */
  nodesByType(type: NodeType): Promise<GraphNode[]>;
  /** All nodes. */
  allNodes(): Promise<GraphNode[]>;
  /** All edges. */
  allEdges(): Promise<GraphEdge[]>;
}

/** Table names (overridable for tests / multi-tenant prefixing). */
export interface PgGraphTables {
  nodes: string;
  edges: string;
}

const DEFAULT_TABLES: PgGraphTables = {
  nodes: 'personal_graph_nodes',
  edges: 'personal_graph_edges',
};

/** Dedup a source list by provider+externalId, last writer wins (matches graph-store.mergeSources). */
function dedupeSources(sources: SourceRef[]): SourceRef[] {
  const seen = new Map<string, SourceRef>();
  for (const s of sources ?? []) {
    seen.set(`${s.provider}|${s.externalId ?? ''}`, s);
  }
  return [...seen.values()];
}

/** A raw node row as returned by SELECT/RETURNING. */
interface NodeRow {
  id: string;
  type: string;
  label: string;
  sources: SourceRef[] | null;
  props: Record<string, unknown> | null;
}

/** A raw edge row as returned by SELECT/RETURNING. */
interface EdgeRow {
  id: string;
  type: string;
  from_id: string;
  to_id: string;
  sources: SourceRef[] | null;
  props: Record<string, unknown> | null;
}

function rowToNode(r: NodeRow): GraphNode {
  return {
    id: r.id,
    type: r.type as NodeType,
    label: r.label ?? '',
    sources: dedupeSources(r.sources ?? []),
    props: r.props ?? {},
  } as GraphNode;
}

function rowToEdge(r: EdgeRow): GraphEdge {
  const props = r.props ?? undefined;
  return {
    id: r.id,
    type: r.type as GraphEdge['type'],
    from: r.from_id,
    to: r.to_id,
    sources: dedupeSources(r.sources ?? []),
    ...(props && Object.keys(props).length > 0 ? { props } : {}),
  };
}

/**
 * Postgres-backed personal graph store. Inject a `query` fn (pg Pool.query compatible). The two
 * tables are created by migration 057-personal-graph.sql; the user_sub owner column + composite
 * (user_sub, id) primary key + RLS policies come from 094-derived-owner-rls.sql.
 *
 * The store is scoped to ONE owner at construction (ADR-057: the user owns their store): every
 * query filters on `user_sub = ownerSub`, mirroring the DB-side RLS policy so app filter and
 * policy can never disagree about whose graph this is.
 */
export class PostgresGraphStore implements AsyncGraphStore {
  private readonly query: QueryFn;
  private readonly ownerSub: string;
  private readonly t: PgGraphTables;

  /**
   * @description Create a store scoped to one owner.
   *
   * @param query - pg `Pool.query`-compatible query function
   * @param ownerSub - OIDC subject of the graph owner; every row read or written carries it.
   *   A blank value is rejected (fail closed): '' is the fail-closed owner sentinel reserved by
   *   migration 094 for rows no real caller may match, and guc-pool stamps anonymous connections
   *   with '' — an ownerless store must be an error, never an accidental anonymous-shared graph.
   * @param tables - Optional table-name overrides (tests / prefixing)
   */
  constructor(query: QueryFn, ownerSub: string, tables: Partial<PgGraphTables> = {}) {
    if (typeof ownerSub !== 'string' || ownerSub.trim().length === 0) {
      throw new Error('PostgresGraphStore requires a non-empty ownerSub (the personal graph is per-user; see ADR-076 / migration 094)');
    }
    this.query = query;
    this.ownerSub = ownerSub;
    this.t = { ...DEFAULT_TABLES, ...tables };
  }

  /**
   * Upsert a node. ON CONFLICT (user_sub, id) merges: sources are concatenated (the app dedupes the
   * returned row), props are shallow-merged (existing || incoming, incoming wins), and a new
   * non-empty label replaces the old one. Type is immutable for an id, so the existing type is
   * preserved on conflict. The composite conflict target means the same deterministic node id is a
   * distinct row per owner (migration 094).
   */
  async upsertNode(node: GraphNode): Promise<GraphNode> {
    const sources = JSON.stringify(dedupeSources(node.sources ?? []));
    const props = JSON.stringify(node.props ?? {});
    const sql = `
      INSERT INTO ${this.t.nodes} (user_sub, id, type, label, sources, props, updated_at)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, NOW())
      ON CONFLICT (user_sub, id) DO UPDATE SET
        label      = CASE WHEN length(EXCLUDED.label) > 0 THEN EXCLUDED.label ELSE ${this.t.nodes}.label END,
        sources    = ${this.t.nodes}.sources || EXCLUDED.sources,
        props      = ${this.t.nodes}.props || EXCLUDED.props,
        updated_at = NOW()
      RETURNING id, type, label, sources, props
    `;
    const { rows } = await this.query(sql, [this.ownerSub, node.id, node.type, node.label ?? '', sources, props]);
    return rowToNode(rows[0] as NodeRow);
  }

  /**
   * Upsert an edge by its stable id (type,from,to). ON CONFLICT (user_sub, id) merges sources
   * (concatenate + app dedupe) and props (shallow merge). from/to/type are stable for a given id.
   */
  async upsertEdge(edge: GraphEdge): Promise<GraphEdge> {
    const sources = JSON.stringify(dedupeSources(edge.sources ?? []));
    const props = JSON.stringify(edge.props ?? {});
    const sql = `
      INSERT INTO ${this.t.edges} (user_sub, id, type, from_id, to_id, sources, props, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, NOW())
      ON CONFLICT (user_sub, id) DO UPDATE SET
        sources    = ${this.t.edges}.sources || EXCLUDED.sources,
        props      = ${this.t.edges}.props || EXCLUDED.props,
        updated_at = NOW()
      RETURNING id, type, from_id, to_id, sources, props
    `;
    const { rows } = await this.query(sql, [
      this.ownerSub,
      edge.id,
      edge.type,
      edge.from,
      edge.to,
      sources,
      props,
    ]);
    return rowToEdge(rows[0] as EdgeRow);
  }

  async getNode(id: string): Promise<GraphNode | undefined> {
    const { rows } = await this.query(
      `SELECT id, type, label, sources, props FROM ${this.t.nodes} WHERE user_sub = $1 AND id = $2 LIMIT 1`,
      [this.ownerSub, id],
    );
    return rows.length > 0 ? rowToNode(rows[0] as NodeRow) : undefined;
  }

  async neighbors(id: string, opts?: { direction?: 'out' | 'in' | 'both' }): Promise<GraphEdge[]> {
    const dir = opts?.direction ?? 'both';
    const base = `SELECT id, type, from_id, to_id, sources, props FROM ${this.t.edges} WHERE user_sub = $1`;
    let sql: string;
    if (dir === 'out') sql = `${base} AND from_id = $2`;
    else if (dir === 'in') sql = `${base} AND to_id = $2`;
    else sql = `${base} AND (from_id = $2 OR to_id = $2)`;
    const { rows } = await this.query(sql, [this.ownerSub, id]);
    return (rows as EdgeRow[]).map(rowToEdge);
  }

  async nodesByType(type: NodeType): Promise<GraphNode[]> {
    const { rows } = await this.query(
      `SELECT id, type, label, sources, props FROM ${this.t.nodes} WHERE user_sub = $1 AND type = $2`,
      [this.ownerSub, type],
    );
    return (rows as NodeRow[]).map(rowToNode);
  }

  async allNodes(): Promise<GraphNode[]> {
    const { rows } = await this.query(
      `SELECT id, type, label, sources, props FROM ${this.t.nodes} WHERE user_sub = $1`,
      [this.ownerSub],
    );
    return (rows as NodeRow[]).map(rowToNode);
  }

  async allEdges(): Promise<GraphEdge[]> {
    const { rows } = await this.query(
      `SELECT id, type, from_id, to_id, sources, props FROM ${this.t.edges} WHERE user_sub = $1`,
      [this.ownerSub],
    );
    return (rows as EdgeRow[]).map(rowToEdge);
  }
}
