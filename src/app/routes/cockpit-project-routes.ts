/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted project CRUD routes from cockpit-routes.ts to satisfy 800-line refactoring trigger
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { DEFAULT_PROJECT_ID, DEFAULT_PROJECT_NAME } from '@/entities/ticket';
import { createChildLogger } from '@/shared/logger';
import type { AppContext } from '../composition-root';
import {
  buildProjectSelection,
  buildProjectSelectionFromTask,
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

  router.get('/projects', async (_req: Request, res: Response) => {
    try {
      logger.info('GET /api/v1/projects');
      const projects = new Map<string, { id: string; name: string; identifier: string; projectId: string; workspaceSlug: string; ticketCount?: number }>();

      const registry = loadProjectRegistry(ctx);
      for (const [id, entry] of registry) {
        projects.set(id, { ...entry, ticketCount: 0 });
      }

      const internalTickets = await ctx.ticketService.listTickets({ limit: 500 }).catch(() => []);
      for (const ticket of internalTickets as Array<Record<string, unknown>>) {
        const metadata = readRecord(ticket.metadata);
        const selection = buildProjectSelection(
          readOptionalString(metadata.projectName) || readOptionalString(metadata.project),
          readOptionalString(metadata.projectId),
          readOptionalString(metadata.projectIdentifier),
          readOptionalString(metadata.workspaceSlug),
        );
        const existing = projects.get(selection.id);
        if (existing) {
          existing.ticketCount = (existing.ticketCount || 0) + 1;
        } else {
          projects.set(selection.id, { ...selection, ticketCount: 1 });
        }
      }

      const tasks = await ctx.taskStore.list({ limit: 500 });
      for (const task of tasks) {
        const selection = buildProjectSelectionFromTask(task as Record<string, unknown>);
        if (!projects.has(selection.id)) {
          projects.set(selection.id, { ...selection, ticketCount: 0 });
        }
      }

      const registryIds = new Set(registry.keys());
      const filtered = Array.from(projects.values()).filter(
        (p) => (p.ticketCount && p.ticketCount > 0) || registryIds.has(p.id) || p.id === DEFAULT_PROJECT_ID,
      );

      res.json({
        success: true,
        projects: filtered.sort((left, right) => left.name.localeCompare(right.name)),
      });
    } catch (error) {
      logger.error({ err: error }, 'Failed to list projects');
      res.json({ success: true, projects: [] });
    }
  });

  router.post('/projects', async (req: Request, res: Response) => {
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

  router.patch('/projects/:projectId', async (req: Request, res: Response) => {
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

  router.delete('/projects/:projectId', async (req: Request, res: Response) => {
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