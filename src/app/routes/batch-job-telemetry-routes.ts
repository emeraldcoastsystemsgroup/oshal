/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial auth-gated batch Job telemetry routes for recent-run JSON and a user-facing runtime graph/report page.
 */

import { Router, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import * as path from 'path';
import { BatchJobTelemetryStore, type BatchTelemetryListOptions } from '@/features/batch-job-telemetry';
import { canAccessResource, isOperator } from '@/shared/middleware/authz';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'batch-job-telemetry-routes' });

/**
 * @description Routes for batch Job telemetry. Mount behind requiresAuth.
 * @param deps - Postgres pool plus the repo API directory for static HTML.
 * @returns Express router exposing recent JSON and a report surface.
 */
export function createBatchJobTelemetryRoutes(deps: { pool?: Pool; apiDir: string }): Router {
  const router = Router();
  const store = deps.pool ? new BatchJobTelemetryStore(deps.pool) : null;

  router.get('/recent', async (req: Request, res: Response) => {
    const startedAt = Date.now();
    if (!store) {
      res.status(503).json({ success: false, error: 'Batch job telemetry requires a database.' });
      return;
    }
    try {
      const runs = await store.listRecent(resolveListOptions(req));
      logger.info({ count: runs.length, durationMs: Date.now() - startedAt }, 'Batch job telemetry served');
      res.json({ success: true, count: runs.length, runs, gaps: currentCaptureGaps() });
    } catch (error) {
      logger.error({ err: error, durationMs: Date.now() - startedAt }, 'Failed to load batch job telemetry');
      res.status(500).json({ success: false, error: 'Failed to load batch job telemetry' });
    }
  });

  router.get('/report', (_req: Request, res: Response) => {
    res.sendFile(path.join(deps.apiDir, 'batch-job-telemetry.html'));
  });

  return router;
}

function resolveListOptions(req: Request): BatchTelemetryListOptions {
  const sub = (req as { oidc?: { user?: { sub?: string } } }).oidc?.user?.sub ?? '';
  const options: BatchTelemetryListOptions = {
    since: parseDate(req.query.since),
    until: parseDate(req.query.until),
    ticketId: req.query.ticketId ? String(req.query.ticketId) : undefined,
    limit: req.query.limit ? Number(req.query.limit) : undefined,
  };
  if (isOperator(req) && req.query.scope === 'all') return options;
  if (isOperator(req) && req.query.ownerSub) return { ...options, ownerSub: String(req.query.ownerSub) };
  return { ...options, ownerSub: sub, includeUnowned: canAccessResource(req, null) };
}

function parseDate(value: unknown): Date | undefined {
  if (!value) return undefined;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function currentCaptureGaps(): string[] {
  return [
    'Historical batch Jobs before 2026-07-18 only have logs/chat_tasks where available; oshal_batch_job_runs starts at this release.',
    'CPU request is captured only when the Job template exports CPU_REQUEST or K8S_CPU_REQUEST; Kubernetes Downward API wiring is recommended.',
    'CPU limit is read from env or local cgroup files; Kubernetes Metrics Server samples are not yet joined for pod-level CPU over time.',
  ];
}
