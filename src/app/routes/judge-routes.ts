/**
 * Judge Routes — the shared LLM-judge/grading service API.
 *
 * POST /api/judge grades one {task, output, rubric[], reference?} into a validated verdict
 * {score, dimensions, rationale, mode}. Grading is LLM work, so the reasoning runs on the
 * quality-judge CONCIERGE bot (inline on the api via ctx.orchestrator — the sanctioned
 * inline-concierge transport, same as movies/workflow-assistant): the controller never calls
 * an LLM itself, and grading cost lands in chat_tasks under the judge's agent_id. When
 * FORCE_LLM_PROVIDER=noop or the bot is unavailable, JudgeService degrades to the
 * deterministic lexical lane, flagged mode:'lexical-fallback'.
 *
 * Mounted auth-gated: app.use('/api/judge', requiresAuth, createJudgeRoutes(ctx)).
 *
 * CHANGE LOG
 * ---------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * ---------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — POST /api/judge over the quality-judge concierge (JudgeService, @/features/quality-judge). Body validation (rubric = non-empty string array), caller-sub threading for cost attribution, structured error replies.
 * ---------------------------------------------------------------------------
 * @module judge-routes
 */

import { Router, type Request, type Response } from 'express';
import { createChildLogger } from '@/shared/logger';
import type { AppContext } from '@/app/composition/app-context';
import {
  JudgeService,
  QUALITY_JUDGE_AGENT_ID,
  type JudgeGradeInput,
} from '@/features/quality-judge';

const logger = createChildLogger({ module: 'judge-routes' });

/**
 * @description Resolve the authenticated caller's OIDC sub (same shape as the other concierge
 * routes) so the judge task is owned/cost-attributed per user. MOCK_OIDC local dev resolves a
 * demo sub; anything else unauthenticated is a 401.
 * @param req - The Express request (requiresAuth has already run at the mount).
 * @returns The caller's sub.
 */
function resolveCallerSub(req: Request): string {
  const oidc = (req as any).oidc;
  if (oidc && typeof oidc.isAuthenticated === 'function' && oidc.isAuthenticated()) {
    const u = oidc.user || {};
    const sub = u.sub || u.oid;
    if (sub) return String(sub);
  }
  if (process.env.MOCK_OIDC === 'true') return 'demo-viewer';
  throw Object.assign(new Error('Not authenticated'), { status: 401 });
}

/**
 * @description Validate the request body into a JudgeGradeInput. Strict on shape (task/output
 * strings, rubric a non-empty string array) because the verdict contract keys dimensions off
 * the rubric verbatim — silently coercing garbage here would corrupt every downstream consumer.
 * @param body - The raw request body.
 * @returns The validated input, or an error message describing exactly what is wrong.
 */
export function parseGradeBody(body: unknown): { input?: JudgeGradeInput; error?: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.task !== 'string' || b.task.trim().length === 0) return { error: 'task (non-empty string) is required' };
  if (typeof b.output !== 'string' || b.output.trim().length === 0) return { error: 'output (non-empty string) is required' };
  if (!Array.isArray(b.rubric) || b.rubric.length === 0 || !b.rubric.every((c) => typeof c === 'string' && c.trim().length > 0)) {
    return { error: 'rubric (non-empty array of non-empty strings) is required' };
  }
  if (b.reference !== undefined && typeof b.reference !== 'string') return { error: 'reference must be a string when provided' };
  return {
    input: {
      task: b.task,
      output: b.output,
      rubric: b.rubric as string[],
      ...(typeof b.reference === 'string' && b.reference.trim().length > 0 ? { reference: b.reference } : {}),
    },
  };
}

/**
 * @description Build the auth-gated judge router. The mount wraps it in requiresAuth
 * (app.use('/api/judge', requiresAuth, createJudgeRoutes(ctx))) — never mount it bare.
 * @param ctx - The app context (supplies the orchestrator the concierge brain runs on).
 * @returns The Express router exposing POST / (grade one output).
 */
export function createJudgeRoutes(ctx: AppContext): Router {
  const router = Router();

  router.post('/', async (req: Request, res: Response) => {
    const started = Date.now();
    let sub: string;
    try { sub = resolveCallerSub(req); }
    catch (e: any) { res.status(e.status || 401).json({ error: e.message }); return; }

    const { input, error } = parseGradeBody(req.body);
    if (error || !input) { res.status(400).json({ error: error || 'invalid body' }); return; }

    try {
      const judge = new JudgeService({
        // The sanctioned inline-concierge transport (docs/building-a-bot.md Form B): the brain
        // runs on the quality-judge bot via the orchestrator, so its cost is recorded in
        // chat_tasks under the judge's agent_id — never an LLM call from controller code.
        invoker: async (taskId, prompt) => {
          const result = await ctx.orchestrator.processMessage(taskId, prompt, {
            agenticMode: true,
            autoApprove: false,
            source: 'quality-judge',
            agentId: QUALITY_JUDGE_AGENT_ID,
            userSub: sub,
          } as any);
          if (!result.success) throw new Error(result.error || 'judge brain execution failed');
          return String(result.response ?? '');
        },
      });
      const verdict = await judge.grade(input);
      logger.info(
        { sub, mode: verdict.mode, score: verdict.score, durationMs: Date.now() - started },
        'POST /api/judge served',
      );
      res.json(verdict);
    } catch (err: any) {
      logger.error({ err, stack: err?.stack, sub }, 'POST /api/judge failed');
      res.status(500).json({ error: err?.message || 'internal error' });
    }
  });

  return router;
}
