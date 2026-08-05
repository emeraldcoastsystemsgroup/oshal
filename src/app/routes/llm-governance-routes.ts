/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | NEW: read-only admin route exposing LLM governance status (enforcement on/off, caps, today spend vs cap per scope). Additive; registered by a maintainer in server.ts.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Update docs/ paths after docs directory consolidation.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Make the machine-only governance check fail closed when no internal signing secret is configured and compare presented credentials in constant time, preventing an unconfigured public quota-exhaustion path and timing oracle.
 */

/**
 * @description
 * Read-only admin router for the additive LLM governance layer. Surfaces:
 *  - whether enforcement is on (OSHAL_LLM_BUDGETS),
 *  - the configured budget caps, quota caps, and routing policy,
 *  - today's spend vs cap per scope (read READ-ONLY through BudgetService).
 *
 * This router NEVER mutates anything. It is exported but NOT self-registered;
 * a maintainer mounts it in server.ts (see docs/architecture/model-gateway.md).
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import type { Express, Request, RequestHandler, Response } from 'express';
import { createChildLogger } from '@/shared/logger';
import {
  BudgetService,
  readBudgetConfig,
  type BudgetScope,
  readQuotaConfig,
  readRoutingConfig,
  gateLlmCall,
  recordGateUsage,
  estimateProjectedCostUsd,
} from '@/features/llm-provider';

const VALID_SCOPES: ReadonlySet<string> = new Set(['global', 'day', 'owner_sub', 'bot']);

/**
 * @description Shared-secret guard for the internal /check endpoint. Bots call
 * it across the docker network; it must not be abusable publicly (recording
 * usage from an unauthenticated caller would be a quota-exhaustion DoS). The
 * endpoint stays closed until a secret is configured, including in development.
 * Comparing fixed-length digests avoids leaking the secret length or prefix.
 */
function internalCallerAllowed(req: Request): boolean {
  const secret = process.env.OSHAL_INTERNAL_TOKEN || process.env.SESSION_SECRET || '';
  const presented = req.get('x-oshal-internal');
  if (!secret || !presented) return false;
  const expectedDigest = createHash('sha256').update(secret).digest();
  const presentedDigest = createHash('sha256').update(presented).digest();
  return timingSafeEqual(presentedDigest, expectedDigest);
}

const logger = createChildLogger({ module: 'llm-governance-routes' });

/**
 * @description Minimal context this router needs: a Postgres pool for the
 * read-only spend lookup. Compatible with the full AppContext (which exposes
 * `pool`) without importing it, so this file stays dependency-light.
 */
interface LlmGovernanceRouteContext {
  pool?: import('pg').Pool | null;
}

/**
 * @description Registers the read-only LLM governance admin endpoints.
 *
 * @param app - Express application.
 * @param ctx - Application context (only `pool` is used).
 * @param requiresAuth - Optional auth middleware. Passed through when provided so
 *   the maintainer can gate the endpoint like the other /api routes.
 */
export function registerLlmGovernanceRoutes(
  app: Express,
  ctx: LlmGovernanceRouteContext,
  requiresAuth?: RequestHandler,
): void {
  const handlers: RequestHandler[] = requiresAuth ? [requiresAuth] : [];

  /**
   * @route GET /api/llm-governance/status
   * @description Current governance posture: enforcement flag, caps, routing
   * policy, and today's spend vs cap for each budget scope.
   */
  app.get('/api/llm-governance/status', ...handlers, async (_req: Request, res: Response) => {
    const startedAt = Date.now();
    try {
      const budgetConfig = readBudgetConfig();
      const quotaConfig = readQuotaConfig();
      const routingConfig = readRoutingConfig();

      const enforcementOn = budgetConfig.enabled || quotaConfig.enabled || routingConfig.enabled;

      const budgetService = new BudgetService(ctx.pool ?? null, budgetConfig);
      const scopes: BudgetScope[] = ['global', 'day', 'owner_sub', 'bot'];

      // For status we report today's GLOBAL/day spend against each cap. Per-key
      // (owner/bot) spend is left to a future drill-down; here we surface the
      // configured cap and the day-level spend so an operator can see headroom.
      const todaySpend = await budgetService.readTodaySpendUsd('global', '');

      const perScope = scopes.map((scope) => {
        const capUsd = budgetService.capForScope(scope);
        const spentUsd = todaySpend ?? null;
        return {
          scope,
          capUsd,
          spentUsd,
          remainingUsd: capUsd !== null && spentUsd !== null ? Math.max(capUsd - spentUsd, 0) : null,
          overCap: capUsd !== null && spentUsd !== null ? spentUsd >= capUsd : false,
        };
      });

      res.json({
        ok: true,
        data: {
          enforcement: {
            on: enforcementOn,
            budgets: budgetConfig.enabled,
            quotas: quotaConfig.enabled,
            routing: routingConfig.enabled,
            envFlag: 'OSHAL_LLM_BUDGETS',
          },
          budget: {
            globalDailyUsd: budgetConfig.globalDailyUsd,
            perOwnerDailyUsd: budgetConfig.perOwnerDailyUsd,
            perBotDailyUsd: budgetConfig.perBotDailyUsd,
            cacheTtlMs: budgetConfig.cacheTtlMs,
          },
          quota: {
            windowMs: quotaConfig.windowMs,
            maxRequestsPerWindow: quotaConfig.maxRequestsPerWindow,
            maxTokensPerWindow: quotaConfig.maxTokensPerWindow,
          },
          routing: {
            policy: routingConfig.policy,
            nearCapThreshold: routingConfig.nearCapThreshold,
          },
          spendToday: {
            asOf: new Date().toISOString(),
            available: todaySpend !== null,
            perScope,
          },
        },
      });
      logger.info({ durationMs: Date.now() - startedAt, enforcementOn }, 'GET /api/llm-governance/status');
    } catch (err) {
      logger.error({ err, durationMs: Date.now() - startedAt }, 'Failed to build LLM governance status');
      res.status(500).json({ ok: false, error: 'Failed to build governance status' });
    }
  });

  /**
   * @route POST /api/llm-governance/check
   * @description The model-gateway pre-flight. Bots (any-bot generateResponse)
   * call this BEFORE an LLM call so every call is metered at one place — the
   * controller — which centralizes the quota window across the whole worker
   * fleet. Runs the shared governance gate (budget + quota + cost-aware routing)
   * and, on allow, records the projected usage against the shared quota window.
   *
   * Off by default: when OSHAL_LLM_BUDGETS is unset the gate returns
   * { allowed: true, model: requestedModel } and recording is a no-op, so a bot
   * that calls this on every request pays only the round-trip until enforcement
   * is enabled.
   *
   * INTERNAL: guarded by a shared secret (x-oshal-internal), NOT OIDC, so the
   * bot nodes can reach it on the docker network. Never mounted behind
   * requiresAuth.
   */
  app.post('/api/llm-governance/check', async (req: Request, res: Response) => {
    if (!internalCallerAllowed(req)) {
      res.status(403).json({ ok: false, error: 'forbidden' });
      return;
    }
    try {
      const body = (req.body ?? {}) as {
        requestedModel?: string;
        scope?: string;
        key?: string;
        projectedCostUsd?: number;
        estTokens?: number;
      };
      const requestedModel = typeof body.requestedModel === 'string' ? body.requestedModel : '';
      const scope = (VALID_SCOPES.has(body.scope ?? '') ? body.scope : 'global') as BudgetScope;
      const key = typeof body.key === 'string' && body.key ? body.key : 'global';
      const estTokens = Number.isFinite(body.estTokens) && (body.estTokens ?? 0) > 0 ? (body.estTokens as number) : 0;
      // Prefer a caller-supplied projection; otherwise estimate it HERE from the
      // token estimate + model so pricing stays on the controller (single source
      // of truth — bots never carry a pricing table).
      const projectedCostUsd = Number.isFinite(body.projectedCostUsd) && (body.projectedCostUsd ?? 0) > 0
        ? (body.projectedCostUsd as number)
        : estimateProjectedCostUsd({ modelId: requestedModel, inputTokens: estTokens, outputTokens: 0 });

      const decision = await gateLlmCall(
        { requestedModel, scope, key, projectedCostUsd },
        ctx.pool ?? null,
      );

      // Record the projected usage against the shared (fleet-wide) quota window
      // when allowed, so sliding-window request/token quotas actually accumulate
      // across all worker calls. No-op when enforcement is off.
      if (decision.allowed) {
        recordGateUsage(scope, key, estTokens);
      }

      res.json({
        ok: true,
        allowed: decision.allowed,
        model: decision.model,
        downshiftedFrom: decision.downshiftedFrom,
        reason: decision.reason,
      });
    } catch (err) {
      // Fail OPEN: a gate error must not break the bot's call path.
      logger.error({ err }, 'POST /api/llm-governance/check failed — failing open (allowed)');
      res.json({ ok: true, allowed: true, model: (req.body?.requestedModel ?? ''), downshiftedFrom: null, reason: 'gate-error-open' });
    }
  });
}
