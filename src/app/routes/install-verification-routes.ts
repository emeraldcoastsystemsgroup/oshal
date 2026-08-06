/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | CORE-05 installer verification API: named package smokes and one PAT-only live generation with durable cost-attribution proof.
 */

import crypto from 'crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import {
  verifyAppSmokes,
  type AppSmokeFetch,
  type SwarmAppService,
} from '@/features/swarm-apps';
import { createChildLogger } from '@/shared/logger';
import {
  getCaller,
  hasValidServiceSecret,
  requiresOperator,
} from '@/shared/middleware/authz';
import { isAiDisabled, sendAiDisabled } from '@/shared/middleware/ai-availability';
import type { AppContext } from '@/app/composition/app-context';

const logger = createChildLogger({ module: 'install-verification-routes' });
const APP_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PAT_AUTHORIZATION = /^Bearer\s+oshal_pat_[a-f0-9]{48}$/;
const MAX_APPS = 64;
const LIVE_TIMEOUT_MS = 90_000;
const LIVE_PROMPT = 'Reply with exactly OSHAL_LIVE_OK and nothing else.';

/** Injectable seams are test-only; production uses loopback HTTP and random task ids. */
export interface InstallVerificationRouteOptions {
  apiBaseUrl?: string;
  fetchImpl?: AppSmokeFetch;
  randomUUID?: () => string;
}

/** @description Service secret is sufficient for install smokes; human callers must be operators. */
function serviceOrOperator(req: Request, res: Response, next: NextFunction): void {
  if (hasValidServiceSecret(req)) {
    next();
    return;
  }
  requiresOperator(req, res, next);
}

/** @description Fixed loopback base; callers cannot supply a target and turn this into an SSRF. */
function apiBaseUrl(options: InstallVerificationRouteOptions): string {
  return options.apiBaseUrl
    ?? process.env.OSHAL_INTERNAL_API_URL
    ?? `http://127.0.0.1:${process.env.PORT || '5000'}`;
}

/** @description Parse and bound a JSON app-name list, preserving request order without duplicates. */
function requestedApps(body: unknown): string[] | null {
  const value = body && typeof body === 'object' ? (body as Record<string, unknown>).apps : undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_APPS) return null;
  const names = value.map((entry) => typeof entry === 'string' ? entry.trim() : '');
  if (names.some((name) => !APP_NAME.test(name))) return null;
  return [...new Set(names)];
}

/** @description Read a bounded JSON response without leaking authorization material into errors. */
async function readJsonResponse(response: { text(): Promise<string> }): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > 256 * 1024) throw new Error('verification response exceeded 256 KiB');
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('verification response was not an object');
  return parsed as Record<string, unknown>;
}

/** @description A noop/stub marker can never satisfy an explicitly billed live proof. */
function isDishonestLiveValue(value: unknown): boolean {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return !normalized || ['noop', 'stub', 'empty'].includes(normalized) || /\b(?:noop|stub)\b/.test(normalized);
}

/**
 * @description Build installer-only verification routes. Mount behind serviceSecretOr(requiresAuth):
 * app smokes accept the machine secret, while the spend-bearing live proof additionally requires
 * an authenticated operator PAT and forwards that PAT through the ordinary /api/send-message path.
 */
export function createInstallVerificationRoutes(
  ctx: AppContext,
  swarmApps: SwarmAppService,
  options: InstallVerificationRouteOptions = {},
): Router {
  const router = Router();
  router.use(serviceOrOperator);

  /** POST /apps — execute every smoke declared by each exact installed app name. */
  router.post('/apps', async (req: Request, res: Response) => {
    const names = requestedApps(req.body);
    if (!names) {
      res.status(400).json({ error: 'apps must be a non-empty array of at most 64 package-name slugs' });
      return;
    }
    try {
      const records = await Promise.all(names.map(async (requestedName) => ({
        requestedName,
        record: await swarmApps.getApp(requestedName),
      })));
      const authorization = String(req.headers.authorization || '');
      const result = await verifyAppSmokes(records, {
        apiBaseUrl: apiBaseUrl(options),
        serviceSecret: String(process.env.SWARM_SERVICE_SECRET || '').trim() || undefined,
        ...(PAT_AUTHORIZATION.test(authorization) ? { authorization } : {}),
        noAi: isAiDisabled(),
        preOnboarding: req.body?.preOnboarding === true,
        fetchImpl: options.fetchImpl,
      });
      logger.info(
        { requestedApps: names, failedApps: result.failedApps, pendingApps: result.pendingApps },
        'Package smoke verification completed',
      );
      res.status(result.success ? 200 : 503).json(result);
    } catch (error) {
      logger.warn({ err: error, requestedApps: names }, 'Package smoke verification failed before execution');
      res.status(503).json({
        success: false,
        failedApps: names,
        pendingApps: [],
        apps: names.map((appName) => ({ appName, status: 'failed', smokes: [], error: 'verification unavailable' })),
      });
    }
  });

  /**
   * POST /live — exactly one ordinary direct-mode chat request, no retry and no tool loop. This is
   * intentionally separate from package smokes because it spends real tokens and therefore needs
   * an explicit operator PAT rather than the deployment-wide service secret.
   */
  router.post('/live', requiresOperator, async (req: Request, res: Response) => {
    const authorization = String(req.headers.authorization || '');
    if (!PAT_AUTHORIZATION.test(authorization)) {
      res.status(400).json({ error: 'live_verification_requires_pat' });
      return;
    }
    if (isAiDisabled()) {
      sendAiDisabled(res);
      return;
    }
    const ownerSub = getCaller(req).sub;
    if (!ownerSub) {
      res.status(401).json({ error: 'not_authenticated' });
      return;
    }
    const taskId = `oshal-live-verify-${(options.randomUUID ?? crypto.randomUUID)()}`;
    const startedAt = Date.now();
    try {
      const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as AppSmokeFetch);
      // One HTTP request and direct mode mean one provider generation. There is deliberately no
      // retry here: a retry would make the operator's explicit one-generation cost bound false.
      const response = await fetchImpl(new URL('/api/send-message', apiBaseUrl(options)).toString(), {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          authorization,
        },
        body: JSON.stringify({
          taskId,
          text: LIVE_PROMPT,
          agenticMode: false,
          chatOnly: true,
          interactionMode: 'chat',
          source: 'oshal-verify-live',
        }),
        signal: AbortSignal.timeout(LIVE_TIMEOUT_MS),
        redirect: 'manual',
      });
      const body = await readJsonResponse(response);
      if (response.status !== 200 || body.success !== true) {
        throw new Error(`chat generation returned HTTP ${response.status}`);
      }
      if (isDishonestLiveValue(body.response)) throw new Error('chat generation returned an empty/noop/stub result');
      const persistedTaskId = typeof body.taskIdUsed === 'string' && body.taskIdUsed ? body.taskIdUsed : taskId;
      const { rows } = await ctx.pool.query(
        `SELECT provider_id, total_input_tokens, total_output_tokens, total_cost,
                total_requests, usage_by_model
           FROM chat_tasks
          WHERE task_id = $1 AND owner_sub = $2
          LIMIT 1`,
        [persistedTaskId, ownerSub],
      );
      const row = rows[0] as Record<string, unknown> | undefined;
      const provider = typeof row?.provider_id === 'string' ? row.provider_id.trim() : '';
      const requests = Number(row?.total_requests || 0);
      const inputTokens = Number(row?.total_input_tokens || 0);
      const outputTokens = Number(row?.total_output_tokens || 0);
      if (!row || requests !== 1 || inputTokens + outputTokens <= 0 || isDishonestLiveValue(provider)) {
        throw new Error('generation did not persist one real provider request with token attribution in chat_tasks');
      }
      logger.info(
        { taskId: persistedTaskId, provider, requests, durationMs: Date.now() - startedAt },
        'Bounded live AI verification completed',
      );
      res.json({
        success: true,
        taskId: persistedTaskId,
        provider,
        requests,
        inputTokens,
        outputTokens,
        totalCost: Number(row.total_cost || 0),
        models: row.usage_by_model && typeof row.usage_by_model === 'object'
          ? Object.keys(row.usage_by_model as Record<string, unknown>)
          : [],
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      logger.warn({ err: error, taskId, durationMs: Date.now() - startedAt }, 'Bounded live AI verification failed');
      res.status(503).json({ success: false, error: (error as Error).message });
    }
  });

  return router;
}
