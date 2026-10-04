/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Build project lists exclusively from caller-visible tickets and tasks.
 */
import type { Request, Response } from 'express';
import type { AppContext } from '../composition-root';
import { DEFAULT_PROJECT_ID } from '@/entities/ticket';
import { getCaller, isOperator } from '@/shared/middleware/authz';
import { canReadCockpitTask, canReadCockpitTicket } from './cockpit-resource-access';
import { loadProjectRegistry, buildProjectSelection, buildProjectSelectionFromTask, readRecord, readOptionalString } from './cockpit-route-helpers';

type Project = { id: string; name: string; identifier: string; projectId: string; workspaceSlug: string; ticketCount?: number };

/** @description Read admitted ticket project names and counts. @param ctx Runtime. @param req Caller. @param ownerSub Verified scope. @param projects Accumulator. @returns No value. */
async function addTickets(ctx: AppContext, req: Request, ownerSub: string | undefined, projects: Map<string, Project>): Promise<void> {
  const internalTickets = await ctx.ticketService.listTickets({ limit: 500, ownerSub });
  for (const ticket of internalTickets) {
    if (!await canReadCockpitTicket(ctx, req, ticket)) continue;
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

}

/** @description Read admitted task-only projects. @param ctx Runtime. @param req Caller. @param ownerSub Verified scope. @param projects Accumulator. @returns Visible task project IDs. */
async function addTasks(ctx: AppContext, req: Request, ownerSub: string | undefined, projects: Map<string, Project>): Promise<Set<string>> {
  const tasks = await ctx.taskStore.list({ limit: 500, ownerSub });
  const visibleTaskProjectIds = new Set<string>();
  for (const task of tasks) {
    if (!await canReadCockpitTask(ctx, req, task)) continue;
    const selection = buildProjectSelectionFromTask(task as Record<string, unknown>);
    visibleTaskProjectIds.add(selection.id);
    if (!projects.has(selection.id)) {
      projects.set(selection.id, { ...selection, ticketCount: 0 });
    }
  }

  return visibleTaskProjectIds;
}

/** @description Refuse missing principals before loading project records. @param ctx Runtime. @returns Caller-scoped project handler. */
export function handleGetCockpitProjects(ctx: AppContext) {
  return async (req: Request, res: Response): Promise<void> => {
    const operator = isOperator(req), caller = getCaller(req).sub;
    if (!operator && !caller) { res.status(401).json({ success: false, error: 'Authentication required' }); return; }
    try {
      const ownerSub = operator ? undefined : caller!;
      const registry = operator ? loadProjectRegistry(ctx) : new Map<string, Project>();
      const projects = new Map<string, Project>(Array.from(registry, ([id, entry]) => [id, { ...entry, ticketCount: 0 }]));
      await addTickets(ctx, req, ownerSub, projects);
      const taskIds = await addTasks(ctx, req, ownerSub, projects);
      const filtered = Array.from(projects.values()).filter(p =>
        (p.ticketCount || 0) > 0 || registry.has(p.id) || taskIds.has(p.id) || p.id === DEFAULT_PROJECT_ID);
      res.json({ success: true, projects: filtered.sort((a, b) => a.name.localeCompare(b.name)) });
    } catch {
      res.status(500).json({ success: false, error: 'Failed to load projects' });
    }
  };
}
