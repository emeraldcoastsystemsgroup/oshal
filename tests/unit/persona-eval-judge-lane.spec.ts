/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the persona-eval judge lane (the controller/LLM-boundary fix): the routes hand the runner a rubricJudge, semantic grading goes through THAT lane and never through the execution provider, the judge's lexical-fallback flag rides into the assertion detail, the report names its grader, and the CLI's provider-judge fallback still works. Goes red if the route stops injecting the judge (the exact hole this closed), if the runner prefers the raw provider again, or if a noop execution lane starts grading canned stub output because a judge happens to be wired.
 */

import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PersonaEvalRunner, type PersonaEvalSuite, type RubricJudgeLane } from '../../src/features/persona-evals';
import type { LLMService } from '../../src/features/llm-provider';

/** A minimal LLMService stand-in: records every prompt it is asked to complete. */
class RecordingLane {
  readonly prompts: string[] = [];
  constructor(private readonly name: string, private readonly reply: string) {}
  getProviderName(): string { return this.name; }
  async sendRequest(options: { messages: Array<{ content: string }> }): Promise<{ content: Array<{ type: string; text: string }> }> {
    this.prompts.push(options.messages[0]?.content ?? '');
    return { content: [{ type: 'text', text: this.reply }] };
  }
}

/** Writes a throwaway persona YAML the runner can load AS DEPLOYED. */
function writeTempPersona(): string {
  const dir = mkdtempSync(join(tmpdir(), 'persona-eval-judge-'));
  writeFileSync(
    join(dir, 'test-persona.yaml'),
    ['name: test-persona', 'role: Test Persona', 'perspective: |', '  You are a test persona.', ''].join('\n'),
    'utf8',
  );
  return dir;
}

/** One suite with a single semantic (rubric) assertion. */
function semanticSuite(minScore = 70): PersonaEvalSuite {
  return {
    persona: 'test-persona',
    tasks: [{
      id: 't1',
      prompt: 'Summarize the incident.',
      assertions: [{ id: 'sem1', tier: 'semantic', type: 'rubric', rubric: 'names the root cause', minScore }],
    }],
  };
}

describe('persona-eval judge lane — the runner prefers the injected judge', () => {
  it('grades through the injected lane and NEVER asks the execution provider to judge', async () => {
    const execution = new RecordingLane('fake-harness', 'the root cause was a full disk');
    const judgeCalls: Array<{ rubric: string; output: string }> = [];
    const rubricJudge: RubricJudgeLane = async ({ rubric, output }) => {
      judgeCalls.push({ rubric, output });
      return { score: 88, mode: 'llm' };
    };

    const report = await new PersonaEvalRunner({
      executionService: execution as unknown as LLMService,
      rubricJudge,
      personaDir: writeTempPersona(),
    }).runSuite(semanticSuite());

    const assertion = report.tasks[0].assertions[0];
    expect(assertion.status).toBe('pass');
    expect(assertion.score).toBe(88);
    expect(judgeCalls).toHaveLength(1);
    expect(judgeCalls[0].rubric).toBe('names the root cause');
    expect(judgeCalls[0].output).toContain('full disk');

    // The execution lane ran the TASK once and was never handed a grading prompt — that is the
    // controller/LLM-boundary property this guard exists for.
    expect(execution.prompts).toHaveLength(1);
    expect(execution.prompts[0]).toContain('Summarize the incident.');
    expect(execution.prompts.some((p) => p.includes('strict QA judge'))).toBe(false);

    // The report says WHO judged it, so spend can be traced to the judge bot.
    expect(report.lane.judge).toBe('shared-judge-bot');
    expect(report.lane.semanticCapable).toBe(true);
    expect(report.lane.laneNotice).toContain('shared-judge-bot');
  });

  it('labels a degraded (lexical-fallback) verdict in the assertion detail instead of passing it off as judged', async () => {
    const report = await new PersonaEvalRunner({
      executionService: new RecordingLane('fake-harness', 'output') as unknown as LLMService,
      rubricJudge: async () => ({ score: 71, mode: 'lexical-fallback' }),
      personaDir: writeTempPersona(),
    }).runSuite(semanticSuite());

    const assertion = report.tasks[0].assertions[0];
    expect(assertion.status).toBe('pass');
    expect(assertion.detail).toBe('judge scored 71 (threshold 70) via lexical-fallback');
  });

  it('a judge error is an assertion ERROR, never a default pass', async () => {
    const report = await new PersonaEvalRunner({
      executionService: new RecordingLane('fake-harness', 'output') as unknown as LLMService,
      rubricJudge: async () => ({ error: 'judge bot unreachable' }),
      personaDir: writeTempPersona(),
    }).runSuite(semanticSuite());

    expect(report.tasks[0].assertions[0].status).toBe('error');
    expect(report.tasks[0].assertions[0].detail).toContain('judge bot unreachable');
    expect(report.passed).toBe(false);
  });

  it('a wired judge does NOT make a noop execution lane semantic-capable (grading stub output is not a verdict)', async () => {
    let judgeCalled = false;
    const report = await new PersonaEvalRunner({
      executionService: new RecordingLane('noop', 'canned stub output') as unknown as LLMService,
      rubricJudge: async () => { judgeCalled = true; return { score: 100, mode: 'llm' }; },
      personaDir: writeTempPersona(),
    }).runSuite(semanticSuite());

    expect(judgeCalled).toBe(false);
    expect(report.lane.semanticCapable).toBe(false);
    expect(report.tasks[0].assertions[0].status).toBe('skipped');
  });

  it('with no judge lane the provider path still grades — the documented CLI fallback', async () => {
    const judgeProvider = new RecordingLane('cli-provider', '{"score": 91}');
    const report = await new PersonaEvalRunner({
      executionService: new RecordingLane('fake-harness', 'output') as unknown as LLMService,
      judgeService: judgeProvider as unknown as LLMService,
      personaDir: writeTempPersona(),
    }).runSuite(semanticSuite());

    expect(report.tasks[0].assertions[0].score).toBe(91);
    expect(report.lane.judge).toBe('cli-provider');
    expect(judgeProvider.prompts[0]).toContain('strict QA judge');
  });
});

describe('persona-eval routes — the judge lane is actually wired at the mount', () => {
  const routeSource = readFileSync(resolve(process.cwd(), 'src/app/routes/persona-eval-routes.ts'), 'utf8');

  it('the route builds the runner WITH a rubricJudge backed by the shared quality-judge bot', () => {
    // The hole this closed: `new PersonaEvalRunner({ executionService: ctx.getProvider() })` alone
    // meant semantic grading was a live model call made by the controller, outside every budget
    // chokepoint and absent from chat_tasks.
    expect(routeSource).toContain('rubricJudge: buildRubricJudge(ctx, sub)');
    expect(routeSource).toContain('new JudgeService({');
    expect(routeSource).toContain('agentId: QUALITY_JUDGE_AGENT_ID');
    expect(routeSource).toContain('ctx.orchestrator.processMessage');
    // Grading must not be re-pointed at the provider handle by a later edit.
    expect(routeSource).not.toContain('judgeService: ctx.getProvider()');
  });

  it('the docs describe exactly this wiring (no aspirational /api/judge claim)', () => {
    const doc = readFileSync(resolve(process.cwd(), 'docs/architecture/platform-shared-services.md'), 'utf8');
    expect(doc).toContain('the persona-eval **API** path');
    expect(doc).toContain('`JudgeService`');
    // The CLI genuinely does not go through the bot; the doc has to say so.
    expect(doc).toContain('grades on its own provider lane');
  });
});
