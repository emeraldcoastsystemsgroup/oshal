/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added agent-memory and knowledge-memory list routes for non-swarm memory layers
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added knowledge-memory summary route for the native RAG Center engineering surface
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Operator-gated all memory listing routes. These return agent memories (by well-known agentId) and the platform-wide knowledge-document catalog, which can include other users' conversational context and ingested sources — previously readable by any authenticated user. Now require operator privilege (requireOperator → 403).
 */

import { Router, type Request, type Response } from 'express';
import { createChildLogger } from '@/shared/logger';
import { isOperator, requireOperator } from '@/shared/middleware/authz';
import type { AppContext } from '../composition-root';

const logger = createChildLogger({ module: 'memory-routes' });

/**
 * @description Creates read-only memory listing routes for agent and knowledge memory.
 *
 * @param ctx - Application context
 * @returns Router for memory listing endpoints
 */
export function createMemoryRoutes(ctx: AppContext): Router {
  const router = Router();
  router.get('/agents/:agentId', handleListAgentMemories(ctx));
  router.get('/knowledge/summary', handleKnowledgeSummary(ctx));
  router.get('/knowledge', handleListKnowledgeMemory(ctx));
  logger.info('Memory routes registered');
  return router;
}

function handleListAgentMemories(ctx: AppContext) {
  return async (req: Request, res: Response): Promise<void> => {
    if (!requireOperator(req, res)) return;
    const agentId = String(req.params.agentId);
    const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : undefined;
    logger.info({ agentId, limit }, 'GET /api/memory/agents/:agentId');
    try {
      const memories = await ctx.memoryService.listAgentMemories(agentId, limit);
      res.json({ memories, count: memories.length });
    } catch (error) {
      logger.error({ err: error, agentId }, 'Failed to list agent memories');
      res.status(500).json({ error: 'Failed to list agent memories' });
    }
  };
}

function handleListKnowledgeMemory(ctx: AppContext) {
  return async (req: Request, res: Response): Promise<void> => {
    if (!isOperator(req) && req.query.surface === '1') {
      res.json({
        documents: [],
        count: 0,
        restricted: true,
        error: 'operator_required',
        message: 'Operator privilege is required to inspect platform knowledge memory.',
      });
      return;
    }
    if (!requireOperator(req, res)) return;
    const collection = typeof req.query.collection === 'string' ? req.query.collection : undefined;
    const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : undefined;
    logger.info({ collection, limit }, 'GET /api/memory/knowledge');
    try {
      const documents = await ctx.memoryService.listKnowledgeDocuments({ collection, limit });
      res.json({ documents, count: documents.length });
    } catch (error) {
      logger.error({ err: error, collection }, 'Failed to list knowledge memory');
      res.status(500).json({ error: 'Failed to list knowledge memory' });
    }
  };
}

function handleKnowledgeSummary(ctx: AppContext) {
  return async (req: Request, res: Response): Promise<void> => {
    if (!isOperator(req) && req.query.surface === '1') {
      res.json({
        ...buildKnowledgeSummary([]),
        restricted: true,
        error: 'operator_required',
        message: 'Operator privilege is required to inspect platform knowledge memory.',
      });
      return;
    }
    if (!requireOperator(req, res)) return;
    logger.info('GET /api/memory/knowledge/summary');
    try {
      const documents = await ctx.memoryService.listKnowledgeDocuments();
      res.json(buildKnowledgeSummary(documents));
    } catch (error) {
      logger.error({ err: error }, 'Failed to build knowledge memory summary');
      res.status(500).json({ error: 'Failed to build knowledge memory summary' });
    }
  };
}

function buildKnowledgeSummary(documents: Array<Record<string, unknown>>) {
  const collections = new Map<string, { collection: string; documents: number; chunks: number; latest: string }>();
  let sharedDocuments = 0;
  let targetedDocuments = 0;
  let totalChunks = 0;

  for (const document of documents) {
    const collectionName = typeof document.collection === 'string' ? document.collection : 'unknown';
    const chunkCount = typeof document.chunkCount === 'number' ? document.chunkCount : 0;
    const createdAt = typeof document.createdAt === 'string' ? document.createdAt : '';
    const hasAgentScope = typeof document.agentId === 'string' && document.agentId.trim().length > 0;

    totalChunks += chunkCount;
    if (hasAgentScope) {
      targetedDocuments += 1;
    } else {
      sharedDocuments += 1;
    }

    const existing = collections.get(collectionName);
    if (!existing) {
      collections.set(collectionName, {
        collection: collectionName,
        documents: 1,
        chunks: chunkCount,
        latest: createdAt,
      });
      continue;
    }

    existing.documents += 1;
    existing.chunks += chunkCount;
    if (createdAt > existing.latest) {
      existing.latest = createdAt;
    }
  }

  return {
    totals: {
      documents: documents.length,
      collections: collections.size,
      chunks: totalChunks,
      sharedDocuments,
      targetedDocuments,
    },
    collections: [...collections.values()].sort((left, right) => right.latest.localeCompare(left.latest)),
  };
}
