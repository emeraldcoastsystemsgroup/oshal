/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Token Chase step 1: read API + debugger view route (ADR-046)
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Token Chase step 2: POST /runs/:runId/replay — single-call no-edit determinism gate (ADR-046)
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Token Chase step 5: GET /savings (corpus read → estimated-vs-actual roll-up) + POST /runs/:runId/savings (end-to-end loop over a run) (ADR-046)
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Token Chase step 4 + 4b (ADR-046): variant/savings observations are now judge-graded before persisting (assessVariantQuality over the shared quality-judge concierge — same inline transport as /api/judge; degrades to the flagged lexical proxy when the LLM lane is off) and GET /savings/report serves the judged headline table with llm-judged vs lexical-fallback numbers kept separate.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Review fix: /savings/report treats an empty ?bar= as "no override" (falls back to the default bar) instead of coercing Number('') to 0, which previously counted every graded frame as quality-held.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Spend gate wiring (BACKLOG "per-run judge budget cap"): both token-spending optimizer routes now build a TokenChaseBudgetGate with the cost-governance BudgetService bound in as the governance probe (per-call construction, same pattern as inline-bot-execution). POST /runs/:runId/savings passes it into runSavings (per-round gating, budget status in the response); POST .../variant pre-checks it once and answers 429 + status instead of spending when exhausted. TOKEN_CHASE_BUDGET_USD (finite default) is the per-run ceiling; TOKEN_CHASE_JUDGE_BAR stays a quality bar only.
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Token Chase step 2b (ADR-046 §10 debugger view): two READ-ONLY debugger endpoints — GET /runs/:runId/observations (the run's persisted replay/variant/grade history, for timeline badges) and GET /runs/:runId/frames/:seq/inspect (one frame's full captured payload + its recorded observations side-by-side, the drill-in). The debugger never fires replays — the existing replay/variant routes stay the only actions; the inspect route degrades to frame-only (flagged) when the corpus read fails so a DB hiccup can't blank the forensics view.
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Keep-winner → re-baseline + judge spend cap (ADR-046 step 4 loop, BACKLOG "auto keep-winner then re-baseline loop + per-run judge budget cap"): (1) mounts the promotion routes (promote/revert/list — see token-chase-promotion-routes.ts); (2) both replay paths load the run's ACTIVE promotions as baseline overrides so a promoted lane IS the frame's cost baseline from now on (the corpus rows then carry it, so the savings report re-baselines automatically); (3) the savings grading loop consults a per-run TokenChaseJudgeBudget BEFORE every judge call — TOKEN_CHASE_JUDGE_BUDGET_USD hard ceiling measured against the judge agent's REAL chat_tasks spend since the run began; on breach remaining frames persist UNGRADED and the response says partiallyGraded honestly; (4) after the loop the OPERATOR-GATED auto keep-winner pass runs (TOKEN_CHASE_AUTO_PROMOTE, default OFF — maybeAutoPromote touches nothing when disabled).
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | Tail-replay action (ADR-046 §1/§8): new POST /runs/:runId/tail-replay restages frame N's workspace tree and replays N..end on the accountable bot, determinism-gating each frame and stopping at the first divergence (which frame + why). Read-of-the-run + bot re-fires only; the controller never calls an LLM. Additive — the promotion routes and every existing action are untouched.
 */

import { Router, type Request, type Response } from 'express';
import path from 'node:path';
import fsSync from 'node:fs';
import { createChildLogger } from '@/shared/logger';
import type { AppContext } from '@/app/composition/app-context';
import {
  TokenChaseReadService, TokenChaseReplayService, TokenChaseTailReplayService, TokenChaseOptimizeService,
  buildTokenChaseDemoComparison,
  assessVariantQuality,
  listRunObservations,
  recordOptimizerObservation,
  summarizeCorpusSavings,
  summarizeJudgedSavings,
  TokenChaseBudgetGate,
  TokenChaseJudgeBudget,
  type DebuggerObservation,
  type QualityGrader,
  type TokenChaseAccess,
  type VariantReplayResult,
} from '@/features/token-chase';
import { JudgeService, QUALITY_JUDGE_AGENT_ID } from '@/features/quality-judge';
import { BudgetService } from '@/features/cost-governance';
import { listOptimizerLogins, resolveOptimizerLane } from './optimizer-providers';
import { createTokenChasePromotionRoutes, loadBaselineOverrides, maybeAutoPromote } from './token-chase-promotion-routes';

const logger = createChildLogger({ module: 'token-chase-routes' });

// Subs allowed to see every user's captured frames (comma-separated). Everyone else is owner-scoped.
const ADMIN_SUBS = new Set((process.env.TOKEN_CHASE_ADMIN_SUBS ?? '').split(',').map((s) => s.trim()).filter(Boolean));

/**
 * @description Builds the owner-scoping access context from the authenticated request. A caller sees
 * their own frames plus system frames (no recorded owner); admins (TOKEN_CHASE_ADMIN_SUBS) see all.
 * @param req - The authenticated Express request.
 * @returns The access context for the read service.
 */
function accessOf(req: Request): TokenChaseAccess {
  const callerSub = (req as { oidc?: { user?: { sub?: string } } }).oidc?.user?.sub ?? null;
  return { callerSub, isAdmin: callerSub !== null && ADMIN_SUBS.has(callerSub) };
}

/**
 * @description Builds the step-4 quality grader for one caller: JudgeService over the shared
 * quality-judge concierge, reached via the sanctioned inline transport (ctx.orchestrator, same as
 * POST /api/judge) so grading cost lands in chat_tasks under the judge's agent_id and the
 * controller never calls an LLM itself. JudgeService degrades to its flagged lexical-fallback
 * lane on its own when FORCE_LLM_PROVIDER=noop or the bot is unreachable.
 * @param ctx - The app context (supplies the orchestrator the concierge brain runs on).
 * @param sub - The caller's sub, threaded through for cost attribution.
 * @returns The grader the token-chase assessor consumes.
 */
function buildQualityGrader(ctx: AppContext, sub: string): QualityGrader {
  const judge = new JudgeService({
    invoker: async (taskId, prompt) => {
      const result = await (ctx.orchestrator as unknown as {
        processMessage: (taskId: string, prompt: string, opts: Record<string, unknown>) => Promise<{ success: boolean; error?: string; response?: unknown }>;
      }).processMessage(taskId, prompt, {
        agenticMode: true,
        autoApprove: false,
        source: 'token-chase-assessor',
        agentId: QUALITY_JUDGE_AGENT_ID,
        userSub: sub,
      });
      if (!result.success) throw new Error(result.error || 'judge brain execution failed');
      return String(result.response ?? '');
    },
  });
  return (input) => judge.grade(input);
}

/**
 * @description Builds the per-run spend gate for one optimizer request: the finite
 * TOKEN_CHASE_BUDGET_USD ceiling plus the cost-governance BudgetService bound in as the
 * governance probe (per-call construction is safe — BudgetService holds no per-instance
 * caches, same pattern as inline-bot-execution). The gate is what makes TOKEN_CHASE_JUDGE_BAR
 * honest: the bar stays a QUALITY gate; spend is capped here.
 * @param ctx - The app context (supplies the DB pool the governance probe reads).
 * @param sub - The accountable caller.
 * @returns The gate the optimizer consults before each round.
 */
function buildBudgetGate(ctx: AppContext, sub: string): TokenChaseBudgetGate {
  return new TokenChaseBudgetGate({
    userSub: sub,
    governance: (userSub) => new BudgetService(ctx.pool).checkBudget(userSub),
  });
}

/**
 * @description Builds the per-run JUDGE spend cap (BACKLOG "per-run judge budget cap"):
 * TOKEN_CHASE_JUDGE_BUDGET_USD enforced against MEASURED judge spend — the probe sums the
 * quality-judge concierge's chat_tasks cost since the run began (real ledger dollars; grading
 * cost lands there under QUALITY_JUDGE_AGENT_ID). The window is agent-scoped, not caller-scoped,
 * which is the conservative direction: concurrent runs count toward each other's caps rather
 * than neither. Fail-closed on the cap; the probe itself failing is an infra gap and fails open
 * inside the gate (logged at ERROR).
 * @param ctx - The app context (supplies the DB pool the probe reads).
 * @returns The judge budget consulted before every judge call of one grading run.
 */
function buildJudgeBudget(ctx: AppContext): TokenChaseJudgeBudget {
  const since = new Date();
  return new TokenChaseJudgeBudget({
    spendProbe: async () => {
      const result = (await ctx.pool.query(
        `SELECT COALESCE(SUM(total_cost), 0) AS spend
           FROM chat_tasks
          WHERE agent_id = $1 AND updated_at >= $2`,
        [QUALITY_JUDGE_AGENT_ID, since.toISOString()],
      )) as { rows: Array<{ spend: string | number | null }> };
      return Number(result.rows?.[0]?.spend ?? 0);
    },
  });
}

/**
 * @description Grades one variant replay via the step-4 assessor, then persists the observation
 * WITH the judge grade into the corpus. When a judge budget is supplied it is consulted BEFORE
 * the judge call: an exhausted budget skips grading (no LLM spend) but STILL persists the
 * observation ungraded — the run degrades to partially-graded, visibly, never silently. Fully
 * best-effort: neither the assessor nor the recorder throws, and a top-level guard logs anything
 * unexpected so a persistence hiccup can never break an optimizer response.
 * @param ctx - The app context (DB pool + orchestrator).
 * @param sub - The observation owner.
 * @param result - The graded variant replay result.
 * @param judgeBudget - Optional per-run judge spend cap (the savings loop passes one).
 */
async function assessAndRecord(
  ctx: AppContext,
  sub: string,
  result: VariantReplayResult,
  judgeBudget?: TokenChaseJudgeBudget,
): Promise<void> {
  try {
    if (judgeBudget) {
      const verdict = await judgeBudget.beforeJudgeCall();
      if (!verdict.allowed) {
        logger.warn(
          { runId: result.runId, seq: result.seq, spentUsd: verdict.spentUsd, capUsd: verdict.capUsd },
          'Judge budget exhausted — persisting observation UNGRADED (run is partially graded)',
        );
        await recordOptimizerObservation(ctx.pool, sub, result, null);
        judgeBudget.noteSkipped();
        return;
      }
    }
    const assessment = await assessVariantQuality(buildQualityGrader(ctx, sub), result);
    await recordOptimizerObservation(ctx.pool, sub, result, assessment);
    judgeBudget?.noteGraded();
  } catch (err) {
    logger.error({ err, stack: (err as Error)?.stack, runId: result.runId, seq: result.seq }, 'Assess-and-record failed (non-fatal)');
  }
}

/**
 * @description Creates the Token Chase API and debugger view. Read routes list captured runs/frames
 * and serve the timeline UI; the replay route runs the single-call no-edit determinism gate (step 2),
 * which re-fires a frame on its owning bot node — never the controller — and grades it against the
 * baseline. All routes are owner-scoped and must be wrapped in requiresAuth by the caller.
 * @param apiDir - Resolved directory that holds static HTML surfaces (for the debugger view).
 * @param ctx - App context (the DB pool resolves each caller's BYO-LLM lanes for variant replays).
 * @returns Router mounted at /api/token-chase.
 */
export function createTokenChaseRoutes(apiDir: string, ctx: AppContext): Router {
  const router = Router();
  const service = new TokenChaseReadService();
  const replayService = new TokenChaseReplayService(service);
  const tailReplayService = new TokenChaseTailReplayService(service);
  const optimizeService = new TokenChaseOptimizeService(service);

  router.get('/runs', handleListRuns(service));
  router.get('/runs/:runId', handleGetFrames(service));
  router.get('/runs/:runId/frames/:seq', handleGetFrame(service));
  // Step 2b (ADR-046 §10) — the debugger's READ-ONLY trace endpoints: the run's persisted
  // replay/variant/grade observations (timeline badges) and the single-frame inspect bundle
  // (captured payload + recorded results side-by-side). The debugger never fires replays —
  // POST /replay and POST .../variant above remain the only actions.
  router.get('/runs/:runId/observations', handleRunObservations(ctx));
  router.get('/runs/:runId/frames/:seq/inspect', handleFrameInspect(service, ctx));
  router.post('/runs/:runId/replay', handleReplay(replayService));
  // Tail replay (ADR-046 §1/§8): restage frame N's workspace tree, then replay N..end on the
  // accountable bot node, determinism-gating each frame and STOPPING at the first divergence.
  router.post('/runs/:runId/tail-replay', handleTailReplay(tailReplayService));
  router.get('/demo/comparison', (_req: Request, res: Response) => {
    res.json({ variant: buildTokenChaseDemoComparison(), noTokenSpend: true });
  });
  // The caller's own configured LLM connections — the providers the optimizer runs against.
  router.get('/connections', handleConnections(ctx));
  // Token Chase optimizer (ADR-046 step 3) — replay a captured call on the caller's chosen connection.
  router.post('/runs/:runId/frames/:seq/variant', handleVariant(optimizeService, ctx));
  // Savings (ADR-046 step 5): GET reads the caller's corpus into an estimated-vs-actual roll-up
  // (?runId= to narrow); POST replays every frame of a run on a chosen lane and returns the live loop.
  router.get('/savings', handleSavingsRead(ctx));
  // Step 4b (ADR-046 §12): the judged headline report — per-lane $ saved with quality-held counts,
  // llm-judged vs lexical-fallback numbers kept separate. Corpus read only; re-runs nothing.
  router.get('/savings/report', handleJudgedSavingsRead(ctx));
  router.post('/runs/:runId/savings', handleRunSavings(optimizeService, ctx));
  // Keep-winner → re-baseline (ADR-046): promote a frame's winning lane, revert it, and read the
  // promotion store + audit trail. Same requiresAuth wrapper — mounted inside this router.
  router.use(createTokenChasePromotionRoutes(ctx));
  router.get('/ui', handleView(apiDir));

  logger.info('Token Chase routes registered');
  return router;
}

/**
 * @description GET /connections — lists the caller's own configured LLM connections (the per-user
 * Bring-Your-Own-LLM connectors). These are the "providers" the optimizer runs against; the framework
 * already holds the user's login, so no settings-poking is needed. Each entry carries a connectionId
 * the variant route resolves to an endpoint+key+model.
 */
function handleConnections(ctx: AppContext) {
  return async (req: Request, res: Response): Promise<void> => {
    const sub = accessOf(req).callerSub;
    if (!sub) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    try {
      const connections = await listOptimizerLogins(ctx.pool, sub);
      res.json({ connections });
    } catch (error) {
      logger.error({ err: error }, 'Failed to list optimizer connections');
      res.status(500).json({ error: 'Failed to list connections' });
    }
  };
}

/**
 * @description POST /runs/:runId/frames/:seq/variant — replays one captured frame against the caller's
 * own chosen LLM connection (controller-side, no bot node) and returns the baseline-vs-variant
 * cost/latency/accuracy diff. The connection is one of the caller's configured providers
 * (`GET /api/token-chase/connections`), billed to their own key. Body:
 * `{ connectionId: string, label?: string }`.
 */
function handleVariant(service: TokenChaseOptimizeService, ctx: AppContext) {
  return async (req: Request, res: Response): Promise<void> => {
    const runId = String(req.params.runId);
    const seq = Number.parseInt(String(req.params.seq), 10);
    if (!Number.isInteger(seq) || seq < 0) {
      res.status(400).json({ error: 'Invalid frame sequence' });
      return;
    }
    const sub = accessOf(req).callerSub;
    if (!sub) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    const body = (req.body ?? {}) as { connectionId?: string; label?: string };
    const connectionId = (body.connectionId ?? '').trim();
    if (!connectionId) {
      res.status(400).json({ error: 'Body must include a connectionId (from /api/token-chase/connections).' });
      return;
    }
    const lane = await resolveOptimizerLane(ctx.pool, sub, connectionId);
    if (!lane) {
      res.status(404).json({ error: 'Provider not available — it has no usable login/key on this instance.' });
      return;
    }
    const label = (body.label ?? '').trim() || lane.label;
    // Spend gate: one round = one check. A fresh gate carries no run spend, so this is the
    // governance consult (operator hard caps / runaway kill switch) — exhausted answers with
    // the status instead of spending, never a throw.
    const gate = buildBudgetGate(ctx, sub);
    const budgetVerdict = await gate.check();
    if (budgetVerdict.exhausted) {
      logger.warn({ runId, seq, reason: budgetVerdict.reason, governanceReason: budgetVerdict.governanceReason }, 'Token Chase variant replay blocked by the spend gate');
      res.status(429).json({ error: 'Token Chase budget exhausted — the variant replay was not run.', budget: budgetVerdict });
      return;
    }
    try {
      // Every lane replays through the bot node's /api/token-chase/replay-call. `byo` lanes hand the bot
      // an ephemeral OpenAI-compatible endpoint; `current` runs the bot's own configured provider.
      const byo = lane.kind === 'byo' ? { baseUrl: lane.baseUrl, apiKey: lane.apiKey, model: lane.model } : undefined;
      // Re-baseline: a frame with an ACTIVE promotion measures cost against the promoted lane.
      const overrides = await loadBaselineOverrides(ctx.pool, sub, runId);
      const result = await service.replayVariant(runId, seq, { label, byo }, accessOf(req), overrides.get(seq));
      if (!result) {
        res.status(404).json({ error: 'Frame not found' });
        return;
      }
      // Judge-grade (step 4) then append the corpus observation for graded results
      // (fire-and-forget — never blocks the response).
      if (result.tier) void assessAndRecord(ctx, sub, result);
      res.json({ variant: result });
    } catch (error) {
      logger.error({ err: error, runId, seq }, 'Token Chase variant replay failed');
      res.status(500).json({ error: 'Variant replay failed' });
    }
  };
}

/** @description POST /runs/:runId/replay — re-fires frame `fromFrame` with no edit and grades determinism. */
function handleReplay(service: TokenChaseReplayService) {
  return async (req: Request, res: Response): Promise<void> => {
    const runId = String(req.params.runId);
    const body = (req.body ?? {}) as { fromFrame?: unknown; seq?: unknown };
    const fromFrame = Number.parseInt(String(body.fromFrame ?? body.seq), 10);
    if (!Number.isInteger(fromFrame) || fromFrame < 0) {
      res.status(400).json({ error: 'Body must include a non-negative fromFrame (call sequence)' });
      return;
    }
    try {
      const result = await service.replayFrame(runId, fromFrame, accessOf(req));
      if (!result) {
        res.status(404).json({ error: 'Frame not found' });
        return;
      }
      res.json({ replay: result });
    } catch (error) {
      logger.error({ err: error, runId, fromFrame }, 'Token Chase replay failed');
      res.status(500).json({ error: 'Replay failed' });
    }
  };
}

/**
 * @description POST /runs/:runId/tail-replay — the forward TAIL replay (ADR-046 §1/§8). From the
 * start frame `fromFrame` it restages the workspace tree that frame saw (from its content-addressed
 * snapshot, into an isolated root — never the live workspace), then replays every frame from there to
 * the end of the run on the bot node that produced each — never the controller — determinism-gating
 * each replayed frame against its capture and STOPPING at the first divergence with the offending frame
 * and reason. Pinned tool-reads are served from the captured prompt; unpinned reads fall through with a
 * per-frame warning. Body: `{ fromFrame: number }` (accepts legacy `seq`). Owner-scoped.
 */
function handleTailReplay(service: TokenChaseTailReplayService) {
  return async (req: Request, res: Response): Promise<void> => {
    const runId = String(req.params.runId);
    const body = (req.body ?? {}) as { fromFrame?: unknown; seq?: unknown };
    const fromFrame = Number.parseInt(String(body.fromFrame ?? body.seq), 10);
    if (!Number.isInteger(fromFrame) || fromFrame < 0) {
      res.status(400).json({ error: 'Body must include a non-negative fromFrame (call sequence)' });
      return;
    }
    try {
      const result = await service.replayForward(runId, fromFrame, accessOf(req));
      if (!result) {
        res.status(404).json({ error: 'Start frame not found' });
        return;
      }
      res.json({ tailReplay: result });
    } catch (error) {
      logger.error({ err: error, runId, fromFrame }, 'Token Chase tail replay failed');
      res.status(500).json({ error: 'Tail replay failed' });
    }
  };
}

/** @description GET /runs — lists captured runs (task workspaces holding frames). */
function handleListRuns(service: TokenChaseReadService) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      res.json({ runs: await service.listRuns(accessOf(req)) });
    } catch (error) {
      logger.error({ err: error }, 'Failed to list Token Chase runs');
      res.status(500).json({ error: 'Failed to list runs' });
    }
  };
}

/** @description GET /runs/:runId — lists the ordered frame summaries for one run. */
function handleGetFrames(service: TokenChaseReadService) {
  return async (req: Request, res: Response): Promise<void> => {
    const runId = String(req.params.runId);
    try {
      res.json({ runId, frames: await service.getFrames(runId, accessOf(req)) });
    } catch (error) {
      logger.error({ err: error, runId }, 'Failed to get Token Chase frames');
      res.status(500).json({ error: 'Failed to get frames' });
    }
  };
}

/** @description GET /runs/:runId/frames/:seq — reads one frame in full for the inspector. */
function handleGetFrame(service: TokenChaseReadService) {
  return async (req: Request, res: Response): Promise<void> => {
    const runId = String(req.params.runId);
    const seq = Number.parseInt(String(req.params.seq), 10);
    if (!Number.isInteger(seq) || seq < 0) {
      res.status(400).json({ error: 'Invalid frame sequence' });
      return;
    }
    try {
      const frame = await service.getFrame(runId, seq, accessOf(req));
      if (!frame) {
        res.status(404).json({ error: 'Frame not found' });
        return;
      }
      res.json({ frame });
    } catch (error) {
      logger.error({ err: error, runId, seq }, 'Failed to get Token Chase frame');
      res.status(500).json({ error: 'Failed to get frame' });
    }
  };
}

/**
 * @description GET /runs/:runId/observations — the step-2b debugger's run-level trace read: every
 * persisted replay/variant/grade observation recorded for this run (metrics only — cost pair, delta,
 * accuracy, tier, judge grade), ordered by frame sequence. READ-ONLY and owner-scoped to the caller's
 * own corpus rows (mirrors the savings reads); re-runs nothing and spends no tokens.
 */
function handleRunObservations(ctx: AppContext) {
  return async (req: Request, res: Response): Promise<void> => {
    const runId = String(req.params.runId);
    const sub = accessOf(req).callerSub;
    if (!sub) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    try {
      const observations = await listRunObservations(ctx.pool, sub, runId);
      res.json({ runId, observations });
    } catch (error) {
      logger.error({ err: error, stack: (error as Error)?.stack, runId }, 'Failed to read Token Chase run observations');
      res.status(500).json({ error: 'Failed to read observations' });
    }
  };
}

/**
 * @description GET /runs/:runId/frames/:seq/inspect — the step-2b debugger drill-in: one frame's full
 * captured payload (prompt/history/system, response, tokens, cost fields) PLUS its persisted
 * replay/variant/grade observations, in one bundle for the side-by-side view. READ-ONLY. Frame
 * visibility uses the same owner scoping as GET .../frames/:seq (404 when absent or not visible);
 * observations are the caller's own corpus rows. When the corpus read fails the response degrades to
 * frame-only with `observationsUnavailable: true` (logged at ERROR) — the captured frame lives on
 * disk, and a DB hiccup must not blank the forensics view.
 */
function handleFrameInspect(service: TokenChaseReadService, ctx: AppContext) {
  return async (req: Request, res: Response): Promise<void> => {
    const runId = String(req.params.runId);
    const seq = Number.parseInt(String(req.params.seq), 10);
    if (!Number.isInteger(seq) || seq < 0) {
      res.status(400).json({ error: 'Invalid frame sequence' });
      return;
    }
    const sub = accessOf(req).callerSub;
    if (!sub) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    try {
      const frame = await service.getFrame(runId, seq, accessOf(req));
      if (!frame) {
        res.status(404).json({ error: 'Frame not found' });
        return;
      }
      let observations: DebuggerObservation[] = [];
      let observationsUnavailable = false;
      try {
        observations = await listRunObservations(ctx.pool, sub, runId, seq);
      } catch (obsError) {
        observationsUnavailable = true;
        logger.error({ err: obsError, stack: (obsError as Error)?.stack, runId, seq }, 'Frame inspect: corpus observations unavailable — degrading to frame-only');
      }
      res.json({ inspect: { runId, seq, frame, observations, observationsUnavailable } });
    } catch (error) {
      logger.error({ err: error, stack: (error as Error)?.stack, runId, seq }, 'Failed to inspect Token Chase frame');
      res.status(500).json({ error: 'Failed to inspect frame' });
    }
  };
}

/**
 * @description GET /savings — reads the caller's persisted optimizer observations into an
 * estimated-vs-actual savings roll-up (realizable = the zero-risk equivalent-cheaper swaps). This is
 * the corpus READ path (previously write-only). `?runId=` narrows to one run; omit for the whole corpus.
 * Cheap — no LLM tokens are spent.
 */
function handleSavingsRead(ctx: AppContext) {
  return async (req: Request, res: Response): Promise<void> => {
    const sub = accessOf(req).callerSub;
    if (!sub) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    const runId = typeof req.query.runId === 'string' && req.query.runId.trim() ? req.query.runId.trim() : undefined;
    try {
      const savings = await summarizeCorpusSavings(ctx.pool, sub, runId);
      res.json({ savings });
    } catch (error) {
      logger.error({ err: error }, 'Failed to read Token Chase savings');
      res.status(500).json({ error: 'Failed to read savings' });
    }
  };
}

/**
 * @description GET /savings/report — the step-4b judged headline report (ADR-046 §12): per
 * provider/model lane baseline vs variant $, $ and % saved, and quality-held counts against the
 * configurable bar (?bar=, else TOKEN_CHASE_JUDGE_BAR, else 80). LLM-judged frames roll into
 * `verifiedSavedUsd`; lexical-fallback frames into the separate `lexicalProxySavedUsd` — the two
 * are never blended. Corpus read only; `?runId=` narrows to one run. No LLM tokens are spent.
 */
function handleJudgedSavingsRead(ctx: AppContext) {
  return async (req: Request, res: Response): Promise<void> => {
    const sub = accessOf(req).callerSub;
    if (!sub) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    const runId = typeof req.query.runId === 'string' && req.query.runId.trim() ? req.query.runId.trim() : undefined;
    // Only treat a non-empty ?bar= as an override; an empty/missing value falls back to the default
    // bar (avoids Number('') === 0 quietly counting every graded frame as quality-held).
    const barText = typeof req.query.bar === 'string' ? req.query.bar.trim() : '';
    const barRaw = Number(barText);
    const bar = barText !== '' && Number.isFinite(barRaw) && barRaw >= 0 && barRaw <= 100 ? barRaw : undefined;
    try {
      const report = await summarizeJudgedSavings(ctx.pool, sub, runId, bar);
      res.json({ report });
    } catch (error) {
      logger.error({ err: error }, 'Failed to read Token Chase judged savings report');
      res.status(500).json({ error: 'Failed to read savings report' });
    }
  };
}

/**
 * @description POST /runs/:runId/savings — the end-to-end savings loop over a REAL run: replays every
 * replayable frame on the caller's chosen connection (`{ connectionId }`), grades each, persists the
 * observations to the corpus, and returns the aggregate SavingsSummary. Spends the caller's own tokens.
 */
function handleRunSavings(service: TokenChaseOptimizeService, ctx: AppContext) {
  return async (req: Request, res: Response): Promise<void> => {
    const runId = String(req.params.runId);
    const sub = accessOf(req).callerSub;
    if (!sub) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    const body = (req.body ?? {}) as { connectionId?: string; label?: string };
    const connectionId = (body.connectionId ?? '').trim();
    if (!connectionId) {
      res.status(400).json({ error: 'Body must include a connectionId (from /api/token-chase/connections).' });
      return;
    }
    const lane = await resolveOptimizerLane(ctx.pool, sub, connectionId);
    if (!lane) {
      res.status(404).json({ error: 'Provider not available — it has no usable login/key on this instance.' });
      return;
    }
    const label = (body.label ?? '').trim() || lane.label;
    const byo = lane.kind === 'byo' ? { baseUrl: lane.baseUrl, apiKey: lane.apiKey, model: lane.model } : undefined;
    try {
      // The per-run JUDGE spend cap (TOKEN_CHASE_JUDGE_BUDGET_USD) — consulted before EVERY judge
      // call; on breach the remaining frames persist ungraded and the response says so honestly.
      const judgeBudget = buildJudgeBudget(ctx);
      // Re-baseline: frames with an ACTIVE promotion measure savings against the promoted lane.
      const overrides = await loadBaselineOverrides(ctx.pool, sub, runId);
      const { summary, results, budget } = await service.runSavings(
        runId,
        { label, byo },
        accessOf(req),
        // Step 4: each graded frame is judge-assessed then persisted with its grade (awaited so
        // the corpus is complete when the loop returns; the assessor never throws).
        async (result) => { if (result.tier) await assessAndRecord(ctx, sub, result, judgeBudget); },
        // The per-run spend gate (TOKEN_CHASE_BUDGET_USD + cost-governance) — consulted before
        // each round; an exhausted budget stops the loop cleanly and is reported in `budget`.
        buildBudgetGate(ctx, sub),
        overrides,
      );
      // Operator-gated auto keep-winner (TOKEN_CHASE_AUTO_PROMOTE, default OFF): promote each
      // frame's fresh winner to its new baseline. A no-op that touches nothing when disabled.
      const autoPromote = await maybeAutoPromote(ctx.pool, sub, runId);
      const judge = judgeBudget.status();
      res.json({
        savings: summary,
        frames: results.length,
        budget,
        judgeBudget: judge,
        partiallyGraded: judge.partiallyGraded,
        rebaselinedFrames: overrides.size,
        autoPromote,
      });
    } catch (error) {
      logger.error({ err: error, runId }, 'Token Chase savings loop failed');
      res.status(500).json({ error: 'Savings loop failed' });
    }
  };
}

/** @description GET /ui — serves the static debugger view from the api directory. */
function handleView(apiDir: string) {
  return (_req: Request, res: Response): void => {
    const file = path.join(apiDir, 'token-chase.html');
    if (!fsSync.existsSync(file)) {
      res.status(404).send('Token Chase view not found');
      return;
    }
    res.sendFile(file);
  };
}
