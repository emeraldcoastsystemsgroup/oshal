/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-076 Phase 2 owner threading: fake becomes user_sub-keyed (composite (user_sub,id) PK per migration 094) and every SQL recognizer REQUIRES the owner filter, so a store query that drops user_sub goes red; added blank-ownerSub fail-closed test, per-owner deterministic-id isolation test, and cross-owner neighbors leak test.
 */

/**
 * PostgresGraphStore SQL-shaping + result-mapping contract (ADR-066). Drives the store with a
 * FAITHFUL in-memory fake `query` fn that emulates the INSERT ... ON CONFLICT (user_sub, id)
 * DO UPDATE jsonb merge and the SELECTs, proving idempotent upserts, source merge across ingests,
 * getNode, neighbors, and query-by-type — all without a live Postgres.
 *
 * ADR-076 Phase 2 (migration 094): the fake is user_sub-KEYED and every recognizer REQUIRES the
 * owner in the SQL + params — a store query that drops user_sub throws "unrecognized SQL" and the
 * spec goes red. Includes cross-owner isolation and the blank-ownerSub fail-closed constructor.
 * @module tests/unit/personal-graph/pg-graph-store
 */
import { describe, it, expect } from 'vitest';
import { PostgresGraphStore, type QueryFn } from '@/features/personal-graph/pg-graph-store';
import type { PersonNode, GraphEdge, SourceRef } from '@/features/personal-graph/graph-types';

interface NodeRow {
  user_sub: string;
  id: string;
  type: string;
  label: string;
  sources: SourceRef[];
  props: Record<string, unknown>;
}
interface EdgeRow {
  user_sub: string;
  id: string;
  type: string;
  from_id: string;
  to_id: string;
  sources: SourceRef[];
  props: Record<string, unknown>;
}

const OWNER = 'auth0|owner-a';
const OTHER = 'auth0|owner-b';

/**
 * A faithful fake of pg `Pool.query` backed by Maps keyed by `${user_sub}|${id}` — the composite
 * (user_sub, id) PK from migration 094. It recognizes the store's SQL by keyword, REQUIRES the
 * user_sub column/filter to be present (missing owner threading = unrecognized SQL = red spec),
 * and emulates the same ON CONFLICT merge the real DB performs: sources concatenate (jsonb ||),
 * props shallow-merge (jsonb ||), non-empty label wins. Returns rows in the RETURNING/SELECT shape.
 */
function makeFakeQuery(): { query: QueryFn; nodes: Map<string, NodeRow>; edges: Map<string, EdgeRow> } {
  const nodes = new Map<string, NodeRow>();
  const edges = new Map<string, EdgeRow>();
  const key = (sub: string, id: string) => `${sub}|${id}`;

  const query: QueryFn = async (sql, params) => {
    const s = sql.trim();

    // --- node upsert (must carry user_sub in the column list AND the conflict target) ---
    if (/INSERT INTO\s+\S*personal_graph_nodes\s*\(user_sub,/i.test(s) && /ON CONFLICT \(user_sub, id\)/i.test(s)) {
      const [userSub, id, type, label, sourcesJson, propsJson] = params as [
        string,
        string,
        string,
        string,
        string,
        string,
      ];
      const incomingSources = JSON.parse(sourcesJson) as SourceRef[];
      const incomingProps = JSON.parse(propsJson) as Record<string, unknown>;
      const existing = nodes.get(key(userSub, id));
      let row: NodeRow;
      if (!existing) {
        row = { user_sub: userSub, id, type, label, sources: incomingSources, props: incomingProps };
      } else {
        row = {
          user_sub: existing.user_sub,
          id: existing.id,
          type: existing.type, // type is immutable for an id
          label: label.length > 0 ? label : existing.label,
          sources: [...existing.sources, ...incomingSources], // jsonb ||
          props: { ...existing.props, ...incomingProps }, // jsonb ||
        };
      }
      nodes.set(key(userSub, id), row);
      return { rows: [row] };
    }

    // --- edge upsert ---
    if (/INSERT INTO\s+\S*personal_graph_edges\s*\(user_sub,/i.test(s) && /ON CONFLICT \(user_sub, id\)/i.test(s)) {
      const [userSub, id, type, fromId, toId, sourcesJson, propsJson] = params as [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ];
      const incomingSources = JSON.parse(sourcesJson) as SourceRef[];
      const incomingProps = JSON.parse(propsJson) as Record<string, unknown>;
      const existing = edges.get(key(userSub, id));
      let row: EdgeRow;
      if (!existing) {
        row = { user_sub: userSub, id, type, from_id: fromId, to_id: toId, sources: incomingSources, props: incomingProps };
      } else {
        row = {
          ...existing,
          sources: [...existing.sources, ...incomingSources],
          props: { ...existing.props, ...incomingProps },
        };
      }
      edges.set(key(userSub, id), row);
      return { rows: [row] };
    }

    // --- node selects (owner filter is mandatory) ---
    if (/FROM\s+\S*personal_graph_nodes\s+WHERE user_sub = \$1/i.test(s)) {
      const mine = [...nodes.values()].filter((n) => n.user_sub === params[0]);
      if (/AND id = \$2/i.test(s)) {
        return { rows: mine.filter((n) => n.id === params[1]) };
      }
      if (/AND type = \$2/i.test(s)) {
        return { rows: mine.filter((n) => n.type === params[1]) };
      }
      return { rows: mine };
    }

    // --- edge selects (owner filter is mandatory) ---
    if (/FROM\s+\S*personal_graph_edges\s+WHERE user_sub = \$1/i.test(s)) {
      const mine = [...edges.values()].filter((e) => e.user_sub === params[0]);
      if (/\(from_id = \$2 OR to_id = \$2\)/i.test(s)) {
        return { rows: mine.filter((e) => e.from_id === params[1] || e.to_id === params[1]) };
      }
      if (/AND from_id = \$2/i.test(s)) {
        return { rows: mine.filter((e) => e.from_id === params[1]) };
      }
      if (/AND to_id = \$2/i.test(s)) {
        return { rows: mine.filter((e) => e.to_id === params[1]) };
      }
      return { rows: mine };
    }

    throw new Error(`fake query: unrecognized SQL (owner threading missing?): ${s}`);
  };

  return { query, nodes, edges };
}

function person(id: string, props: PersonNode['props'], source: SourceRef): PersonNode {
  return { id, type: 'Person', label: props.name ?? id, sources: [source], props };
}

describe('PostgresGraphStore', () => {
  it('rejects a blank ownerSub (fail closed — never an anonymous shared graph)', () => {
    const { query } = makeFakeQuery();
    expect(() => new PostgresGraphStore(query, '')).toThrow(/ownerSub/);
    expect(() => new PostgresGraphStore(query, '   ')).toThrow(/ownerSub/);
  });

  it('upsert is idempotent by (owner, id) and merges sources across two ingests of the same node', async () => {
    const { query, nodes } = makeFakeQuery();
    const store = new PostgresGraphStore(query, OWNER);

    await store.upsertNode(person('person:a@x.com', { email: 'a@x.com' }, { provider: 'google-calendar' }));
    const merged = await store.upsertNode(
      person('person:a@x.com', { email: 'a@x.com', name: 'Alice' }, { provider: 'gmail' }),
    );

    // one physical row (idempotent by (owner, id))
    expect(nodes.size).toBe(1);
    expect(await store.nodesByType('Person')).toHaveLength(1);
    // sources accumulated + deduped
    expect(merged.sources.map((x) => x.provider).sort()).toEqual(['gmail', 'google-calendar']);
    // props shallow-merged, newest non-null wins
    expect(merged.props.email).toBe('a@x.com');
    expect(merged.props.name).toBe('Alice');
  });

  it('the same deterministic node id is a DISTINCT row per owner, and reads never cross owners', async () => {
    const { query, nodes } = makeFakeQuery();
    const storeA = new PostgresGraphStore(query, OWNER);
    const storeB = new PostgresGraphStore(query, OTHER);

    await storeA.upsertNode(person('person:shared@x.com', { email: 'shared@x.com', name: 'A-view' }, { provider: 'gmail' }));
    await storeB.upsertNode(person('person:shared@x.com', { email: 'shared@x.com', name: 'B-view' }, { provider: 'gmail' }));

    // two physical rows — the old bare-id PK would have collapsed (and cross-merged) them
    expect(nodes.size).toBe(2);
    expect((await storeA.getNode('person:shared@x.com'))?.label).toBe('A-view');
    expect((await storeB.getNode('person:shared@x.com'))?.label).toBe('B-view');
    expect(await storeA.allNodes()).toHaveLength(1);
    expect(await storeB.allNodes()).toHaveLength(1);
  });

  it('dedupes identical sources across re-ingest (same provider+externalId)', async () => {
    const { query } = makeFakeQuery();
    const store = new PostgresGraphStore(query, OWNER);
    const src: SourceRef = { provider: 'gmail', externalId: 'm1' };
    await store.upsertNode(person('person:b@x.com', { email: 'b@x.com' }, src));
    const merged = await store.upsertNode(person('person:b@x.com', { email: 'b@x.com' }, src));
    expect(merged.sources).toHaveLength(1);
  });

  it('getNode returns the stored node or undefined', async () => {
    const { query } = makeFakeQuery();
    const store = new PostgresGraphStore(query, OWNER);
    await store.upsertNode(person('person:c@x.com', { email: 'c@x.com', name: 'C' }, { provider: 'gmail' }));
    const got = await store.getNode('person:c@x.com');
    expect(got?.label).toBe('C');
    expect(got?.type).toBe('Person');
    expect(await store.getNode('person:missing')).toBeUndefined();
  });

  it('neighbors filters by direction and stays within the owner', async () => {
    const { query } = makeFakeQuery();
    const store = new PostgresGraphStore(query, OWNER);
    const other = new PostgresGraphStore(query, OTHER);
    const e = (id: string, type: GraphEdge['type'], from: string, to: string): GraphEdge => ({
      id,
      type,
      from,
      to,
      sources: [],
    });
    await store.upsertEdge(e('attended:p->-e', 'attended', 'p', 'e'));
    await store.upsertEdge(e('authored:p->-m', 'authored', 'p', 'm'));
    await store.upsertEdge(e('mentions:m->-p', 'mentions', 'm', 'p'));
    // another owner's edge incident to the same node id must never leak in
    await other.upsertEdge(e('attended:p->-z', 'attended', 'p', 'z'));

    expect(await store.neighbors('p', { direction: 'out' })).toHaveLength(2);
    expect(await store.neighbors('p', { direction: 'in' })).toHaveLength(1);
    expect(await store.neighbors('p', { direction: 'both' })).toHaveLength(3);
    expect(await store.neighbors('p')).toHaveLength(3); // default = both
  });

  it('edge upsert is idempotent by (owner, id) and merges sources', async () => {
    const { query, edges } = makeFakeQuery();
    const store = new PostgresGraphStore(query, OWNER);
    const base: GraphEdge = {
      id: 'attended:person:a->-event:1',
      type: 'attended',
      from: 'person:a',
      to: 'event:1',
      sources: [{ provider: 'google-calendar' }],
    };
    await store.upsertEdge(base);
    const merged = await store.upsertEdge({
      ...base,
      sources: [{ provider: 'google-calendar', externalId: 'x' }],
    });
    expect(edges.size).toBe(1);
    expect(await store.allEdges()).toHaveLength(1);
    expect(merged.sources).toHaveLength(2); // different externalId => not deduped
  });

  it('nodesByType returns only matching nodes', async () => {
    const { query } = makeFakeQuery();
    const store = new PostgresGraphStore(query, OWNER);
    await store.upsertNode(person('person:d@x.com', { email: 'd@x.com' }, { provider: 'gmail' }));
    await store.upsertNode({
      id: 'org:acme.com',
      type: 'Org',
      label: 'Acme',
      sources: [{ provider: 'gmail' }],
      props: { domain: 'acme.com' },
    });
    expect(await store.nodesByType('Person')).toHaveLength(1);
    expect(await store.nodesByType('Org')).toHaveLength(1);
    expect(await store.allNodes()).toHaveLength(2);
  });
});
