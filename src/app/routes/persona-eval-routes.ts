/**
 * Persona regression evals (golden-task gate) — operator-facing API.
 *
 * Personas ARE the quality gate (ai-lab/bot-personas/*.yaml), but until now nothing
 * regression-tested a persona edit. These routes run a persona's golden suite
 * (ai-lab/persona-evals/<persona>.yaml) through the server's ACTIVE provider lane
 * (ctx.getProvider() — the same LLMService the runtime resolved from FORCE_LLM_PROVIDER /
 * global-config) and report tiered assertion results honestly: structural assertions run in
 * every lane; semantic rubric assertions are graded by the LLM judge only when the lane is a
 * real provider, and are SKIPPED WITH NOTICE under noop — never faked green.
 *
 * Semantic grading runs on the SHARED quality-judge concierge bot, not on the provider handed to
 * the runner: grading is LLM work and the swarm controller never calls a model itself. The judge
 * lane below is the same JudgeService transport POST /api/judge, token-chase step 4, and the
 * LinkedIn assistant use, so its spend is recorded in `chat_tasks` under the judge's agent_id and
 * runs under that bot's harness/model settings. (The persona EXECUTION lane is still
 * ctx.getProvider() — see the note on buildRubricJudge.)
 *
 * Mount (integrator): app.use('/api/persona-evals', requiresAuth, requiresOperator, createPersonaEvalRoutes(ctx));
 * The router ALSO applies requiresOperator internally as a second layer, so a mis-mount
 * without the operator gate still refuses non-operators (evals can run real LLM spend and
 * expose persona internals).
 *
 * Runs are async (kick + poll, the ADR-063 golden-loop shape) because a real-lane suite can
 * take minutes; finished reports persist to the file-backed results store.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — GET /suites (catalog), POST /run (kick async: one persona or 'all'), GET /run/:runId (poll), GET /results (+ /results/:file). Operator-gated at the mount AND in-router.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Review fix: pruneRuns only evicts FINISHED runs (done/error), so kicking >50 runs can no longer 404 the poll record of a run that is still executing; if every tracked run is live the map temporarily exceeds the cap with a WARN (they become evictable as they finish).
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Closed a controller/LLM-boundary hole: semantic rubric grading ran on ctx.getProvider(), so in the api container the CONTROLLER made a live model call that hit none of the budget/cost chokepoints and never reached chat_tasks. The runner now gets a rubricJudge lane backed by JudgeService over the quality-judge concierge (the ADR-106 shared grader), bound to the operator who kicked the run so the spend is attributed. Guarded by tests/unit/persona-eval-judge-lane.spec.ts.
 *
 * @module persona-eval-routes
 */

import { Router, type Request, type Response } from 'express';
import { randomUUID } from 'crypto';
import { createChildLogger } from '@/shared/logger';
import { getCaller, requiresOperator } from '@/shared/middleware/authz';
import type { AppContext } from '@/app/composition/app-context';
import {
  PersonaEvalResultsStore,
  PersonaEvalRunner,
  listPersonaEvalSuites,
  loadPersonaEvalSuite,
  type PersonaEvalReport,
  type RubricJudgeLane,
} from '@/features/persona-evals';
import { JudgeService, QUALITY_JUDGE_AGENT_ID } from '@/features/quality-judge';

const logger = createChildLogger({ module: 'persona-eval-routes' });

/** In-memory run registry (kick + poll). Bounded so a long-lived api can't grow unbounded. */
interface EvalRun {
  runId: string;
  status: 'running' | 'done' | 'error';
  startedAt: string;
  finishedAt?: string;
  personas: string[];
  reports: Array<{ persona: string; file?: string; passed?: boolean; error?: string; report?: PersonaEvalReport }>;
  error?: string;
}
const RUNS = new Map<string, EvalRun>();
const MAX_TRACKED_RUNS = 50;

/**
 * Drops the oldest FINISHED runs past the cap. A still-'running' run is never evicted — its
 * background work is alive and pollers must keep resolving its runId — so when every tracked
 * run is live the map temporarily exceeds the cap (logged at WARN); finished runs become
 * evictable on the next kick.
 */
function pruneRuns(): void {
  for (const [runId, run] of RUNS) {
    if (RUNS.size <= MAX_TRACKED_RUNS) return;
    if (run.status !== 'running') RUNS.delete(runId);
  }
  if (RUNS.size > MAX_TRACKED_RUNS) {
    logger.warn({ tracked: RUNS.size, cap: MAX_TRACKED_RUNS }, 'persona-eval run registry over cap: every tracked run is still running; none evicted');
  }
}

/**
 * @description Builds the persona-evals router. Auth contract: mount behind
 * `requiresAuth, requiresOperator`; the router re-applies the operator gate internally as a
 * fail-closed second layer (empty OSHAL_OPERATOR_SUBS/EMAILS allowlist = nobody passes).
 * @param ctx - App context; `ctx.getProvider()` supplies the execution + judge lane.
 * @returns The router.
 */
export function createPersonaEvalRoutes(ctx: AppContext): Router {
  const router = Router();
  router.use(requiresOperator);
  const store = new PersonaEvalResultsStore();

  /** The suite catalog: every golden suite on disk, with load errors surfaced per file. */
  router.get('/suites', (_req: Request, res: Response) => {
    try {
      res.json({ suites: listPersonaEvalSuites() });
    } catch (err) {
      logger.error({ err }, 'persona-eval suites listing failed');
      res.status(500).json({ error: err instanceof Error ? err.message : 'internal error' });
    }
  });

  /**
   * Kick a run (async — returns runId immediately; poll GET /run/:runId).
   * Body: { persona: '<suite name>' | 'all' }.
   */
  router.post('/run', (req: Request, res: Response) => {
    try {
      const requested = String(req.body?.persona ?? 'all').trim() || 'all';
      const available = listPersonaEvalSuites().filter((s) => !s.error);
      const personas = requested === 'all' ? available.map((s) => s.persona) : [requested];
      if (requested !== 'all' && !available.some((s) => s.persona === requested)) {
        res.status(404).json({ error: `no valid suite for persona '${requested}'`, available: available.map((s) => s.persona) });
        return;
      }
      if (personas.length === 0) {
        res.status(404).json({ error: 'no valid persona-eval suites found on disk' });
        return;
      }
      const run = startRun(ctx, store, personas, resolveRunnerSub(req));
      res.status(202).json({ runId: run.runId, status: run.status, personas });
    } catch (err) {
      logger.error({ err }, 'persona-eval run kick failed');
      res.status(500).json({ error: err instanceof Error ? err.message : 'internal error' });
    }
  });

  /** Poll a run; the full per-assertion reports are included once status is 'done'. */
  router.get('/run/:runId', (req: Request, res: Response) => {
    const run = RUNS.get(String(req.params.runId));
    if (!run) {
      res.status(404).json({ error: 'unknown runId (runs are tracked in-memory; finished reports persist under /results)' });
      return;
    }
    res.json(run);
  });

  /** Stored report history (newest first), optionally ?persona=<name>. */
  router.get('/results', async (req: Request, res: Response) => {
    try {
      const persona = typeof req.query.persona === 'string' && req.query.persona.trim() ? req.query.persona.trim() : undefined;
      res.json({ results: await store.list(persona) });
    } catch (err) {
      logger.error({ err }, 'persona-eval results listing failed');
      res.status(500).json({ error: err instanceof Error ? err.message : 'internal error' });
    }
  });

  /** One full stored report by file name (traversal-guarded in the store). */
  router.get('/results/:file', async (req: Request, res: Response) => {
    try {
      const report = await store.read(String(req.params.file));
      if (!report) {
        res.status(404).json({ error: 'report not found' });
        return;
      }
      res.json(report);
    } catch (err) {
      logger.error({ err, file: req.params.file }, 'persona-eval report read failed');
      res.status(500).json({ error: err instanceof Error ? err.message : 'internal error' });
    }
  });

  return router;
}

/**
 * @description The identity a run's judge spend is attributed to. The router is operator-gated, so
 * a caller always exists; the email is accepted as the fallback key because a local/mock session can
 * carry an email without a sub, and 'operator' is the last resort rather than an unattributed call.
 * @param req - The authenticated request.
 * @returns A non-empty attribution key for the judge bot's cost rows.
 */
function resolveRunnerSub(req: Request): string {
  const caller = getCaller(req);
  return caller.sub ?? caller.email ?? 'operator';
}

/**
 * @description Builds the semantic-grading lane for a run: JudgeService over the shared
 * quality-judge concierge, reached by the sanctioned inline transport (ctx.orchestrator — the same
 * one POST /api/judge and token-chase use), so grading cost lands in `chat_tasks` under the judge's
 * agent_id and the controller never calls an LLM itself. JudgeService degrades to its FLAGGED
 * lexical-fallback lane on its own when FORCE_LLM_PROVIDER=noop or the bot is unreachable, and the
 * flag rides back to the report as the assertion's `via <mode>` so a proxy score is never mistaken
 * for a judged one.
 *
 * NOTE ON SCOPE: this closes the GRADING half only. Executing the golden tasks themselves still runs
 * on ctx.getProvider() (the runner's `executionService`) — that path is the eval's subject-under-test
 * and moving it onto a dispatched bot is a larger change tracked separately.
 * @param ctx - App context (supplies the orchestrator the concierge brain runs on).
 * @param sub - The operator the run (and its judge spend) is attributed to.
 * @returns The rubric-grading lane the runner consumes.
 */
function buildRubricJudge(ctx: AppContext, sub: string): RubricJudgeLane {
  const judge = new JudgeService({
    invoker: async (taskId, prompt) => {
      const result = await ctx.orchestrator.processMessage(taskId, prompt, {
        agenticMode: true,
        autoApprove: false,
        source: 'persona-eval-judge',
        agentId: QUALITY_JUDGE_AGENT_ID,
        userSub: sub,
      } as never);
      if (!result.success) throw new Error(result.error || 'judge brain execution failed');
      return String(result.response ?? '');
    },
  });
  return async ({ rubric, taskPrompt, output }) => {
    const verdict = await judge.grade({ task: taskPrompt, output, rubric: [rubric] });
    return { score: verdict.score, mode: verdict.mode };
  };
}

/**
 * @description Starts an async suite run over the given personas on the server's active
 * provider lane, persisting each finished report to the results store. Fire-and-forget with
 * every failure captured onto the run record — a thrown suite never kills the api process.
 * @param ctx - App context supplying the provider lane.
 * @param store - Results store for finished reports.
 * @param personas - Suite names to run, in order.
 * @param sub - The operator the run's judge spend is attributed to.
 * @returns The tracked run record (status 'running').
 */
function startRun(ctx: AppContext, store: PersonaEvalResultsStore, personas: string[], sub: string): EvalRun {
  const run: EvalRun = {
    runId: randomUUID(),
    status: 'running',
    startedAt: new Date().toISOString(),
    personas,
    reports: [],
  };
  RUNS.set(run.runId, run);
  pruneRuns();
  logger.info({ runId: run.runId, personas }, 'persona-eval run started');

  void (async () => {
    try {
      const runner = new PersonaEvalRunner({
        executionService: ctx.getProvider(),
        // Grading goes to the shared judge BOT — never the controller's own provider handle.
        rubricJudge: buildRubricJudge(ctx, sub),
      });
      for (const persona of personas) {
        try {
          const suite = loadPersonaEvalSuite(persona);
          const report = await runner.runSuite(suite);
          const file = await store.save(report);
          run.reports.push({ persona, file, passed: report.passed, report });
        } catch (err) {
          logger.error({ err, persona, runId: run.runId }, 'persona-eval suite run failed');
          run.reports.push({ persona, error: err instanceof Error ? err.message : String(err) });
        }
      }
      run.status = 'done';
    } catch (err) {
      logger.error({ err, runId: run.runId }, 'persona-eval run crashed');
      run.status = 'error';
      run.error = err instanceof Error ? err.message : String(err);
    }
    run.finishedAt = new Date().toISOString();
    logger.info({ runId: run.runId, status: run.status, passed: run.reports.filter((r) => r.passed).length }, 'persona-eval run finished');
  })();

  return run;
}
