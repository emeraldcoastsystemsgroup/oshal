/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added authenticated Jarvis ambient settings, text-batch, daily transcript/review, retention deletion, and proposal-queue routes.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Blocked public guest identities from enabling persistent voice profiles or selecting a private organization.
 */

import { Router, type Request, type RequestHandler } from 'express';
import type { AppContext } from '@/app/composition/app-context';
import {
  AmbientInputError,
  AmbientModeDisabledError,
  ambientListeningFor,
  type AmbientActionSuggestion,
  type AmbientDailyReview,
  type AmbientDayTranscript,
  type AmbientListeningServiceContract,
  type AmbientSettings,
  type AmbientTranscriptSegment,
} from '@/features/ambient-listening';
import { userModelFor } from '@/features/user-model';
import { createChildLogger } from '@/shared/logger';
import { isGuestRequest } from '@/shared/middleware/guest-session';

const logger = createChildLogger({ module: 'ambient-listening-routes' });

/** @description Required confirmation phrase for irreversible transcript and biometric-profile erasure. */
export const AMBIENT_DELETE_CONFIRMATION = 'DELETE AMBIENT DATA';

/** @description App-layer sink that surfaces proposals without executing the proposed action. */
export type AmbientSuggestionSink = (
  userSub: string,
  suggestion: AmbientActionSuggestion,
) => Promise<void>;

/** @description Test/deployment overrides for the ambient route composition. */
export interface AmbientListeningRouteOptions {
  service?: AmbientListeningServiceContract;
  suggestionSink?: AmbientSuggestionSink;
}

/**
 * @description Builds the authenticated Jarvis ambient router. The server mounts it behind
 * requiresAuth; handlers also fail closed when no OIDC subject is present.
 * @param ctx - App context containing the caller-scoped Postgres pool.
 * @param options - Optional service/suggestion adapters for isolated testing.
 * @returns Express router mounted at `/api/jarvis/ambient`.
 */
export function createAmbientListeningRoutes(
  ctx: Pick<AppContext, 'pool'>,
  options: AmbientListeningRouteOptions = {},
): Router {
  const router = Router();
  const service = options.service ?? ambientListeningFor(ctx.pool);
  const sink = options.suggestionSink ?? defaultSuggestionSink(ctx.pool);

  mountAmbientCaptureRoutes(router, service);
  mountAmbientReviewRoutes(router, service, sink);
  mountAmbientDeletionRoutes(router, service);
  return router;
}

function mountAmbientCaptureRoutes(router: Router, service: AmbientListeningServiceContract): void {
  router.get('/settings', ambientRoute('getSettings', async (_req, res, sub) => {
    res.json({ settings: serializeSettings(await service.getSettings(sub)) });
  }));

  router.put('/settings', ambientRoute('updateSettings', async (req, res, sub) => {
    if (isGuestRequest(req) && (req.body?.rememberSpeakers === true || req.body?.speakerTenantId)) {
      res.status(403).json({ error: 'public_tenant_profile_forbidden' });
      return;
    }
    res.json({ settings: serializeSettings(await service.updateSettings(sub, req.body)) });
  }));

  router.post('/segments', ambientRoute('appendSegments', async (req, res, sub) => {
    const result = await service.appendSegments(sub, req.body);
    res.status(201).json({
      accepted: result.accepted,
      duplicates: result.duplicates,
      segments: result.segments.map(serializeSegment),
    });
  }));

  router.get('/days/:date', ambientRoute('getDay', async (req, res, sub) => {
    res.json(serializeDay(await service.getDay(sub, String(req.params.date))));
  }));
}

function mountAmbientReviewRoutes(
  router: Router,
  service: AmbientListeningServiceContract,
  sink: AmbientSuggestionSink,
): void {
  router.post('/days/:date/review', ambientRoute('reviewDay', async (req, res, sub) => {
    const review = await service.reviewDay(sub, String(req.params.date));
    const queuedSuggestions = await queueSuggestions(sub, review.suggestions, sink);
    const serialized = serializeReview(review);
    res.json({
      review: serialized,
      summary: serialized.summary,
      suggestions: serialized.suggestions,
      proposedActions: serialized.suggestions,
      queuedSuggestions,
      actionsExecuted: 0,
    });
  }));
}

function mountAmbientDeletionRoutes(router: Router, service: AmbientListeningServiceContract): void {
  router.delete('/days/:date', ambientRoute('deleteDay', async (req, res, sub) => {
    const deletedSegments = await service.deleteDay(sub, String(req.params.date));
    res.json({ ok: true, deletedSegments });
  }));

  router.delete('/data', ambientRoute('clearTranscriptData', async (req, res, sub) => {
    if (req.body?.confirm !== AMBIENT_DELETE_CONFIRMATION) {
      throw new AmbientInputError(`confirm must equal "${AMBIENT_DELETE_CONFIRMATION}"`, 'confirmation_required');
    }
    const deleted = await service.clearTranscriptData(sub);
    res.json({ ok: true, ambientEnabled: false, ...deleted });
  }));
}

type AmbientHandler = (
  req: Request,
  res: Parameters<RequestHandler>[1],
  userSub: string,
) => Promise<void>;

function ambientRoute(operation: string, handler: AmbientHandler): RequestHandler {
  return async (req, res) => {
    const startedAt = Date.now();
    const sub = callerSub(req);
    logger.info({ operation, method: req.method, date: req.params.date }, 'Ambient route entered');
    if (!sub) {
      res.status(401).json({ error: 'sign_in_required' });
      logger.info({ operation, status: 401, durationMs: Date.now() - startedAt }, 'Ambient route completed');
      return;
    }
    try {
      await handler(req, res, sub);
      logger.info({ operation, status: res.statusCode, durationMs: Date.now() - startedAt }, 'Ambient route completed');
    } catch (error) {
      logger.error({ err: error, operation, durationMs: Date.now() - startedAt }, 'Ambient route failed');
      writeAmbientError(res, error);
    }
  };
}

function callerSub(req: Request): string | null {
  const user = (req as Request & { oidc?: { user?: { sub?: string } } }).oidc?.user;
  return user?.sub ? String(user.sub) : null;
}

function writeAmbientError(res: Parameters<RequestHandler>[1], error: unknown): void {
  if (error instanceof AmbientInputError) {
    res.status(400).json({ error: error.code, message: error.message });
    return;
  }
  if (error instanceof AmbientModeDisabledError) {
    res.status(409).json({ error: 'ambient_not_enabled', message: error.message });
    return;
  }
  res.status(500).json({ error: 'ambient_unavailable' });
}

function defaultSuggestionSink(pool: AppContext['pool']): AmbientSuggestionSink {
  return async (userSub, suggestion) => {
    const kind = suggestion.kind === 'reminder'
      ? 'ambient-reminder'
      : suggestion.kind === 'task' ? 'ambient-task' : 'ambient-follow-up';
    await userModelFor(pool).proposeSuggestion(userSub, { kind, message: suggestion.prompt });
  };
}

async function queueSuggestions(
  userSub: string,
  suggestions: AmbientActionSuggestion[],
  sink: AmbientSuggestionSink,
): Promise<number> {
  const results = await Promise.allSettled(suggestions.map((suggestion) => sink(userSub, suggestion)));
  for (const result of results) {
    if (result.status === 'rejected') {
      logger.error({ err: result.reason }, 'Ambient proposal could not be queued in the user model');
    }
  }
  return results.filter((result) => result.status === 'fulfilled').length;
}

function serializeSettings(settings: AmbientSettings): Record<string, unknown> {
  return { ...settings, updatedAt: settings.updatedAt.toISOString() };
}

function serializeSegment(segment: AmbientTranscriptSegment): Record<string, unknown> {
  return {
    ...segment,
    capturedAt: segment.capturedAt.toISOString(),
    endedAt: segment.endedAt?.toISOString() ?? null,
    createdAt: segment.createdAt.toISOString(),
  };
}

function serializeReview(review: AmbientDailyReview): Record<string, unknown> & { summary: string; suggestions: AmbientActionSuggestion[] } {
  return {
    ...review,
    createdAt: review.createdAt.toISOString(),
    updatedAt: review.updatedAt.toISOString(),
  };
}

function serializeDay(day: AmbientDayTranscript): Record<string, unknown> {
  return {
    localDate: day.localDate,
    timeZone: day.timeZone,
    segments: day.segments.map(serializeSegment),
    review: day.review ? serializeReview(day.review) : null,
  };
}
