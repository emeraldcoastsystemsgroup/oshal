/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | /api/me data-lifecycle surface: GET /export (self-scope JSON bundle — one section per store + honest manifest; a single JSON download because no zip library is a dependency and adding packages is out of scope), POST /delete-request (mints the short-lived signed confirmation token; operator subs refused up front), POST /delete-confirm (verifies the sub-bound token, executes the registry delete pass, writes the RETAINED data_lifecycle_audit row — 080-data-lifecycle.sql — and reports every store outcome). Auth-gated via the requiresAuth param, the sanctioned route-factory pattern.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Review fix: buildAllExporters is now async (per-request information_schema discovery covers every remaining sub-keyed table) — all three handlers await it; the export manifest and BOTH delete responses now carry KNOWN_EXPORT_GAPS so the stores this surface still does not cover are disclosed to the user, never implied deleted.
 */

/**
 * The self-service data-lifecycle surface. Everything here is SELF-scoped: the subject is
 * always the authenticated caller (getCaller — never the body/query), so no user can export
 * or delete another user's data regardless of what they post. Deletion is two-step
 * (request → signed token → confirm) so a single stray POST can never destroy an account,
 * and operator-allowlist accounts are refused outright.
 *
 * @module app/routes/data-lifecycle-routes
 */

import { Router, type Request, type Response, type RequestHandler } from 'express';
import type { Express } from 'express';
import type { AppContext } from '@/app/composition/app-context';
import { createChildLogger } from '@/shared/logger';
import { getCaller } from '@/shared/middleware/authz';
import {
  buildAllExporters,
  buildExportBundle,
  executeDeleteAll,
  isDeleteRefused,
  mintDeleteToken,
  verifyDeleteToken,
  KNOWN_EXPORT_GAPS,
} from '@/features/data-lifecycle';

const logger = createChildLogger({ module: 'data-lifecycle-routes' });

/**
 * @description Write the retained data_lifecycle_audit row (migration 080). The row is the
 * durable record that an export/delete happened and what each store reported — it survives
 * the deletion on purpose. Failure to record is logged at ERROR and surfaced to the caller
 * (auditRecorded:false) but does not undo the already-executed deletes.
 * @param pool - Postgres pool.
 * @param entry - Who, what, and the per-store outcomes.
 * @returns True when the audit row landed.
 */
async function writeAuditRow(
  pool: AppContext['pool'],
  entry: {
    userSub: string;
    userEmail: string | null;
    action: 'export' | 'delete';
    outcomes: Array<{ store: string; action?: string; ok?: boolean; error?: string; deleted?: number; count?: number; reason?: string }>;
  },
): Promise<boolean> {
  try {
    const deleted = entry.outcomes.filter((o) => o.action === 'deleted').length;
    const skipped = entry.outcomes.filter((o) => o.action === 'skipped').length;
    const failed = entry.outcomes.filter((o) => o.action === 'failed' || o.ok === false).length;
    await pool.query(
      `INSERT INTO data_lifecycle_audit (user_sub, user_email, action, outcomes, stores_deleted, stores_skipped, stores_failed)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)`,
      [entry.userSub, entry.userEmail, entry.action, JSON.stringify(entry.outcomes), deleted, skipped, failed],
    );
    return true;
  } catch (err) {
    logger.error({ err, stack: (err as Error).stack, action: entry.action, userSub: entry.userSub }, 'data_lifecycle_audit write FAILED');
    return false;
  }
}

/**
 * @description Build the /api/me data-lifecycle router. Mounted behind requiresAuth by
 * {@link registerDataLifecycleRoutes}; every handler additionally re-derives the subject from
 * the validated session and 401s without one (defense-in-depth for MOCK_OIDC edge shapes).
 * @param ctx - App context (Postgres pool — the GUC-wrapped one, so RLS identity is stamped).
 * @param requiresAuth - The OIDC guard from server.ts, applied to every route here.
 * @returns The router.
 */
export function createDataLifecycleRouter(ctx: AppContext, requiresAuth?: RequestHandler): Router {
  const router = Router();
  const guards: RequestHandler[] = requiresAuth ? [requiresAuth] : [];

  /** GET /export — one JSON download: manifest {generatedAt, stores, counts} + per-store sections. */
  router.get('/export', ...guards, async (req: Request, res: Response) => {
    const start = Date.now();
    const { sub, email } = getCaller(req);
    if (!sub) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const bundle = await buildExportBundle(await buildAllExporters(ctx.pool), sub, KNOWN_EXPORT_GAPS);
      // The export itself is a data access worth remembering; failure to audit never blocks it.
      void writeAuditRow(ctx.pool, {
        userSub: sub,
        userEmail: email,
        action: 'export',
        outcomes: bundle.manifest.stores.map((s) => ({
          store: s.store,
          ok: s.ok,
          ...(s.ok ? { count: s.count } : { error: s.error }),
        })),
      });
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="oshal-data-export-${new Date().toISOString().slice(0, 10)}.json"`,
      );
      res.json(bundle);
      logger.info({ sub, durationMs: Date.now() - start, stores: bundle.manifest.stores.length }, 'GET /api/me/export done');
    } catch (err) {
      logger.error({ err, stack: (err as Error).stack, sub }, 'GET /api/me/export failed');
      res.status(500).json({ error: 'export failed' });
    }
  });

  /** POST /delete-request — step 1: refuse operators, mint the short-lived signed token. */
  router.post('/delete-request', ...guards, async (req: Request, res: Response) => {
    const { sub, email } = getCaller(req);
    if (!sub) { res.status(401).json({ error: 'unauthorized' }); return; }
    const refusal = isDeleteRefused(sub, email);
    if (refusal) {
      logger.warn({ sub }, 'delete-request refused: operator account');
      res.status(403).json({ error: 'operator-account', message: refusal });
      return;
    }
    const minted = mintDeleteToken(sub);
    if (!minted) {
      // No signing secret => an unsigned confirmation would be forgeable. Fail closed.
      res.status(503).json({ error: 'delete unavailable', message: 'No signing secret configured (SESSION_SECRET); deletion confirmation cannot be issued.' });
      return;
    }
    try {
      const exporters = await buildAllExporters(ctx.pool);
      logger.info({ sub, expiresAt: minted.expiresAt }, 'delete-request: token minted');
      res.json({
        token: minted.token,
        expiresAt: minted.expiresAt,
        confirmVia: 'POST /api/me/delete-confirm with body {"token": "<this token>"}',
        stores: exporters.map((e) => ({
          store: e.store,
          deletable: e.deletable,
          ...(e.deleteNote ? { note: e.deleteNote } : {}),
        })),
        // Stores the platform holds that this surface does NOT cover — disclosed up front.
        knownGaps: KNOWN_EXPORT_GAPS,
      });
    } catch (err) {
      logger.error({ err, stack: (err as Error).stack, sub }, 'POST /api/me/delete-request failed (store discovery)');
      res.status(500).json({ error: 'delete-request failed' });
    }
  });

  /** POST /delete-confirm {token} — step 2: verify, delete via the registry, retain the audit row. */
  router.post('/delete-confirm', ...guards, async (req: Request, res: Response) => {
    const start = Date.now();
    const { sub, email } = getCaller(req);
    if (!sub) { res.status(401).json({ error: 'unauthorized' }); return; }
    const refusal = isDeleteRefused(sub, email);
    if (refusal) {
      logger.warn({ sub }, 'delete-confirm refused: operator account');
      res.status(403).json({ error: 'operator-account', message: refusal });
      return;
    }
    const token = typeof req.body?.token === 'string' ? req.body.token : null;
    if (!token) { res.status(400).json({ error: 'token required', message: 'POST {"token": ...} from /api/me/delete-request.' }); return; }
    if (!verifyDeleteToken(token, sub)) {
      logger.warn({ sub }, 'delete-confirm: invalid or expired token');
      res.status(403).json({ error: 'invalid token', message: 'Token is invalid, expired, or was issued for a different account. Request a new one.' });
      return;
    }
    try {
      const outcomes = await executeDeleteAll(await buildAllExporters(ctx.pool), sub);
      const auditRecorded = await writeAuditRow(ctx.pool, { userSub: sub, userEmail: email, action: 'delete', outcomes });
      logger.info({ sub, durationMs: Date.now() - start, outcomes, auditRecorded }, 'POST /api/me/delete-confirm executed');
      // knownGaps: what was NOT deleted because no exporter covers it yet — success must never imply it was.
      res.json({ executedAt: new Date().toISOString(), outcomes, knownGaps: KNOWN_EXPORT_GAPS, auditRecorded });
    } catch (err) {
      logger.error({ err, stack: (err as Error).stack, sub }, 'POST /api/me/delete-confirm failed');
      res.status(500).json({ error: 'delete failed' });
    }
  });

  return router;
}

/**
 * @description Register the /api/me data-lifecycle routes. Call from server.ts; this module
 * does NOT mount itself (mirrors registerAuditExportRoutes). Express mount matching is
 * segment-bounded, so /api/me never shadows /api/memory.
 * @param app - Express app.
 * @param ctx - App context (pool).
 * @param requiresAuth - The OIDC guard; MUST be passed — every route here reads/destroys personal data.
 */
export function registerDataLifecycleRoutes(app: Express, ctx: AppContext, requiresAuth: RequestHandler): void {
  app.use('/api/me', createDataLifecycleRouter(ctx, requiresAuth));
  logger.info('Data-lifecycle routes registered at /api/me (export, delete-request, delete-confirm)');
}
