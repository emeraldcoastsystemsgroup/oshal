/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Workflow Studio run-history routes: GET /runs (owner-scoped list; operators may ?scope=all) + GET /runs/:runId (run detail with ordered steps, object-level access check). Mounted at /api/workflow-studio behind requiresAuth in server.ts — routes are anonymous by default in this app, so the auth gate lives at the mount. Read-only; recording is done by the dispatch-graph-worker, never by these routes.
 */

import { Router, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { WorkflowRunHistoryStore, type WorkflowRunListOptions } from '@/features/workflow-studio';
import { canAccessResource, isOperator } from '@/shared/middleware/authz';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'workflow-run-routes' });

const RunParamSchema = z.object({
  runId: z.string().uuid(),
});

/**
 * @description The authenticated caller's OIDC sub, or null when unauthenticated.
 * @param req - Express request
 * @returns the caller sub or null
 */
function callerSub(req: Request): string | null {
  return (req as { oidc?: { user?: { sub?: string } } }).oidc?.user?.sub ?? null;
}

/**
 * @description Compute owner scoping for the run list. Non-operators are ALWAYS hard-scoped to
 * their own owner_sub (plus unowned legacy rows only when OSHAL_ALLOW_LEGACY_UNOWNED=true, the
 * same compatibility switch canAccessResource honors). Operators default to their own runs and
 * may pass ?scope=all to see everyone, or ?ownerSub= to inspect one user — mirrors
 * GET /api/tickets.
 * @param req - Express request
 * @returns scoping fields for WorkflowRunListOptions
 */
function resolveListScope(req: Request): Pick<WorkflowRunListOptions, 'ownerSub' | 'includeUnowned'> {
  const sub = callerSub(req);
  const allowLegacyUnowned = (process.env.OSHAL_ALLOW_LEGACY_UNOWNED ?? 'false').toLowerCase() === 'true';
  if (isOperator(req)) {
    if (req.query.scope === 'all') return {};
    if (req.query.ownerSub) return { ownerSub: String(req.query.ownerSub), includeUnowned: false };
    return { ownerSub: sub ?? '', includeUnowned: true };
  }
  // Non-operator: own runs only; '' matches nothing when unauthenticated (fail closed).
  return { ownerSub: sub ?? '', includeUnowned: allowLegacyUnowned };
}

/**
 * @description Routes for the Workflow Studio run history + run inspector. Mount at
 * /api/workflow-studio BEHIND requiresAuth (routes are anonymous by default in this app).
 * @param deps - pool (run history requires a database) or a pre-built store (tests)
 * @returns an Express router exposing GET /runs and GET /runs/:runId
 */
export function createWorkflowRunRoutes(deps: { pool?: Pool; store?: WorkflowRunHistoryStore } = {}): Router {
  const router = Router();
  const store = deps.store ?? (deps.pool ? new WorkflowRunHistoryStore(deps.pool) : null);

  router.get('/runs', async (req: Request, res: Response) => {
    const startedAt = Date.now();
    if (!store) {
      res.status(503).json({ success: false, error: 'Run history requires a database.' });
      return;
    }
    try {
      const options: WorkflowRunListOptions = {
        ...resolveListScope(req),
        ticketType: req.query.ticketType ? String(req.query.ticketType) : undefined,
        ticketId: req.query.ticketId ? String(req.query.ticketId) : undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        offset: req.query.offset ? Number(req.query.offset) : undefined,
      };
      const runs = await store.listRuns(options);
      logger.info({ count: runs.length, scoped: options.ownerSub !== undefined, durationMs: Date.now() - startedAt }, 'Workflow run list served');
      res.json({ success: true, count: runs.length, runs });
    } catch (error) {
      logger.error({ err: error, durationMs: Date.now() - startedAt }, 'Failed to list workflow runs');
      res.status(500).json({ success: false, error: 'Failed to list workflow runs' });
    }
  });

  router.get('/runs/:runId', async (req: Request, res: Response) => {
    const startedAt = Date.now();
    if (!store) {
      res.status(503).json({ success: false, error: 'Run history requires a database.' });
      return;
    }
    try {
      const parsed = RunParamSchema.safeParse(req.params);
      if (!parsed.success) {
        res.status(400).json({ success: false, error: 'Invalid run id' });
        return;
      }
      const run = await store.getRun(parsed.data.runId);
      if (!run) {
        res.status(404).json({ success: false, error: `Workflow run not found: ${parsed.data.runId}` });
        return;
      }
      // Object-level authorization: owner, operator, or (explicitly enabled) legacy-unowned.
      if (!canAccessResource(req, run.ownerSub)) {
        res.status(404).json({ success: false, error: `Workflow run not found: ${parsed.data.runId}` });
        return;
      }
      logger.info({ runId: run.runId, steps: run.steps.length, durationMs: Date.now() - startedAt }, 'Workflow run detail served');
      res.json({ success: true, run });
    } catch (error) {
      logger.error({ err: error, runId: req.params.runId, durationMs: Date.now() - startedAt }, 'Failed to load workflow run');
      res.status(500).json({ success: false, error: 'Failed to load workflow run' });
    }
  });

  return router;
}
