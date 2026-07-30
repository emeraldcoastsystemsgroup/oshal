/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Persona regression eval runner: loads the persona AS DEPLOYED (loadPersonaFromFile — the bot nodes' own loader), assembles the same embedded-persona system prompt shape the bot-node prompt assembly uses as its fallback, executes each golden task through the injected LLMService lane (noop or real harness — the existing provider interface every harness implements), and evaluates tiered assertions into an evidence-carrying report. All-skipped runs are NOT passes.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Accept an injected `rubricJudge` lane and prefer it for every semantic assertion, so the API path can grade on the SHARED quality-judge bot (cost in chat_tasks) instead of the raw LLMService the caller handed in — the controller/LLM-boundary rule. The provider path is unchanged and stays the documented fallback for callers with no judge lane (the CLI). Two honesty consequences: the judge's own lane label rides into the assertion detail, and a judge lane no longer makes a NOOP EXECUTION lane semantic-capable — grading canned stub output would manufacture a verdict.
 */

import { randomUUID } from 'crypto';
import { createChildLogger } from '@/shared/logger';
import type { LLMService } from '@/features/llm-provider';
import { loadPersonaFromFile, type BotPersona } from '@/features/swarm-orchestration';
import { evaluateStructuralAssertion, type StructuralEvalContext } from './assertion-engine';
import { gradeRubric, isSemanticCapable, type RubricJudgeLane } from './semantic-judge';
import type {
  AssertionResult,
  EvalAssertion,
  EvalLaneInfo,
  EvalSummary,
  EvalTask,
  PersonaEvalReport,
  PersonaEvalSuite,
  TaskResult,
} from '../types';

const logger = createChildLogger({ module: 'persona-eval-runner' });

/** Cap on the raw-output excerpt persisted per task (evidence, not a transcript store). */
const DEFAULT_MAX_EXCERPT = 2000;

/**
 * @description Dependencies for a runner instance. The execution lane is an `LLMService` —
 * the exact interface every harness (claude-code, codex, cline, gemini) and the noop
 * provider already implement, so the eval exercises the same provider boundary the swarm's
 * bot execution does. The judge lane defaults to the execution lane; under noop, semantic
 * assertions are skipped-with-notice rather than fake-graded.
 */
export interface PersonaEvalRunnerDeps {
  /** The lane that executes the persona (noop for plumbing runs; a real harness for the gate). */
  executionService: LLMService;
  /**
   * PREFERRED judge lane: a grading callback the app layer binds to the SHARED quality-judge bot
   * (ADR-106), so grading spend is a real bot call captured in `chat_tasks` and the controller never
   * calls a model itself. When present it wins over `judgeService`/`executionService` for every
   * semantic assertion.
   */
  rubricJudge?: RubricJudgeLane;
  /**
   * Fallback judge lane for callers with no shared-judge transport (the `scripts/persona-eval.ts`
   * CLI has no orchestrator): a raw `LLMService` used directly for rubric grading. Defaults to the
   * execution lane. Ignored when `rubricJudge` is supplied.
   */
  judgeService?: LLMService;
  /** Persona YAML directory override (defaults to ai-lab/bot-personas via the shared loader). */
  personaDir?: string;
  /** Workspace directory for `artifact-exists` assertions (CLI lanes that captured one). */
  workspaceDir?: string;
  /** Cap on the stored output excerpt per task. */
  maxOutputChars?: number;
}

/**
 * @description Runs a persona's golden-task suite through an LLM lane and evaluates the tiered
 * assertions into a {@link PersonaEvalReport}. One instance is stateless across runs and safe
 * to reuse; each `runSuite` call re-reads the persona from disk so the eval always grades the
 * persona AS CURRENTLY EDITED — the whole point of a regression gate on persona edits.
 */
export class PersonaEvalRunner {
  private readonly deps: PersonaEvalRunnerDeps;

  constructor(deps: PersonaEvalRunnerDeps) {
    this.deps = deps;
  }

  /**
   * @description Executes every golden task in the suite and returns the full report.
   * Throws when the persona YAML cannot be found — an eval against a missing persona is a
   * configuration error, not a gradeable run.
   * @param suite - A validated suite (see suite-loader).
   * @returns Report with per-task, per-assertion detail and the gate verdict.
   */
  async runSuite(suite: PersonaEvalSuite): Promise<PersonaEvalReport> {
    const startedAt = new Date().toISOString();
    const persona = loadPersonaFromFile(suite.persona, this.deps.personaDir);
    if (!persona || !persona.perspective) {
      throw new Error(`persona '${suite.persona}' not found (or has no perspective) in ${this.deps.personaDir ?? 'ai-lab/bot-personas'}`);
    }
    const lane = this.describeLane();
    logger.info({ persona: suite.persona, lane: lane.provider, tasks: suite.tasks.length }, 'Persona eval suite starting');

    const systemPrompt = buildPersonaSystemPrompt(persona);
    const tasks: TaskResult[] = [];
    for (const task of suite.tasks) {
      tasks.push(await this.runTask(persona, systemPrompt, task, lane));
    }

    const summary = summarize(tasks);
    const passed = summary.tasks.failed === 0 && summary.tasks.errored === 0 && summary.tasks.passed > 0;
    const report: PersonaEvalReport = {
      persona: suite.persona,
      suiteDescription: suite.description,
      lane,
      startedAt,
      finishedAt: new Date().toISOString(),
      tasks,
      summary,
      passed,
    };
    logger.info({ persona: suite.persona, passed, summary: summary.tasks }, 'Persona eval suite finished');
    return report;
  }

  /** Executes one golden task and evaluates its assertions. */
  private async runTask(
    persona: BotPersona,
    systemPrompt: string,
    task: EvalTask,
    lane: EvalLaneInfo,
  ): Promise<TaskResult> {
    const start = Date.now();
    const prompt = buildTaskPrompt(task);
    let output: string;
    try {
      const res = await this.deps.executionService.sendRequest({
        messages: [{ role: 'user', content: prompt }],
        systemPrompt,
        taskId: `persona-eval-${task.id}-${randomUUID().slice(0, 8)}`,
        agentId: persona.agentId || persona.name,
        interactionMode: 'task',
      });
      output = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('').trim();
    } catch (err) {
      logger.error({ err, task: task.id, persona: persona.name }, 'Persona eval task execution failed');
      return {
        id: task.id,
        title: task.title ?? task.id,
        status: 'error',
        outputExcerpt: '',
        durationMs: Date.now() - start,
        assertions: task.assertions.map((a) => ({
          id: a.id, tier: a.tier, type: a.type, status: 'skipped' as const,
          detail: `not evaluated: task execution failed (${err instanceof Error ? err.message : String(err)})`,
        })),
      };
    }

    const assertions = await this.evaluateAssertions(task, prompt, output, lane);
    return {
      id: task.id,
      title: task.title ?? task.id,
      status: rollupTaskStatus(assertions),
      outputExcerpt: output.slice(0, this.deps.maxOutputChars ?? DEFAULT_MAX_EXCERPT),
      durationMs: Date.now() - start,
      assertions,
    };
  }

  /** Evaluates all assertions for a task: structural mechanically, semantic via the judge. */
  private async evaluateAssertions(
    task: EvalTask,
    prompt: string,
    output: string,
    lane: EvalLaneInfo,
  ): Promise<AssertionResult[]> {
    const ctx: StructuralEvalContext = { workspaceDir: this.deps.workspaceDir };
    const results: AssertionResult[] = [];
    for (const a of task.assertions) {
      if (a.tier === 'structural') {
        results.push(evaluateStructuralAssertion(a, output, ctx));
      } else {
        results.push(await this.evaluateSemantic(a, prompt, output, lane));
      }
    }
    return results;
  }

  /** Grades one semantic assertion, or skips-with-notice when the lane cannot judge. */
  private async evaluateSemantic(
    a: EvalAssertion,
    prompt: string,
    output: string,
    lane: EvalLaneInfo,
  ): Promise<AssertionResult> {
    const base = { id: a.id, tier: a.tier, type: a.type };
    if (!lane.semanticCapable) {
      return {
        ...base,
        status: 'skipped',
        detail: `semantic rubric skipped: lane '${lane.provider}' has no LLM judge (noop). Run with a real provider lane to grade this assertion.`,
      };
    }
    const args = { rubric: String(a.rubric), taskPrompt: prompt, output };
    // The shared-judge lane wins when the caller wired one; the raw provider stays the fallback for
    // callers that have no bot transport (see PersonaEvalRunnerDeps).
    const grade = this.deps.rubricJudge
      ? await this.deps.rubricJudge(args)
      : await gradeRubric(this.deps.judgeService ?? this.deps.executionService, args);
    if (grade.error !== undefined || grade.score === undefined) {
      return { ...base, status: 'error', detail: grade.error ?? 'judge returned no score' };
    }
    const minScore = a.minScore ?? 70;
    const via = grade.mode ? ` via ${grade.mode}` : '';
    return {
      ...base,
      status: grade.score >= minScore ? 'pass' : 'fail',
      score: grade.score,
      detail: `judge scored ${grade.score} (threshold ${minScore})${via}`,
    };
  }

  /** Describes the active lane honestly, including what its results do and do not prove. */
  private describeLane(): EvalLaneInfo {
    const provider = this.deps.executionService.getProviderName();
    // Grading canned noop output would manufacture a verdict no matter how good the judge is, so the
    // EXECUTION lane has to be real before semantic assertions are graded at all — a shared-judge
    // lane does not buy its way past that.
    const executionReal = isSemanticCapable(this.deps.executionService);
    const judge = this.deps.rubricJudge
      ? 'shared-judge-bot'
      : (this.deps.judgeService ?? this.deps.executionService).getProviderName();
    const semanticCapable = executionReal
      && (this.deps.rubricJudge !== undefined || isSemanticCapable(this.deps.judgeService ?? this.deps.executionService));
    return {
      provider,
      judge,
      semanticCapable,
      laneNotice: semanticCapable
        ? `Executed on '${provider}'; semantic rubrics graded by '${judge}'. Structural + semantic tiers both graded.`
        : `Executed on '${provider}' (noop lane): structural assertions ran against the stub output — this run proves the eval plumbing end-to-end, NOT persona quality. Semantic assertions were skipped with notice.`,
    };
  }
}

/**
 * @description Builds the persona's system prompt the way the bot-node prompt assembly embeds
 * a filesystem persona when no workspace context file can be written (the `buildFilePersonaLayer`
 * fallback shape): identity header, the full `perspective` block (which IS the persona's quality
 * gate), then the operating procedure. Keeping this shape identical means the eval grades the
 * same instruction surface the deployed bot actually receives.
 * @param persona - The persona as loaded from ai-lab/bot-personas.
 * @returns The assembled system prompt.
 */
export function buildPersonaSystemPrompt(persona: BotPersona): string {
  const sections = [
    `# YOUR IDENTITY`,
    `You are **${persona.name}** — ${persona.role || 'AI assistant'}.`,
    '',
    `## Bot Identity: ${persona.role || persona.name}`,
    '',
    persona.perspective,
  ];
  if (persona.systemPrompt && persona.systemPrompt.trim().length > 0) {
    sections.push('', '## Required Operating Procedure', '', persona.systemPrompt.trim());
  }
  return sections.join('\n');
}

/**
 * @description Builds the user message for one golden task: the fixture-ticket prompt plus the
 * structured fixture data as an explicit block, framed the way whole-ticket dispatches frame
 * their payload (the ask arrives as one text block the persona must ground itself in).
 * @param task - The golden task.
 * @returns The prompt string sent as the user message.
 */
export function buildTaskPrompt(task: EvalTask): string {
  const parts = [task.prompt.trim()];
  if (task.fixture !== undefined) {
    parts.push(
      '',
      '== FIXTURE DATA (this is the real data handed to you for this task — ground every claim in it) ==',
      '',
      JSON.stringify(task.fixture, null, 2),
    );
  }
  return parts.join('\n');
}

/**
 * @description Rolls one task's assertion outcomes into a task status. Any fail/error fails the
 * task; a task where EVERY assertion skipped is `skipped` (visible, not green); otherwise pass.
 * Exported for unit tests.
 * @param assertions - The task's assertion results.
 * @returns The task status.
 */
export function rollupTaskStatus(assertions: AssertionResult[]): TaskResult['status'] {
  if (assertions.some((a) => a.status === 'fail' || a.status === 'error')) return 'fail';
  if (assertions.length > 0 && assertions.every((a) => a.status === 'skipped')) return 'skipped';
  return 'pass';
}

/**
 * @description Aggregates task results into the report summary (tasks and assertions counted
 * separately). Exported for unit tests.
 * @param tasks - Executed task results.
 * @returns The summary counts.
 */
export function summarize(tasks: TaskResult[]): EvalSummary {
  const summary: EvalSummary = {
    tasks: { total: tasks.length, passed: 0, failed: 0, skipped: 0, errored: 0 },
    assertions: { total: 0, passed: 0, failed: 0, skipped: 0, errored: 0 },
  };
  for (const t of tasks) {
    if (t.status === 'pass') summary.tasks.passed++;
    else if (t.status === 'fail') summary.tasks.failed++;
    else if (t.status === 'skipped') summary.tasks.skipped++;
    else summary.tasks.errored++;
    for (const a of t.assertions) {
      summary.assertions.total++;
      if (a.status === 'pass') summary.assertions.passed++;
      else if (a.status === 'fail') summary.assertions.failed++;
      else if (a.status === 'skipped') summary.assertions.skipped++;
      else summary.assertions.errored++;
    }
  }
  return summary;
}
