/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-174 Amendment B guards (step B5-6, shared knowledge) against the real rag routes with the real memory layer in memory mode and a fake vector store: /ingest and /upload stamp the record's id onto every chunk (a caller's own knowledge_id in the metadata is overridden) and mark the record chunksTagged; DELETE /knowledge/:id removes the chunks by that id and then the record, writes one knowledge.remove audit event and reports what went; an operator removes shared and private documents alike, a person only their own private one (403 otherwise, and nothing is touched); a document stored before ids were stamped loses its record and the reply says its chunks stay; an invalid id is 400, an unknown one 404, a failed chunk removal keeps the record; a record gone between the read and the delete is a 404 with no event, and no memory service is a 503; a record write that fails after the chunks went in removes those chunks again; ingest answers the id and the knowledge view says chunksTagged. Each fails on the tree before the fix.
 */

import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const databaseMocks = vi.hoisted(() => ({ createOptionalPostgresPool: vi.fn(() => null), ensureConversationStoreSchema: vi.fn() }));
vi.mock('@/shared/services/database', async (importOriginal) => ({ ...await importOriginal<object>(), ...databaseMocks }));
const governanceMocks = vi.hoisted(() => ({ emitAuditEvent: vi.fn(async (_pool: unknown, _event: Record<string, unknown>) => true) }));
vi.mock('@/features/governance', async (importOriginal) => ({ ...await importOriginal<object>(), ...governanceMocks }));
vi.mock('@/app/routes/connector-tenancy', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/app/routes/connector-tenancy')>(),
  getUserTenantIds: vi.fn(async () => []),
}));

import { createRagRoutes } from '@/app/routes/rag-routes';
import { MemoryLayerService } from '@/features/memory/services/memory-layer-service';

const OPERATOR = 'portal-admin';
const ALICE = 'alice';
const BOB = 'bob';

const ingested: Array<{ collection: string; metadata: Record<string, string> }> = [];
const ingest = vi.fn(async (_texts: string[], collection: string, metadata: Record<string, string>) => {
  ingested.push({ collection, metadata });
  return { collection, documentCount: 1, chunkCount: 3 };
});
const deleteDocumentChunks = vi.fn(async (_collection: string, _knowledgeId: string) => 3);

let memory: MemoryLayerService;
let server: ReturnType<express.Express['listen']>;
let base = '';

beforeEach(async () => {
  vi.stubEnv('OSHAL_OPERATOR_SUBS', OPERATOR); vi.stubEnv('OSHAL_OPERATOR_EMAILS', '');
  ingested.length = 0; ingest.mockClear(); deleteDocumentChunks.mockClear(); governanceMocks.emitAuditEvent.mockClear();
  memory = new MemoryLayerService({} as never, {} as never);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { Object.assign(req, { oidc: { user: { sub: String(req.headers['x-test-sub'] ?? '') } } }); next(); });
  app.use('/api/rag', createRagRoutes({ ingest, deleteDocumentChunks } as never, memory, {} as never));
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); vi.unstubAllEnvs(); });

const ingestAs = (sub: string, body: Record<string, unknown>) => fetch(`${base}/api/rag/ingest`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-test-sub': sub }, body: JSON.stringify({ format: 'text', content: 'Shared notes for everyone', collection: 'swarm-knowledge', ...body }),
});
const removeAs = (sub: string, id: string) => fetch(`${base}/api/rag/knowledge/${id}`, { method: 'DELETE', headers: { 'x-test-sub': sub } });
const listAs = async (sub: string) => (await (await fetch(`${base}/api/rag/knowledge`, { headers: { 'x-test-sub': sub } })).json()) as { documents: Array<{ knowledgeId: string }> };

describe('ingest and upload stamp the record id onto the chunks', () => {
  it('an operator ingest tags every chunk with the record id and overrides a caller-supplied knowledge_id', async () => {
    const res = await ingestAs(OPERATOR, { metadata: { knowledge_id: 'someone-elses-id', source: 'wiki' } });
    expect(res.status).toBe(200);
    const [doc] = await memory.listKnowledgeDocuments();
    expect(((await res.json()) as { knowledgeId: string }).knowledgeId).toBe(doc.knowledgeId);
    expect(((await listAs(OPERATOR)).documents[0] as { chunksTagged?: boolean }).chunksTagged).toBe(true);
    expect(doc.ownerSub).toBeUndefined();
    expect(doc.metadata.chunksTagged).toBe(true);
    expect(ingested).toHaveLength(1);
    expect(ingested[0].metadata.knowledge_id).toBe(doc.knowledgeId);
    expect(ingested[0].metadata.knowledge_id).not.toBe('someone-elses-id');
    expect(ingested[0].metadata.source).toBe('wiki');
  });

  it('an upload tags its chunks with the record id too', async () => {
    const form = new FormData();
    form.append('collection', 'swarm-knowledge');
    form.append('files', new Blob(['Plain text the swarm should know'], { type: 'text/plain' }), 'notes.txt');
    const res = await fetch(`${base}/api/rag/upload`, { method: 'POST', headers: { 'x-test-sub': OPERATOR }, body: form });
    expect(res.status).toBe(200);
    const [doc] = await memory.listKnowledgeDocuments();
    expect(doc.metadata.chunksTagged).toBe(true);
    expect(ingested[0].metadata.knowledge_id).toBe(doc.knowledgeId);
  });
});

describe('DELETE /api/rag/knowledge/:knowledgeId', () => {
  it('an operator removes a shared document: chunks by id, then the record, with one audit event', async () => {
    await ingestAs(OPERATOR, {});
    const [doc] = await memory.listKnowledgeDocuments();
    const res = await removeAs(OPERATOR, doc.knowledgeId);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, removed: true, knowledgeId: doc.knowledgeId, collection: 'swarm-knowledge', scope: 'swarm', chunksTagged: true, chunksRemoved: 3 });
    expect(deleteDocumentChunks).toHaveBeenCalledWith('swarm-knowledge', doc.knowledgeId);
    expect((await listAs(OPERATOR)).documents).toEqual([]);
    expect(governanceMocks.emitAuditEvent).toHaveBeenCalledTimes(1);
    expect(governanceMocks.emitAuditEvent.mock.calls[0][1]).toMatchObject({ actorSub: OPERATOR, action: 'knowledge.remove', resourceType: 'knowledge', resourceId: doc.knowledgeId, decision: 'allow', metadata: { collection: 'swarm-knowledge', scope: 'swarm', chunksRemoved: 3, operator: true } });
    expect((await removeAs(OPERATOR, doc.knowledgeId)).status).toBe(404);
  });

  it('a person removes only their own private document; shared and other people\'s documents are refused untouched', async () => {
    await ingestAs(OPERATOR, {});
    await ingestAs(ALICE, { private: true, collection: 'my-knowledge' });
    await ingestAs(BOB, { private: true, collection: 'my-knowledge' });
    const docs = await memory.listKnowledgeDocuments();
    const shared = docs.find((d) => !d.ownerSub)!;
    const alices = docs.find((d) => d.ownerSub === ALICE)!;
    const bobs = docs.find((d) => d.ownerSub === BOB)!;
    expect((await removeAs(ALICE, shared.knowledgeId)).status).toBe(403);
    expect((await removeAs(ALICE, bobs.knowledgeId)).status).toBe(403);
    expect(deleteDocumentChunks).not.toHaveBeenCalled();
    expect(governanceMocks.emitAuditEvent).not.toHaveBeenCalled();
    expect(await memory.listKnowledgeDocuments()).toHaveLength(3);
    const own = await removeAs(ALICE, alices.knowledgeId);
    expect(own.status).toBe(200);
    expect(await own.json()).toMatchObject({ removed: true, scope: 'private', chunksRemoved: 3 });
    expect(deleteDocumentChunks).toHaveBeenCalledWith('my-knowledge', alices.knowledgeId);
    expect((await memory.listKnowledgeDocuments()).map((d) => d.knowledgeId).sort()).toEqual([bobs.knowledgeId, shared.knowledgeId].sort());
    // The operator can still remove a person's private document.
    expect((await removeAs(OPERATOR, bobs.knowledgeId)).status).toBe(200);
  });

  it('a document stored before ids were stamped loses its record and the reply says its chunks stay', async () => {
    const legacy = await memory.recordKnowledgeDocument({ collection: 'swarm-knowledge', title: 'old', source: 'ingest-api', chunkCount: 2, documentCount: 1, metadata: {} });
    const res = await removeAs(OPERATOR, legacy.knowledgeId);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toMatchObject({ removed: true, chunksTagged: false, chunksRemoved: null });
    expect(String(body.note)).toContain('chunks stay');
    expect(deleteDocumentChunks).not.toHaveBeenCalled();
    expect(await memory.listKnowledgeDocuments()).toEqual([]);
  });

  it('answers 404 with no event when the record went between the read and the delete, and 503 without a memory service', async () => {
    await ingestAs(OPERATOR, {});
    const [doc] = await memory.listKnowledgeDocuments();
    const racing = { getKnowledgeDocument: () => memory.getKnowledgeDocument(doc.knowledgeId), deleteKnowledgeDocument: async () => null } as unknown as MemoryLayerService;
    const app = express();
    app.use((req, _res, next) => { Object.assign(req, { oidc: { user: { sub: OPERATOR } } }); next(); });
    app.use('/api/rag', createRagRoutes({ ingest, deleteDocumentChunks } as never, racing, {} as never));
    app.use('/api/rag-none', createRagRoutes({ ingest, deleteDocumentChunks } as never, undefined, {} as never));
    const other = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => other.once('listening', resolve));
    const port = (other.address() as AddressInfo).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/rag/knowledge/${doc.knowledgeId}`, { method: 'DELETE' });
      expect(res.status).toBe(404);
      expect(governanceMocks.emitAuditEvent).not.toHaveBeenCalled();
      expect((await fetch(`http://127.0.0.1:${port}/api/rag-none/knowledge/${doc.knowledgeId}`, { method: 'DELETE' })).status).toBe(503);
    } finally { await new Promise<void>((resolve) => other.close(() => resolve())); }
  });

  it('removes the chunks again when the record write fails after them, so none survive without a record', async () => {
    const failing = { ...memory, recordKnowledgeDocument: async () => { throw new Error('insert refused'); } } as unknown as MemoryLayerService;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { Object.assign(req, { oidc: { user: { sub: OPERATOR } } }); next(); });
    app.use('/api/rag', createRagRoutes({ ingest, deleteDocumentChunks } as never, failing, {} as never));
    const other = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => other.once('listening', resolve));
    const port = (other.address() as AddressInfo).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/rag/ingest`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ format: 'text', content: 'orphan text', collection: 'swarm-knowledge' }) });
      expect(res.status).toBe(500);
      expect(ingested).toHaveLength(1);
      expect(deleteDocumentChunks).toHaveBeenCalledWith('swarm-knowledge', ingested[0].metadata.knowledge_id);
    } finally { await new Promise<void>((resolve) => other.close(() => resolve())); }
  });

  it('answers 400 for a non-id, 404 for an unknown id, and keeps the record when the chunk removal fails', async () => {
    expect((await removeAs(OPERATOR, 'not-an-id')).status).toBe(400);
    expect((await removeAs(OPERATOR, '00000000-0000-4000-8000-000000000000')).status).toBe(404);
    await ingestAs(OPERATOR, {});
    const [doc] = await memory.listKnowledgeDocuments();
    deleteDocumentChunks.mockRejectedValueOnce(new Error('chroma down'));
    expect((await removeAs(OPERATOR, doc.knowledgeId)).status).toBe(500);
    expect(await memory.listKnowledgeDocuments()).toHaveLength(1);
    expect(governanceMocks.emitAuditEvent).not.toHaveBeenCalled();
  });
});
