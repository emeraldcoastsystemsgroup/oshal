import { describe, it, expect } from 'vitest';
import { readWorldCoverage } from '@/features/world-data/world-coverage-read';
describe('World coverage archive reads', () => {
  it('uses bounded read-only source queries and preserves partial unavailable sources', async () => {
    const queries: any[] = [];
    const pool = { query: async (q: any) => {
      queries.push(q); expect(q.text).toMatch(/^SELECT/);
      expect(q.text).not.toMatch(/CREATE|INSERT|UPDATE|DELETE|ALTER/);
      expect(q.values[0]).toEqual(new Date('2026-09-10T00:00:00Z'));
      if (q.text.includes('world_events')) throw Error('missing table');
      return { rows: q.text.includes('world_pulls') ? [{ fetched: '15' }] : [{ title: 'Saved article' }] };
    } };
    const value = await readWorldCoverage(pool as any, new Date('2026-09-10T00:00:00Z'), ['world:topic:technology']);
    expect(value.coverage).toEqual({ fetched: '15' }); expect(value.events).toBeNull();
    expect(value.articles).toHaveLength(1); expect(queries).toHaveLength(3);
    expect(queries[1].values[1]).toEqual(['world:topic:technology']);
    expect(queries[1].text).toMatch(/LIMIT 16/); expect(queries[1].text).toMatch(/entity_id = s.entity/);
    expect(queries[1].text).toMatch(/LIMIT 100/);
    expect(queries[1].text).toMatch(/pub_date > .*interval '48 hours'/);
  });
  it('rejects unbounded subject selection before querying', async () => {
    const pool = { query: () => { throw Error('must not query'); } };
    await expect(readWorldCoverage(pool as any, new Date(), Array(17).fill('world:topic:ai'))).rejects.toThrow('1–16');
    await expect(readWorldCoverage(pool as any, new Date(), [])).rejects.toThrow('1–16');
  });
});
