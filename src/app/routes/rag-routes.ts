/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial RAG API routes: upload, search, health
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added /api/rag/ingest JSON endpoint for tool-compatible inline ingestion payloads
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added vector embedding model catalog endpoint for RAG popup provider/model selection
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Added optional knowledge-memory recording on upload and ingest routes
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Added collections listing endpoint and all-collections search support for the chat RAG popup
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Enforce permission-aware retrieval: build caller context for /search; stamp owner_sub on private ingest/upload so ACL-tagged chunks are caller-scoped while shared corpus stays public
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Source-ACL sync: carry the caller's email + source-ACL groups (public:anyone, domain:<domain>) in the retrieval context so native by-email/domain/anyone source shares resolve; ragAclFromConnection now layers a document's native source permissions (via the source-acl-mapper) over the connection baseline
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | ADR-091: DELETE /api/rag/collections/:name — engine-agnostic collection drop for reseeds (the LM demo seeder used raw Chroma REST, which the pgvector engine has no equivalent for); auth rides the /api/rag mount
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | Stamp ownerSub on catalog records for private ingest; add permission-aware GET /api/rag/knowledge (operator sees all; a user sees shared swarm + per-bot + their own private) powering the Settings RAG visibility surface. Owner sub exposed to operators only
 * 10 | maintainer@emeraldcoastsystemsgroup.com   | Multi-user regression fix (adversarial review of migration 094): a non-operator's DEFAULT (non-private) ingest stamped owner_sub NULL, which the new FORCE-RLS WITH CHECK rejects (500 after Chroma already ingested — orphan chunks). ownerSubForIngest now returns NULL only for an OPERATOR's shared-corpus write; every non-operator ingest is owned-by-caller, so it passes the owner arm AND stops polluting the shared corpus everyone's bots read. Explicit private:true still owns the row.
 */

import { Router, type Request } from 'express';
import type { Pool } from 'pg';
import multer from 'multer';
import { createChildLogger } from '@/shared/logger';
import { RagService, sourceAclGroupsForCaller, sourceAclToRagAcl, type RagPermissionContext } from '@/features/rag';
import { callerFromRequest, resolveRole, Role } from '@/features/governance';
import { getUserTenantIds } from './connector-tenancy';
import { classifyKnowledgeScope, type MemoryLayerService } from '@/features/memory';

const logger = createChildLogger({ module: 'rag-routes' });

/**
 * @description A caller's tenant (household) membership modeled as a RAG "group", so a document
 * shared through a tenant connector grants read access to that tenant's members and denies
 * everyone else — the same mechanism connector-source ACL sync needs.
 */
export function tenantGroup(tenantId: string): string {
  return `tenant:${String(tenantId).trim()}`;
}

/**
 * @description Build the caller's RAG permission context from the request OIDC session. Shared
 * (unowned) corpus stays readable because allowPublic is true; chunks tagged with owner_sub /
 * allowed_users / allowed_groups / tenant_id are then restricted to the caller. Token roles are
 * treated as the caller's groups for group-grant matching; operators see everything.
 *
 * @param req - The Express request carrying the OIDC session.
 * @returns A permission context for RagService.search.
 */
async function ragContextFromRequest(req: Request, pool?: Pool | null): Promise<RagPermissionContext> {
  const caller = callerFromRequest(req);
  const groups = [...(caller.roles ?? [])];
  // Add the caller's tenant memberships as groups so tenant-shared chunks are readable by members.
  if (pool && caller.sub) {
    try {
      for (const tenantId of await getUserTenantIds(pool, caller.sub)) groups.push(tenantGroup(tenantId));
    } catch {
      /* tenancy schema unavailable — fall back to token-role groups only */
    }
  }
  // Source-ACL groups the caller carries by identity: the well-known public:anyone group (any
  // signed-in user) and their email-domain group, so `anyone`- and `domain`-shared source docs
  // resolve without a directory pre-sync. Their verified email lets native by-email source shares
  // (a Drive file shared to their address) match without resolving email->sub first.
  for (const g of sourceAclGroupsForCaller(caller.email)) groups.push(g);
  return {
    userSub: caller.sub ?? '',
    emails: caller.email ? [caller.email] : [],
    groups,
    isOperator: resolveRole(caller) === Role.Admin,
    allowPublic: true,
  };
}

/**
 * @description Resolve the owner sub to stamp on an ingested document's catalog row.
 *
 * A NULL owner = a SHARED corpus document every user's bots can read. Since migration
 * 094 forces RLS on knowledge_memory_documents, only an OPERATOR may mint a shared
 * (NULL-owner) row — a non-operator's default ingest is stamped owned-by-them so it
 * (a) passes the WITH CHECK owner arm instead of 500-ing after Chroma already ingested,
 * and (b) doesn't pollute the shared corpus everyone reads. Explicit `private:true`
 * always owns the row. So: operator + not-private → shared (NULL); everyone else, and
 * anyone asking for private → owned by the caller.
 *
 * @param req - The Express request (OIDC session + body).
 * @returns NULL for an operator's shared-corpus write; otherwise the caller's sub.
 */
function ownerSubForIngest(req: Request): string | null {
  const body = (req.body ?? {}) as { private?: unknown; visibility?: unknown };
  const wantsPrivate = body.private === true
    || body.private === 'true'
    || (typeof body.visibility === 'string' && body.visibility.toLowerCase() === 'private');
  const caller = callerFromRequest(req);
  const isOperator = resolveRole(caller) === Role.Admin;
  // Only an operator may write a shared (NULL-owner) corpus document, and only when not
  // explicitly private. Everyone else's ingest — and any explicit private ingest — is owned.
  if (isOperator && !wantsPrivate) {
    return null;
  }
  return caller.sub ?? null;
}

/**
 * @description Build the ACL metadata to stamp on ingested chunks from a request body plus the
 * resolved owner sub: `owner_sub` (private ingest), and `allowed_groups` / `allowed_users` /
 * `tenant_id` from the body. These are exactly the fields the retrieval permission filter reads,
 * so ingesting with them enables group- and tenant-scoped sharing, not just owner-private. Lists
 * are normalized to comma strings to match the string metadata store and the filter's comma-split
 * parsing; the filter lowercases at compare time, so casing is preserved here. Pure and testable.
 *
 * @param body - The ingest request body.
 * @param ownerSub - The resolved owner sub (or null for shared/public ingest).
 * @returns ACL metadata record with only the fields that were provided.
 */
export function ragAclFromBody(body: Record<string, unknown>, ownerSub: string | null): Record<string, string> {
  const acl: Record<string, string> = {};
  if (ownerSub) acl.owner_sub = ownerSub;
  const groups = normalizeAclList(body.allowedGroups ?? body.allowed_groups).split(',').filter(Boolean);
  const users = normalizeAclList(body.allowedUsers ?? body.allowed_users);
  // A tenant share is expressed as a `tenant:<id>` group so it GRANTS to members (a bare tenant_id
  // only narrows). Combined with the caller's tenant-group memberships this reads back correctly.
  const tenant = firstNonEmptyString(body.tenantId, body.tenant_id);
  if (tenant) groups.push(tenantGroup(tenant));
  if (groups.length) acl.allowed_groups = groups.join(',');
  if (users) acl.allowed_users = users;
  return acl;
}

/**
 * @description Derive ingest ACL from the SOURCE connection a document came through — the
 * connector-source ACL sync primitive. A tenant-shared connection (tenant_id set) grants to that
 * tenant's members via a `tenant:<id>` group; a personal connection grants to its owner. Pure.
 *
 * @param connection - The source connection row (tenant_id + owner subs).
 * @returns ACL metadata to stamp on chunks ingested from that connection.
 */
export function ragAclFromConnection(
  connection: { tenant_id?: string | null; user_sub?: string | null; connected_by_sub?: string | null },
  source?: { provider: string; nativePermissions: unknown } | null,
): Record<string, string> {
  const tenantId = connection.tenant_id ? String(connection.tenant_id).trim() : '';
  const owner = String(connection.connected_by_sub || connection.user_sub || '').trim();
  const base: Record<string, string> = tenantId
    ? { allowed_groups: tenantGroup(tenantId) }
    : owner
      ? { owner_sub: owner }
      : {};
  if (!source) return base;
  // A per-document native source ACL (the file's OWN share list) layers on top of the connection
  // baseline: the owner/tenant still applies, and the source's users/groups/domains are unioned in
  // so the chunk inherits the source system's real access rules, not just who connected the account.
  const sourceAcl = sourceAclToRagAcl(source.provider, source.nativePermissions, tenantId ? null : owner);
  return mergeAclRecords(base, sourceAcl);
}

/** @description Union two chunk ACL records — owner_sub from either, allowed_users/allowed_groups merged as de-duped comma lists. */
function mergeAclRecords(a: Record<string, string>, b: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  const owner = a.owner_sub || b.owner_sub;
  if (owner) out.owner_sub = owner;
  const users = unionCsv(a.allowed_users, b.allowed_users);
  if (users) out.allowed_users = users;
  const groups = unionCsv(a.allowed_groups, b.allowed_groups);
  if (groups) out.allowed_groups = groups;
  return out;
}

/** @description Union comma-separated ACL token lists, trimming and de-duplicating; returns a comma string. */
function unionCsv(...values: Array<string | undefined>): string {
  const set = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    for (const part of value.split(',')) {
      const token = part.trim();
      if (token) set.add(token);
    }
  }
  return [...set].join(',');
}

/** @description Resolve ingest ACL metadata from an Express request (owner sub + body ACL fields). */
function ragAclFromRequest(req: Request): Record<string, string> {
  return ragAclFromBody((req.body ?? {}) as Record<string, unknown>, ownerSubForIngest(req));
}

function normalizeAclList(value: unknown): string {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return raw.map((item) => String(item).trim()).filter(Boolean).join(',');
}

function firstNonEmptyString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
const VECTOR_MODEL_CATALOG = [
  {
    providerId: 'openai',
    providerName: 'OpenAI',
    models: [
      { id: 'text-embedding-3-large', displayName: 'text-embedding-3-large' },
      { id: 'text-embedding-3-small', displayName: 'text-embedding-3-small' },
      { id: 'text-embedding-ada-002', displayName: 'text-embedding-ada-002' },
    ],
  },
  {
    providerId: 'google',
    providerName: 'Google',
    models: [
      { id: 'text-embedding-004', displayName: 'text-embedding-004' },
      { id: 'gemini-embedding-001', displayName: 'gemini-embedding-001' },
    ],
  },
  {
    providerId: 'cohere',
    providerName: 'Cohere',
    models: [
      { id: 'embed-v4.0', displayName: 'embed-v4.0' },
      { id: 'embed-english-v3.0', displayName: 'embed-english-v3.0' },
    ],
  },
  {
    providerId: 'voyage',
    providerName: 'Voyage',
    models: [
      { id: 'voyage-3-large', displayName: 'voyage-3-large' },
      { id: 'voyage-3', displayName: 'voyage-3' },
    ],
  },
  {
    providerId: 'local',
    providerName: 'Local / OSS',
    models: [
      { id: 'bge-m3', displayName: 'bge-m3' },
      { id: 'e5-large-v2', displayName: 'e5-large-v2' },
      { id: 'nomic-embed-text', displayName: 'nomic-embed-text' },
    ],
  },
];

/**
 * @description Convert arbitrary metadata payload values into string fields for RagService storage.
 *
 * @param value - Raw request metadata payload.
 * @returns String-keyed metadata record.
 */
function normalizeMetadataRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const metadata: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (raw === null || raw === undefined) {
      continue;
    }
    if (typeof raw === 'string') {
      metadata[key] = raw;
      continue;
    }
    try {
      metadata[key] = JSON.stringify(raw);
    } catch (error) {
      logger.error({ err: error, key }, 'Failed to stringify RAG metadata value');
      metadata[key] = String(raw);
    }
  }
  return metadata;
}

/**
 * @description Creates Express router for RAG API endpoints.
 * @param ragService - Injected RagService instance.
 * @returns Express Router with RAG routes.
 */
export function createRagRoutes(ragService: RagService, memoryService?: MemoryLayerService, pool?: Pool | null): Router {
  const router = Router();

  /**
   * @openapi
   * /api/rag/upload:
   *   post:
   *     summary: Upload and ingest files into RAG
   *     tags: [RAG]
   */
  router.post('/upload', upload.array('files', 20), async (req, res) => {
    logger.info({ fileCount: (req.files as Express.Multer.File[])?.length ?? 0 }, 'POST /api/rag/upload');
    try {
      const files = req.files as Express.Multer.File[];
      if (!files || files.length === 0) {
        logger.warn('No files provided for RAG upload');
        res.status(400).json({ error: 'No files provided' });
        return;
      }

      const collection = (req.body?.collection as string) || 'default';
      const texts = files.map(f => f.buffer.toString('utf-8'));
      const acl = ragAclFromRequest(req);
      const result = await ragService.ingest(texts, collection, {
        source: 'upload',
        uploadedAt: new Date().toISOString(),
        ...acl,
      });
      if (memoryService) {
        await memoryService.recordKnowledgeDocument({
          agentId: typeof req.body?.agentId === 'string' ? req.body.agentId : undefined,
          taskId: typeof req.body?.taskId === 'string' ? req.body.taskId : undefined,
          ownerSub: acl.owner_sub || undefined,
          collection,
          title: files.map((file) => file.originalname).join(', ').slice(0, 255) || `Upload to ${collection}`,
          source: 'rag-upload',
          format: 'file-upload',
          chunkCount: result.chunkCount,
          documentCount: result.documentCount,
          metadata: {
            fileNames: files.map((file) => file.originalname),
            fileCount: files.length,
          },
        });
      }

      logger.info({ collection, chunkCount: result.chunkCount }, 'RAG upload complete');
      res.json({ success: true, count: result.documentCount, chunks: result.chunkCount, collection });
    } catch (err) {
      logger.error({ err }, 'RAG upload failed');
      res.status(500).json({ error: 'RAG ingestion failed' });
    }
  });

  /**
   * @openapi
   * /api/rag/ingest:
   *   post:
   *     summary: Ingest inline content payload into RAG
   *     tags: [RAG]
   */
  router.post('/ingest', async (req, res) => {
    logger.info('POST /api/rag/ingest');
    const format = typeof req.body?.format === 'string' ? req.body.format.trim() : '';
    const content = typeof req.body?.content === 'string' ? req.body.content : '';
    const collection = typeof req.body?.collection === 'string' && req.body.collection.trim().length > 0
      ? req.body.collection.trim()
      : 'default';
    const metadata = normalizeMetadataRecord(req.body?.metadata);

    if (format.length === 0 || content.trim().length === 0) {
      res.status(400).json({ error: 'Both "format" and non-empty "content" are required' });
      return;
    }

    try {
      const acl = ragAclFromRequest(req);
      const ownerSub = acl.owner_sub || metadata.owner_sub;
      const result = await ragService.ingest([content], collection, {
        ...metadata,
        format,
        source: metadata.source || 'ingest-api',
        ...acl,
        ...(ownerSub ? { owner_sub: ownerSub } : {}),
      });
      if (memoryService) {
        await memoryService.recordKnowledgeDocument({
          agentId: typeof req.body?.agentId === 'string' ? req.body.agentId.trim() || undefined : undefined,
          taskId: typeof req.body?.taskId === 'string' ? req.body.taskId.trim() || undefined : undefined,
          ownerSub: ownerSub || undefined,
          collection,
          title: deriveKnowledgeTitle(req.body?.title, content, collection),
          source: metadata.source || 'ingest-api',
          format,
          chunkCount: result.chunkCount,
          documentCount: result.documentCount,
          embeddingProviderId: metadata.embeddingProviderId,
          embeddingModelId: metadata.embeddingModelId,
          metadata,
        });
      }
      res.json({ success: true, ...result });
    } catch (err) {
      logger.error({ err }, 'RAG ingest endpoint failed');
      res.status(500).json({ error: 'RAG ingestion failed' });
    }
  });

  /**
   * @openapi
   * /api/rag/collections:
   *   get:
   *     summary: List known RAG collections
   *     tags: [RAG]
   */
  router.get('/collections', async (_req, res) => {
    logger.info('GET /api/rag/collections');
    try {
      const collections = await ragService.listCollections();
      res.json({ collections });
    } catch (err) {
      logger.error({ err }, 'RAG collections listing failed');
      res.status(500).json({ error: 'RAG collections listing failed' });
    }
  });

  /**
   * @openapi
   * /api/rag/knowledge:
   *   get:
   *     summary: List knowledge documents the caller may see (permission-aware RAG visibility)
   *     tags: [RAG]
   */
  router.get('/knowledge', async (req, res) => {
    const caller = callerFromRequest(req);
    const isOperator = resolveRole(caller) === Role.Admin;
    const collection = typeof req.query.collection === 'string' ? req.query.collection.trim() : '';
    const agentId = typeof req.query.agentId === 'string' ? req.query.agentId.trim() : '';
    const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 500;
    logger.info({ isOperator, collection, agentId }, 'GET /api/rag/knowledge');
    if (!memoryService) {
      res.json({ documents: [], count: 0, isOperator });
      return;
    }
    try {
      // The service scopes the rows: an operator sees every document; a normal caller sees shared
      // (swarm/bot) docs plus only their own private docs — so this route never leaks another
      // user's private knowledge into the visibility surface.
      const documents = await memoryService.listKnowledgeDocuments({
        collection: collection || undefined,
        agentId: agentId || undefined,
        limit: Number.isFinite(limit) && limit > 0 ? limit : 500,
        visibleTo: { callerSub: caller.sub ?? '', isOperator },
      });
      const view = documents.map((doc) => toKnowledgeView(doc, isOperator));
      res.json({ documents: view, count: view.length, isOperator });
    } catch (err) {
      logger.error({ err }, 'RAG knowledge listing failed');
      res.status(500).json({ error: 'RAG knowledge listing failed' });
    }
  });

  /**
   * @openapi
   * /api/rag/search:
   *   get:
   *     summary: Search RAG collection
   *     tags: [RAG]
   */
  router.get('/search', async (req, res) => {
    const query = req.query.q as string;
    const collection = typeof req.query.collection === 'string' ? req.query.collection.trim() : '';
    const topK = parseInt(req.query.topK as string, 10) || 5;
    logger.info({ query, collection, topK }, 'GET /api/rag/search');

    if (!query) {
      res.status(400).json({ error: 'Query parameter "q" is required' });
      return;
    }

    try {
      const context = await ragContextFromRequest(req, pool);
      const results = collection.length > 0
        ? await ragService.search(query, collection, topK, context)
        : await ragService.searchAllCollections(query, topK, context);
      res.json({ results, count: results.length, collection: collection || 'all' });
    } catch (err) {
      logger.error({ err }, 'RAG search failed');
      res.status(500).json({ error: 'RAG search failed' });
    }
  });

  /**
   * @openapi
   * /api/rag/collections/{name}:
   *   delete:
   *     summary: Drop a whole RAG collection (engine-agnostic reseed path)
   *     tags: [RAG]
   */
  router.delete('/collections/:name', async (req, res) => {
    const name = String(req.params.name || '');
    // Same character family the ingest side produces — blocks traversal/globs.
    if (!/^[a-zA-Z0-9._-]{1,128}$/.test(name)) {
      res.status(400).json({ error: 'invalid collection name' });
      return;
    }
    logger.info({ name }, 'DELETE /api/rag/collections/:name');
    try {
      await ragService.deleteCollection(name);
      res.json({ deleted: name });
    } catch (err: any) {
      logger.error({ err, name }, 'Collection delete failed');
      res.status(500).json({ error: 'collection delete failed' });
    }
  });

  /**
   * @openapi
   * /api/rag/health:
   *   get:
   *     summary: Check ChromaDB connectivity
   *     tags: [RAG]
   */
  router.get('/health', async (_req, res) => {
    logger.info('GET /api/rag/health');
    const ok = await ragService.healthCheck();
    res.json({ chromadb: ok ? 'connected' : 'unreachable' });
  });

  /**
   * @openapi
   * /api/rag/embedding-models:
   *   get:
   *     summary: List vector embedding providers/models for RAG configuration UI
   *     tags: [RAG]
   */
  router.get('/embedding-models', (_req, res) => {
    logger.info('GET /api/rag/embedding-models');
    res.json({ providers: VECTOR_MODEL_CATALOG });
  });

  logger.info('RAG routes registered');
  return router;
}

/**
 * @description Build a stable knowledge-memory title from request input or ingested content.
 *
 * @param requestedTitle - Optional explicit request title
 * @param content - Ingested raw content
 * @param collection - Target collection name
 * @returns Short document title
 */
/**
 * @description Project one stored knowledge document into the safe shape the Settings RAG
 * visibility surface renders: scope classification (swarm/bot/private), collection, counts, and
 * timestamps. The owner sub is exposed ONLY to operators — a normal caller only ever receives
 * shared docs plus their own, so their private docs are self-evident without leaking any sub.
 *
 * @param doc - The stored knowledge document.
 * @param isOperator - Whether the caller is an operator (controls owner-sub exposure).
 * @returns A UI-safe knowledge document view.
 */
function toKnowledgeView(
  doc: {
    knowledgeId: string;
    title: string;
    collection: string;
    source: string;
    format?: string;
    agentId?: string;
    ownerSub?: string;
    chunkCount?: number;
    documentCount?: number;
    createdAt: string;
  },
  isOperator: boolean,
): Record<string, unknown> {
  return {
    knowledgeId: doc.knowledgeId,
    title: doc.title,
    collection: doc.collection,
    source: doc.source,
    format: doc.format ?? null,
    scope: classifyKnowledgeScope(doc),
    agentId: doc.agentId ?? null,
    ownerSub: isOperator ? doc.ownerSub ?? null : null,
    chunkCount: doc.chunkCount ?? 0,
    documentCount: doc.documentCount ?? 0,
    createdAt: doc.createdAt,
  };
}

function deriveKnowledgeTitle(requestedTitle: unknown, content: string, collection: string): string {
  if (typeof requestedTitle === 'string' && requestedTitle.trim().length > 0) {
    return requestedTitle.trim().slice(0, 255);
  }
  const firstLine = content
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return (firstLine || `Knowledge document for ${collection}`).slice(0, 255);
}
