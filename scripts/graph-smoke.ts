/**
 * Graph connector smoke test (ADR-045) — exercises the REAL connector against a live ArangoDB.
 * Run: ARANGO_URL=http://localhost:58529 ARANGO_ROOT_PASSWORD=oshal \
 *      npx ts-node -r tsconfig-paths/register scripts/graph-smoke.ts
 * Not part of the build (outside src/); a dev verification helper.
 */
import { createGraphConnector } from '@/features/graph';

async function main(): Promise<void> {
  const c = createGraphConnector();
  if (!c) throw new Error('connector is null — ARANGO_URL not set');

  const g = await c.getPersonGraph('smoke-test-user'); // provisions an isolated person graph
  const nodesWritten = await g.upsertNodes([
    { id: 'svc:api', labels: ['service'], props: { name: 'API' } },
    { id: 'svc:db', labels: ['service'], props: { name: 'DB' } },
    { id: 'host:h1', labels: ['host'], props: { region: 'us' } },
  ]);
  const edgesWritten = await g.upsertEdges([
    { from: 'svc:api', to: 'svc:db', type: 'depends_on' },
    { from: 'svc:db', to: 'host:h1', type: 'runs_on' },
  ]);
  const neighbors = (await g.neighbors('svc:api', 2)).map((n) => n.id).sort();
  const path = (await g.shortestPath('svc:api', 'host:h1')).map((n) => n.id);
  const services = await g.rawQuery('FOR x IN nodes FILTER @l IN x.labels SORT x.id RETURN x.id', { l: 'service' });
  const idempotent = await g.upsertNodes([{ id: 'svc:api', labels: ['service'], props: { name: 'API v2' } }]);

  console.log(JSON.stringify({ nodesWritten, edgesWritten, neighbors, path, services, idempotentReupsert: idempotent }, null, 2));
}

main().then(() => process.exit(0)).catch((e) => { console.error('SMOKE FAIL:', e); process.exit(1); });
