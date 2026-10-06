/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-174 Amendment B guards (step B5-6) for DELETE /api/rag/knowledge/:id end to end on a private pgvector PostgreSQL under the NON-superuser application role, with FORCE RLS on both tables (migration 070's rag_chunks policies as shipped; knowledge_memory_documents given migration 094's exact policy, since 094 itself needs the whole conversation schema) and the GUC-stamped pools and request identity the api uses: an operator removes a shared document and a person's private one, chunks and record; a person removes their own private document, and is refused on a shared one (403, nothing touched) and answered 404 on another person's (RLS hides the row); a person's /ingest naming another document's id in its metadata cannot make them remove that document's chunks. Each fails on the tree before the fix.
 */

import type { AddressInfo } from 'node:net';
import express from 'express';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DisposablePostgres } from '../helpers/disposable-postgres';

const state = vi.hoisted(() => ({ pool: null as unknown, superPool: null as unknown }));
vi.mock('@/shared/services/database', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    createOptionalPostgresPool: () => state.pool,
    // The schema is bootstrapped once, by the superuser; the application role's service must not try.
    ensureConversationStoreSchema: (pool: unknown) => (pool === state.superPool ? (original.ensureConversationStoreSchema as (p: unknown) => unknown)(pool) : undefined),
  };
});
vi.mock('@/app/routes/connector-tenancy', async (importOriginal) => ({ ...await importOriginal<object>(), getUserTenantIds: vi.fn(async () => []) }));

import { _setRagPoolForTests, pgvectorRagEngine } from '@/features/rag/services/pgvector-rag-engine';
import { wrapPoolWithGuc } from '@/shared/services/database/guc-pool';
import { runWithRequestIdentity } from '@/shared/services/database/request-identity';
import { isOperator } from '@/shared/middleware/authz';
import { createRagRoutes } from '@/app/routes/rag-routes';
import { MemoryLayerService } from '@/features/memory/services/memory-layer-service';

const APP_ROLE = 'oshal_app';
const OPERATOR = 'op-sub';
const database = new DisposablePostgres({ purpose: 'rag-knowledge-remove-rls', image: 'pgvector/pgvector:pg16', migrations: ['070-rag-chunks-pgvector.sql'], max: 4, roles: [APP_ROLE] });
let server: ReturnType<express.Express['listen']>;
let base = '';
let superuser: Pool;

beforeAll(async () => {
  vi.stubEnv('OSHAL_OPERATOR_SUBS', OPERATOR); vi.stubEnv('OSHAL_OPERATOR_EMAILS', ''); vi.stubEnv('RAG_ENGINE', 'pgvector');
  superuser = await database.start();
  state.superPool = superuser; state.pool = superuser;
  await new MemoryLayerService({} as never, {} as never).listKnowledgeDocuments(); // bootstraps the conversation schema as the superuser
  await superuser.query(`
    ALTER TABLE knowledge_memory_documents ADD COLUMN IF NOT EXISTS owner_sub TEXT;
    ALTER TABLE knowledge_memory_documents ENABLE ROW LEVEL SECURITY;
    ALTER TABLE knowledge_memory_documents FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS knowledge_memory_documents_shared_or_owner ON knowledge_memory_documents;
    CREATE POLICY knowledge_memory_documents_shared_or_owner ON knowledge_memory_documents AS PERMISSIVE FOR ALL
      USING (current_setting('oshal.is_operator', true) = 'on' OR owner_sub IS NULL OR owner_sub = current_setting('oshal.current_sub', true))
      WITH CHECK (current_setting('oshal.is_operator', true) = 'on' OR owner_sub = current_setting('oshal.current_sub', true));
    GRANT SELECT, INSERT, UPDATE, DELETE ON knowledge_memory_documents TO ${APP_ROLE};
    GRANT SELECT, INSERT, UPDATE, DELETE ON rag_chunks TO ${APP_ROLE};
  `);
  const appPool = database.rolePool(APP_ROLE);
  state.pool = wrapPoolWithGuc(appPool);
  _setRagPoolForTests(appPool);
  const memory = new MemoryLayerService({} as never, {} as never);
  await memory.listKnowledgeDocuments().catch(() => undefined);
  const ragService = {
    ingest: async (texts: string[], collection: string, metadata: Record<string, string>) => {
      await pgvectorRagEngine.addChunks(collection, texts.map((_t, i) => `c-${Math.random().toString(36).slice(2)}-${i}`), texts, texts.map(() => ({ ...metadata })), null);
      return { collection, documentCount: texts.length, chunkCount: texts.length };
    },
    deleteDocumentChunks: (collection: string, id: string) => pgvectorRagEngine.deleteByKnowledgeId(collection, id),
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const sub = String(req.headers['x-test-sub'] ?? '');
    Object.assign(req, { oidc: { user: { sub } } });
    runWithRequestIdentity({ sub: sub || null, isOperator: isOperator(req) }, () => next());
  });
  app.use('/api/rag', createRagRoutes(ragService as never, memory, null));
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 180_000);
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); _setRagPoolForTests(null); await database.stop(); vi.unstubAllEnvs(); });

const ingestAs = async (sub: string, body: Record<string, unknown>) => {
  const res = await fetch(`${base}/api/rag/ingest`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-sub': sub }, body: JSON.stringify({ format: 'text', content: `text for ${sub}`, collection: 'my-knowledge', ...body }) });
  expect(res.status).toBe(200);
  return ((await res.json()) as { knowledgeId: string }).knowledgeId;
};
const removeAs = (sub: string, id: string) => fetch(`${base}/api/rag/knowledge/${id}`, { method: 'DELETE', headers: { 'x-test-sub': sub } });
const chunks = async (id: string) => Number((await superuser.query("SELECT count(*)::int AS n FROM rag_chunks WHERE metadata->>'knowledge_id' = $1", [id])).rows[0].n);
const records = async (id: string) => Number((await superuser.query('SELECT count(*)::int AS n FROM knowledge_memory_documents WHERE knowledge_id = $1::uuid', [id])).rows[0].n);

describe('DELETE /api/rag/knowledge/:id under RLS as the application role', () => {
  it('an operator removes shared and private documents; a person only their own, refused on shared and answered 404 on another person\'s', async () => {
    const shared = await ingestAs(OPERATOR, {});
    const alices = await ingestAs('alice', {});
    const bobs = await ingestAs('bob', {});
    expect([await chunks(shared), await chunks(alices), await chunks(bobs)]).toEqual([1, 1, 1]);

    expect((await removeAs('alice', shared)).status).toBe(403);
    expect((await removeAs('alice', bobs)).status).toBe(404);
    expect([await chunks(shared), await records(shared), await chunks(bobs), await records(bobs)]).toEqual([1, 1, 1, 1]);

    const own = await removeAs('alice', alices);
    expect(own.status).toBe(200);
    expect(await own.json()).toMatchObject({ removed: true, scope: 'private', chunksTagged: true, chunksRemoved: 1 });
    expect([await chunks(alices), await records(alices)]).toEqual([0, 0]);

    expect(await (await removeAs(OPERATOR, bobs)).json()).toMatchObject({ removed: true, chunksRemoved: 1 });
    expect(await (await removeAs(OPERATOR, shared)).json()).toMatchObject({ removed: true, scope: 'swarm', chunksRemoved: 1 });
    expect([await chunks(shared), await records(shared), await chunks(bobs), await records(bobs)]).toEqual([0, 0, 0, 0]);
  });

  it('a person\'s ingest naming another document\'s id in its metadata cannot make them remove that document', async () => {
    const victim = await ingestAs(OPERATOR, {});
    const mallorys = await ingestAs('mallory', { metadata: { knowledge_id: victim } });
    expect(mallorys).not.toBe(victim);
    expect([await chunks(victim), await chunks(mallorys)]).toEqual([1, 1]);
    expect((await removeAs('mallory', mallorys)).status).toBe(200);
    expect([await chunks(victim), await records(victim), await chunks(mallorys)]).toEqual([1, 1, 0]);
    expect((await removeAs('mallory', victim)).status).toBe(403);
    expect([await chunks(victim), await records(victim)]).toEqual([1, 1]);
  });
});
