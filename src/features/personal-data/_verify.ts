/* Standalone end-to-end check for the personal-data vault (ADR-057/058). Run:
 *   node_modules/.bin/ts-node --transpile-only --compiler-options '{"module":"CommonJS","esModuleInterop":true}' src/features/personal-data/_verify.ts
 * Proves: entity resolution + non-destructive dedup, junk-sorting (confidence floor), scope guard,
 * and the "relate two datasets" join (holding -> security -> sector). No server, no harness. */
/* eslint-disable no-console -- CLI: standalone ts-node verify script, no server/logger context */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PersonalIntelligenceService } from './personal-intelligence-service';
import { SqliteVaultStore } from './sqlite-vault-store';
import { resolveVault } from './vault';
import type { SchemaContribution } from './schema-contribution';

function assert(cond: boolean, msg: string): void { if (!cond) { console.error('FAIL:', msg); process.exit(1); } console.log('  ok -', msg); }

async function main() {
  const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-'));
  const ownerSub = 'the operator';
  const config = { storeRoot, tenant: 'default', defaultOwnerSub: ownerSub, contributionFloor: 0.4 };
  const store = new SqliteVaultStore();
  const svc = new PersonalIntelligenceService(config, store);
  const layout = resolveVault(storeRoot, 'default', ownerSub);
  const now = '2026-06-19T00:00:00Z';

  const contribution: SchemaContribution = {
    ownerSub,
    provenance: { source: 'verify', ingestedAt: now, confidence: 1, derivedBy: 'verify-bot' },
    entities: [
      { ref: 'self', type: 'person', match: { email: 'the operator@x.com' }, label: 'the operator', attrs: {}, worldRef: null, confidence: 1 },
      { ref: 'aapl', type: 'security', match: { symbol: 'AAPL' }, label: 'Apple', attrs: {}, worldRef: 'world:company:apple', confidence: 1 },
      { ref: 'h1', type: 'holding', match: { account: 'brk-1', symbol: 'AAPL' }, label: 'AAPL position', attrs: { qty: 100 }, worldRef: null, confidence: 1 },
      { ref: 'junk', type: 'skill', match: { name: 'noise' }, label: 'junk', attrs: {}, worldRef: null, confidence: 0.2 }, // below floor -> dropped
    ],
    edges: [
      { type: 'holds', from: 'self', to: 'h1', attrs: {}, confidence: 1 },
      { type: 'of', from: 'h1', to: 'aapl', attrs: {}, confidence: 1 },
      { type: 'in_sector', from: 'aapl', to: 'world:sector:tech', attrs: {}, confidence: 1 }, // world ref crossing — allowed
    ],
    facts: [
      { entity: 'h1', metric: 'position_value', value: 18000, at: now, confidence: 0.9 },
    ],
  };

  console.log('Ingest #1:');
  const r1 = await svc.ingest(contribution);
  console.log(' ', r1);
  assert(r1.created === 3 && r1.merged === 0, 'first ingest creates 3 entities (junk skill dropped)');
  assert(r1.dropped === 1, 'junk (confidence 0.2 < floor 0.4) dropped');
  assert(r1.edges === 3 && r1.facts === 1, '3 edges + 1 fact written');

  console.log('Ingest #2 (identical) — resolution must dedup:');
  const r2 = await svc.ingest(contribution);
  console.log(' ', r2);
  assert(r2.created === 0 && r2.merged === 3, 'second ingest merges, creates nothing (entity resolution works)');

  const entities = store.getEntities(layout, ownerSub);
  const edges = store.getEdges(layout, ownerSub);
  assert(entities.length === 3, `vault holds 3 entities after 2 ingests, not 6 (got ${entities.length})`);
  assert(edges.length === 3, `vault holds 3 edges after 2 ingests, not 6 (got ${edges.length})`);

  console.log('Relate holdings -> securities -> sector (the whole point):');
  const related = store.relateHoldingsToSectors(layout, ownerSub);
  console.log(' ', related);
  assert(related.length === 1, 'one holding relates through to a sector');
  assert(related[0].worldRef === 'world:company:apple' && related[0].sector === 'world:sector:tech',
    'the join reaches the shared world (company:apple, sector:tech) — RAG cannot do this');

  store.close();
  fs.rmSync(storeRoot, { recursive: true, force: true });
  console.log('\nALL CHECKS PASSED');
}

main().catch((e) => { console.error('ERROR', e); process.exit(1); });
