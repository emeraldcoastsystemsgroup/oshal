/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-100 Phase 1: authenticated ambient person-model recall route — GET /recall answers "how many times has <person> mentioned <topic> today" with a literal count + quoted receipts. Auth-gated (exposes personal transcript data); handlers fail closed without an OIDC subject.
 */

import { Router, type Request, type RequestHandler } from 'express';
import path from 'path';
import type { AppContext } from '@/app/composition/app-context';
import {
  detectRecallIntent,
  recallQuery,
  buildRecallReceiptsBlock,
  getOpenAsks,
  updateAskStatus,
  listPersonConsentStatus,
  recordConsent,
  type RecallIntent,
} from '@/features/person-model';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'person-model-routes' });

/**
 * @description Builds the authenticated ambient person-model router. The server mounts it behind
 * requiresAuth; handlers also fail closed when no OIDC subject is present (transcript data is private).
 * @param ctx - App context carrying the caller-scoped Postgres pool.
 * @returns Express router mounted at `/api/jarvis/ambient/person`.
 */
export function createPersonModelRoutes(ctx: Pick<AppContext, 'pool'>): Router {
  const router = Router();
  const apiDir = path.resolve(process.cwd(), 'src/api');

  // GET / — the Ambient Recall surface (the extension app's face).
  router.get('/', (_req, res) => {
    res.sendFile(path.join(apiDir, 'person-model.html'), (err) => {
      if (err) { logger.error({ err }, 'person-model surface serve failed'); res.status(404).end(); }
    });
  });

  // GET /recall?q=<natural question>  OR  ?person=Ella&terms=volleyball&range=today|all
  router.get('/recall', personRoute('recall', async (req, res, sub) => {
    const intent = parseIntent(req);
    if (!intent) {
      res.status(400).json({ error: 'unrecognized_recall', message: 'Provide ?q=<question> or ?person= & ?terms=.' });
      return;
    }
    const result = await recallQuery(ctx.pool, sub, intent);
    res.json({
      intent,
      resolved: result.personResolved,
      personLabel: result.personLabel,
      count: result.count,
      range: result.range,
      terms: result.terms,
      receipts: result.receipts,
      factsBlock: buildRecallReceiptsBlock(intent, result),
    });
  }));

  // GET /asks?person=Ella — open asks/commitments, each beside its verbatim source quote.
  router.get('/asks', personRoute('asks', async (req, res, sub) => {
    const personName = typeof req.query.person === 'string' ? req.query.person : undefined;
    res.json({ asks: await getOpenAsks(ctx.pool, sub, { personName }) });
  }));

  // POST /asks/:askId/status { status: 'done' | 'dismissed' | 'open' } — user state, never model-written.
  router.post('/asks/:askId/status', personRoute('updateAsk', async (req, res, sub) => {
    const status = req.body?.status;
    if (status !== 'done' && status !== 'dismissed' && status !== 'open') {
      res.status(400).json({ error: 'invalid_status' });
      return;
    }
    const updated = await updateAskStatus(ctx.pool, sub, String(req.params.askId), status);
    res.status(updated ? 200 : 404).json({ updated });
  }));

  // GET /consents — each heard voice with its current modeling posture (for Manage Voices).
  router.get('/consents', personRoute('listConsents', async (_req, res, sub) => {
    res.json({ consents: await listPersonConsentStatus(ctx.pool, sub) });
  }));

  // POST /consents { profileId, status, isMinor?, scope? } — record a per-person modeling decision.
  // A 'declined' also purges that person's already-derived data (handled in recordConsent).
  router.post('/consents', personRoute('recordConsent', async (req, res, sub) => {
    const { profileId, status, isMinor, scope } = req.body ?? {};
    if (typeof profileId !== 'string' || !profileId) { res.status(400).json({ error: 'profile_required' }); return; }
    if (status !== 'granted' && status !== 'declined' && status !== 'revoked') {
      res.status(400).json({ error: 'invalid_status' });
      return;
    }
    await recordConsent(ctx.pool, sub, {
      profileId, status, isMinor: isMinor === true,
      scope: scope === 'voiceprint' ? 'voiceprint' : 'transcript', method: 'owner_attested',
    });
    res.json({ recorded: true });
  }));

  return router;
}

/** Builds a RecallIntent from either a free-text `q` or explicit person/terms/range params. */
function parseIntent(req: Request): RecallIntent | null {
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  if (q.trim()) return detectRecallIntent(q);
  const person = typeof req.query.person === 'string' ? req.query.person.trim() : '';
  const terms = typeof req.query.terms === 'string' ? req.query.terms.trim() : '';
  if (!person && !terms) return null;
  const range = req.query.range === 'all' ? 'all' : 'today';
  const wantsPlayback = req.query.playback === '1' || req.query.playback === 'true';
  return { personName: person, terms, range, wantsPlayback };
}

type PersonHandler = (req: Request, res: Parameters<RequestHandler>[1], sub: string) => Promise<void>;

/** Wraps a handler with caller-sub resolution, entry/exit logging, and a fail-closed 401. */
function personRoute(operation: string, handler: PersonHandler): RequestHandler {
  return async (req, res) => {
    const startedAt = Date.now();
    const sub = callerSub(req);
    logger.info({ operation, method: req.method }, 'Person-model route entered');
    if (!sub) {
      res.status(401).json({ error: 'sign_in_required' });
      return;
    }
    try {
      await handler(req, res, sub);
      logger.info({ operation, status: res.statusCode, durationMs: Date.now() - startedAt }, 'Person-model route completed');
    } catch (error) {
      logger.error({ err: error, operation, durationMs: Date.now() - startedAt }, 'Person-model route failed');
      res.status(500).json({ error: 'person_model_unavailable' });
    }
  };
}

/** Resolves the authenticated OIDC subject, or null. */
function callerSub(req: Request): string | null {
  const user = (req as Request & { oidc?: { user?: { sub?: string } } }).oidc?.user;
  return user?.sub ? String(user.sub) : null;
}
