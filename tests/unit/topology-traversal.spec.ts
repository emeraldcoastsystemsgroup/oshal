/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Behavioural guard for TopologyStore against the LIVE Postgres: a cyclic fixture terminates with minimum hop counts, the hub gate is MUTATION-TESTED (same fixture, gate on = two components, gate off = one), depth is exact at the boundary and clamped at the cap, an edgeless node correlates to itself, and the proportional sweep brake refuses a half-slice delete while permitting a small one.
 */

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type {
  TopologyEdgeRow,
  TopologyNodeRow,
} from '../../src/features/alert-pipeline/services/alert-pipeline-types';
import {
  MAX_TRAVERSAL_DEPTH,
  TopologyStore,
} from '../../src/features/alert-pipeline/services/topology-store';

/**
 * The traversal is a recursive CTE, the sweep brake is a transactional measurement, and the upserts
 * are ON CONFLICT statements — none of that has any behaviour outside Postgres, so this spec runs
 * against the live database. It NEVER skips: a missing database is a red test, because a guard that
 * quietly disappears when its dependency is absent is not a guard.
 */
const DSN =
  process.env.ALERT_PIPELINE_TEST_DSN ??
  process.env.TEST_DATABASE_URL ??
  `postgresql://oshal:oshal@127.0.0.1:${process.env.OSHAL_PG_PORT ?? '55433'}/oshal`;

/** Strips the password out of a DSN so a connection failure message is safe to print. */
function safeDsn(dsn: string): string {
  return dsn.replace(/\/\/([^:@/]+):[^@/]*@/, '//$1:***@');
}

/** Unique, LIKE-safe key namespace for this run so parallel runs never collide or sweep each other. */
const PFX = `topo-${process.pid.toString(36)}-${Date.now().toString(36)}-${Math.random()
  .toString(36)
  .slice(2, 8)}-`;

const SCOPE = `${PFX}fixture`;
const SWEEP_SCOPE = `${PFX}sweep`;
const FRESH_SCOPE = `${PFX}fresh`;
const COMPOSE_SCOPE = `${PFX}compose`;

/** Namespaced node key. */
const k = (name: string): string => `${PFX}${name}`;

/** Builds a node in this run's fixture slice; `over` supplies the field a case is actually about. */
function node(key: string, over: Partial<TopologyNodeRow> = {}): TopologyNodeRow {
  return {
    nodeKey: key,
    displayName: null,
    kinds: ['service'],
    traverseVia: null,
    status: 'active',
    props: {},
    loaderTag: 'operator',
    loaderScope: SCOPE,
    ...over,
  };
}

/** Builds a directed edge in this run's fixture slice. */
function edge(src: string, dst: string, over: Partial<TopologyEdgeRow> = {}): TopologyEdgeRow {
  return {
    srcKey: src,
    dstKey: dst,
    edgeType: 'depends_on',
    directionCertified: false,
    attrs: {},
    loaderTag: 'operator',
    loaderScope: SCOPE,
    ...over,
  };
}

let pool: Pool;
let store: TopologyStore;

/** Node keys of the linear chain fixture, c0 … c5. */
const CHAIN = [0, 1, 2, 3, 4, 5].map((i) => k(`chain-${i}`));
/** Node keys of the sweep-slice fixture, s0 … s5. */
const SWEEP_KEYS = [0, 1, 2, 3, 4, 5].map((i) => k(`sw-${i}`));

/**
 * Loads every fixture in one pass: a 3-cycle, a gated hub between two unrelated services, a
 * six-node chain, an edgeless node, a six-node sweep slice, and a freshness slice.
 */
async function loadFixtures(): Promise<void> {
  const cycle = ['cyc-a', 'cyc-b', 'cyc-c'].map(k);
  await store.upsertNodes([
    ...cycle.map((key) => node(key)),
    node(k('hub-svc1')),
    node(k('hub-svc2')),
    // The gate: this hub may only be ENTERED over a `contains` edge, and both service edges are
    // `depends_on` — so the two services must not meet through it.
    node(k('hub'), { kinds: ['group'], traverseVia: ['contains'] }),
    ...CHAIN.map((key) => node(key)),
    node(k('solo')),
    ...SWEEP_KEYS.map((key) => node(key, { loaderTag: 'discovery', loaderScope: SWEEP_SCOPE })),
    node(k('fresh-1'), { loaderTag: 'observed', loaderScope: FRESH_SCOPE }),
    node(k('fresh-2'), { loaderTag: 'observed', loaderScope: FRESH_SCOPE }),
  ]);
  await store.upsertEdges([
    edge(cycle[0], cycle[1]),
    edge(cycle[1], cycle[2]),
    edge(cycle[2], cycle[0]),
    edge(k('hub-svc1'), k('hub')),
    edge(k('hub-svc2'), k('hub')),
    ...CHAIN.slice(0, -1).map((src, i) => edge(src, CHAIN[i + 1])),
    ...SWEEP_KEYS.slice(0, -1).map((src, i) =>
      edge(src, SWEEP_KEYS[i + 1], { loaderTag: 'discovery', loaderScope: SWEEP_SCOPE }),
    ),
  ]);
}

beforeAll(async () => {
  // row_security=off is set per connection at startup so every pooled connection reads the
  // fixtures the same way, rather than depending on which connection a SET happened to land on.
  pool = new Pool({ connectionString: DSN, max: 4, options: '-c row_security=off' });
  try {
    await pool.query('SELECT 1');
  } catch (error) {
    throw new Error(
      `topology traversal spec requires the live oshal Postgres at ${safeDsn(DSN)} — ` +
        `start it with \`bash scripts/oshal-up.sh\` (cause: ${(error as Error).message})`,
    );
  }
  const present = await pool.query<{ node: string | null; edge: string | null; run: string | null }>(
    `SELECT to_regclass('public.oshal_topology_node')::text AS node,
            to_regclass('public.oshal_topology_edge')::text AS edge,
            to_regclass('public.oshal_topology_loader_run')::text AS run`,
  );
  const missing = Object.entries(present.rows[0] ?? {})
    .filter(([, value]) => value === null)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(
      `migration 107 is not applied to ${safeDsn(DSN)} — missing topology table(s): ${missing.join(', ')}`,
    );
  }
  store = new TopologyStore(pool);
  await loadFixtures();
}, 60000);

afterAll(async () => {
  if (!pool) return;
  const like = `${PFX}%`;
  await pool.query('DELETE FROM oshal_topology_edge WHERE src_key LIKE $1 OR dst_key LIKE $1', [like]);
  await pool.query('DELETE FROM oshal_topology_node WHERE node_key LIKE $1', [like]);
  await pool.query('DELETE FROM oshal_topology_loader_run WHERE loader_scope LIKE $1', [like]);
  await pool.end();
}, 60000);

describe('TopologyStore traversal', () => {
  it('(a) terminates on a cyclic topology and returns each node once at its minimum hops', async () => {
    const hops = await store.neighbors(k('cyc-a'), MAX_TRAVERSAL_DEPTH);
    const keys = hops.map((hop) => hop.nodeKey);
    // The path-array guard confines the walk to simple paths, so a cyclic estate — the normal
    // case, since a depends on b while b's host runs a — cannot feed itself back into the
    // recursive term. Each reachable node comes back exactly once.
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.sort()).toEqual([k('cyc-a'), k('cyc-b'), k('cyc-c')].sort());
    const byKey = new Map(hops.map((hop) => [hop.nodeKey, hop.hops]));
    expect(byKey.get(k('cyc-a'))).toBe(0);
    // b is one hop forward; c is one hop BACKWARD over the closing edge — undirected expansion and
    // the MIN aggregate are what make it 1 rather than 2.
    expect(byKey.get(k('cyc-b'))).toBe(1);
    expect(byKey.get(k('cyc-c'))).toBe(1);
  });

  it('(b) the hub gate keeps two services apart, and clearing it collapses the SAME fixture into one component', async () => {
    const gated = await store.correlate([k('hub-svc1'), k('hub-svc2')], 3);
    expect(gated.components).toEqual([[k('hub-svc1')], [k('hub-svc2')]]);
    // The refused hub is not in the evidence either — the snapshot shows the graph the decision used.
    expect(gated.subgraph.nodes.map((n) => n.nodeKey)).not.toContain(k('hub'));
    expect(await store.neighbors(k('hub-svc1'), 3)).toEqual([{ nodeKey: k('hub-svc1'), hops: 0 }]);

    // MUTATION: same nodes, same edges, gate removed from the DATA. If the gate clause were
    // removed from the QUERY the first assertion above would already have failed with one component.
    await pool.query('UPDATE oshal_topology_node SET traverse_via = NULL WHERE node_key = $1', [k('hub')]);
    const open = await store.correlate([k('hub-svc1'), k('hub-svc2')], 3);
    expect(open.components).toEqual([[k('hub-svc1'), k('hub-svc2')]]);
    expect(open.subgraph.nodes.map((n) => n.nodeKey)).toContain(k('hub'));
    expect(open.subgraph.engine).toBe('postgres-cte');

    // Restore the gate so this case cannot leak into any other.
    await pool.query('UPDATE oshal_topology_node SET traverse_via = $2 WHERE node_key = $1', [
      k('hub'),
      ['contains'],
    ]);
  });

  it('(c) respects the depth boundary exactly, one hop beyond, and clamps to the hard cap', async () => {
    const atTwo = await store.neighbors(CHAIN[0], 2);
    expect(atTwo.map((hop) => hop.nodeKey)).toEqual(CHAIN.slice(0, 3));
    expect(atTwo.every((hop) => hop.hops <= 2)).toBe(true);

    const atThree = await store.neighbors(CHAIN[0], 3);
    expect(atThree.map((hop) => hop.nodeKey)).toEqual(CHAIN.slice(0, 4));
    expect(atThree.find((hop) => hop.nodeKey === CHAIN[3])?.hops).toBe(3);

    // A caller-supplied depth is configuration and can be wrong; the traversal stays bounded.
    const clamped = await store.neighbors(CHAIN[0], 99);
    expect(clamped).toHaveLength(MAX_TRAVERSAL_DEPTH + 1);
    expect(Math.max(...clamped.map((hop) => hop.hops))).toBe(MAX_TRAVERSAL_DEPTH);
    expect(clamped.map((hop) => hop.nodeKey)).not.toContain(CHAIN[5]);
  });

  it('a decommissioned node stops bridging, and a decommissioned seed traverses nothing', async () => {
    await pool.query("UPDATE oshal_topology_node SET status = 'decommissioned' WHERE node_key = $1", [
      CHAIN[1],
    ]);
    // The retired host must not keep two live services connected through it.
    const cut = await store.neighbors(CHAIN[0], MAX_TRAVERSAL_DEPTH);
    expect(cut).toEqual([{ nodeKey: CHAIN[0], hops: 0 }]);

    await pool.query("UPDATE oshal_topology_node SET status = 'decommissioned' WHERE node_key = $1", [
      CHAIN[0],
    ]);
    expect(await store.neighbors(CHAIN[0], 2)).toEqual([]);

    await pool.query(
      "UPDATE oshal_topology_node SET status = 'active' WHERE node_key = ANY($1::text[])",
      [[CHAIN[0], CHAIN[1]]],
    );
    expect(await store.neighbors(CHAIN[0], 1)).toHaveLength(2);
  });

  it('(d) an edgeless node correlates to itself only, and an unknown seed is still its own component', async () => {
    const solo = await store.correlate([k('solo')], 3);
    expect(solo.components).toEqual([[k('solo')]]);
    expect(solo.subgraph.nodes.map((n) => n.nodeKey)).toEqual([k('solo')]);
    expect(solo.subgraph.edges).toEqual([]);
    expect(solo.subgraph.seeds).toEqual([k('solo')]);

    // A target the mirror has never heard of must produce its own incident, never vanish.
    const unknown = await store.correlate([k('solo'), k('never-discovered')], 2);
    expect(unknown.components).toEqual([[k('never-discovered')], [k('solo')]]);
    expect(unknown.subgraph.nodes.map((n) => n.nodeKey)).toEqual([k('solo')]);
  });
});

describe('TopologyStore sweep brake', () => {
  it('(e) refuses a sweep that would take half the slice, and permits one that takes a small fraction', async () => {
    const sliceCount = async (): Promise<number> => {
      const result = await pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM oshal_topology_node WHERE loader_tag = $1 AND loader_scope = $2',
        ['discovery', SWEEP_SCOPE],
      );
      return Number(result.rows[0].count);
    };
    expect(await sliceCount()).toBe(6);

    // A feed reporting only 3 of 6 looks exactly like a truncated feed: refuse, delete nothing.
    const refused = await store.sweep('discovery', SWEEP_SCOPE, SWEEP_KEYS.slice(0, 3));
    expect(refused.refused).toBe(true);
    expect(refused.swept).toBe(0);
    expect(refused.edgesSwept).toBe(0);
    expect(await sliceCount()).toBe(6);

    // A feed reporting 5 of 6 is a decommission: delete the one, and the edge that dangled with it.
    const permitted = await store.sweep('discovery', SWEEP_SCOPE, SWEEP_KEYS.slice(0, 5));
    expect(permitted.refused).toBe(false);
    expect(permitted.swept).toBe(1);
    expect(permitted.edgesSwept).toBeGreaterThanOrEqual(1);
    expect(await sliceCount()).toBe(5);

    // A full re-report deletes nothing and must not be mistaken for a refusal.
    const noop = await store.sweep('discovery', SWEEP_SCOPE, SWEEP_KEYS.slice(0, 5));
    expect(noop).toMatchObject({ refused: false, swept: 0, edgesSwept: 0 });
    expect(await sliceCount()).toBe(5);

    // An empty keep-set is the worst case the brake exists for.
    const emptyKeep = await store.sweep('discovery', SWEEP_SCOPE, []);
    expect(emptyKeep.refused).toBe(true);
    expect(await sliceCount()).toBe(5);

    // Another loader's slice is untouched by any of it.
    const fixtureSlice = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM oshal_topology_node WHERE loader_scope = $1',
      [SCOPE],
    );
    expect(Number(fixtureSlice.rows[0].count)).toBeGreaterThan(0);
  });
});

describe('TopologyStore loader provenance', () => {
  it('records one durable run row per loader pass, including the refusal', async () => {
    await store.recordLoaderRun({
      loaderTag: 'discovery',
      loaderScope: SWEEP_SCOPE,
      durationMs: 1234,
      success: true,
      nodesUpserted: 6,
      edgesUpserted: 5,
      nodesSwept: 1,
      edgesSwept: 1,
      sweepRefused: true,
      error: null,
      counts: { service: 6 },
    });
    const result = await pool.query<{
      sweep_refused: boolean;
      nodes_upserted: number;
      duration_ms: number;
      counts: Record<string, number>;
    }>(
      `SELECT sweep_refused, nodes_upserted, duration_ms, counts
         FROM oshal_topology_loader_run WHERE loader_scope = $1 ORDER BY run_id DESC LIMIT 1`,
      [SWEEP_SCOPE],
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].sweep_refused).toBe(true);
    expect(result.rows[0].nodes_upserted).toBe(6);
    expect(result.rows[0].duration_ms).toBe(1234);
    expect(result.rows[0].counts).toEqual({ service: 6 });
  });

  it('reports per-slice freshness so a stalled loader is visible', async () => {
    const slices = await store.loaderFreshness();
    const mine = slices.find((slice) => slice.loaderScope === FRESH_SCOPE);
    expect(mine).toBeDefined();
    expect(mine?.loaderTag).toBe('observed');
    expect(mine?.count).toBe(2);
    expect(mine?.maxRefreshedAt).toBeInstanceOf(Date);
  });

  it('seeds a static map idempotently, materializing endpoints named only as a dependency', async () => {
    const entries = [
      {
        nodeKey: k('cmp-api'),
        displayName: 'api',
        kinds: ['container'],
        dependsOn: [k('cmp-db')],
        loaderScope: COMPOSE_SCOPE,
      },
    ];
    await store.seedFromStaticMap(entries);
    await store.seedFromStaticMap(entries);

    const nodes = await pool.query<{ node_key: string; loader_tag: string }>(
      'SELECT node_key, loader_tag FROM oshal_topology_node WHERE loader_scope = $1 ORDER BY node_key',
      [COMPOSE_SCOPE],
    );
    expect(nodes.rows.map((row) => row.node_key)).toEqual([k('cmp-api'), k('cmp-db')]);
    expect(nodes.rows.every((row) => row.loader_tag === 'compose')).toBe(true);

    const edges = await pool.query<{ src_key: string; dst_key: string; direction_certified: boolean }>(
      'SELECT src_key, dst_key, direction_certified FROM oshal_topology_edge WHERE loader_scope = $1',
      [COMPOSE_SCOPE],
    );
    expect(edges.rows).toHaveLength(1);
    // An authored dependency is a certified arrow — the only kind root ranking may consult.
    expect(edges.rows[0].direction_certified).toBe(true);
    expect(await store.neighbors(k('cmp-api'), 1)).toEqual([
      { nodeKey: k('cmp-api'), hops: 0 },
      { nodeKey: k('cmp-db'), hops: 1 },
    ]);
  });
});
