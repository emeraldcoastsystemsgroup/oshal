/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | JudgeService — the ONE shared grading entry point. Grading is LLM work, so the LLM lane runs on the quality-judge CONCIERGE bot (inline on the api via the injected brain invoker — the swarm controller itself never calls an LLM); one corrective retry on malformed output; deterministic lexical fallback lane when FORCE_LLM_PROVIDER=noop or the bot is unavailable, flagged mode:'lexical-fallback'.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Review fix: gradeViaBot tracks how many LLM invocations it actually started and passes that into lexicalFallbackGrade, so degraded verdicts (twice-malformed = 2, throw during attempt N = N) no longer report attempts:0 and under-count judge spend/retry rate.
 */

import { randomUUID } from 'crypto';
import { createChildLogger } from '@/shared/logger';
import {
  buildJudgePrompt,
  extractJudgeJson,
  lexicalFallbackGrade,
  validateLlmVerdict,
  type JudgeGradeInput,
  type JudgeVerdict,
} from './judge-verdict';

const logger = createChildLogger({ module: 'quality-judge' });

/**
 * @description The quality-judge concierge bot's agent id — MUST match the entry in both
 * swarm-bot-registry.ts and swarm-bot-registry-local.ts and ai-lab/bot-personas/quality-judge.yaml
 * (the docs/building-a-bot.md identity rule). Exported so the app-layer route and any consumer
 * dispatching by id all point at the same accountable bot (its grading cost lands in chat_tasks
 * under this id).
 */
export const QUALITY_JUDGE_AGENT_ID = 'a0000000-0000-0000-0000-000000000053';

/**
 * @description How a grading prompt reaches the quality-judge concierge's brain. The app layer
 * wires this to `ctx.orchestrator.processMessage(taskId, prompt, { agentId: QUALITY_JUDGE_AGENT_ID, ... })`
 * (the sanctioned inline-concierge transport — same as movies/workflow-assistant); the feature
 * layer only sees this narrow function so FSD's app→features direction is preserved and tests
 * can inject a fake brain with zero LLM cost.
 * @param taskId - Unique task id for cost capture / conversation isolation.
 * @param prompt - The full grading prompt.
 * @returns The raw model reply text.
 */
export type JudgeBrainInvoker = (taskId: string, prompt: string) => Promise<string>;

/** @description Construction options for {@link JudgeService}. */
export interface JudgeServiceOptions {
  /**
   * The concierge brain transport; omit/null when no orchestrator exists in this process
   * (e.g. bare unit tests) — every grade then takes the lexical fallback lane.
   */
  invoker?: JudgeBrainInvoker | null;
  /**
   * Process-level provider override, defaulting to env FORCE_LLM_PROVIDER. When it resolves to
   * 'noop' the LLM lane is skipped entirely (the noop harness returns canned text that would
   * never parse as a verdict — burning two attempts on it is pure waste).
   */
  forceProvider?: string;
}

/**
 * @description Shared LLM-judge/grading service. `grade()` returns a VALIDATED verdict from one
 * of two clearly-flagged lanes: the quality-judge concierge bot (mode 'llm', one corrective
 * retry on malformed output) or the deterministic Jaccard/token-coverage proxy (mode
 * 'lexical-fallback') when the LLM lane is configured off or unavailable. Consumers
 * (POST /api/judge, token-chase, persona evals) never see a malformed or throwing judge.
 */
export class JudgeService {
  private readonly invoker: JudgeBrainInvoker | null;
  private readonly forceProvider: string;

  /**
   * @description Wire the service to (optionally) a concierge brain transport.
   * @param options - Invoker + provider override; see {@link JudgeServiceOptions}.
   */
  constructor(options: JudgeServiceOptions = {}) {
    this.invoker = options.invoker ?? null;
    this.forceProvider = (options.forceProvider ?? process.env.FORCE_LLM_PROVIDER ?? '').trim().toLowerCase();
  }

  /**
   * @description Grade one output against a task + rubric (+ optional reference). Never throws
   * and never returns a malformed verdict: LLM-lane failures (unavailable bot, invoke error,
   * twice-malformed reply) degrade to the deterministic lexical lane, flagged in `mode` and
   * explained in `rationale` so consumers and dashboards can tell proxy scores from judgements.
   * @param input - The grade input {task, output, rubric[], reference?}.
   * @returns The validated verdict.
   */
  async grade(input: JudgeGradeInput): Promise<JudgeVerdict> {
    const started = Date.now();
    logger.info(
      { rubricCount: input.rubric.length, hasReference: !!input.reference, outputChars: input.output.length },
      'Judge grade requested',
    );

    if (this.forceProvider === 'noop') {
      const verdict = lexicalFallbackGrade(input, 'FORCE_LLM_PROVIDER=noop');
      logger.info({ mode: verdict.mode, score: verdict.score, durationMs: Date.now() - started }, 'Judge grade complete');
      return verdict;
    }
    if (!this.invoker) {
      const verdict = lexicalFallbackGrade(input, 'judge bot unavailable — no brain invoker wired');
      logger.info({ mode: verdict.mode, score: verdict.score, durationMs: Date.now() - started }, 'Judge grade complete');
      return verdict;
    }

    const verdict = await this.gradeViaBot(input);
    logger.info(
      { mode: verdict.mode, score: verdict.score, attempts: verdict.attempts, durationMs: Date.now() - started },
      'Judge grade complete',
    );
    return verdict;
  }

  /**
   * @description The LLM lane: prompt the concierge, extract + validate JSON, retry ONCE with a
   * corrective prompt on malformed output, and fall back lexically when both attempts fail or
   * the bot errors. Kept under the 50-line rule by delegating parsing to the pure helpers.
   * @param input - The grade input.
   * @returns A validated verdict from the LLM lane, or the flagged lexical fallback.
   */
  private async gradeViaBot(input: JudgeGradeInput): Promise<JudgeVerdict> {
    const prompt = buildJudgePrompt(input);
    let raw = '';
    // Real LLM invocations started — threaded into every degraded verdict so
    // verdict.attempts never under-reports judge spend (review finding 2026-07-15).
    let attemptsStarted = 0;
    try {
      attemptsStarted = 1;
      raw = await this.invoker!(`judge-${randomUUID()}`, prompt);
      const first = validateLlmVerdict(extractJudgeJson(raw), input.rubric, 1);
      if (first) return first;

      logger.warn({ replyChars: raw.length }, 'Judge reply malformed — retrying once with corrective prompt');
      const retryPrompt = [
        'Your previous reply was not a valid verdict JSON object. This is attempt 2 of 2.',
        'Reply with ONLY the JSON object described below — no prose, no fences, no apology.',
        '',
        prompt,
      ].join('\n');
      attemptsStarted = 2;
      raw = await this.invoker!(`judge-${randomUUID()}`, retryPrompt);
      const second = validateLlmVerdict(extractJudgeJson(raw), input.rubric, 2);
      if (second) return second;

      logger.error(
        { replyPreview: raw.slice(0, 200) },
        'Judge reply malformed after retry — degrading to the lexical fallback lane',
      );
      return lexicalFallbackGrade(input, 'judge bot returned malformed output twice', attemptsStarted);
    } catch (err) {
      logger.error({ err, stack: (err as Error)?.stack }, 'Judge bot invocation failed — degrading to the lexical fallback lane');
      return lexicalFallbackGrade(input, 'judge bot invocation failed', attemptsStarted);
    }
  }
}
