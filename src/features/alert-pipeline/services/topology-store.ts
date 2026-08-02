/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | TopologyStore — the read/write face of the topology mirror: chunked idempotent node and edge upserts, the proportional sweep brake that keeps a truncated discovery feed from erasing the graph, durable per-run loader provenance, and the bounded undirected recursive-CTE traversal (path cycle guard + hub gate) that correlation partitions into connected components.
 */

import type { Pool, PoolClient } from 'pg';

import { createChildLogger } from '@/shared/logger';

import type {
  TopologyEdgeRow,
  TopologyHop,
  TopologyLoader,
  TopologyNodeRow,
  TraversedSubgraph,
} from './alert-pipeline-types';

const logger = createChildLogger({ module: 'topology-store' });

/**
 * @description Hard ceiling on traversal depth. The cycle guard is per-path, so the CTE walks
 * simple paths and its cost grows with branching factor; the cap is what keeps a dense estate
 * from turning one correlation into a graph-wide crawl. It is also a precision control — beyond
 * four hops "related" stops meaning anything operationally useful.
 */
export const MAX_TRAVERSAL_DEPTH = 4;

/**
 * @description Stamped onto every subgraph so a frozen snapshot records which traversal produced
 * it. A grouping decision is only reproducible if the engine version that made it is on the row.
 */
export const TOPOLOGY_TRAVERSAL_VERSION = 'postgres-cte/1';

/**
 * Bind-parameter budget per statement. Postgres refuses a statement above 65535 parameters, and
 * a loader that grows past the limit would fail only in production where the feed is large — so
 * multi-row inserts are chunked well below it rather than near it.
 */
const MAX_BIND_PARAMS = 60000;

/** Column order and per-column casts for a node tuple; the cast makes the parameter type explicit. */
const NODE_CASTS = [
  'text',
  'text',
  'text[]',
  'text[]',
  'boolean',
  'text',
  'jsonb',
  'text',
  'text',
] as const;

/** Column order and per-column casts for an edge tuple. */
const EDGE_CASTS = ['text', 'text', 'text', 'boolean', 'jsonb', 'text', 'text'] as const;

/**
 * @description The outcome of a loader sweep. `refused` is the proportional brake firing: the
 * slice was left completely untouched because the keep-set was small enough to look like a
 * truncated feed rather than a genuine decommission.
 */
export interface SweepOutcome {
  /** Node rows actually deleted. Zero whenever `refused` is true. */
  swept: number;
  /** Edge rows deleted in the same slice because an endpoint left the keep-set. */
  edgesSwept: number;
  /** True when the brake fired and nothing was deleted. */
  refused: boolean;
  /** Size of the loader's node slice the decision was measured against. */
  sliceSize: number;
}

/**
 * @description One durable audit row for a loader pass. A failed loader's process is gone by the
 * time anyone looks and its logs go with it, so the run records itself into Postgres.
 */
export interface LoaderRunRecord {
  loaderTag: TopologyLoader;
  loaderScope: string;
  durationMs: number;
  success: boolean;
  nodesUpserted: number;
  edgesUpserted: number;
  nodesSwept: number;
  edgesSwept: number;
  /** Set when the proportional brake refused the sweep — the single most important field here. */
  sweepRefused: boolean;
  error: string | null;
  /** Free-form per-kind counts (e.g. `{ container: 12, service: 4 }`) for drift inspection. */
  counts: Record<string, number>;
}

/** @description Per-loader-slice freshness, the self-check that a loader has stopped refreshing. */
export interface LoaderFreshness {
  loaderTag: string;
  loaderScope: string;
  count: number;
  maxRefreshedAt: Date | null;
}

/** @description Seeds partitioned into connected components, plus the subgraph that produced them. */
export interface CorrelationResult {
  /** Each entry is one connected component: the seed keys that reached one another. */
  components: string[][];
  /** Every node and edge the traversal touched, ready to freeze into an evidence snapshot. */
  subgraph: TraversedSubgraph;
}

/**
 * @description One line of a static topology map: a node and the nodes it depends on. The shape a
 * compose file, a service inventory or a hand-written estate map reduces to.
 */
export interface StaticTopologyEntry {
  nodeKey: string;
  displayName?: string | null;
  kinds?: string[];
  /** Hub gate for this node; omit or pass null to leave the node freely traversable. */
  traverseVia?: string[] | null;
  /**
   * Pass false to mark this node a hub: still reachable and still reported at its true hop
   * count, but the walk stops there. Set it on a shared dependency — a control plane, a message
   * bus, a shared datastore — that would otherwise bridge every peer depending on it into one
   * component. Defaults to true.
   */
  transitAllowed?: boolean;
  props?: Record<string, unknown>;
  /** Keys this node depends on. Referenced keys are materialized as nodes if not declared. */
  dependsOn?: string[];
  /** Edge type for this entry's dependencies. Defaults to `depends_on`. */
  edgeType?: string;
  /** Slice this entry belongs to, so several static maps can share the `compose` tag. */
  loaderScope?: string;
}

/** Raw node row as Postgres returns it. */
interface TopologyNodeDbRow {
  node_key: string;
  display_name: string | null;
  kinds: string[] | null;
  traverse_via: string[] | null;
  transit_allowed: boolean;
  status: string;
  props: Record<string, unknown> | null;
  loader_tag: string;
  loader_scope: string;
}

/** Raw edge row as Postgres returns it. */
interface TopologyEdgeDbRow {
  src_key: string;
  dst_key: string;
  edge_type: string;
  direction_certified: boolean;
  attrs: Record<string, unknown> | null;
  loader_tag: string;
  loader_scope: string;
}

const NODE_SELECT =
  'node_key, display_name, kinds, traverse_via, transit_allowed, status, props, loader_tag, loader_scope';
const EDGE_SELECT =
  'src_key, dst_key, edge_type, direction_certified, attrs, loader_tag, loader_scope';

/**
 * The traversal. Four things carry the whole design:
 *   1. `w.path` plus `NOT (nx.node_key = ANY(w.path))` — the cycle guard. A cyclic estate is the
 *      normal case (a depends on b, b's host runs a), and without the guard the recursive term
 *      never stops producing rows.
 *   2. The hub gate `nx.traverse_via IS NULL OR e.edge_type = ANY(nx.traverse_via)` — an
 *      expansion may ENTER a gated node only over a permitted edge type. Without it every alert
 *      in a large estate meets every other one through a shared group node within two hops, one
 *      component swallows the batch, and the failure presents as correlation working unusually well.
 *   3. `status = 'active'` on both the seed and every entered node, so a decommissioned host stops
 *      acting as a bridge between two live services.
 *   4. Undirected expansion — the join matches an edge from either end and follows it to the far
 *      side. Correlation wants a superset and must survive a reversed arrow; only root-candidate
 *      ranking consults direction, and only over certified edges.
 * The final aggregate keeps each node ONCE, at the cheapest hop count that reached it.
 */
const TRAVERSAL_SQL = `
  WITH RECURSIVE walk AS (
    SELECT n.node_key, 0 AS hops, ARRAY[n.node_key] AS path
      FROM oshal_topology_node n
     WHERE n.node_key = $1
       AND n.status = 'active'
    UNION ALL
    SELECT nx.node_key, w.hops + 1, w.path || nx.node_key
      FROM walk w
      -- The node we are expanding FROM must permit transit. A hub marked
      -- transit_allowed = false still appears in the result at its true hop count
      -- (it was reached on the previous iteration) but the walk stops there, so a
      -- shared dependency does not bridge every peer that depends on it into one
      -- component. The seed row is exempt: a traversal must always leave its seed.
      JOIN oshal_topology_node cur
        ON cur.node_key = w.node_key
       AND (w.hops = 0 OR cur.transit_allowed)
      JOIN oshal_topology_edge e
        ON e.src_key = w.node_key OR e.dst_key = w.node_key
      JOIN oshal_topology_node nx
        ON nx.node_key = CASE WHEN e.src_key = w.node_key THEN e.dst_key ELSE e.src_key END
     WHERE w.hops < $2
       AND nx.status = 'active'
       AND NOT (nx.node_key = ANY(w.path))
       AND (nx.traverse_via IS NULL OR e.edge_type = ANY(nx.traverse_via))
  )
  SELECT node_key, MIN(hops)::int AS hops
    FROM walk
   GROUP BY node_key
   ORDER BY MIN(hops), node_key
`;

/**
 * @description Splits rows into batches small enough that the whole statement stays far below the
 * Postgres bind-parameter ceiling.
 * @param rows Rows to batch.
 * @param paramsPerRow Bind parameters each row contributes.
 * @returns Batches in input order; empty when there are no rows.
 */
function chunkForParams<T>(rows: T[], paramsPerRow: number): T[][] {
  const perChunk = Math.max(1, Math.floor(MAX_BIND_PARAMS / Math.max(1, paramsPerRow)));
  const batches: T[][] = [];
  for (let i = 0; i < rows.length; i += perChunk) batches.push(rows.slice(i, i + perChunk));
  return batches;
}

/**
 * @description Renders `($1::text, $2::jsonb), ($3::text, ...)` for a multi-row VALUES list. Only
 * placeholders and casts are generated — every value stays a bind parameter.
 * @param rowCount Number of tuples.
 * @param casts Per-column Postgres type casts, in column order.
 * @returns The VALUES tuple list.
 */
function renderTuples(rowCount: number, casts: readonly string[]): string {
  const tuples: string[] = [];
  let next = 1;
  for (let r = 0; r < rowCount; r += 1) {
    tuples.push(`(${casts.map((cast) => `$${next++}::${cast}`).join(', ')})`);
  }
  return tuples.join(', ');
}

/**
 * @description Keeps the LAST row per natural key. A single statement cannot apply ON CONFLICT to
 * the same key twice — Postgres rejects the whole batch — and a feed that repeats a key means the
 * later observation, so last-wins is both the safe and the correct resolution.
 * @param rows Rows to dedupe.
 * @param keyOf Natural-key extractor.
 * @returns Deduped rows in first-seen order.
 */
function dedupeBy<T>(rows: T[], keyOf: (row: T) => string): T[] {
  const byKey = new Map<string, T>();
  for (const row of rows) byKey.set(keyOf(row), row);
  return Array.from(byKey.values());
}

/**
 * @description Clamps a requested depth into `[0, MAX_TRAVERSAL_DEPTH]`. A caller-supplied depth is
 * configuration and can be wrong; the traversal must stay bounded regardless of what it is handed.
 * @param depth Requested depth.
 * @returns A safe depth. A non-finite value falls back to the cap, which is still bounded.
 */
function clampDepth(depth: number): number {
  const requested = Number.isFinite(depth) ? Math.floor(depth) : MAX_TRAVERSAL_DEPTH;
  return Math.max(0, Math.min(requested, MAX_TRAVERSAL_DEPTH));
}

/**
 * @description Maps a node row out of Postgres into the shared contract shape.
 * @param row Raw row.
 * @returns The node in contract form.
 */
function mapNodeRow(row: TopologyNodeDbRow): TopologyNodeRow {
  return {
    nodeKey: row.node_key,
    displayName: row.display_name,
    kinds: row.kinds ?? [],
    traverseVia: row.traverse_via,
    transitAllowed: row.transit_allowed,
    status: row.status === 'decommissioned' ? 'decommissioned' : 'active',
    props: row.props ?? {},
    loaderTag: row.loader_tag as TopologyLoader,
    loaderScope: row.loader_scope,
  };
}

/**
 * @description Maps an edge row out of Postgres into the shared contract shape.
 * @param row Raw row.
 * @returns The edge in contract form.
 */
function mapEdgeRow(row: TopologyEdgeDbRow): TopologyEdgeRow {
  return {
    srcKey: row.src_key,
    dstKey: row.dst_key,
    edgeType: row.edge_type,
    directionCertified: row.direction_certified,
    attrs: row.attrs ?? {},
    loaderTag: row.loader_tag as TopologyLoader,
    loaderScope: row.loader_scope,
  };
}

/**
 * @description True when the two reachable sets share at least one node that is permitted to
 * bridge them. Iterates the smaller set, so a hub-heavy seed does not make the pairwise pass
 * quadratic in the larger set's size.
 * @param a First reachable set.
 * @param b Second reachable set.
 * @param bridgeable Nodes allowed to act as a bridge; a shared node outside this set is ignored.
 * @returns Whether the sets intersect at a bridging node.
 */
function intersectsWithin(a: Set<string>, b: Set<string>, bridgeable: Set<string>): boolean {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const key of small) if (large.has(key) && bridgeable.has(key)) return true;
  return false;
}

/**
 * @description Partitions seeds into connected components by union-find over their reachable sets.
 * Two seeds join when one seed reaches the other directly, or when their reachable sets intersect
 * at a node that PERMITS TRANSIT. The direct-reach clause matters because a seed absent from the
 * mirror has only itself in its set and would otherwise never merge with a live neighbour that
 * names it. The transit restriction on the intersection clause matters because a shared hub is
 * reachable from every peer that depends on it, and counting that as a bridge would rebuild the
 * whole-estate component the traversal's own gating just prevented.
 * @param seeds Distinct seed keys, in caller order.
 * @param reach Reachable node set per seed.
 * @param bridgeable Traversed nodes that permit transit; only these can join two seeds.
 * @returns Components, each sorted, ordered by their first member so output is deterministic.
 */
function partitionSeeds(
  seeds: string[],
  reach: Map<string, Set<string>>,
  bridgeable: Set<string>,
): string[][] {
  const parent = new Map<string, string>(seeds.map((seed) => [seed, seed]));
  const find = (key: string): string => {
    let root = key;
    let hop = parent.get(root);
    while (hop !== undefined && hop !== root) {
      root = hop;
      hop = parent.get(root);
    }
    parent.set(key, root);
    return root;
  };
  for (let i = 0; i < seeds.length; i += 1) {
    for (let j = i + 1; j < seeds.length; j += 1) {
      const a = seeds[i];
      const b = seeds[j];
      const setA = reach.get(a) ?? new Set<string>();
      const setB = reach.get(b) ?? new Set<string>();
      if (!setA.has(b) && !setB.has(a) && !intersectsWithin(setA, setB, bridgeable)) continue;
      const rootA = find(a);
      const rootB = find(b);
      if (rootA !== rootB) parent.set(rootA, rootB);
    }
  }
  const grouped = new Map<string, string[]>();
  for (const seed of seeds) {
    const root = find(seed);
    const bucket = grouped.get(root);
    if (bucket) bucket.push(seed);
    else grouped.set(root, [seed]);
  }
  return Array.from(grouped.values())
    .map((component) => component.slice().sort())
    .sort((left, right) => left[0].localeCompare(right[0]));
}

/**
 * @description The topology mirror's store: loaders write through it, correlation reads through it.
 * Every statement is bind-parameterised, every multi-row write is chunked, and every destructive
 * write is scoped to one loader's own slice and guarded by the proportional brake.
 */
export class TopologyStore {
  private readonly pool: Pool;

  /**
   * @description Builds a store over an existing pool. The pool supplies the connection identity,
   * so the store never opens its own and never carries credentials.
   * @param pool Postgres pool.
   */
  constructor(pool: Pool) {
    this.pool = pool;
  }

  /**
   * @description Idempotently writes nodes on the `node_key` natural key, refreshing provenance and
   * both timestamps on every pass. Re-running a loader must be a no-op in content and a refresh in
   * time — that is what makes `loaderFreshness` a usable staleness signal.
   * @param nodes Nodes to write; duplicates within the batch resolve last-wins.
   * @returns The number of rows inserted or updated.
   */
  async upsertNodes(nodes: TopologyNodeRow[]): Promise<number> {
    const unique = dedupeBy(nodes, (node) => node.nodeKey);
    if (unique.length === 0) return 0;
    let written = 0;
    try {
      for (const batch of chunkForParams(unique, NODE_CASTS.length)) {
        const params: unknown[] = [];
        for (const node of batch) {
          params.push(
            node.nodeKey,
            node.displayName ?? null,
            node.kinds ?? [],
            node.traverseVia ?? null,
            node.transitAllowed ?? true,
            node.status ?? 'active',
            JSON.stringify(node.props ?? {}),
            node.loaderTag,
            node.loaderScope ?? '',
          );
        }
        const result = await this.pool.query(
          `INSERT INTO oshal_topology_node
             (node_key, display_name, kinds, traverse_via, transit_allowed, status, props,
              loader_tag, loader_scope, refreshed_at, last_seen_at)
           SELECT v.*, now(), now() FROM (VALUES ${renderTuples(batch.length, NODE_CASTS)}) AS v
           ON CONFLICT (node_key) DO UPDATE SET
             display_name    = EXCLUDED.display_name,
             kinds           = EXCLUDED.kinds,
             traverse_via    = EXCLUDED.traverse_via,
             transit_allowed = EXCLUDED.transit_allowed,
             status       = EXCLUDED.status,
             props        = EXCLUDED.props,
             loader_tag   = EXCLUDED.loader_tag,
             loader_scope = EXCLUDED.loader_scope,
             refreshed_at = now(),
             last_seen_at = now()`,
          params,
        );
        written += result.rowCount ?? 0;
      }
    } catch (error) {
      logger.error({ err: error, nodeCount: unique.length }, 'topology node upsert failed');
      throw error;
    }
    return written;
  }

  /**
   * @description Idempotently writes edges on the `(src_key, dst_key, edge_type)` natural key.
   * Parallel relationships of different types are distinct edges and must never collapse into one.
   * An edge whose endpoint is not in the mirror is skipped rather than aborting its whole batch —
   * one dangling reference in a discovery feed must not discard thousands of good edges — and the
   * skipped count is logged so a systematically broken feed is visible.
   * @param edges Edges to write; duplicates within the batch resolve last-wins.
   * @returns The number of rows inserted or updated.
   */
  async upsertEdges(edges: TopologyEdgeRow[]): Promise<number> {
    const unique = dedupeBy(edges, (edge) => JSON.stringify([edge.srcKey, edge.dstKey, edge.edgeType]));
    if (unique.length === 0) return 0;
    let written = 0;
    try {
      for (const batch of chunkForParams(unique, EDGE_CASTS.length)) {
        const result = await this.pool.query(
          this.edgeUpsertSql(batch.length),
          this.edgeUpsertParams(batch),
        );
        written += result.rowCount ?? 0;
      }
    } catch (error) {
      logger.error({ err: error, edgeCount: unique.length }, 'topology edge upsert failed');
      throw error;
    }
    if (written < unique.length) {
      logger.warn(
        { requested: unique.length, written, skipped: unique.length - written },
        'topology edges skipped — an endpoint is not present in the node mirror',
      );
    }
    return written;
  }

  /**
   * @description Builds the edge upsert. Endpoints are checked with EXISTS inside the statement so
   * a dangling edge is filtered by the database rather than by a second round trip that could race.
   * @param rowCount Number of tuples in the batch.
   * @returns The parameterised statement.
   */
  private edgeUpsertSql(rowCount: number): string {
    return `INSERT INTO oshal_topology_edge
        (src_key, dst_key, edge_type, direction_certified, attrs,
         loader_tag, loader_scope, refreshed_at, last_seen_at)
      SELECT v.src_key, v.dst_key, v.edge_type, v.direction_certified, v.attrs,
             v.loader_tag, v.loader_scope, now(), now()
        FROM (VALUES ${renderTuples(rowCount, EDGE_CASTS)})
          AS v(src_key, dst_key, edge_type, direction_certified, attrs, loader_tag, loader_scope)
       WHERE EXISTS (SELECT 1 FROM oshal_topology_node n WHERE n.node_key = v.src_key)
         AND EXISTS (SELECT 1 FROM oshal_topology_node n WHERE n.node_key = v.dst_key)
      ON CONFLICT (src_key, dst_key, edge_type) DO UPDATE SET
        direction_certified = EXCLUDED.direction_certified,
        attrs               = EXCLUDED.attrs,
        loader_tag          = EXCLUDED.loader_tag,
        loader_scope        = EXCLUDED.loader_scope,
        refreshed_at        = now(),
        last_seen_at        = now()`;
  }

  /**
   * @description Flattens an edge batch into the bind-parameter list in `EDGE_CASTS` column order.
   * @param batch Edges in one chunk.
   * @returns Bind parameters for the batch.
   */
  private edgeUpsertParams(batch: TopologyEdgeRow[]): unknown[] {
    const params: unknown[] = [];
    for (const edge of batch) {
      params.push(
        edge.srcKey,
        edge.dstKey,
        edge.edgeType,
        edge.directionCertified,
        JSON.stringify(edge.attrs ?? {}),
        edge.loaderTag,
        edge.loaderScope ?? '',
      );
    }
    return params;
  }

  /**
   * @description Removes rows of ONE loader's slice that the loader no longer reports, behind the
   * proportional brake: if the delete would take half the slice or more, nothing is deleted and the
   * refusal is logged at ERROR. A truncated feed is indistinguishable from a mass decommission at
   * the row level, and guessing wrong erases the topology — after which correlation silently finds
   * nothing forever, with no error anywhere. Recovering a slice is a loader re-run; recovering from
   * "correlation quietly stopped working" is an outage nobody notices.
   * @param loaderTag Loader whose slice is swept — never another loader's rows.
   * @param loaderScope Scope within that loader.
   * @param keepKeys Node keys the loader still reports.
   * @returns What was deleted, and whether the brake refused.
   */
  async sweep(
    loaderTag: TopologyLoader,
    loaderScope: string,
    keepKeys: string[],
  ): Promise<SweepOutcome> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const outcome = await this.sweepSlice(client, loaderTag, loaderScope, keepKeys);
      await client.query(outcome.refused ? 'ROLLBACK' : 'COMMIT');
      return outcome;
    } catch (error) {
      logger.error({ err: error, loaderTag, loaderScope }, 'topology sweep failed');
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        logger.error({ err: rollbackError, loaderTag, loaderScope }, 'topology sweep rollback failed');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * @description Measures the slice, applies the brake, and deletes inside the caller's transaction.
   * Measuring and deleting in one transaction is what makes the brake sound — a concurrent loader
   * pass cannot change the denominator between the decision and the delete.
   * @param client Transaction-bound client.
   * @param loaderTag Loader whose slice is swept.
   * @param loaderScope Scope within that loader.
   * @param keepKeys Node keys the loader still reports.
   * @returns The sweep outcome.
   */
  private async sweepSlice(
    client: PoolClient,
    loaderTag: TopologyLoader,
    loaderScope: string,
    keepKeys: string[],
  ): Promise<SweepOutcome> {
    const keep = Array.from(new Set(keepKeys));
    const scope = [loaderTag, loaderScope, keep];
    const measured = await client.query<{ slice: string; doomed: string }>(
      `SELECT count(*)::text AS slice,
              count(*) FILTER (WHERE NOT (node_key = ANY($3::text[])))::text AS doomed
         FROM oshal_topology_node
        WHERE loader_tag = $1 AND loader_scope = $2`,
      scope,
    );
    const sliceSize = Number(measured.rows[0]?.slice ?? '0');
    const doomed = Number(measured.rows[0]?.doomed ?? '0');
    if (doomed === 0) return { swept: 0, edgesSwept: 0, refused: false, sliceSize };
    if (doomed * 2 >= sliceSize) {
      logger.error(
        { loaderTag, loaderScope, sliceSize, doomed, keepCount: keep.length },
        'topology sweep REFUSED — the delete would take half the slice or more, which reads as a truncated feed; nothing deleted',
      );
      return { swept: 0, edgesSwept: 0, refused: true, sliceSize };
    }
    const edges = await client.query(
      `DELETE FROM oshal_topology_edge
        WHERE loader_tag = $1 AND loader_scope = $2
          AND (NOT (src_key = ANY($3::text[])) OR NOT (dst_key = ANY($3::text[])))`,
      scope,
    );
    const nodes = await client.query(
      `DELETE FROM oshal_topology_node
        WHERE loader_tag = $1 AND loader_scope = $2 AND NOT (node_key = ANY($3::text[]))`,
      scope,
    );
    const outcome = {
      swept: nodes.rowCount ?? 0,
      edgesSwept: edges.rowCount ?? 0,
      refused: false,
      sliceSize,
    };
    logger.info({ loaderTag, loaderScope, ...outcome }, 'topology slice swept');
    return outcome;
  }

  /**
   * @description Writes the audit row for one loader pass. Called on success AND on failure — the
   * run that died is the one an operator most needs a row for, and `sweepRefused` is the field that
   * explains a slice that stopped shrinking.
   * @param run The completed run.
   * @returns Nothing; the write is durable when the promise resolves.
   */
  async recordLoaderRun(run: LoaderRunRecord): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO oshal_topology_loader_run
           (loader_tag, loader_scope, duration_ms, success, nodes_upserted, edges_upserted,
            nodes_swept, edges_swept, sweep_refused, error, counts)
         VALUES ($1::text, $2::text, $3::int, $4::boolean, $5::int, $6::int,
                 $7::int, $8::int, $9::boolean, $10::text, $11::jsonb)`,
        [
          run.loaderTag,
          run.loaderScope,
          Math.max(0, Math.round(run.durationMs)),
          run.success,
          run.nodesUpserted,
          run.edgesUpserted,
          run.nodesSwept,
          run.edgesSwept,
          run.sweepRefused,
          run.error,
          JSON.stringify(run.counts ?? {}),
        ],
      );
    } catch (error) {
      logger.error({ err: error, loaderTag: run.loaderTag }, 'topology loader run audit write failed');
      throw error;
    }
  }

  /**
   * @description Per-slice size and newest refresh timestamp. A loader that has silently stopped
   * shows here as a slice whose `maxRefreshedAt` stops advancing while its rows still look healthy,
   * which is the only symptom a stalled discovery feed produces.
   * @returns One entry per loader tag and scope, ordered by tag then scope.
   */
  async loaderFreshness(): Promise<LoaderFreshness[]> {
    try {
      const result = await this.pool.query<{
        loader_tag: string;
        loader_scope: string;
        count: string;
        max_refreshed_at: Date | null;
      }>(
        `SELECT loader_tag, loader_scope, count(*)::text AS count, max(refreshed_at) AS max_refreshed_at
           FROM oshal_topology_node
          GROUP BY loader_tag, loader_scope
          ORDER BY loader_tag, loader_scope`,
      );
      return result.rows.map((row) => ({
        loaderTag: row.loader_tag,
        loaderScope: row.loader_scope,
        count: Number(row.count),
        maxRefreshedAt: row.max_refreshed_at,
      }));
    } catch (error) {
      logger.error({ err: error }, 'topology loader freshness read failed');
      throw error;
    }
  }

  /**
   * @description Breadth-bounded undirected traversal from one seed. Returns every active node
   * reachable within the depth, each ONCE, at the minimum hop count that reached it — the hop count
   * is what an incident member row records as its dependency distance, so it must be the cheapest
   * path and not whichever path the walk happened to finish on.
   * @param seed Normalized node key to start from.
   * @param maxDepth Requested depth, clamped to `MAX_TRAVERSAL_DEPTH`.
   * @returns Reachable nodes with minimum hops; empty when the seed is absent or decommissioned.
   */
  async neighbors(seed: string, maxDepth: number): Promise<TopologyHop[]> {
    const depth = clampDepth(maxDepth);
    try {
      const result = await this.pool.query<{ node_key: string; hops: number }>(TRAVERSAL_SQL, [
        seed,
        depth,
      ]);
      return result.rows.map((row) => ({ nodeKey: row.node_key, hops: Number(row.hops) }));
    } catch (error) {
      logger.error({ err: error, seed, depth }, 'topology traversal failed');
      throw error;
    }
  }

  /**
   * @description Correlates a batch of alerting targets: traverse from each seed, union the
   * reachable sets, and partition the seeds into connected components. A seed that is missing from
   * the mirror still comes back as its own single-seed component — an unknown target must produce
   * an incident of its own, never vanish from the batch.
   * @param seeds Alerting target keys.
   * @param maxDepth Requested depth, clamped to `MAX_TRAVERSAL_DEPTH`.
   * @returns The components and the traversed subgraph to freeze as evidence.
   */
  async correlate(seeds: string[], maxDepth: number): Promise<CorrelationResult> {
    const depth = clampDepth(maxDepth);
    const unique = Array.from(new Set(seeds.filter((seed) => seed.trim().length > 0)));
    const reach = new Map<string, Set<string>>();
    const traversed = new Set<string>();
    for (const seed of unique) {
      const hops = await this.neighbors(seed, depth);
      const reachable = new Set(hops.map((hop) => hop.nodeKey));
      reachable.add(seed);
      reach.set(seed, reachable);
      for (const key of reachable) traversed.add(key);
    }
    const subgraph = await this.loadSubgraph(Array.from(traversed), unique, depth);
    // Only a node the walk may CONTINUE through counts as evidence that two seeds share an
    // incident. Two peers that both depend on a marked hub each reach it, but neither reaches
    // the other — treating that shared hub as a bridge is exactly the collapse transit gating
    // exists to prevent, and it would reappear here even though the traversal itself stopped.
    const bridgeable = new Set(
      subgraph.nodes.filter((node) => node.transitAllowed).map((node) => node.nodeKey),
    );
    const components = partitionSeeds(unique, reach, bridgeable);
    logger.info(
      { seeds: unique.length, depth, components: components.length, nodes: subgraph.nodes.length },
      'topology correlation complete',
    );
    return { components, subgraph };
  }

  /**
   * @description Loads the subgraph INDUCED on the traversed node set: those nodes, and the edges
   * whose both endpoints are in the set. A hub the gate refused to enter is not in the set, so its
   * edges are absent — the frozen evidence therefore shows the graph the decision actually used,
   * not a wider one that would make the grouping look unjustified in review.
   * @param keys Traversed node keys.
   * @param seeds Seeds the traversal started from.
   * @param depth Depth the traversal ran at.
   * @returns The subgraph, stamped with the engine and version that produced it.
   */
  private async loadSubgraph(
    keys: string[],
    seeds: string[],
    depth: number,
  ): Promise<TraversedSubgraph> {
    const frame = { seeds, depth, engine: 'postgres-cte' as const, version: TOPOLOGY_TRAVERSAL_VERSION };
    if (keys.length === 0) return { nodes: [], edges: [], ...frame };
    try {
      const nodes = await this.pool.query<TopologyNodeDbRow>(
        `SELECT ${NODE_SELECT} FROM oshal_topology_node
          WHERE node_key = ANY($1::text[]) ORDER BY node_key`,
        [keys],
      );
      const edges = await this.pool.query<TopologyEdgeDbRow>(
        `SELECT ${EDGE_SELECT} FROM oshal_topology_edge
          WHERE src_key = ANY($1::text[]) AND dst_key = ANY($1::text[])
          ORDER BY src_key, dst_key, edge_type`,
        [keys],
      );
      return { nodes: nodes.rows.map(mapNodeRow), edges: edges.rows.map(mapEdgeRow), ...frame };
    } catch (error) {
      logger.error({ err: error, keyCount: keys.length }, 'topology subgraph read failed');
      throw error;
    }
  }

  /**
   * @description Bulk-loads a static estate map into the `compose` slice. Dependencies declared in
   * a static map are authored, not inferred, so their arrows are written `direction_certified` —
   * they are exactly the edges root-candidate ranking is allowed to consult. Endpoints named only
   * as a dependency are materialized as bare nodes first, so the edge write can never dangle.
   * @param entries The static map.
   * @returns Nothing; nodes and edges are committed when the promise resolves.
   */
  async seedFromStaticMap(entries: StaticTopologyEntry[]): Promise<void> {
    const nodes = new Map<string, TopologyNodeRow>();
    const edges: TopologyEdgeRow[] = [];
    for (const entry of entries) {
      const loaderScope = entry.loaderScope ?? '';
      nodes.set(entry.nodeKey, {
        nodeKey: entry.nodeKey,
        displayName: entry.displayName ?? null,
        kinds: entry.kinds ?? [],
        traverseVia: entry.traverseVia ?? null,
        transitAllowed: entry.transitAllowed ?? true,
        status: 'active',
        props: entry.props ?? {},
        loaderTag: 'compose',
        loaderScope,
      });
      for (const dst of entry.dependsOn ?? []) {
        if (!nodes.has(dst)) {
          nodes.set(dst, {
            nodeKey: dst,
            displayName: null,
            kinds: [],
            traverseVia: null,
            transitAllowed: true,
            status: 'active',
            props: {},
            loaderTag: 'compose',
            loaderScope,
          });
        }
        edges.push({
          srcKey: entry.nodeKey,
          dstKey: dst,
          edgeType: entry.edgeType ?? 'depends_on',
          directionCertified: true,
          attrs: {},
          loaderTag: 'compose',
          loaderScope,
        });
      }
    }
    const nodesUpserted = await this.upsertNodes(Array.from(nodes.values()));
    const edgesUpserted = await this.upsertEdges(edges);
    logger.info({ nodesUpserted, edgesUpserted }, 'static topology map seeded');
  }
}
