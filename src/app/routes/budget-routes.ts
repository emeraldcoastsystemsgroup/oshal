/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial /api/budgets surface for the cost-governance slice: list/set spend budgets + a windowed spend read. Auth-gated (requiresAuth param, the sanctioned factory pattern); cross-user scopes are operator-only via the OSHAL_OPERATOR_SUBS/EMAILS allowlist — a non-operator can list/set/read ONLY their own 'user'-scope budget, so one user's caps and spend never leak to another.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Ops-rails read surface: GET /api/budgets/state — a requiresOperator-gated, read-only governance snapshot (every cap with its trailing-window spend + the recent oshal_budget_events enforcement trail). Fail-open (BudgetService semantics). This is the tool-budgets operator rail; it never mutates and never enforces.
 */

import { Router, type Request, type Response, type RequestHandler } from 'express';
import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { getCaller, isOperator, requiresOperator } from '@/shared/middleware/authz';
import {
  BudgetService,
  BUDGET_SCOPE_TYPES,
  type BudgetCaller,
  type BudgetScopeType,
} from '@/features/cost-governance';

const logger = createChildLogger({ module: 'budget-routes' });

/** @description Dependencies for the budget routes. `service` is injectable for tests. */
export interface BudgetRoutesDeps {
  pool: Pool | null;
  service?: BudgetService;
}

/**
 * @description Derives the service-facing caller from the validated OIDC session.
 * Identity is NEVER read from body/query — only req.oidc (authz.getCaller) — so a
 * caller cannot impersonate another sub by posting it.
 * @param req - The authenticated Express request.
 * @returns The caller identity + operator flag.
 */
function callerFrom(req: Request): BudgetCaller {
  const { sub } = getCaller(req);
  return { sub, operator: isOperator(req) };
}

/**
 * @description Parses + validates a POST /api/budgets body. Returns null (caller sends 400)
 * on any invalid field rather than trusting partial input into a governance table.
 * @param body - The raw request body.
 * @returns The validated input or null.
 */
export function parseSetBudgetBody(body: unknown): {
  scopeType: BudgetScopeType; scopeKey: string; dailyUsd: number; hard: boolean; enabled: boolean;
} | null {
  const b = (body ?? {}) as Record<string, unknown>;
  const scopeType = String(b.scopeType ?? '');
  const scopeKey = typeof b.scopeKey === 'string' ? b.scopeKey.trim() : '';
  const dailyUsd = Number(b.dailyUsd);
  if (!(BUDGET_SCOPE_TYPES as readonly string[]).includes(scopeType)) return null;
  if (!scopeKey || scopeKey.length > 512) return null;
  if (!Number.isFinite(dailyUsd) || dailyUsd < 0) return null;
  return {
    scopeType: scopeType as BudgetScopeType,
    scopeKey,
    dailyUsd,
    hard: b.hard === true,
    enabled: b.enabled !== false, // default TRUE — setting a cap without enabling it is a footgun
  };
}

/**
 * @description Parses GET /api/budgets/spend query params. Accepts either
 * `?scope=<type>:<key>` (compact) or `?scopeType=&scopeKey=` (explicit), plus an optional
 * `windowHours` clamped to 1..720 (default 24, matching the daily-cap window).
 * @param query - The raw request query bag.
 * @returns The validated scope + window or null.
 */
export function parseSpendQuery(query: Record<string, unknown>): {
  scopeType: BudgetScopeType; scopeKey: string; windowHours: number;
} | null {
  let scopeType = String(query.scopeType ?? '');
  let scopeKey = String(query.scopeKey ?? '');
  const compact = String(query.scope ?? '');
  if (compact && (!scopeType || !scopeKey)) {
    const idx = compact.indexOf(':');
    if (idx > 0) {
      scopeType = compact.slice(0, idx);
      scopeKey = compact.slice(idx + 1);
    }
  }
  scopeKey = scopeKey.trim();
  if (!(BUDGET_SCOPE_TYPES as readonly string[]).includes(scopeType) || !scopeKey) return null;
  const rawHours = Number(query.windowHours ?? 24);
  const windowHours = Number.isFinite(rawHours) ? Math.min(720, Math.max(1, Math.floor(rawHours))) : 24;
  return { scopeType: scopeType as BudgetScopeType, scopeKey, windowHours };
}

/**
 * @description Builds the /api/budgets router (mount: `app.use('/api/budgets', createBudgetRoutes(requiresAuth, { pool: ctx.pool }))`).
 * Every endpoint sits behind `requiresAuth`; cross-user reads/writes additionally require the
 * operator allowlist. Non-operators may only touch their OWN 'user'-scope budget + spend.
 * @param requiresAuth - The app-level OIDC auth middleware (sanctioned param pattern).
 * @param deps - Postgres pool (null tolerated: endpoints degrade per BudgetService semantics).
 * @returns The configured Express router.
 */
export function createBudgetRoutes(requiresAuth: RequestHandler, deps: BudgetRoutesDeps): Router {
  const router = Router();
  const service = deps.service ?? new BudgetService(deps.pool);
  router.use(requiresAuth);

  // List budgets visible to the caller (operator: all; user: own 'user' row only).
  router.get('/', async (req: Request, res: Response) => {
    const startedAt = Date.now();
    try {
      const caller = callerFrom(req);
      const budgets = await service.getBudgets(caller);
      logger.info({ sub: caller.sub, operator: caller.operator, count: budgets.length, durationMs: Date.now() - startedAt }, 'GET /api/budgets');
      res.json({ success: true, budgets });
    } catch (err) {
      logger.error({ err }, 'GET /api/budgets failed');
      res.status(500).json({ success: false, error: 'Failed to list budgets' });
    }
  });

  // Create/update a budget. Authorization lives in BudgetService.setBudget (operator: any
  // scope; user: own 'user' scope only) so the rule holds for every future caller too.
  router.post('/', async (req: Request, res: Response) => {
    const startedAt = Date.now();
    try {
      const input = parseSetBudgetBody(req.body);
      if (!input) {
        res.status(400).json({ success: false, error: 'Invalid budget: need scopeType (user|app|ticket), scopeKey, dailyUsd >= 0' });
        return;
      }
      const caller = callerFrom(req);
      const result = await service.setBudget(caller, input);
      if (!result.ok) {
        const status = result.error === 'forbidden' ? 403 : 503;
        res.status(status).json({ success: false, error: result.error === 'forbidden' ? 'Operator privilege required for this scope' : 'Budget store unavailable' });
        return;
      }
      logger.info({ sub: caller.sub, scopeType: input.scopeType, hard: input.hard, durationMs: Date.now() - startedAt }, 'POST /api/budgets upserted');
      res.json({ success: true, budget: result.budget });
    } catch (err) {
      logger.error({ err }, 'POST /api/budgets failed');
      res.status(500).json({ success: false, error: 'Failed to set budget' });
    }
  });

  // Windowed spend read. Cross-user scopes (app, ticket, another user) are operator-only:
  // spend numbers reveal another user's activity, so scope to self unless allowlisted.
  router.get('/spend', async (req: Request, res: Response) => {
    const startedAt = Date.now();
    try {
      const parsed = parseSpendQuery(req.query as Record<string, unknown>);
      if (!parsed) {
        res.status(400).json({ success: false, error: 'Invalid scope: use ?scope=<user|app|ticket>:<key> or ?scopeType=&scopeKey= (+ optional windowHours 1..720)' });
        return;
      }
      const caller = callerFrom(req);
      const selfRead = parsed.scopeType === 'user' && caller.sub !== null && parsed.scopeKey === caller.sub;
      if (!caller.operator && !selfRead) {
        res.status(403).json({ success: false, error: 'Operator privilege required for cross-user spend reads' });
        return;
      }
      const spendUsd = await service.computeSpend(parsed.scopeType, parsed.scopeKey, parsed.windowHours);
      if (spendUsd === null) {
        res.status(503).json({ success: false, error: 'Spend store unavailable' });
        return;
      }
      logger.info({ sub: caller.sub, scopeType: parsed.scopeType, windowHours: parsed.windowHours, durationMs: Date.now() - startedAt }, 'GET /api/budgets/spend');
      res.json({ success: true, ...parsed, spendUsd });
    } catch (err) {
      logger.error({ err }, 'GET /api/budgets/spend failed');
      res.status(500).json({ success: false, error: 'Failed to read spend' });
    }
  });

  // Operator-only read-only governance snapshot (the ops-rails tool-budgets surface): every cap
  // with its trailing-window spend + the recent enforcement events. requiresOperator-gated
  // because it exposes EVERY user/app/ticket cap and every breach across the deployment — never
  // a basic-user surface. Read-only: it never mutates a cap and never runs an enforcement check.
  router.get('/state', requiresOperator, async (req: Request, res: Response) => {
    const startedAt = Date.now();
    try {
      const rawHours = Number(req.query.windowHours ?? 24);
      const windowHours = Number.isFinite(rawHours) ? rawHours : 24;
      const rawLimit = Number(req.query.eventLimit ?? 50);
      const eventLimit = Number.isFinite(rawLimit) ? rawLimit : 50;
      const state = await service.getBudgetState(windowHours, eventLimit);
      logger.info({ budgets: state.budgets.length, events: state.events.length, windowHours: state.windowHours, durationMs: Date.now() - startedAt }, 'GET /api/budgets/state');
      res.json({ success: true, ...state });
    } catch (err) {
      logger.error({ err }, 'GET /api/budgets/state failed');
      res.status(500).json({ success: false, error: 'Failed to read budget state' });
    }
  });

  return router;
}
