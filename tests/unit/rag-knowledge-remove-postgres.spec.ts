/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-174 Amendment B guards (step B5-6, shared knowledge) on a private pgvector PostgreSQL: the pgvector engine's deleteByKnowledgeId removes exactly the chunks whose metadata carries the id (other documents' chunks and untagged chunks stay, and the collection survives), and the memory layer in Postgres mode stores a record under the id the route minted, reads it back by id, deletes it by id returning it, and answers null for a second delete. Each fails on the tree before the fix.
 */

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DisposablePostgres } from '../helpers/disposable-postgres';

const databaseMocks = vi.hoisted(() => ({ createOptionalPostgresPool: vi.fn((): Pool | null => null) }));
vi.mock('@/shared/services/database', async (importOriginal) => ({ ...await importOriginal<object>(), ...databaseMocks }));

import { _setRagPoolForTests, pgvectorRagEngine } from '@/features/rag/services/pgvector-rag-engine';
import { MemoryLayerService } from '@/features/memory/services/memory-layer-service';

const database = new DisposablePostgres({ purpose: 'rag-knowledge-remove', image: 'pgvector/pgvector:pg16', migrations: ['070-rag-chunks-pgvector.sql'], max: 4 });
let pool: Pool;

beforeAll(async () => {
  pool = await database.start();
  _setRagPoolForTests(pool);
  databaseMocks.createOptionalPostgresPool.mockReturnValue(pool);
}, 180_000);
afterAll(async () => { _setRagPoolForTests(null); await database.stop(); });

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

describe('pgvector deleteByKnowledgeId', () => {
  it('removes exactly the tagged document\'s chunks and leaves the rest of the collection', async () => {
    const rows: Array<[string, string, Record<string, string>]> = [
      ['a-0', 'swarm-knowledge', { knowledge_id: A, chunkIndex: '0' }],
      ['a-1', 'swarm-knowledge', { knowledge_id: A, chunkIndex: '1' }],
      ['b-0', 'swarm-knowledge', { knowledge_id: B, chunkIndex: '0' }],
      ['old-0', 'swarm-knowledge', { chunkIndex: '0' }],
      ['a-other', 'another-collection', { knowledge_id: A, chunkIndex: '0' }],
    ];
    for (const [id, collection, metadata] of rows) {
      await pool.query('INSERT INTO rag_chunks (chunk_id, collection, document, metadata) VALUES ($1, $2, $3, $4::jsonb)', [id, collection, `text ${id}`, JSON.stringify(metadata)]);
    }
    expect(await pgvectorRagEngine.deleteByKnowledgeId('swarm-knowledge', A)).toBe(2);
    const left = await pool.query('SELECT chunk_id FROM rag_chunks ORDER BY chunk_id');
    expect(left.rows.map((r) => r.chunk_id)).toEqual(['a-other', 'b-0', 'old-0']);
    expect(await pgvectorRagEngine.deleteByKnowledgeId('swarm-knowledge', A)).toBe(0);
    expect(await pgvectorRagEngine.deleteByKnowledgeId('swarm-knowledge', '33333333-3333-4333-8333-333333333333')).toBe(0);
  });
});

describe('the memory layer in Postgres mode', () => {
  it('stores a record under the minted id, reads it by id, deletes it by id and returns it once', async () => {
    const memory = new MemoryLayerService({} as never, {} as never);
    const stored = await memory.recordKnowledgeDocument({ knowledgeId: A, collection: 'swarm-knowledge', title: 'Shared notes', source: 'ingest-api', chunkCount: 2, documentCount: 1, metadata: { chunksTagged: true } });
    expect(stored.knowledgeId).toBe(A);
    const check = await pool.query('SELECT knowledge_id, owner_sub FROM knowledge_memory_documents WHERE knowledge_id = $1::uuid', [A]);
    expect(check.rows).toEqual([{ knowledge_id: A, owner_sub: null }]);
    expect((await memory.getKnowledgeDocument(A))?.title).toBe('Shared notes');
    expect(await memory.getKnowledgeDocument(B)).toBeNull();
    const deleted = await memory.deleteKnowledgeDocument(A);
    expect(deleted?.knowledgeId).toBe(A);
    expect(deleted?.metadata.chunksTagged).toBe(true);
    expect(await memory.deleteKnowledgeDocument(A)).toBeNull();
    expect(await memory.getKnowledgeDocument(A)).toBeNull();
  });
});
