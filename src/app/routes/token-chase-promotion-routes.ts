/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Token Chase keep-winner → re-baseline routes (ADR-046, BACKLOG "auto keep-winner then re-baseline loop"): POST /runs/:runId/frames/:seq/promote runs the keep-winner bar (llm-judged only, min quality + min savings) over the frame's persisted observations and promotes the winner to the frame's preferred lane (422 + per-candidate rejections when nothing clears the bar); POST /promotions/:id/revert is the reversal; GET /runs/:runId/promotions lists the store + the promote/auto-promote/revert audit trail. maybeAutoPromote is the OPERATOR-GATED auto mode consumed by the savings loop — default OFF, on ONLY when TOKEN_CHASE_AUTO_PROMOTE=true, and it touches nothing when disabled. Optional applyToBotConfig routes a framework-provider winner through the EXISTING ADR-034 config-ownership path (ConfigSyncService.pushToBot → the bot's PUT /api/llm-provider, version bump + config_sync_log audit) — never a bypass; BYO/endpoint lanes are refused honestly because a per-user key must never become bot config. Mounted inside createTokenChaseRoutes, so every route sits behind the same requiresAuth wrapper.
 */

import { Router, type Request, type Response } from 'express';
import { createChildLogger } from '@/shared/logger';
import type { AppContext } from '@/app/composition/app-context';
import {
  TokenChaseReadService,
  isAutoPromoteEnabled,
  listActivePromotions,
  listPromotionAudit,
  listPromotions,
  listRunObservations,
  promoteFrameWinner,
  readKeepWinnerThresholds,
  revertPromotion,
  selectWinner,
  type BaselineOverride,
  type DebuggerObservation,
  type FrameWinner,
  type KeepWinnerThresholds,
  type PromotionRecord,
  type TokenChaseAccess,
} from '@/features/token-chase';

const logger = createChildLogger({ module: 'token-chase-promotion-routes' });

/** @description Owner-scoping context from the authenticated request (mirrors token-chase-routes). */
function accessOf(req: Request): TokenChaseAccess {
  const callerSub = (req as { oidc?: { user?: { sub?: string } } }).oidc?.user?.sub ?? null;
  const admins = new Set((process.env.TOKEN_CHASE_ADMIN_SUBS ?? '').split(',').map((s) => s.trim()).filter(Boolean));
  return { callerSub, isAdmin: callerSub !== null && admins.has(callerSub) };
}

/** @description The outcome of one gated auto-promotion pass over a run. */
export interface AutoPromoteOutcome {
  /** Whether TOKEN_CHASE_AUTO_PROMOTE enabled the pass at all (default OFF). */
  enabled: boolean;
  /** Frames whose winner was auto-promoted in this pass. */
  promoted: PromotionRecord[];
  /** Frames that had a winner already active as the baseline (nothing to do). */
  alreadyBaseline: number;
  /** Frames considered (frames with at least one persisted observation). */
  considered: number;
  /** Present when the pass failed partway — reported, never silent. */
  error?: string;
}

/**
 * @description The operator-gated auto keep-winner pass (BACKLOG "auto keep-winner then
 * re-baseline loop"). When TOKEN_CHASE_AUTO_PROMOTE is not explicitly on, it does NOTHING — no
 * reads, no writes (promotion is a visible, reversible action; auto-apply is an opt-in). When
 * on: reads the run's persisted observations, runs the keep-winner bar per frame, and promotes
 * each winner whose lane is not already the frame's active baseline (source 'auto', full audit
 * trail). Per-frame failures are logged at ERROR and surfaced in the outcome — never thrown, so
 * a bad frame cannot break the savings response this rides on.
 * @param pool - The app DB pool.
 * @param userSub - The accountable caller (owns the observations + promotions).
 * @param runId - The captured run whose fresh grades to act on.
 * @param env - Environment bag (injectable for tests); defaults to process.env.
 * @returns The pass outcome (enabled=false with zero touches when the gate is off).
 */
export async function maybeAutoPromote(
  pool: AppContext['pool'],
  userSub: string,
  runId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AutoPromoteOutcome> {
  if (!isAutoPromoteEnabled(env)) {
    return { enabled: false, promoted: [], alreadyBaseline: 0, considered: 0 };
  }
  const outcome: AutoPromoteOutcome = { enabled: true, promoted: [], alreadyBaseline: 0, considered: 0 };
  try {
    const observations = await listRunObservations(pool, userSub, runId);
    const bySeq = new Map<number, DebuggerObservation[]>();
    for (const o of observations) {
      const list = bySeq.get(o.seq) ?? [];
      list.push(o);
      bySeq.set(o.seq, list);
    }
    outcome.considered = bySeq.size;
    const thresholds = readKeepWinnerThresholds(env);
    const active = await listActivePromotions(pool, userSub, runId);
    for (const [seq, rows] of bySeq) {
      const { winner } = selectWinner(rows, thresholds);
      if (!winner) continue;
      const current = active.get(seq);
      if (current && current.provider === winner.observation.variantProvider && current.model === winner.observation.variantModel) {
        outcome.alreadyBaseline += 1;
        continue;
      }
      try {
        outcome.promoted.push(await promoteWinnerRecord(pool, userSub, runId, seq, winner, 'auto'));
      } catch (err) {
        logger.error({ err, stack: (err as Error)?.stack, runId, seq }, 'Auto-promotion failed for frame (continuing)');
        outcome.error = `frame ${seq}: ${(err as Error).message}`;
      }
    }
    if (outcome.promoted.length > 0) {
      logger.info({ runId, promoted: outcome.promoted.length, considered: outcome.considered }, 'Auto keep-winner pass promoted new baselines');
    }
  } catch (err) {
    logger.error({ err, stack: (err as Error)?.stack, runId }, 'Auto-promotion pass failed');
    outcome.error = (err as Error).message;
  }
  return outcome;
}

/** @description Persists one selected winner as the frame's active promotion. */
function promoteWinnerRecord(
  pool: AppContext['pool'],
  userSub: string,
  runId: string,
  seq: number,
  winner: FrameWinner,
  source: 'manual' | 'auto',
): Promise<PromotionRecord> {
  const o = winner.observation;
  return promoteFrameWinner(pool, userSub, {
    runId,
    seq,
    provider: o.variantProvider,
    model: String(o.variantModel),
    label: null,
    baselineProvider: o.baselineProvider,
    baselineModel: o.baselineModel,
    baselineCostUsd: o.baselineCostUsd,
    variantCostUsd: o.variantCostUsd,
    savedUsd: winner.savedUsd,
    judgeScore: o.judgeScore as number,
    judgeMode: String(o.judgeMode),
    source,
  });
}

/**
 * @description Loads the run's ACTIVE promotions as per-frame baseline overrides for the
 * optimizer — the read side of re-baselining. Fails OPEN to "no overrides" with an ERROR log: a
 * store hiccup degrades to the captured baseline (honest, conservative) rather than blocking a run.
 * @param pool - The app DB pool.
 * @param userSub - Owner scope.
 * @param runId - The captured run id.
 * @returns Map of frame seq → BaselineOverride (empty when none / on failure).
 */
export async function loadBaselineOverrides(
  pool: AppContext['pool'],
  userSub: string,
  runId: string,
): Promise<Map<number, BaselineOverride>> {
  const overrides = new Map<number, BaselineOverride>();
  try {
    const active = await listActivePromotions(pool, userSub, runId);
    for (const [seq, p] of active) {
      if (p.variantCostUsd == null) continue; // no recorded cost — nothing honest to re-baseline against
      overrides.set(seq, { provider: p.provider, model: p.model, costUsd: p.variantCostUsd, label: p.label ?? p.model });
    }
  } catch (err) {
    logger.error({ err, stack: (err as Error)?.stack, runId }, 'Failed to load promotion baseline overrides — using captured baselines');
  }
  return overrides;
}

/** Parses + validates optional threshold overrides from a request body; null = invalid. */
function thresholdsFrom(body: { minQuality?: unknown; minSavingsUsd?: unknown }, env: NodeJS.ProcessEnv): KeepWinnerThresholds | null {
  const t = readKeepWinnerThresholds(env);
  if (body.minQuality !== undefined) {
    const q = Number(body.minQuality);
    if (!Number.isFinite(q) || q < 0 || q > 100) return null;
    t.minQuality = q;
  }
  if (body.minSavingsUsd !== undefined) {
    const s = Number(body.minSavingsUsd);
    if (!Number.isFinite(s) || s < 0) return null;
    t.minSavingsUsd = s;
  }
  return t;
}

/**
 * @description Applies a promoted winner to the owning bot's configuration through the EXISTING
 * ADR-034 config-ownership path — ConfigSyncService.pushToBot (BotNodeClient.switchProvider →
 * the bot's PUT /api/llm-provider, authoritative record + version bump + config_sync_log audit).
 * Never a bypass, and never for per-user lanes: only a framework provider id may become bot
 * config (a BYO endpoint+key belongs to one user and must not be pushed into a shared bot).
 * @param ctx - The app context (supplies ConfigSyncService via the swarm bindings).
 * @param access - Caller scope used to resolve the frame's owning bot.
 * @param promotion - The just-persisted promotion.
 * @returns Whether the push applied, with an honest reason when it did not.
 */
async function applyWinnerToBotConfig(
  ctx: AppContext,
  access: TokenChaseAccess,
  promotion: PromotionRecord,
): Promise<{ applied: boolean; reason?: string; newVersion?: number }> {
  const configSync = ctx.swarm?.configSyncService;
  if (!configSync) return { applied: false, reason: 'Config sync (ADR-034) is not available on this deployment.' };
  const rawProvider = promotion.provider ?? '';
  const providerId = rawProvider.startsWith('framework:') ? rawProvider.slice('framework:'.length) : rawProvider;
  if (!providerId || providerId.includes('/') || providerId.startsWith('http')) {
    return { applied: false, reason: 'Winner lane is not a framework provider — BYO/endpoint lanes never become bot config.' };
  }
  const frame = await new TokenChaseReadService().getFrame(promotion.runId, promotion.seq, access);
  if (!frame?.agentId) return { applied: false, reason: 'Captured frame no longer resolves an owning bot.' };
  const result = await configSync.pushToBot(frame.agentId, { providerId, modelId: promotion.model });
  return { applied: result.pushed, reason: result.reason, newVersion: result.newVersion };
}

/**
 * @description Creates the Token Chase promotion routes (mounted INSIDE createTokenChaseRoutes,
 * behind the same requiresAuth wrapper): keep-winner promote, revert, and the promotions + audit
 * read. All owner-scoped by the caller's sub, mirroring the corpus reads.
 * @param ctx - App context (DB pool + swarm bindings for the ADR-034 apply path).
 * @returns Router with the promotion endpoints.
 */
export function createTokenChasePromotionRoutes(ctx: AppContext): Router {
  const router = Router();
  router.get('/runs/:runId/promotions', handleListPromotions(ctx));
  router.post('/runs/:runId/frames/:seq/promote', handlePromote(ctx));
  router.post('/promotions/:promotionId/revert', handleRevert(ctx));
  return router;
}

/** @description GET /runs/:runId/promotions — the run's promotion store + audit trail (owner-scoped). */
function handleListPromotions(ctx: AppContext) {
  return async (req: Request, res: Response): Promise<void> => {
    const runId = String(req.params.runId);
    const sub = accessOf(req).callerSub;
    if (!sub) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    try {
      const [promotions, audit] = await Promise.all([
        listPromotions(ctx.pool, sub, runId),
        listPromotionAudit(ctx.pool, sub, runId),
      ]);
      res.json({ runId, promotions, audit });
    } catch (error) {
      logger.error({ err: error, stack: (error as Error)?.stack, runId }, 'Failed to list Token Chase promotions');
      res.status(500).json({ error: 'Failed to list promotions' });
    }
  };
}

/**
 * @description POST /runs/:runId/frames/:seq/promote — the manual keep-winner apply: select the
 * frame's winner (llm-judged only, quality bar + min savings; per-request overrides via
 * `{ minQuality?, minSavingsUsd? }`) and persist it as the frame's preferred lane. 422 with the
 * per-candidate rejections when nothing clears the bar — the "no winner" answer is evidence, not
 * an empty error. `{ applyToBotConfig: true }` additionally routes a framework-provider winner
 * through the ADR-034 pushToBot path; the result is reported per-field, never silently dropped.
 */
function handlePromote(ctx: AppContext) {
  return async (req: Request, res: Response): Promise<void> => {
    const runId = String(req.params.runId);
    const seq = Number.parseInt(String(req.params.seq), 10);
    if (!Number.isInteger(seq) || seq < 0) {
      res.status(400).json({ error: 'Invalid frame sequence' });
      return;
    }
    const access = accessOf(req);
    const sub = access.callerSub;
    if (!sub) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    const body = (req.body ?? {}) as { minQuality?: unknown; minSavingsUsd?: unknown; applyToBotConfig?: unknown };
    const thresholds = thresholdsFrom(body, process.env);
    if (!thresholds) {
      res.status(400).json({ error: 'minQuality must be 0..100 and minSavingsUsd must be >= 0.' });
      return;
    }
    try {
      const observations = await listRunObservations(ctx.pool, sub, runId, seq);
      if (observations.length === 0) {
        res.status(404).json({ error: 'No recorded observations for this frame — run a variant replay first.' });
        return;
      }
      const selection = selectWinner(observations, thresholds);
      if (!selection.winner) {
        res.status(422).json({
          error: 'No variant clears the promotion bar (llm-judged, at/above quality, strictly cheaper).',
          thresholds: selection.thresholds,
          rejected: selection.rejected,
        });
        return;
      }
      const promotion = await promoteWinnerRecord(ctx.pool, sub, runId, seq, selection.winner, 'manual');
      const payload: Record<string, unknown> = { promotion, thresholds: selection.thresholds, rejected: selection.rejected };
      if (body.applyToBotConfig === true) {
        payload.botConfig = await applyWinnerToBotConfig(ctx, access, promotion);
      }
      res.json(payload);
    } catch (error) {
      logger.error({ err: error, stack: (error as Error)?.stack, runId, seq }, 'Token Chase promotion failed');
      res.status(500).json({ error: 'Promotion failed' });
    }
  };
}

/** @description POST /promotions/:promotionId/revert — demote an active promotion (owner-scoped, audited). */
function handleRevert(ctx: AppContext) {
  return async (req: Request, res: Response): Promise<void> => {
    const promotionId = String(req.params.promotionId);
    const sub = accessOf(req).callerSub;
    if (!sub) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    try {
      const reverted = await revertPromotion(ctx.pool, sub, promotionId);
      if (!reverted) {
        res.status(404).json({ error: 'No active promotion with that id belongs to you.' });
        return;
      }
      res.json({ promotion: reverted });
    } catch (error) {
      logger.error({ err: error, stack: (error as Error)?.stack, promotionId }, 'Token Chase promotion revert failed');
      res.status(500).json({ error: 'Revert failed' });
    }
  };
}
