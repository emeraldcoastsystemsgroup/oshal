/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added agent factory CRUD routes for bot generation API
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | POST /create-and-start — one-call create+launch replacing the unrolled-back POST /api/swarm/agents + POST /api/agents/:agentId/launch pair. Same requiresAuth-mounted router (swarm extension mounts this factory under /api/swarm/agents), same spec schema; on launch failure the service rolls the creation back (502 with rolledBack in the body), so a failed launch never leaves a routable zombie.
 */

import { Router, type Request, type Response } from 'express';
import type { AgentFactoryService, AgentSpecification } from '@/features/agent-management';
import { AuthMode } from '@/shared/types/tool';
import { ToolRuntimeConfigSchema } from '@/entities/tool';
import { createChildLogger } from '@/shared/logger';
import { z, ZodError } from 'zod';

const logger = createChildLogger({ module: 'agent-factory-routes' });

const ConfigFieldSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['string', 'password', 'url', 'number', 'boolean', 'select', 'textarea']),
  label: z.string().min(1),
  required: z.boolean(),
  defaultValue: z.string().optional(),
  options: z.array(z.string()).optional(),
  placeholder: z.string().optional(),
  description: z.string().optional(),
});

const AgentToolAssignmentSchema = z.object({
  toolId: z.string().uuid().optional(),
  toolName: z.string().min(1).optional(),
  authMode: z.nativeEnum(AuthMode).optional(),
  toolConfig: ToolRuntimeConfigSchema.optional(),
}).refine((value) => Boolean(value.toolId || value.toolName), {
  message: 'Each tool assignment must include toolId or toolName',
});

const AgentConfigGuideSchema = z.object({
  title: z.string().min(1).optional(),
  summary: z.string().min(1).optional(),
  docPath: z.string().min(1),
});

const AgentSpecificationRequestSchema = z.object({
  name: z.string().min(1),
  systemPrompt: z.string().min(1),
  role: z.string().min(1),
  topology: z.enum(['localhost', 'swarm']),
  constraints: z.array(z.string()).default([]),
  capabilities: z.array(z.string()).min(1),
  routingKeywords: z.array(z.string()).min(1),
  selectorDescriptor: z.string().min(1),
  providerId: z.string().optional(),
  modelId: z.string().optional(),
  knowledgeSources: z.array(z.string()).optional(),
  toolAssignments: z.array(AgentToolAssignmentSchema).optional(),
  configFields: z.array(ConfigFieldSchema).optional(),
  configValues: z.record(z.unknown()).optional(),
  configGuide: AgentConfigGuideSchema.optional(),
});

/**
 * @description Creates routes for the agent factory bot generation API.
 * @param factoryService - AgentFactoryService instance
 * @returns Express router
 */
export function createAgentFactoryRoutes(factoryService: AgentFactoryService): Router {
  const router = Router();

  /**
   * POST /api/swarm/agents — Create a new agent from a specification.
   */
  router.post('/', async (req: Request, res: Response) => {
    const startedAt = Date.now();
    logger.info({ name: req.body?.name ?? null }, 'POST /api/swarm/agents');
    try {
      const spec = AgentSpecificationRequestSchema.parse(req.body) as AgentSpecification;
      const result = await factoryService.deployPersonaOnly(spec);
      if (result.duplicate) {
        logger.warn({ name: spec.name, durationMs: Date.now() - startedAt }, 'POST /api/swarm/agents duplicate agent');
        res.status(409).json(result);
        return;
      }
      if (!result.success) {
        logger.warn({ name: spec.name, durationMs: Date.now() - startedAt }, 'POST /api/swarm/agents service returned failure');
        res.status(500).json(result);
        return;
      }
      logger.info({ name: spec.name, durationMs: Date.now() - startedAt }, 'POST /api/swarm/agents complete');
      res.status(201).json(result);
    } catch (error) {
      if (error instanceof ZodError) {
        logger.warn({ issues: error.issues, durationMs: Date.now() - startedAt }, 'POST /api/swarm/agents validation failed');
        res.status(400).json({
          error: 'Invalid agent specification',
          issues: error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        });
        return;
      }
      logger.error({ err: error, durationMs: Date.now() - startedAt }, 'POST /api/swarm/agents failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * POST /api/swarm/agents/create-and-start — Atomic create + container launch.
   * Same auth posture as create/launch (this router mounts behind requiresAuth);
   * same specification schema as POST /. On launch failure the creation is rolled
   * back by the service (never a silent zombie) and the response is 502 with
   * rolledBack/rollbackError so the caller sees exactly what happened.
   */
  router.post('/create-and-start', async (req: Request, res: Response) => {
    const startedAt = Date.now();
    logger.info({ name: req.body?.name ?? null }, 'POST /api/swarm/agents/create-and-start');
    try {
      const spec = AgentSpecificationRequestSchema.parse(req.body) as AgentSpecification;
      const result = await factoryService.createAndStartAgent(spec);
      if (result.duplicate) {
        logger.warn({ name: spec.name, durationMs: Date.now() - startedAt }, 'POST /api/swarm/agents/create-and-start duplicate agent');
        res.status(409).json(result);
        return;
      }
      if (!result.success && !result.agentId) {
        logger.warn({ name: spec.name, durationMs: Date.now() - startedAt }, 'POST /api/swarm/agents/create-and-start creation failed');
        res.status(500).json(result);
        return;
      }
      if (!result.success) {
        logger.warn(
          { name: spec.name, rolledBack: result.rolledBack, containerError: result.containerError, durationMs: Date.now() - startedAt },
          'POST /api/swarm/agents/create-and-start launch failed — creation rolled back',
        );
        res.status(502).json(result);
        return;
      }
      logger.info(
        { name: spec.name, agentId: result.agentId, durationMs: Date.now() - startedAt },
        'POST /api/swarm/agents/create-and-start complete',
      );
      res.status(201).json(result);
    } catch (error) {
      if (error instanceof ZodError) {
        logger.warn({ issues: error.issues, durationMs: Date.now() - startedAt }, 'POST /api/swarm/agents/create-and-start validation failed');
        res.status(400).json({
          error: 'Invalid agent specification',
          issues: error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        });
        return;
      }
      logger.error({ err: error, durationMs: Date.now() - startedAt }, 'POST /api/swarm/agents/create-and-start failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * GET /api/swarm/agents — List all agent names.
   */
  router.get('/', async (_req: Request, res: Response) => {
    const startedAt = Date.now();
    logger.info('GET /api/swarm/agents');
    try {
      const names = await factoryService.listAgentNames();
      logger.info({ count: names.length, durationMs: Date.now() - startedAt }, 'GET /api/swarm/agents complete');
      res.json({ agents: names });
    } catch (error) {
      logger.error({ err: error, durationMs: Date.now() - startedAt }, 'GET /api/swarm/agents failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * DELETE /api/swarm/agents/:agentId — Delete an agent.
   */
  router.delete('/:agentId', async (req: Request, res: Response) => {
    const startedAt = Date.now();
    logger.info({ agentId: req.params.agentId }, 'DELETE /api/swarm/agents/:agentId');
    try {
      const deleted = await factoryService.deleteAgent(req.params.agentId as string);
      if (!deleted) {
        logger.warn({ agentId: req.params.agentId, durationMs: Date.now() - startedAt }, 'DELETE /api/swarm/agents/:agentId not found');
        res.status(404).json({ error: 'Agent not found' });
        return;
      }
      logger.info({ agentId: req.params.agentId, durationMs: Date.now() - startedAt }, 'DELETE /api/swarm/agents/:agentId complete');
      res.json({ deleted: true, agentId: req.params.agentId });
    } catch (error) {
      logger.error({ err: error, agentId: req.params.agentId, durationMs: Date.now() - startedAt }, 'DELETE /api/swarm/agents/:agentId failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  logger.info('Agent factory routes registered');
  return router;
}
