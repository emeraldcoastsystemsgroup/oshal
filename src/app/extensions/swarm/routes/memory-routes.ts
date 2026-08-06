/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added memory API routes — per-agent memory + shared swarm memory
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05: add an operator-only promotion boundary that records the authenticated exact subject as approval evidence.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05 audit: require exact-content approval evidence and bind shared-memory queries to caller/workspace ACL context.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05 audit: operator-gate shared agent memory administration until AgentMemoryService has durable per-owner ACL enforcement.
 */

import { Router, type Request, type Response } from 'express';
import type { AgentMemoryService } from '@/features/agent-management';
import type { SwarmMemoryAccessContext, SwarmMemoryService } from '@/features/agent-management';
import { createChildLogger } from '@/shared/logger';
import { getCaller, isOperator } from '@/shared/middleware/authz';
import { requireExactUserSubject } from '@/shared/security/exact-user-subject';

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
    if (!requireAgentMemoryOperator(req, res)) return;
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
    if (!requireAgentMemoryOperator(req, res)) return;
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
    if (!requireAgentMemoryOperator(req, res)) return;
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
    if (!requireAgentMemoryOperator(req, res)) return;
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
    if (!requireAgentMemoryOperator(req, res)) return;
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
    if (!requireAgentMemoryOperator(req, res)) return;
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
      const ownerSub = requireExactUserSubject(getCaller(req).sub, 'memory owner subject');
      const stored = await swarmMemory.extractAndStore({
        workItemId, title, agentId, executionOutput,
        complexity: req.body?.complexity,
        hadVerificationFailures: req.body?.hadVerificationFailures === true,
        hadEscalations: req.body?.hadEscalations === true,
        categories: Array.isArray(req.body?.categories) ? req.body.categories : [],
        source: 'authenticated-memory-api',
        ownerSub,
        workspaceId: optionalMemoryWorkspaceId(req.body?.workspaceId),
      });
      logger.info({ workItemId, stored, durationMs: Date.now() - startedAt }, 'POST /api/swarm/memory/shared/store complete');
      res.status(stored ? 201 : 200).json({ stored, workItemId });
    } catch (error) {
      logger.error({ err: error, durationMs: Date.now() - startedAt }, 'POST /api/swarm/memory/shared/store failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/shared/:workItemId/approve', handleApproveSwarmMemory(swarmMemory));

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
      const access = memoryAccessFromRequest(req, req.query.workspaceId);
      const results = await swarmMemory.queryRelevant(query, limit, access);
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
      const access = memoryAccessFromRequest(req, req.body?.workspaceId);
      const context = await swarmMemory.queryRelevantContext(
        title, description || '', limit, access,
      );
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

function handleApproveSwarmMemory(swarmMemory: SwarmMemoryService) {
  return async (req: Request, res: Response): Promise<void> => {
    const startedAt = Date.now();
    if (!isOperator(req)) {
      logger.warn({ durationMs: Date.now() - startedAt }, 'Swarm memory approval denied');
      res.status(403).json({ error: 'operator_required' });
      return;
    }
    try {
      const approvedBySub = requireExactUserSubject(getCaller(req).sub, 'operator subject');
      const workItemId = requireMemoryWorkItemId(req.params.workItemId);
      const contentSha256 = requireApprovalDigest(req.body?.contentSha256);
      const provenance = await swarmMemory.promoteMemory(workItemId, {
        kind: 'explicit-approval',
        approvedBySub,
        contentSha256,
        publishShared: req.body?.publishShared === true,
      });
      logger.info({ workItemId, durationMs: Date.now() - startedAt }, 'Swarm memory approved');
      res.json({ workItemId, provenance });
    } catch (error) {
      handleMemoryApprovalError(error, res, startedAt);
    }
  };
}

function requireMemoryWorkItemId(value: unknown): string {
  const workItemId = typeof value === 'string' ? value : '';
  if (!workItemId || workItemId.length > 512 || /[\u0000-\u001f\u007f]/.test(workItemId)) {
    throw new TypeError('Invalid swarm memory work item id');
  }
  return workItemId;
}

function requireApprovalDigest(value: unknown): string {
  const digest = typeof value === 'string' ? value.toLowerCase() : '';
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    throw new TypeError('contentSha256 is required for swarm memory approval');
  }
  return digest;
}

function memoryAccessFromRequest(req: Request, workspaceValue: unknown): SwarmMemoryAccessContext {
  const caller = getCaller(req);
  const workspaceId = optionalMemoryWorkspaceId(workspaceValue);
  return {
    userSub: requireExactUserSubject(caller.sub, 'memory query subject'),
    ...(caller.email ? { emails: [caller.email] } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    isOperator: isOperator(req),
    allowPublic: true,
  };
}

function optionalMemoryWorkspaceId(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError('Invalid memory workspace id');
  }
  return value;
}

function handleMemoryApprovalError(error: unknown, res: Response, startedAt: number): void {
  const message = error instanceof Error ? error.message : '';
  const notFound = message === 'Swarm memory entry not found';
  const invalid = error instanceof TypeError;
  logger.error({ err: error, durationMs: Date.now() - startedAt }, 'Swarm memory approval failed');
  if (notFound) res.status(404).json({ error: 'memory_not_found' });
  else if (invalid) res.status(400).json({ error: 'invalid_approval_request' });
  else res.status(500).json({ error: 'Internal server error' });
}

function requireAgentMemoryOperator(req: Request, res: Response): boolean {
  if (isOperator(req)) return true;
  logger.warn(
    { method: req.method, agentId: req.params.agentId },
    'Shared agent memory access denied',
  );
  res.status(403).json({ error: 'operator_required' });
  return false;
}
