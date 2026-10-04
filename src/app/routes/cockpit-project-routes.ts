/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted project CRUD routes from cockpit-routes.ts to satisfy 800-line refactoring trigger
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Scope project discovery to current readable owner records; expose the global registry only to operators.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Registry MUTATIONS are operator administration too (requiresOperator on create, rename, archive). Seq 2 made the global registry operator-only to read, but any signed-in user could still write it and have its rename/archive rewrite project metadata across tickets - a confirmed exposure in the 2026-10-04 route-auth audit. Users organize their own tickets through the owner-scoped PUT /api/tickets/:id/project, which needs no registry entry.
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { DEFAULT_PROJECT_ID, DEFAULT_PROJECT_NAME } from '@/entities/ticket';
import { createChildLogger } from '@/shared/logger';
import { requiresOperator } from '@/shared/middleware/authz';
import type { AppContext } from '../composition-root';
import { handleGetCockpitProjects } from './cockpit-private-projects';
import {
  loadProjectRegistry,
  readOptionalString,
  readRecord,
  saveProjectRegistry,
  slugify,
} from './cockpit-route-helpers';

const logger = createChildLogger({ module: 'cockpit-project-routes' });

/**
 * @description Creates Express router with project CRUD endpoints for the cockpit UI.
 * @param ctx - Application context
 * @returns Configured Express router with project list, create, rename, and archive routes
 */
export function createCockpitProjectRoutes(ctx: AppContext): Router {
  const router = Router();

  router.get('/projects', handleGetCockpitProjects(ctx));

  router.post('/projects', requiresOperator, async (req: Request, res: Response) => {
    try {
      const { name } = req.body || {};
      if (!name || typeof name !== 'string' || !name.trim()) {
        res.status(400).json({ success: false, error: 'Project name is required' });
        return;
      }
      const trimmedName = name.trim();
      const projectId = slugify(trimmedName);
      logger.info({ projectId, name: trimmedName }, 'POST /api/v1/projects — creating project');

      const registry = loadProjectRegistry(ctx);
      if (registry.has(projectId)) {
        res.status(409).json({ success: false, error: `Project "${trimmedName}" already exists` });
        return;
      }

      const project = { id: projectId, name: trimmedName, identifier: projectId, projectId, workspaceSlug: projectId, createdAt: new Date().toISOString(), archived: false };
      registry.set(projectId, project);
      saveProjectRegistry(ctx, registry);

      res.json({ success: true, project });
    } catch (error) {
      logger.error({ err: error }, 'Failed to create project');
      res.status(500).json({ success: false, error: 'Failed to create project' });
    }
  });

  router.patch('/projects/:projectId', requiresOperator, async (req: Request, res: Response) => {
    try {
      const { projectId } = req.params;
      const { name } = req.body || {};
      if (!name || typeof name !== 'string' || !name.trim()) {
        res.status(400).json({ success: false, error: 'New project name is required' });
        return;
      }
      const trimmedName = name.trim();
      const newProjectId = slugify(trimmedName);
      logger.info({ projectId, newName: trimmedName, newProjectId }, 'PATCH /api/v1/projects/:projectId — renaming');

      const registry = loadProjectRegistry(ctx);
      const existing = registry.get(projectId as string);
      if (existing) {
        registry.delete(projectId as string);
        existing.name = trimmedName;
        existing.id = newProjectId;
        existing.identifier = newProjectId;
        existing.projectId = newProjectId;
        existing.workspaceSlug = newProjectId;
        registry.set(newProjectId, existing);
        saveProjectRegistry(ctx, registry);
      }

      let updatedCount = 0;
      try {
        const tickets = await ctx.ticketService.listTickets({ limit: 500 });
        for (const ticket of tickets) {
          const metadata = readRecord(ticket.metadata);
          const ticketProjectId = readOptionalString(metadata.projectId) || slugify(readOptionalString(metadata.projectName) || DEFAULT_PROJECT_NAME);
          if (ticketProjectId === projectId) {
            const updatedMetadata = { ...metadata, projectName: trimmedName, projectId: newProjectId, projectIdentifier: newProjectId, workspaceSlug: newProjectId };
            await ctx.ticketService.updateTicket(ticket.ticketId, { metadata: updatedMetadata });
            updatedCount++;
          }
        }
      } catch (ticketError) {
        logger.warn({ err: ticketError }, 'Failed to update ticket metadata during project rename');
      }

      res.json({ success: true, project: { id: newProjectId, name: trimmedName, projectId: newProjectId }, updatedTickets: updatedCount });
    } catch (error) {
      logger.error({ err: error }, 'Failed to rename project');
      res.status(500).json({ success: false, error: 'Failed to rename project' });
    }
  });

  router.delete('/projects/:projectId', requiresOperator, async (req: Request, res: Response) => {
    try {
      const { projectId } = req.params;
      if (projectId === DEFAULT_PROJECT_ID) {
        res.status(400).json({ success: false, error: 'Cannot archive the Default project' });
        return;
      }
      logger.info({ projectId }, 'DELETE /api/v1/projects/:projectId — archiving');

      const registry = loadProjectRegistry(ctx);
      registry.delete(projectId as string);
      saveProjectRegistry(ctx, registry);

      let movedCount = 0;
      try {
        const tickets = await ctx.ticketService.listTickets({ limit: 500 });
        for (const ticket of tickets) {
          const metadata = readRecord(ticket.metadata);
          const ticketProjectId = readOptionalString(metadata.projectId) || slugify(readOptionalString(metadata.projectName) || DEFAULT_PROJECT_NAME);
          if (ticketProjectId === projectId) {
            const updatedMetadata = { ...metadata, projectName: DEFAULT_PROJECT_NAME, projectId: DEFAULT_PROJECT_ID, projectIdentifier: DEFAULT_PROJECT_ID, workspaceSlug: DEFAULT_PROJECT_ID };
            await ctx.ticketService.updateTicket(ticket.ticketId, { metadata: updatedMetadata });
            movedCount++;
          }
        }
      } catch (ticketError) {
        logger.warn({ err: ticketError }, 'Failed to move tickets during project archive');
      }

      res.json({ success: true, archived: projectId, movedTickets: movedCount });
    } catch (error) {
      logger.error({ err: error }, 'Failed to archive project');
      res.status(500).json({ success: false, error: 'Failed to archive project' });
    }
  });

  return router;
}
