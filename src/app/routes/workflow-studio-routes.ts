/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR        | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added workflow-studio routes for design-time workflow definitions, validation, and compile previews
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Wired optional live agent-roster compatibility checks into workflow-studio validation and compile routes
 */

import { Router, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { AgentProfileRepository } from '@/entities/agent';
import {
  WorkflowStudioNodeSchema,
  WorkflowStudioEdgeSchema,
  WorkflowStudioService,
} from '@/features/workflow-studio';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'workflow-studio-routes' });

const DefinitionParamSchema = z.object({
  definitionId: z.string().uuid(),
});

const DefinitionVersionParamSchema = z.object({
  definitionId: z.string().uuid(),
  version: z.coerce.number().int().positive(),
});

const CreateWorkflowSchema = z.object({
  description: z.string().max(4000).optional(),
  name: z.string().min(1).max(160).optional(),
});

const MetadataSchema = z.object({
  notes: z.string().max(4000).optional(),
  seed: z.boolean().optional(),
  tags: z.array(z.string()).optional(),
}).optional();

const SaveWorkflowSchema = z.object({
  description: z.string().max(4000).optional(),
  edges: z.array(WorkflowStudioEdgeSchema),
  id: z.string().uuid(),
  metadata: MetadataSchema,
  name: z.string().min(1).max(160),
  nodes: z.array(WorkflowStudioNodeSchema).min(1),
});

/**
 * @description Creates routes for the workflow-studio design-time authoring surface.
 */
export function createWorkflowStudioRoutes(deps: { pool?: Pool } = {}): Router {
  const router = Router();
  const agentRepository = deps.pool ? new AgentProfileRepository(deps.pool) : null;
  const service = new WorkflowStudioService(
    undefined,
    agentRepository
      ? {
        listAgents: () => agentRepository.listAgents(),
      }
      : undefined,
  );

  router.get('/catalog', async (_req: Request, res: Response) => {
    const catalog = await service.getCatalog();
    res.json({
      catalog,
      success: true,
    });
  });

  router.get('/templates', (_req: Request, res: Response) => {
    res.json({ templates: service.listTemplates(), success: true });
  });

  router.post('/templates/:templateId/create', async (req: Request, res: Response) => {
    try {
      const input = CreateWorkflowSchema.parse(req.body ?? {});
      const definition = await service.createFromTemplate(String(req.params.templateId), input);
      if (!definition) {
        res.status(404).json({ error: `Unknown workflow template: ${req.params.templateId}`, success: false });
        return;
      }
      logger.info({ definitionId: definition.id, templateId: req.params.templateId }, 'Workflow created from template via API');
      res.status(201).json({ definition, success: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create from template';
      logger.warn({ err: error }, 'Workflow template create rejected');
      res.status(400).json({ error: message, success: false });
    }
  });

  router.get('/definitions', async (_req: Request, res: Response) => {
    const definitions = await service.listDefinitions();
    res.json({
      count: definitions.length,
      definitions,
      success: true,
    });
  });

  router.post('/definitions', async (req: Request, res: Response) => {
    try {
      const input = CreateWorkflowSchema.parse(req.body ?? {});
      const definition = await service.createDefinition(input);
      logger.info({ definitionId: definition.id, name: definition.name }, 'Workflow definition created via API');
      res.status(201).json({
        definition,
        success: true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create workflow definition';
      logger.warn({ err: error }, 'Workflow definition create rejected');
      res.status(400).json({
        error: message,
        success: false,
      });
    }
  });

  router.get('/definitions/:definitionId', async (req: Request, res: Response) => {
    const { definitionId } = DefinitionParamSchema.parse(req.params);
    const definition = await service.getDefinition(definitionId);
    if (!definition) {
      res.status(404).json({
        error: `Workflow definition not found: ${definitionId}`,
        success: false,
      });
      return;
    }

    res.json({
      definition,
      success: true,
    });
  });

  router.get('/definitions/:definitionId/versions', async (req: Request, res: Response) => {
    const { definitionId } = DefinitionParamSchema.parse(req.params);
    const definition = await service.getDefinition(definitionId);
    if (!definition) {
      res.status(404).json({
        error: `Workflow definition not found: ${definitionId}`,
        success: false,
      });
      return;
    }

    const versions = await service.listDefinitionVersions(definitionId);
    res.json({
      definitionId,
      success: true,
      versions,
    });
  });

  router.get('/definitions/:definitionId/versions/:version', async (req: Request, res: Response) => {
    const { definitionId, version } = DefinitionVersionParamSchema.parse(req.params);
    const definition = await service.getDefinitionVersion(definitionId, version);
    if (!definition) {
      res.status(404).json({
        error: `Workflow definition version not found: ${definitionId} v${version}`,
        success: false,
      });
      return;
    }

    res.json({
      definition,
      success: true,
    });
  });

  router.put('/definitions/:definitionId', async (req: Request, res: Response) => {
    try {
      const { definitionId } = DefinitionParamSchema.parse(req.params);
      const input = SaveWorkflowSchema.parse(req.body ?? {});
      if (input.id !== definitionId) {
        res.status(400).json({
          error: 'Definition id in URL and body must match.',
          success: false,
        });
        return;
      }

      const definition = await service.saveDefinition({
        ...input,
        metadata: input.metadata
          ? {
            notes: input.metadata.notes,
            seed: input.metadata.seed,
            tags: input.metadata.tags ?? [],
          }
          : undefined,
      });
      logger.info({ definitionId: definition.id, version: definition.version }, 'Workflow definition saved via API');
      res.json({
        definition,
        success: true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save workflow definition';
      logger.warn({ err: error }, 'Workflow definition save rejected');
      res.status(400).json({
        error: message,
        success: false,
      });
    }
  });

  router.post('/definitions/:definitionId/validate', async (req: Request, res: Response) => {
    const { definitionId } = DefinitionParamSchema.parse(req.params);
    const report = await service.validateDefinition(definitionId);
    if (!report) {
      res.status(404).json({
        error: `Workflow definition not found: ${definitionId}`,
        success: false,
      });
      return;
    }

    res.json({
      report,
      success: true,
    });
  });

  router.post('/definitions/:definitionId/compile', async (req: Request, res: Response) => {
    const { definitionId } = DefinitionParamSchema.parse(req.params);
    const preview = await service.compileDefinition(definitionId);
    if (!preview) {
      res.status(404).json({
        error: `Workflow definition not found: ${definitionId}`,
        success: false,
      });
      return;
    }

    res.json({
      preview,
      success: true,
    });
  });

  router.post('/definitions/:definitionId/duplicate', async (req: Request, res: Response) => {
    try {
      const { definitionId } = DefinitionParamSchema.parse(req.params);
      const input = CreateWorkflowSchema.parse(req.body ?? {});
      const definition = await service.duplicateDefinition(definitionId, input);
      if (!definition) {
        res.status(404).json({
          error: `Workflow definition not found: ${definitionId}`,
          success: false,
        });
        return;
      }

      res.status(201).json({
        definition,
        success: true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to duplicate workflow definition';
      logger.warn({ err: error }, 'Workflow definition duplicate rejected');
      res.status(400).json({
        error: message,
        success: false,
      });
    }
  });

  router.post('/definitions/:definitionId/versions/:version/fork', async (req: Request, res: Response) => {
    try {
      const { definitionId, version } = DefinitionVersionParamSchema.parse(req.params);
      const input = CreateWorkflowSchema.parse(req.body ?? {});
      const definition = await service.forkDefinitionVersion(definitionId, version, input);
      if (!definition) {
        res.status(404).json({
          error: `Workflow definition version not found: ${definitionId} v${version}`,
          success: false,
        });
        return;
      }

      res.status(201).json({
        definition,
        success: true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to fork workflow version';
      logger.warn({ err: error }, 'Workflow version fork rejected');
      res.status(400).json({
        error: message,
        success: false,
      });
    }
  });

  return router;
}
