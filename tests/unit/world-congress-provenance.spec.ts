/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard the reserved congressional disclosure namespace. A world contribution — POST /api/world/contribute validates with WorldContributionSchema, and the model-callable `contribute` verb posts there — can never carry a `congress_*` fact or claim the `quiver-congress` source, in any case or spacing; ingest() refuses the same shapes for in-process callers before any graph or series write; and writeMetric accepts a congress_* metric only when paired with the feed source, which is the pairing the collector uses.
 */

/**
 * @description The done-when clause this protects: "no congressional holding is ever written from
 * anything but the feed". The refusal happens before any I/O, so the doubles here (a graph
 * connector and a pg pool that RECORD) are the observation, not a stand-in for the boundary: the
 * assertion is that they were never asked to write. The collector's own write through a real
 * TimescaleDB is proven in world-metrics-observed-at-postgres.spec.ts.
 */

import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import type { GraphConnector } from '@/features/graph';
import { WorldIntelligenceService } from '@/features/world-data/world-intelligence-service';
import {
  CONGRESS_FEED_SOURCE, WorldContributionSchema, isReservedCongressMetric, isReservedCongressSource,
} from '@/features/world-data/world-types';

const AT = '2026-09-24T00:00:00.000Z';

/** A contribution the way the /contribute route receives it. */
function contribution(source: string, metric: string) {
  return {
    source, ingestedAt: AT,
    entities: [{ id: 'world:ticker:nvda', type: 'ticker', label: 'NVDA', props: {} }],
    edges: [],
    facts: [{ entity: 'world:ticker:nvda', metric, value: 3, at: AT }],
  };
}

/** Recording doubles: every graph upsert and every SQL statement lands here. */
function recorders() {
  const graphWrites: string[] = [];
  const sql: Array<{ text: string; values: unknown[] }> = [];
  const connector = {
    getTenantGraph: async () => ({
      upsertNodes: async () => { graphWrites.push('nodes'); },
      upsertEdges: async () => { graphWrites.push('edges'); },
      neighbors: async () => [],
    }),
  } as unknown as GraphConnector;
  const pool = {
    query: async (text: string, values: unknown[] = []) => { sql.push({ text, values }); return { rows: [], rowCount: 1 }; },
  } as unknown as Pool;
  return { graphWrites, sql, svc: new WorldIntelligenceService(connector, pool) };
}

const inserts = (sql: Array<{ text: string; values: unknown[] }>) => sql.filter((q) => /INSERT INTO world_metrics/.test(q.text));

describe('world contribution schema — the congressional namespace is reserved', () => {
  it.each(['congress_buys', 'congress_net', 'Congress_Sentiment', '  CONGRESS_notional'])(
    'refuses a %s fact',
    (metric) => {
      const parsed = WorldContributionSchema.safeParse(contribution('news-aggregator', metric));
      expect(parsed.success).toBe(false);
      expect(JSON.stringify(parsed.error?.issues)).toContain('congressional disclosure feed collector');
    },
  );

  it.each([CONGRESS_FEED_SOURCE, 'Quiver-Congress', ' quiver-congress '])('refuses a contribution claiming source %j', (source) => {
    const parsed = WorldContributionSchema.safeParse(contribution(source, 'sentiment'));
    expect(parsed.success).toBe(false);
  });

  it('still accepts an ordinary contribution, including a metric that merely mentions congress', () => {
    expect(WorldContributionSchema.safeParse(contribution('news-aggregator', 'sentiment')).success).toBe(true);
    expect(WorldContributionSchema.safeParse(contribution('news-aggregator', 'mention_congress_count')).success).toBe(true);
    expect(isReservedCongressMetric('mention_congress_count')).toBe(false);
    expect(isReservedCongressSource('quiver-congress-mirror')).toBe(false);
  });
});

describe('world ingest — an unparsed in-process contribution is refused before any write', () => {
  it('refuses a congress_* fact with no graph upsert and no series write', async () => {
    const { graphWrites, sql, svc } = recorders();
    await expect(svc.ingest(contribution('news-aggregator', 'congress_buys') as never)).rejects.toThrow(/congressional disclosure feed collector/);
    expect(graphWrites).toEqual([]);
    expect(sql).toEqual([]);
  });

  it('refuses the feed source even for an ordinary metric', async () => {
    const { graphWrites, sql, svc } = recorders();
    await expect(svc.ingest(contribution('quiver-congress', 'sentiment') as never)).rejects.toThrow(/quiver-congress/);
    expect(graphWrites).toEqual([]);
    expect(sql).toEqual([]);
  });

  it('an ordinary contribution still reaches the graph and the series', async () => {
    const { graphWrites, sql, svc } = recorders();
    await expect(svc.ingest(contribution('news-aggregator', 'sentiment') as never)).resolves.toEqual({ nodes: 1, edges: 0, facts: 1 });
    expect(graphWrites).toEqual(['nodes']);
    expect(inserts(sql)).toHaveLength(1);
  });
});

describe('writeMetric — congress_* and the feed source only travel together', () => {
  it('refuses a congress_* metric under any other source, before any SQL', async () => {
    const { sql, svc } = recorders();
    await expect(svc.writeMetric('world:ticker:nvda', 'congress_buys', 3, 'model', AT)).rejects.toThrow(/quiver-congress feed source/);
    await expect(svc.writeMetricIfChanged('world:ticker:nvda', 'congress_net', 3, 'feature-rollup', AT, AT)).rejects.toThrow(/quiver-congress feed source/);
    expect(sql).toEqual([]);
  });

  it('refuses the feed source on a metric outside the namespace', async () => {
    const { sql, svc } = recorders();
    await expect(svc.writeMetric('world:ticker:nvda', 'sentiment', 0.4, 'quiver-congress', AT)).rejects.toThrow(/quiver-congress/);
    expect(sql).toEqual([]);
  });

  it('writes the paired shape the collector uses, and ordinary metrics as before', async () => {
    const { sql, svc } = recorders();
    await svc.writeMetric('world:ticker:nvda', 'congress_buys', 3, 'quiver-congress', AT, '2026-09-25T06:00:00.000Z');
    await svc.writeMetric('world:ticker:nvda', 'days_to_earnings', 12, 'nasdaq-calendar');
    const written = inserts(sql);
    expect(written).toHaveLength(2);
    expect(written[0].values).toEqual(['world:ticker:nvda', 'congress_buys', AT, 3, 'quiver-congress', '2026-09-25T06:00:00.000Z']);
    expect(written[1].values[5], 'an unrecorded observation stays NULL').toBeNull();
  });
});
