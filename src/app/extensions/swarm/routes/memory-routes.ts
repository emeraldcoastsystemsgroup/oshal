/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added memory API routes — per-agent memory + shared swarm memory
 */

import { Router, type Request, type Response } from 'express';
import type { AgentMemoryService } from '@/features/agent-management';
import type { SwarmMemoryService } from '@/features/agent-management';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'swarm-memory-routes' });

/**
 * @description Creates routes for per-agent memory and shared swarm memory.
 * @param agentMemory - AgentMemoryService instance
 * @param swarmMemory - SwarmMemoryService instance
 * @returns Express router
 */
export function createMemoryRoutes(
  agentMemory: AgentMemoryService,
  swarmMemory: SwarmMemoryService,
): Router {
  const router = Router();

  // ─── Per-Agent Memory ────────────────────────────────────────────────

  /**
   * POST /api/swarm/memory/agents/:agentId/remember — Store a memory for an agent.
   * Body: { text: string, metadata?: Record<string, string> }
   */
  router.post('/agents/:agentId/remember', async (req: Request, res: Response) => {
    const startedAt = Date.now();
    logger.info({ agentId: req.params.agentId }, 'POST /api/swarm/memory/agents/:agentId/remember');
    try {
      const { text, metadata } = req.body;
      if (!text) {
        logger.warn({ agentId: req.params.agentId, durationMs: Date.now() - startedAt }, 'POST /api/swarm/memory/agents/:agentId/remember missing text');
        res.status(400).json({ error: 'text is required' });
        return;
      }
      await agentMemory.remember(req.params.agentId as string, text, metadata);
      logger.info({ agentId: req.params.agentId, durationMs: Date.now() - startedAt }, 'POST /api/swarm/memory/agents/:agentId/remember complete');
      res.status(201).json({ stored: true, agentId: req.params.agentId });
    } catch (error) {
      logger.error({ err: error, agentId: req.params.agentId, durationMs: Date.now() - startedAt }, 'POST /api/swarm/memory/agents/:agentId/remember failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * POST /api/swarm/memory/agents/:agentId/remember-batch — Store multiple memories.
   * Body: { items: Array<{ text: string, metadata?: Record<string, string> }> }
   */
  router.post('/agents/:agentId/remember-batch', async (req: Request, res: Response) => {
    const startedAt = Date.now();
    logger.info({ agentId: req.params.agentId }, 'POST /api/swarm/memory/agents/:agentId/remember-batch');
    try {
      const { items } = req.body;
      if (!Array.isArray(items) || items.length === 0) {
        logger.warn({ agentId: req.params.agentId, durationMs: Date.now() - startedAt }, 'POST /api/swarm/memory/agents/:agentId/remember-batch missing items');
        res.status(400).json({ error: 'items array is required and must not be empty' });
        return;
      }
      await agentMemory.rememberBatch(req.params.agentId as string, items);
      logger.info({ agentId: req.params.agentId, count: items.length, durationMs: Date.now() - startedAt }, 'POST /api/swarm/memory/agents/:agentId/remember-batch complete');
      res.status(201).json({ stored: true, count: items.length, agentId: req.params.agentId });
    } catch (error) {
      logger.error({ err: error, agentId: req.params.agentId, durationMs: Date.now() - startedAt }, 'POST /api/swarm/memory/agents/:agentId/remember-batch failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * GET /api/swarm/memory/agents/:agentId/recall?q=query&limit=5 — Recall memories.
   */
  router.get('/agents/:agentId/recall', async (req: Request, res: Response) => {
    const startedAt = Date.now();
    logger.info({ agentId: req.params.agentId, query: req.query.q ?? null }, 'GET /api/swarm/memory/agents/:agentId/recall');
    try {
      const query = req.query.q as string;
      if (!query) {
        logger.warn({ agentId: req.params.agentId, durationMs: Date.now() - startedAt }, 'GET /api/swarm/memory/agents/:agentId/recall missing query');
        res.status(400).json({ error: 'q query parameter is required' });
        return;
      }
      const limit = parseInt(req.query.limit as string) || 5;
      const results = await agentMemory.recall(req.params.agentId as string, query, limit);
      logger.info({ agentId: req.params.agentId, count: results.length, durationMs: Date.now() - startedAt }, 'GET /api/swarm/memory/agents/:agentId/recall complete');
      res.json({ agentId: req.params.agentId, query, results });
    } catch (error) {
      logger.error({ err: error, agentId: req.params.agentId, durationMs: Date.now() - startedAt }, 'GET /api/swarm/memory/agents/:agentId/recall failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * POST /api/swarm/memory/agents/:agentId/bootstrap — Bootstrap domain knowledge.
   * Body: { sources: Array<{ title: string, content: string, source?: string, category?: string }> }
   */
  router.post('/agents/:agentId/bootstrap', async (req: Request, res: Response) => {
    const startedAt = Date.now();
    logger.info({ agentId: req.params.agentId }, 'POST /api/swarm/memory/agents/:agentId/bootstrap');
    try {
      const { sources } = req.body;
      if (!Array.isArray(sources) || sources.length === 0) {
        logger.warn({ agentId: req.params.agentId, durationMs: Date.now() - startedAt }, 'POST /api/swarm/memory/agents/:agentId/bootstrap missing sources');
        res.status(400).json({ error: 'sources array is required' });
        return;
      }
      const result = await agentMemory.bootstrapKnowledge(req.params.agentId as string, sources);
      logger.info({ agentId: req.params.agentId, durationMs: Date.now() - startedAt }, 'POST /api/swarm/memory/agents/:agentId/bootstrap complete');
      res.json(result);
    } catch (error) {
      logger.error({ err: error, agentId: req.params.agentId, durationMs: Date.now() - startedAt }, 'POST /api/swarm/memory/agents/:agentId/bootstrap failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * GET /api/swarm/memory/agents/:agentId/knowledge?q=query&limit=5 — Query agent knowledge.
   */
  router.get('/agents/:agentId/knowledge', async (req: Request, res: Response) => {
    const startedAt = Date.now();
    logger.info({ agentId: req.params.agentId, query: req.query.q ?? null }, 'GET /api/swarm/memory/agents/:agentId/knowledge');
    try {
      const query = req.query.q as string;
      if (!query) {
        logger.warn({ agentId: req.params.agentId, durationMs: Date.now() - startedAt }, 'GET /api/swarm/memory/agents/:agentId/knowledge missing query');
        res.status(400).json({ error: 'q query parameter is required' });
        return;
      }
      const limit = parseInt(req.query.limit as string) || 5;
      const results = await agentMemory.queryKnowledge(req.params.agentId as string, query, limit);
      logger.info({ agentId: req.params.agentId, count: results.length, durationMs: Date.now() - startedAt }, 'GET /api/swarm/memory/agents/:agentId/knowledge complete');
      res.json({ agentId: req.params.agentId, query, results });
    } catch (error) {
      logger.error({ err: error, agentId: req.params.agentId, durationMs: Date.now() - startedAt }, 'GET /api/swarm/memory/agents/:agentId/knowledge failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * GET /api/swarm/memory/agents/:agentId/collections — Get collection names for an agent.
   */
  router.get('/agents/:agentId/collections', (req: Request, res: Response) => {
    const collections = agentMemory.getCollectionNames(req.params.agentId as string);
    res.json({ agentId: req.params.agentId, collections });
  });

  // ─── Shared Swarm Memory ────────────────────────────────────────────

  /**
   * POST /api/swarm/memory/shared/store — Store learnings from a completed work item.
   * Body: CompletedWorkContext
   */
  router.post('/shared/store', async (req: Request, res: Response) => {
    const startedAt = Date.now();
    logger.info({ workItemId: req.body?.workItemId ?? null }, 'POST /api/swarm/memory/shared/store');
    try {
      const { workItemId, title, agentId, executionOutput } = req.body;
      if (!workItemId || !title || !agentId || !executionOutput) {
        logger.warn({ durationMs: Date.now() - startedAt }, 'POST /api/swarm/memory/shared/store missing required fields');
        res.status(400).json({ error: 'workItemId, title, agentId, and executionOutput are required' });
        return;
      }
      const stored = await swarmMemory.extractAndStore(req.body);
      logger.info({ workItemId, stored, durationMs: Date.now() - startedAt }, 'POST /api/swarm/memory/shared/store complete');
      res.status(stored ? 201 : 200).json({ stored, workItemId });
    } catch (error) {
      logger.error({ err: error, durationMs: Date.now() - startedAt }, 'POST /api/swarm/memory/shared/store failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * GET /api/swarm/memory/shared/query?q=query&limit=3 — Query shared swarm memory.
   */
  router.get('/shared/query', async (req: Request, res: Response) => {
    const startedAt = Date.now();
    logger.info({ query: req.query.q ?? null }, 'GET /api/swarm/memory/shared/query');
    try {
      const query = req.query.q as string;
      if (!query) {
        logger.warn({ durationMs: Date.now() - startedAt }, 'GET /api/swarm/memory/shared/query missing query');
        res.status(400).json({ error: 'q query parameter is required' });
        return;
      }
      const limit = parseInt(req.query.limit as string) || 3;
      const results = await swarmMemory.queryRelevant(query, limit);
      logger.info({ count: results.length, durationMs: Date.now() - startedAt }, 'GET /api/swarm/memory/shared/query complete');
      res.json({ query, results });
    } catch (error) {
      logger.error({ err: error, durationMs: Date.now() - startedAt }, 'GET /api/swarm/memory/shared/query failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * POST /api/swarm/memory/shared/context — Get formatted context block for prompt injection.
   * Body: { title: string, description: string, limit?: number }
   */
  router.post('/shared/context', async (req: Request, res: Response) => {
    const startedAt = Date.now();
    logger.info({ title: req.body?.title ?? null }, 'POST /api/swarm/memory/shared/context');
    try {
      const { title, description, limit } = req.body;
      if (!title) {
        logger.warn({ durationMs: Date.now() - startedAt }, 'POST /api/swarm/memory/shared/context missing title');
        res.status(400).json({ error: 'title is required' });
        return;
      }
      const context = await swarmMemory.queryRelevantContext(title, description || '', limit);
      logger.info({ durationMs: Date.now() - startedAt }, 'POST /api/swarm/memory/shared/context complete');
      res.json(context);
    } catch (error) {
      logger.error({ err: error, durationMs: Date.now() - startedAt }, 'POST /api/swarm/memory/shared/context failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  logger.info('Swarm memory routes registered');
  return router;
}
