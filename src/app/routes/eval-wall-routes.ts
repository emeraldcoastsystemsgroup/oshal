/**
 * Eval Wall — read-only API for the green-wall dashboard (ADR-063 §eval-wall).
 *
 * Exposes the persisted eval_runs history (eval-results-store) as a rollup + a recent-rows
 * feed the /api/eval-wall/app surface renders. Read-only: it never mutates eval state, it only
 * reports. Cost/latency/quality are pulled straight from eval_runs; any field that was never
 * measured comes back as null (the store + rollup keep honest nulls, no fabricated numbers).
 *
 * Registration follows the register(app, ctx) shape requested by the wiring contract — it mounts
 * itself under /api/eval-wall behind the app's auth guard. It does NOT self-register; server.ts
 * calls registerEvalWallRoutes(app, ctx) once (see the wiring snippet in the task report).
 *
 * CHANGE LOG
 * ---------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — summary + runs read endpoints.
 * ---------------------------------------------------------------------------
 * @module eval-wall-routes
 */

import { Router, type Express, type Request, type Response, type RequestHandler } from 'express';
import * as path from 'path';
import { createChildLogger } from '@/shared/logger';
import type { AppContext } from '@/app/composition/app-context';
import { queryEvalRuns, computeGreenWall, computeEvalTrend } from '@/features/operational-intelligence';

const logger = createChildLogger({ module: 'eval-wall-routes' });

/** Resolve how many days back the wall should consider (default 30, clamped 1..365). */
function windowDays(req: Request): number {
  const raw = parseInt(String(req.query.days ?? '30'), 10);
  if (!Number.isFinite(raw)) return 30;
  return Math.max(1, Math.min(365, raw));
}

/** The signed-in caller's subject (OIDC sub/oid), or null — mirrors the security routes' helper. */
function callerSub(req: Request): string | null {
  const u = (req as { oidc?: { user?: { sub?: string; oid?: string } } }).oidc?.user;
  const sub = u?.sub || u?.oid;
  return sub ? String(sub) : null;
}

/** Live security posture: the real open-findings count from the Security Center for THIS viewer. */
interface SecurityPosture {
  openFindings: number;
  critical: number;
  high: number;
  clean: boolean;          // no open critical/high findings
  lastScanAt: string | null;
  measured: boolean;       // a scan has actually run (else posture is "not measured", not "clean")
}

/**
 * Read the viewer's latest security posture straight from the Security Center's own tables
 * (oshal_security_findings / oshal_security_scans). This is the SAME central store the Security
 * Center writes to — the eval wall just reads it, so posture reflects the live system, not a
 * per-eval-run field. Returns null (→ "not measured") if the security tables aren't present yet.
 */
async function readSecurityPosture(ctx: AppContext, sub: string | null): Promise<SecurityPosture | null> {
  if (!sub) return null;
  try {
    const counts = await ctx.pool.query(
      `SELECT COUNT(*)::int AS open,
              COUNT(*) FILTER (WHERE severity='critical')::int AS critical,
              COUNT(*) FILTER (WHERE severity='high')::int AS high
         FROM oshal_security_findings
        WHERE user_sub = $1 AND status = 'open'`,
      [sub],
    );
    const scan = await ctx.pool.query(
      `SELECT started_at FROM oshal_security_scans
        WHERE user_sub = $1 AND status = 'complete' ORDER BY started_at DESC LIMIT 1`,
      [sub],
    );
    const row = counts.rows[0] || { open: 0, critical: 0, high: 0 };
    const lastScanAt = scan.rows[0]?.started_at
      ? (scan.rows[0].started_at instanceof Date ? scan.rows[0].started_at.toISOString() : String(scan.rows[0].started_at))
      : null;
    return {
      openFindings: Number(row.open) || 0,
      critical: Number(row.critical) || 0,
      high: Number(row.high) || 0,
      clean: (Number(row.critical) || 0) + (Number(row.high) || 0) === 0,
      lastScanAt,
      measured: lastScanAt !== null,
    };
  } catch {
    // Security Center tables not present / not scanned — honest "not measured".
    return null;
  }
}

/** Serve the self-contained surface from src/pages/eval-wall/index.html. */
function serveSurface(): RequestHandler {
  return (_req: Request, res: Response) => {
    const filePath = path.resolve(process.cwd(), 'src/pages/eval-wall/index.html');
    res.sendFile(filePath, (err: unknown) => {
      if (err) { logger.error({ err }, 'failed to serve eval-wall surface'); res.status(404).send('eval-wall surface not found'); }
    });
  };
}

/**
 * Build the eval-wall router (read-only). Exported separately so it can be mounted with a
 * caller-chosen auth guard; registerEvalWallRoutes wires it with the app's requiresAuth.
 */
export function createEvalWallRoutes(ctx: AppContext): Router {
  const router = Router();

  /** Rollup over the recent window: success rate, cost, latency, retries, quality, posture. */
  router.get('/summary', async (req: Request, res: Response) => {
    try {
      const days = windowDays(req);
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
      const runs = await queryEvalRuns(ctx.pool, { since, limit: 1000 });
      const wall = computeGreenWall(runs);
      // Overlay the LIVE security posture (read from the Security Center's own store) so the
      // posture tile reflects the real current system, not the per-run securityFindings field.
      const securityPosture = await readSecurityPosture(ctx, callerSub(req));
      if (securityPosture && securityPosture.measured) {
        wall.postureSummary = {
          totalSecurityFindings: securityPosture.openFindings,
          runsWithFindings: securityPosture.openFindings,
          clean: securityPosture.clean,
        };
      }
      // Per-day success-rate trend for the sparkline — computed from the same runs, no extra query.
      const trend = computeEvalTrend(runs);
      res.json({ windowDays: days, since, ...wall, securityPosture, trend });
    } catch (err) {
      logger.warn({ err }, 'eval-wall summary failed');
      res.status(500).json({ error: 'failed to compute eval-wall summary' });
    }
  });

  /** Recent eval rows (newest first), default 100. */
  router.get('/runs', async (req: Request, res: Response) => {
    try {
      const limit = Math.max(1, Math.min(1000, parseInt(String(req.query.limit ?? '100'), 10) || 100));
      const runs = await queryEvalRuns(ctx.pool, { limit });
      res.json({ runs });
    } catch (err) {
      logger.warn({ err }, 'eval-wall runs failed');
      res.status(500).json({ error: 'failed to read eval-wall runs' });
    }
  });

  /** The dashboard surface itself. */
  router.get('/app', serveSurface());

  return router;
}

/**
 * Mount the eval-wall API on the app. server.ts should call this once, after ctx is built,
 * passing the same requiresAuth guard used by the other /api routes.
 *
 * Usage (server.ts):
 *   import { registerEvalWallRoutes } from './routes/eval-wall-routes';
 *   registerEvalWallRoutes(app, ctx, requiresAuth);
 *
 * The auth guard is optional so this stays drop-in for environments that gate at a higher
 * layer; when omitted the router mounts unguarded (matching the caller's existing pattern).
 */
export function registerEvalWallRoutes(app: Express, ctx: AppContext, requiresAuth?: RequestHandler): void {
  const router = createEvalWallRoutes(ctx);
  if (requiresAuth) {
    app.use('/api/eval-wall', requiresAuth, router);
  } else {
    app.use('/api/eval-wall', router);
  }
  logger.info('eval-wall routes mounted at /api/eval-wall');
}
