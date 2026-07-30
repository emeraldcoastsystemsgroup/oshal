/**
 * Read-only enforcement in the ArangoDB adapter (ADR-045 closure, arango-graph-adapter.ts).
 *
 * `POST /api/graph/query` is documented as "run a raw AQL read", but `rawQuery` hands the string
 * straight to `db.query`, so a REMOVE/INSERT went through. The fix must NOT be an AQL keyword
 * denylist (bypassable, and it rots with every AQL release) — so `readQuery` asks the ENGINE to plan
 * the query and refuses when ArangoDB's own execution plan reports `isModificationQuery`.
 *
 * These cases pin that mechanism against a STUBBED arangojs Database (no engine, no network):
 *   - a read plan → the query runs, and it runs with the caller's bind vars;
 *   - a modification plan → GraphReadOnlyError, and `db.query` is NEVER reached (refused BEFORE the
 *     write, not after);
 *   - the refusal names the collections the plan would have written, so an operator reading the log
 *     can see what was attempted;
 *   - `rawQuery` deliberately does NOT plan — it stays the trusted in-process escape hatch the
 *     data-lifecycle exporter dumps through, so enforcement lives on the caller-facing path only.
 *
 * What this cannot prove without a live engine: that ArangoDB sets `isModificationQuery` correctly.
 * That is the engine's contract (3.10+), exercised end-to-end by scripts/graph-smoke.ts.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — pins that readQuery plans the query through the engine and refuses a data-modifying plan BEFORE executing it, that the refusal reports the would-be-written collections, and that rawQuery stays unplanned for trusted in-process callers.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Database } from 'arangojs';
import { ArangoGraphAdapter } from '@/features/graph/services/arango-graph-adapter';
import { GRAPH_READ_ONLY_CODE, GraphReadOnlyError } from '@/features/graph/services/graph-types';

/** Shape of one recorded db.query call, so the assertions can read what was executed. */
interface RecordedQuery { query: string; bindVars: Record<string, unknown> }

/**
 * A stubbed arangojs Database: `explain` answers with the plan the case wants, `query` records the
 * call and returns a cursor. Nothing here talks to an engine.
 */
function stubDb(plan: { isModificationQuery: boolean; collections?: Array<{ name: string; type: 'read' | 'write' }> }) {
  const queries: RecordedQuery[] = [];
  const explain = vi.fn(async () => ({
    plan: { isModificationQuery: plan.isModificationQuery, collections: plan.collections ?? [] },
  }));
  const query = vi.fn(async (q: string, bindVars: Record<string, unknown>) => {
    queries.push({ query: q, bindVars });
    return { all: async () => [{ id: 'service:api' }] };
  });
  return { db: { explain, query } as unknown as Database, explain, query, queries };
}

describe('ArangoGraphAdapter.readQuery — the engine decides what is a read (ADR-045)', () => {
  it('runs a query the plan calls non-modifying, passing the caller bind vars through', async () => {
    const { db, explain, queries } = stubDb({
      isModificationQuery: false,
      collections: [{ name: 'nodes', type: 'read' }],
    });
    const adapter = new ArangoGraphAdapter(db);

    const rows = await adapter.readQuery('FOR n IN nodes FILTER @l IN n.labels RETURN n.id', { l: 'service' });

    expect(rows).toEqual([{ id: 'service:api' }]);
    expect(explain).toHaveBeenCalledTimes(1);
    // The plan must be asked about the SAME query + binds that will run (an explain of a different
    // string proves nothing about what executes).
    expect(explain.mock.calls[0][0]).toBe('FOR n IN nodes FILTER @l IN n.labels RETURN n.id');
    expect(explain.mock.calls[0][1]).toEqual({ l: 'service' });
    expect(queries).toEqual([
      { query: 'FOR n IN nodes FILTER @l IN n.labels RETURN n.id', bindVars: { l: 'service' } },
    ]);
  });

  it('refuses a modifying plan BEFORE executing it — db.query is never reached', async () => {
    const { db, query } = stubDb({
      isModificationQuery: true,
      collections: [{ name: 'nodes', type: 'write' }],
    });
    const adapter = new ArangoGraphAdapter(db);

    await expect(adapter.readQuery('FOR n IN nodes REMOVE n IN nodes')).rejects.toBeInstanceOf(
      GraphReadOnlyError,
    );
    // The whole point: nothing was executed. A post-hoc check would already have deleted the data.
    expect(query).not.toHaveBeenCalled();
  });

  it('the refusal carries the stable code and names the collections the plan would write', async () => {
    const { db } = stubDb({
      isModificationQuery: true,
      collections: [
        { name: 'nodes', type: 'read' },
        { name: 'edges', type: 'write' },
      ],
    });
    const adapter = new ArangoGraphAdapter(db);

    const err = await adapter
      .readQuery('FOR e IN edges REMOVE e IN edges')
      .then(() => null)
      .catch((e: unknown) => e as GraphReadOnlyError);

    expect(err).toBeInstanceOf(GraphReadOnlyError);
    expect(err?.code).toBe(GRAPH_READ_ONLY_CODE);
    expect(err?.message).toContain('would write: edges');
    // Read-only collections in the same plan are not reported as writes.
    expect(err?.message).not.toContain('nodes');
  });

  it('rawQuery stays the UNPLANNED in-process escape hatch (the exporter dumps through it)', async () => {
    const { db, explain, queries } = stubDb({ isModificationQuery: true });
    const adapter = new ArangoGraphAdapter(db);

    await adapter.rawQuery('FOR n IN nodes RETURN n', {});

    // No explain round-trip, no refusal: trusted core callers keep the direct path. Enforcement is
    // deliberately on readQuery (what the HTTP layer calls), not on every engine access.
    expect(explain).not.toHaveBeenCalled();
    expect(queries).toHaveLength(1);
  });
});
