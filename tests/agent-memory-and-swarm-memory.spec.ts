/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added tests for AgentMemoryService and SwarmMemoryService
 */

import { test, expect } from '@playwright/test';
import { RagService } from '../src/features/rag/services/rag-service';
import { AgentMemoryService } from '../src/features/agent-management/services/agent-memory-service';
import { SwarmMemoryService } from '../src/features/agent-management/services/swarm-memory-service';

// ─── Helpers ───────────────────────────────────────────────────────────

/** Builds a ChromaDB-compatible JSON response */
function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Tracks fetch calls for assertions */
interface FetchCall {
  url: string;
  method: string;
  body?: unknown;
}

// ─── ChromaDB mock state ───────────────────────────────────────────────

const CHROMA_URL = 'http://chromadb.test';

/** In-memory ChromaDB mock: stores documents per collection */
const mockCollections = new Map<string, {
  id: string;
  name: string;
  documents: Array<{ id: string; text: string; metadata: Record<string, string> }>;
}>();

function resetMockCollections() {
  mockCollections.clear();
}

function getOrCreateCollection(name: string) {
  if (!mockCollections.has(name)) {
    mockCollections.set(name, {
      id: `${name}-id`,
      name,
      documents: [],
    });
  }
  return mockCollections.get(name)!;
}

/**
 * Mock fetch that simulates ChromaDB REST API endpoints.
 * Supports: create/get collection, add documents, query documents.
 */
function createChromaFetchMock(fetchCalls: FetchCall[]) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method || 'GET';
    let body: unknown;
    if (init?.body) {
      try { body = JSON.parse(init.body as string); } catch { body = init.body; }
    }
    fetchCalls.push({ url, method, body });

    // POST /api/v1/collections — create or get collection
    if (url === `${CHROMA_URL}/api/v1/collections` && method === 'POST') {
      const reqBody = body as { name: string; get_or_create?: boolean };
      const col = getOrCreateCollection(reqBody.name);
      return jsonResponse({ id: col.id, name: col.name });
    }

    // GET /api/v1/collections — list all collections
    if (url === `${CHROMA_URL}/api/v1/collections` && method === 'GET') {
      const cols = Array.from(mockCollections.values()).map(c => ({ id: c.id, name: c.name }));
      return jsonResponse(cols);
    }

    // GET /api/v1/collections/{name} — get collection by name
    const getColMatch = url.match(new RegExp(`^${CHROMA_URL}/api/v1/collections/([\\w-]+)$`));
    if (getColMatch && method === 'GET') {
      const colName = getColMatch[1];
      // Could be by name or by ID
      const col = mockCollections.get(colName) ||
        Array.from(mockCollections.values()).find(c => c.id === colName);
      if (col) return jsonResponse({ id: col.id, name: col.name });
      return jsonResponse({ error: 'not found' }, 404);
    }

    // POST /api/v1/collections/{colId}/add — add documents
    const addMatch = url.match(new RegExp(`^${CHROMA_URL}/api/v1/collections/([\\w-]+)/add$`));
    if (addMatch && method === 'POST') {
      const colId = addMatch[1];
      const col = Array.from(mockCollections.values()).find(c => c.id === colId);
      if (!col) return jsonResponse({ error: 'not found' }, 404);

      const reqBody = body as { ids: string[]; documents: string[]; metadatas: Array<Record<string, string>> };
      for (let i = 0; i < reqBody.ids.length; i++) {
        col.documents.push({
          id: reqBody.ids[i],
          text: reqBody.documents[i],
          metadata: reqBody.metadatas?.[i] || {},
        });
      }
      return jsonResponse({ success: true });
    }

    // POST /api/v1/collections/{colId}/query — query documents
    const queryMatch = url.match(new RegExp(`^${CHROMA_URL}/api/v1/collections/([\\w-]+)/query$`));
    if (queryMatch && method === 'POST') {
      const colId = queryMatch[1];
      const col = Array.from(mockCollections.values()).find(c => c.id === colId);
      if (!col) return jsonResponse({ error: 'not found' }, 404);

      const reqBody = body as { query_texts: string[]; n_results: number };
      const queryText = (reqBody.query_texts?.[0] || '').toLowerCase();
      const nResults = reqBody.n_results || 5;

      // Simple keyword matching for test purposes
      const scored = col.documents.map(doc => {
        const text = doc.text.toLowerCase();
        let score = 0;
        const tokens = queryText.split(/\s+/).filter(t => t.length > 1);
        for (const token of tokens) {
          if (text.includes(token)) score += 1;
        }
        if (text.includes(queryText)) score += 5;
        return { doc, score };
      })
        .filter(s => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, nResults);

      return jsonResponse({
        ids: [scored.map(s => s.doc.id)],
        documents: [scored.map(s => s.doc.text)],
        metadatas: [scored.map(s => s.doc.metadata)],
        distances: [scored.map(s => 1 - s.score / 10)],
      });
    }

    // POST /api/v1/collections/{colId}/get — fetch documents (flat arrays). This is the
    // BM25 lexical-fallback path (rag-service lexicalSearch): under embed-init contention
    // (e.g. 4 parallel CI workers hitting one webServer while the MiniLM session warms)
    // the service LEGITIMATELY degrades to fetch-all + lexical scoring. The mock must
    // serve it — a real degraded-mode pass was redding as an "Unhandled" 404 in nightly CI.
    const getDocsMatch = url.match(new RegExp(`^${CHROMA_URL}/api/v1/collections/([\\w-]+)/get$`));
    if (getDocsMatch && method === 'POST') {
      const colId = getDocsMatch[1];
      const col = Array.from(mockCollections.values()).find(c => c.id === colId);
      if (!col) return jsonResponse({ error: 'not found' }, 404);
      const reqBody = (body ?? {}) as { limit?: number };
      const sliced = col.documents.slice(0, reqBody.limit ?? col.documents.length);
      return jsonResponse({
        ids: sliced.map(d => d.id),
        documents: sliced.map(d => d.text),
        metadatas: sliced.map(d => d.metadata),
      });
    }

    // Default: 404
    return jsonResponse({ error: `Unhandled: ${method} ${url}` }, 404);
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────

test.describe('AgentMemoryService', () => {
  let originalFetch: typeof global.fetch;
  let fetchCalls: FetchCall[];
  let ragService: RagService;
  let memoryService: AgentMemoryService;

  test.beforeEach(() => {
    resetMockCollections();
    fetchCalls = [];
    originalFetch = global.fetch;
    global.fetch = createChromaFetchMock(fetchCalls) as typeof global.fetch;
    process.env.CHROMADB_URL = CHROMA_URL;
    ragService = new RagService(CHROMA_URL);
    memoryService = new AgentMemoryService(ragService);
  });

  test.afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.CHROMADB_URL;
  });

  test('remember() stores a memory in the agent-specific collection', async () => {
    await memoryService.remember('test-agent', 'The database uses PostgreSQL 16', { category: 'infrastructure' });

    const col = mockCollections.get('agent-memory-test-agent');
    expect(col).toBeDefined();
    expect(col!.documents.length).toBeGreaterThan(0);
    expect(col!.documents[0].text).toContain('PostgreSQL 16');
    expect(col!.documents[0].metadata.agentId).toBe('test-agent');
    expect(col!.documents[0].metadata.type).toBe('memory');
    expect(col!.documents[0].metadata.category).toBe('infrastructure');
  });

  test('recall() retrieves relevant memories via semantic search', async () => {
    // Store some memories first
    await memoryService.remember('test-agent', 'PostgreSQL is the primary database');
    await memoryService.remember('test-agent', 'Redis is used for caching and mesh transport');
    await memoryService.remember('test-agent', 'ChromaDB stores vector embeddings');

    const results = await memoryService.recall('test-agent', 'database', 5);

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].text).toContain('database');
  });

  test('rememberBatch() stores multiple memories at once', async () => {
    await memoryService.rememberBatch('test-agent', [
      { text: 'Memory one about kubernetes', metadata: { topic: 'k8s' } },
      { text: 'Memory two about docker', metadata: { topic: 'containers' } },
      { text: 'Memory three about CI/CD pipelines' },
    ]);

    const col = mockCollections.get('agent-memory-test-agent');
    expect(col).toBeDefined();
    expect(col!.documents.length).toBe(3);
  });

  test('bootstrapKnowledge() loads domain docs into knowledge collection', async () => {
    const result = await memoryService.bootstrapKnowledge('test-agent', [
      { title: 'PostgreSQL Basics', content: 'PostgreSQL is an advanced relational database...', source: 'docs', category: 'database' },
      { title: 'Redis Guide', content: 'Redis is an in-memory data structure store...', source: 'docs', category: 'cache' },
    ]);

    expect(result.collectionName).toBe('agent-knowledge-test-agent');
    expect(result.sourcesProcessed).toBe(2);
    expect(result.totalChunks).toBeGreaterThanOrEqual(2);
    expect(result.errors).toHaveLength(0);

    const col = mockCollections.get('agent-knowledge-test-agent');
    expect(col).toBeDefined();
    expect(col!.documents.length).toBe(2);
    expect(col!.documents[0].metadata.type).toBe('knowledge');
    expect(col!.documents[0].metadata.title).toBe('PostgreSQL Basics');
  });

  test('queryKnowledge() searches the knowledge collection', async () => {
    await memoryService.bootstrapKnowledge('test-agent', [
      { title: 'K8s Guide', content: 'Kubernetes orchestrates container deployments at scale' },
    ]);

    const results = await memoryService.queryKnowledge('test-agent', 'kubernetes container', 3);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].text).toContain('Kubernetes');
  });

  test('recallAll() merges memory + knowledge results', async () => {
    await memoryService.remember('test-agent', 'We deployed the app using kubernetes helm charts');
    await memoryService.bootstrapKnowledge('test-agent', [
      { title: 'K8s Reference', content: 'Kubernetes pods run inside nodes in a cluster' },
    ]);

    const results = await memoryService.recallAll('test-agent', 'kubernetes', 5);
    expect(results.length).toBeGreaterThan(0);
    // Results should come from both collections
  });

  test('getCollectionNames() returns correct collection naming', () => {
    const names = memoryService.getCollectionNames('my-bot');
    expect(names.memory).toBe('agent-memory-my-bot');
    expect(names.knowledge).toBe('agent-knowledge-my-bot');
  });

  test('agents have isolated collections — no cross-contamination', async () => {
    await memoryService.remember('agent-a', 'Agent A secret data');
    await memoryService.remember('agent-b', 'Agent B secret data');

    const colA = mockCollections.get('agent-memory-agent-a');
    const colB = mockCollections.get('agent-memory-agent-b');

    expect(colA).toBeDefined();
    expect(colB).toBeDefined();
    expect(colA!.documents.length).toBe(1);
    expect(colB!.documents.length).toBe(1);
    expect(colA!.documents[0].text).toContain('Agent A');
    expect(colB!.documents[0].text).toContain('Agent B');
  });
});

test.describe('SwarmMemoryService', () => {
  let originalFetch: typeof global.fetch;
  let fetchCalls: FetchCall[];
  let ragService: RagService;
  let swarmMemory: SwarmMemoryService;

  test.beforeEach(() => {
    resetMockCollections();
    fetchCalls = [];
    originalFetch = global.fetch;
    global.fetch = createChromaFetchMock(fetchCalls) as typeof global.fetch;
    process.env.CHROMADB_URL = CHROMA_URL;
    ragService = new RagService(CHROMA_URL);
    swarmMemory = new SwarmMemoryService(ragService);
  });

  test.afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.CHROMADB_URL;
  });

  test('extractAndStore() stores learnings from completed work', async () => {
    const stored = await swarmMemory.extractAndStore({
      workItemId: 'wi-001',
      title: 'Implement user authentication',
      agentId: 'code-developer',
      executionOutput: '## What Worked\n- JWT tokens with RS256 signing\n- Redis session store\n\n## Challenges\n- CORS configuration was tricky\n\n## Key Learnings\n- Always set SameSite=Strict on auth cookies',
    });

    expect(stored).toBe(true);

    const col = mockCollections.get('swarm-memory');
    expect(col).toBeDefined();
    expect(col!.documents.length).toBeGreaterThan(0);

    // The document may be chunked — join all chunk texts for content assertions
    const allText = col!.documents.map(d => d.text).join(' ');
    expect(allText).toContain('Implement user authentication');
    expect(allText).toContain('JWT tokens');
    expect(allText).toContain('CORS configuration');
    expect(allText).toContain('SameSite=Strict');
    // Metadata is on every chunk
    expect(col!.documents[0].metadata.workItemId).toBe('wi-001');
    expect(col!.documents[0].metadata.agentId).toBe('code-developer');
    expect(col!.documents[0].metadata.type).toBe('swarm-learning');
  });

  test('extractAndStore() is idempotent — skips duplicate work items', async () => {
    const first = await swarmMemory.extractAndStore({
      workItemId: 'wi-002',
      title: 'Setup CI pipeline',
      agentId: 'devops-bot',
      executionOutput: 'Pipeline configured with GitHub Actions',
    });

    const second = await swarmMemory.extractAndStore({
      workItemId: 'wi-002',
      title: 'Setup CI pipeline',
      agentId: 'devops-bot',
      executionOutput: 'Pipeline configured with GitHub Actions',
    });

    expect(first).toBe(true);
    expect(second).toBe(false); // Idempotent skip

    const col = mockCollections.get('swarm-memory');
    expect(col!.documents.length).toBe(1); // Only stored once
  });

  test('extractAndStore() handles unstructured output as fallback', async () => {
    const stored = await swarmMemory.extractAndStore({
      workItemId: 'wi-003',
      title: 'Fix login bug',
      agentId: 'code-developer',
      executionOutput: 'Fixed the null pointer exception in the login handler by adding a guard clause for undefined session tokens.',
    });

    expect(stored).toBe(true);

    const col = mockCollections.get('swarm-memory');
    const doc = col!.documents[0];
    // Should contain the raw output as a key learning (fallback)
    expect(doc.text).toContain('null pointer exception');
  });

  test('queryRelevant() finds relevant past experiences', async () => {
    await swarmMemory.extractAndStore({
      workItemId: 'wi-010',
      title: 'Setup PostgreSQL database migrations',
      agentId: 'code-developer',
      executionOutput: '## Key Learnings\n- Use numbered migration files\n- Always include rollback scripts\n- Test migrations on a fresh database',
    });

    await swarmMemory.extractAndStore({
      workItemId: 'wi-011',
      title: 'Configure Kubernetes ingress',
      agentId: 'devops-bot',
      executionOutput: '## Key Learnings\n- Use nginx ingress controller\n- Set rate limiting annotations',
    });

    const results = await swarmMemory.queryRelevant('database migration', 3);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].text).toContain('migration');
  });

  test('queryRelevantContext() returns formatted prompt block', async () => {
    await swarmMemory.extractAndStore({
      workItemId: 'wi-020',
      title: 'Build REST API for user management',
      agentId: 'code-developer',
      executionOutput: '## Key Learnings\n- Use Zod for request validation\n- Return 409 for duplicate entries',
    });

    const context = await swarmMemory.queryRelevantContext(
      'Create REST API for project management',
      'Need CRUD endpoints for projects with validation',
    );

    expect(context.hasContent).toBe(true);
    expect(context.memoryCount).toBeGreaterThan(0);
    expect(context.promptBlock).toContain('Organizational Memory');
    expect(context.promptBlock).toContain('Past Experience');
    expect(context.promptBlock.toLowerCase()).toContain('rest api');
  });

  test('queryRelevantContext() returns empty block when no memories exist', async () => {
    const context = await swarmMemory.queryRelevantContext(
      'Something completely new',
      'No past experience exists',
    );

    // No memories stored, so either no collection or no matches
    expect(context.hasContent).toBe(false);
    expect(context.memoryCount).toBe(0);
    expect(context.promptBlock).toBe('');
  });

  test('getCollectionName() returns the shared collection name', () => {
    expect(swarmMemory.getCollectionName()).toBe('swarm-memory');
  });

  test('stores metadata including verification failures and escalations', async () => {
    await swarmMemory.extractAndStore({
      workItemId: 'wi-030',
      title: 'Complex data pipeline',
      agentId: 'code-developer',
      executionOutput: 'Implemented ETL pipeline',
      complexity: 'high',
      hadVerificationFailures: true,
      hadEscalations: true,
      categories: ['data', 'pipeline'],
    });

    const col = mockCollections.get('swarm-memory');
    const doc = col!.documents[0];
    expect(doc.metadata.complexity).toBe('high');
    expect(doc.metadata.hadVerificationFailures).toBe('true');
    expect(doc.metadata.hadEscalations).toBe('true');
    expect(doc.metadata.categories).toBe('data,pipeline');
  });
});

test.describe('AgentMemoryService + SwarmMemoryService integration', () => {
  let originalFetch: typeof global.fetch;
  let fetchCalls: FetchCall[];
  let ragService: RagService;
  let agentMemory: AgentMemoryService;
  let swarmMemory: SwarmMemoryService;

  test.beforeEach(() => {
    resetMockCollections();
    fetchCalls = [];
    originalFetch = global.fetch;
    global.fetch = createChromaFetchMock(fetchCalls) as typeof global.fetch;
    process.env.CHROMADB_URL = CHROMA_URL;
    ragService = new RagService(CHROMA_URL);
    agentMemory = new AgentMemoryService(ragService);
    swarmMemory = new SwarmMemoryService(ragService);
  });

  test.afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.CHROMADB_URL;
  });

  test('agent memory and swarm memory use separate collections', async () => {
    await agentMemory.remember('code-developer', 'Agent-specific memory about coding patterns');
    await swarmMemory.extractAndStore({
      workItemId: 'wi-100',
      title: 'Shared learning about deployment',
      agentId: 'code-developer',
      executionOutput: 'Deployment went smoothly with blue-green strategy',
    });

    // Should have 3 distinct collections (memory, knowledge is not created until used, swarm)
    expect(mockCollections.has('agent-memory-code-developer')).toBe(true);
    expect(mockCollections.has('swarm-memory')).toBe(true);

    // Agent memory collection only has agent memories
    const agentCol = mockCollections.get('agent-memory-code-developer')!;
    expect(agentCol.documents.every(d => d.metadata.type === 'memory')).toBe(true);

    // Swarm memory collection only has swarm learnings
    const swarmCol = mockCollections.get('swarm-memory')!;
    expect(swarmCol.documents.every(d => d.metadata.type === 'swarm-learning')).toBe(true);
  });

  test('full lifecycle: create agent → bootstrap knowledge → execute → store swarm learning → recall', async () => {
    const agentId = 'kubernetes-ops';

    // 1. Bootstrap knowledge at agent creation time
    const bootstrap = await agentMemory.bootstrapKnowledge(agentId, [
      { title: 'K8s Basics', content: 'Kubernetes uses pods, services, and deployments', category: 'k8s' },
    ]);
    expect(bootstrap.sourcesProcessed).toBe(1);

    // 2. Agent stores runtime memories during execution
    await agentMemory.remember(agentId, 'Discovered that the cluster uses Istio service mesh');

    // 3. After task completion, store learning in shared swarm memory
    const stored = await swarmMemory.extractAndStore({
      workItemId: 'wi-200',
      title: 'Scale web tier to handle Black Friday traffic',
      agentId,
      executionOutput: '## What Worked\n- HPA with custom metrics\n- Pod disruption budgets prevented cascading failures\n\n## Key Learnings\n- Pre-scale 2 hours before expected peak',
      complexity: 'high',
      categories: ['kubernetes', 'scaling'],
    });
    expect(stored).toBe(true);

    // 4. Future ticket arrives — query swarm memory for relevant context
    const context = await swarmMemory.queryRelevantContext(
      'Scale API tier for holiday traffic',
      'Need to prepare infrastructure for expected 10x traffic spike',
    );
    expect(context.hasContent).toBe(true);
    expect(context.promptBlock.toLowerCase()).toContain('scale');

    // 5. Agent can also recall its own memories
    const ownMemories = await agentMemory.recallAll(agentId, 'Istio service mesh', 3);
    expect(ownMemories.length).toBeGreaterThan(0);
  });
});
