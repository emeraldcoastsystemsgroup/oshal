/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Unit tests for the persona regression-eval slice: structural assertion engine (every type incl. artifact skip/traversal), JSON extraction, judge-score parsing, suite validation, task/summary rollups, the runner's honest lane behavior (semantic skipped under noop, graded with a real judge, execution errors surfaced), and a load check over the three shipped golden suites.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Review-fix regressions: loader resolves a suite by its YAML persona: field when the filename differs (and rejects duplicate persona declarations); results store never clobbers reports on same-instant saves.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  PersonaEvalResultsStore,
  PersonaEvalRunner,
  buildPersonaSystemPrompt,
  buildTaskPrompt,
  evaluateStructuralAssertion,
  extractFirstJson,
  listPersonaEvalSuites,
  loadPersonaEvalSuite,
  parseJudgeScore,
  rollupTaskStatus,
  summarize,
  validateAssertion,
  validateSuite,
  type AssertionResult,
  type EvalAssertion,
  type PersonaEvalReport,
  type PersonaEvalSuite,
} from '@/features/persona-evals';
import { LLMService, type LLMResponse, type SendRequestOptions } from '@/features/llm-provider';
import { loadPersonaFromFile } from '@/features/swarm-orchestration';

// ── Helpers ────────────────────────────────────────────────────────────────────

function structural(partial: Partial<EvalAssertion> & { type: EvalAssertion['type'] }): EvalAssertion {
  return { id: partial.id ?? 'a1', tier: 'structural', ...partial };
}

/** Canned-response LLMService — the minimal honest stand-in for a lane in unit tests. */
class FakeLane extends LLMService {
  private readonly reply: string;
  private readonly failWith?: Error;

  constructor(name: string, reply: string, failWith?: Error) {
    super(name, {});
    this.reply = reply;
    this.failWith = failWith;
  }

  async sendRequest(_options: SendRequestOptions): Promise<LLMResponse> {
    if (this.failWith) throw this.failWith;
    return {
      content: [{ type: 'text', text: this.reply }],
      usage: { inputTokens: 1, outputTokens: 1 },
      model: 'fake-model',
      stopReason: 'end_turn',
    };
  }
}

/** Writes a minimal persona YAML into a temp dir and returns the dir. */
function writeTempPersona(): string {
  const dir = mkdtempSync(join(tmpdir(), 'persona-eval-test-'));
  writeFileSync(
    join(dir, 'test-persona.yaml'),
    [
      'name: test-persona',
      'role: Test Role',
      'agent_id: aaaaaaaa-0000-0000-0000-000000000001',
      'perspective: |',
      '  You are a test persona. Always answer with grounded facts.',
      'system_prompt: |',
      '  Follow the operating procedure.',
    ].join('\n'),
    'utf8',
  );
  return dir;
}

function suiteWith(assertions: EvalAssertion[], fixture?: unknown): PersonaEvalSuite {
  return {
    persona: 'test-persona',
    description: 'unit-test suite',
    tasks: [{ id: 't1', title: 'task one', prompt: 'Do the thing.', fixture, assertions }],
  };
}

// ── extractFirstJson ───────────────────────────────────────────────────────────

describe('extractFirstJson', () => {
  it('parses a bare JSON object', () => {
    expect(extractFirstJson('{"a": 1}')).toEqual({ a: 1 });
  });

  it('parses a fenced json block inside prose', () => {
    const text = 'Here you go:\n```json\n[{"id": "m1"}]\n```\nDone.';
    expect(extractFirstJson(text)).toEqual([{ id: 'm1' }]);
  });

  it('parses the widest brace span inside prose', () => {
    expect(extractFirstJson('prefix {"x": [1,2]} suffix')).toEqual({ x: [1, 2] });
  });

  it('returns undefined when nothing parses', () => {
    expect(extractFirstJson('no json here { broken')).toBeUndefined();
  });
});

// ── structural assertions ──────────────────────────────────────────────────────

describe('evaluateStructuralAssertion', () => {
  it('contains passes case-insensitively by default and fails when absent', () => {
    const a = structural({ type: 'contains', value: 'Thursday' });
    expect(evaluateStructuralAssertion(a, 'delivered by THURSDAY').status).toBe('pass');
    expect(evaluateStructuralAssertion(a, 'delivered by Friday').status).toBe('fail');
  });

  it('contains honors caseInsensitive=false', () => {
    const a = structural({ type: 'contains', value: 'Thursday', caseInsensitive: false });
    expect(evaluateStructuralAssertion(a, 'thursday').status).toBe('fail');
  });

  it('not-contains inverts', () => {
    const a = structural({ type: 'not-contains', value: 'Best regards' });
    expect(evaluateStructuralAssertion(a, 'short reply').status).toBe('pass');
    expect(evaluateStructuralAssertion(a, 'bye\nBest regards').status).toBe('fail');
  });

  it('regex and not-regex evaluate with flags', () => {
    const re = structural({ type: 'regex', pattern: '\\bP1\\b' });
    expect(evaluateStructuralAssertion(re, 'Severity: P1 critical').status).toBe('pass');
    expect(evaluateStructuralAssertion(re, 'Severity: P3').status).toBe('fail');
    const notRe = structural({ type: 'not-regex', pattern: '^subject\\s*:', flags: 'im' });
    expect(evaluateStructuralAssertion(notRe, 'Hi Dana,\nsee you').status).toBe('pass');
    expect(evaluateStructuralAssertion(notRe, 'Subject: re: hello\nbody').status).toBe('fail');
  });

  it('json-parses and json-keys check shape on objects and array elements', () => {
    const parses = structural({ type: 'json-parses' });
    expect(evaluateStructuralAssertion(parses, 'nope').status).toBe('fail');
    expect(evaluateStructuralAssertion(parses, '[{"id":1}]').status).toBe('pass');

    const keys = structural({ type: 'json-keys', keys: ['id', 'classification'] });
    expect(evaluateStructuralAssertion(keys, '[{"id":"m1","classification":"junk"}]').status).toBe('pass');
    const r = evaluateStructuralAssertion(keys, '[{"id":"m1"}]');
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('classification');
    expect(evaluateStructuralAssertion(keys, '[]').status).toBe('fail');
  });

  it('citation-block finds a doc_id marker (default and custom patterns)', () => {
    const a = structural({ type: 'citation-block' });
    expect(evaluateStructuralAssertion(a, 'per doc_id: k8s-node-pressure-001').status).toBe('pass');
    expect(evaluateStructuralAssertion(a, 'no provenance here').status).toBe('fail');
    const custom = structural({ type: 'citation-block', pattern: '\\[source:\\s*\\S+\\]' });
    expect(evaluateStructuralAssertion(custom, 'x [source: rb-7]').status).toBe('pass');
  });

  it('max-lines counts non-empty lines and min-words counts words', () => {
    const maxL = structural({ type: 'max-lines', max: 2 });
    expect(evaluateStructuralAssertion(maxL, 'a\n\nb\n').status).toBe('pass');
    expect(evaluateStructuralAssertion(maxL, 'a\nb\nc').status).toBe('fail');
    const minW = structural({ type: 'min-words', min: 3 });
    expect(evaluateStructuralAssertion(minW, 'one two three').status).toBe('pass');
    expect(evaluateStructuralAssertion(minW, 'one two').status).toBe('fail');
  });

  it('artifact-exists skips without a workspace, checks within one, and errors on traversal', () => {
    const a = structural({ type: 'artifact-exists', path: 'INCIDENT-SUMMARY.md' });
    expect(evaluateStructuralAssertion(a, '').status).toBe('skipped');

    const ws = mkdtempSync(join(tmpdir(), 'persona-eval-ws-'));
    expect(evaluateStructuralAssertion(a, '', { workspaceDir: ws }).status).toBe('fail');
    writeFileSync(join(ws, 'INCIDENT-SUMMARY.md'), '# summary', 'utf8');
    expect(evaluateStructuralAssertion(a, '', { workspaceDir: ws }).status).toBe('pass');

    const nested = structural({ type: 'artifact-exists', path: 'deliverables/out.md' });
    mkdirSync(join(ws, 'deliverables'));
    writeFileSync(join(ws, 'deliverables', 'out.md'), 'x', 'utf8');
    expect(evaluateStructuralAssertion(nested, '', { workspaceDir: ws }).status).toBe('pass');

    const escape = structural({ type: 'artifact-exists', path: '../../etc/passwd' });
    expect(evaluateStructuralAssertion(escape, '', { workspaceDir: ws }).status).toBe('error');
  });
});

// ── validation ─────────────────────────────────────────────────────────────────

describe('validateAssertion / validateSuite', () => {
  it('flags missing parameters per type', () => {
    expect(validateAssertion(structural({ type: 'contains' }))).toHaveLength(1);
    expect(validateAssertion(structural({ type: 'regex' }))).toHaveLength(1);
    expect(validateAssertion(structural({ type: 'regex', pattern: '([' }))[0]).toContain('does not compile');
    expect(validateAssertion(structural({ type: 'json-keys', keys: [] }))).toHaveLength(1);
    expect(validateAssertion(structural({ type: 'artifact-exists' }))).toHaveLength(1);
    expect(validateAssertion(structural({ type: 'max-lines' }))).toHaveLength(1);
    expect(validateAssertion(structural({ type: 'min-words', min: 0 }))).toHaveLength(1);
    expect(validateAssertion({ id: 'x', tier: 'semantic', type: 'rubric' } as EvalAssertion)).toHaveLength(1);
    expect(validateAssertion({ id: 'x', tier: 'semantic', type: 'contains', rubric: 'r' } as EvalAssertion)).toHaveLength(1);
    expect(validateAssertion({ id: 'x', tier: 'semantic', type: 'rubric', rubric: 'r', minScore: 150 } as EvalAssertion)).toHaveLength(1);
  });

  it('accepts well-formed assertions', () => {
    expect(validateAssertion(structural({ type: 'contains', value: 'x' }))).toHaveLength(0);
    expect(validateAssertion(structural({ type: 'json-parses' }))).toHaveLength(0);
    expect(validateAssertion({ id: 'x', tier: 'semantic', type: 'rubric', rubric: 'good', minScore: 70 })).toHaveLength(0);
  });

  it('validateSuite reports empty suites, duplicate ids, and empty prompts together', () => {
    const problems = validateSuite({
      persona: '',
      tasks: [
        { id: 't1', prompt: '', assertions: [] },
        { id: 't1', prompt: 'ok', assertions: [structural({ type: 'contains' })] },
      ],
    });
    expect(problems.some((p) => p.includes('persona'))).toBe(true);
    expect(problems.some((p) => p.includes('duplicate task id'))).toBe(true);
    expect(problems.some((p) => p.includes('prompt is empty'))).toBe(true);
    expect(problems.some((p) => p.includes('has no assertions'))).toBe(true);
    expect(problems.some((p) => p.includes("'contains' requires"))).toBe(true);
  });
});

// ── judge parsing ──────────────────────────────────────────────────────────────

describe('parseJudgeScore', () => {
  it('extracts and clamps a score object anywhere in the reply', () => {
    expect(parseJudgeScore('{"score": 85}')).toBe(85);
    expect(parseJudgeScore('verdict follows {"score": 120} done')).toBe(100);
    expect(parseJudgeScore('{"score": -3}')).toBe(0);
  });

  it('returns null for unparseable or non-numeric replies', () => {
    expect(parseJudgeScore('I would say about 85 out of 100')).toBeNull();
    expect(parseJudgeScore('{"score": "great"}')).toBeNull();
    expect(parseJudgeScore('')).toBeNull();
  });
});

// ── rollups ────────────────────────────────────────────────────────────────────

describe('rollupTaskStatus / summarize', () => {
  const mk = (status: AssertionResult['status']): AssertionResult => ({ id: 'a', tier: 'structural', type: 'contains', status, detail: '' });

  it('any fail or error fails the task; all-skipped is skipped, not green', () => {
    expect(rollupTaskStatus([mk('pass'), mk('fail')])).toBe('fail');
    expect(rollupTaskStatus([mk('pass'), mk('error')])).toBe('fail');
    expect(rollupTaskStatus([mk('skipped'), mk('skipped')])).toBe('skipped');
    expect(rollupTaskStatus([mk('pass'), mk('skipped')])).toBe('pass');
  });

  it('summarize counts tasks and assertions separately', () => {
    const s = summarize([
      { id: 't1', title: 't1', status: 'pass', outputExcerpt: '', durationMs: 1, assertions: [mk('pass'), mk('skipped')] },
      { id: 't2', title: 't2', status: 'fail', outputExcerpt: '', durationMs: 1, assertions: [mk('fail')] },
    ]);
    expect(s.tasks).toEqual({ total: 2, passed: 1, failed: 1, skipped: 0, errored: 0 });
    expect(s.assertions).toEqual({ total: 3, passed: 1, failed: 1, skipped: 1, errored: 0 });
  });
});

// ── runner lanes ───────────────────────────────────────────────────────────────

describe('PersonaEvalRunner', () => {
  it('skips semantic assertions with notice under a noop-named lane and still runs structural', async () => {
    const personaDir = writeTempPersona();
    const runner = new PersonaEvalRunner({ executionService: new FakeLane('noop', 'the canned stub output'), personaDir });
    const report = await runner.runSuite(suiteWith([
      structural({ id: 's1', type: 'contains', value: 'canned' }),
      { id: 'sem1', tier: 'semantic', type: 'rubric', rubric: 'is it good?', minScore: 70 },
    ]));
    const [s1, sem1] = report.tasks[0].assertions;
    expect(s1.status).toBe('pass');
    expect(sem1.status).toBe('skipped');
    expect(sem1.detail).toContain('no LLM judge');
    expect(report.lane.semanticCapable).toBe(false);
    expect(report.tasks[0].status).toBe('pass');
    expect(report.passed).toBe(true);
  });

  it('grades semantic assertions with a real judge lane and fails below threshold', async () => {
    const personaDir = writeTempPersona();
    const runner = new PersonaEvalRunner({
      executionService: new FakeLane('fake-harness', 'grounded answer naming Northrop Grumman'),
      judgeService: new FakeLane('fake-judge', '{"score": 62}'),
      personaDir,
    });
    const report = await runner.runSuite(suiteWith([
      { id: 'sem1', tier: 'semantic', type: 'rubric', rubric: 'names the company', minScore: 70 },
      { id: 'sem2', tier: 'semantic', type: 'rubric', rubric: 'names the company', minScore: 60 },
    ]));
    const [sem1, sem2] = report.tasks[0].assertions;
    expect(sem1.status).toBe('fail');
    expect(sem1.score).toBe(62);
    expect(sem2.status).toBe('pass');
    expect(report.passed).toBe(false);
  });

  it('records an unparseable judge reply as an assertion error, never a pass', async () => {
    const personaDir = writeTempPersona();
    const runner = new PersonaEvalRunner({
      executionService: new FakeLane('fake-harness', 'output'),
      judgeService: new FakeLane('fake-judge', 'looks great to me!'),
      personaDir,
    });
    const report = await runner.runSuite(suiteWith([
      { id: 'sem1', tier: 'semantic', type: 'rubric', rubric: 'r', minScore: 70 },
    ]));
    expect(report.tasks[0].assertions[0].status).toBe('error');
    expect(report.passed).toBe(false);
  });

  it('surfaces a lane execution failure as a task error with assertions skipped', async () => {
    const personaDir = writeTempPersona();
    const runner = new PersonaEvalRunner({
      executionService: new FakeLane('fake-harness', '', new Error('provider exploded')),
      personaDir,
    });
    const report = await runner.runSuite(suiteWith([structural({ id: 's1', type: 'contains', value: 'x' })]));
    expect(report.tasks[0].status).toBe('error');
    expect(report.tasks[0].assertions[0].status).toBe('skipped');
    expect(report.tasks[0].assertions[0].detail).toContain('provider exploded');
    expect(report.passed).toBe(false);
  });

  it('throws when the persona does not exist — a missing persona is not gradeable', async () => {
    const personaDir = writeTempPersona();
    const runner = new PersonaEvalRunner({ executionService: new FakeLane('noop', 'x'), personaDir });
    await expect(runner.runSuite({ persona: 'ghost-persona', tasks: suiteWith([]).tasks })).rejects.toThrow(/not found/);
  });

  it('appends fixture data to the task prompt and embeds the persona identity in the system prompt', () => {
    const prompt = buildTaskPrompt({ id: 't', prompt: 'Summarize.', fixture: { emails: [{ id: 'm1' }] }, assertions: [] });
    expect(prompt).toContain('FIXTURE DATA');
    expect(prompt).toContain('"m1"');
    const personaDir = writeTempPersona();
    const persona = loadPersonaFromFile('test-persona', personaDir);
    expect(persona).not.toBeNull();
    const sys = buildPersonaSystemPrompt(persona!);
    expect(sys).toContain('test-persona');
    expect(sys).toContain('You are a test persona');
    expect(sys).toContain('Required Operating Procedure');
  });
});

// ── shipped golden suites stay loadable ────────────────────────────────────────

describe('shipped golden suites', () => {
  it('the three shipped suites load and validate', () => {
    for (const persona of ['email-summarizer', 'incident-response-bot']) {
      const suite = loadPersonaEvalSuite(persona);
      expect(suite.persona).toBe(persona);
      expect(suite.tasks.length).toBeGreaterThanOrEqual(4);
      for (const task of suite.tasks) {
        expect(task.assertions.some((a) => a.tier === 'structural')).toBe(true);
        expect(task.assertions.some((a) => a.tier === 'semantic')).toBe(true);
      }
    }
  });

  it('the suites listing includes the shipped suites without load errors', () => {
    const suites = listPersonaEvalSuites();
    const names = suites.filter((s) => !s.error).map((s) => s.persona);
    expect(names).toEqual(expect.arrayContaining(['email-summarizer', 'incident-response-bot']));
  });
});

// ── review-fix regressions (2026-07-15) ───────────────────────────────────────

/** Writes one valid suite YAML declaring the given persona into dir. */
function writeSuiteYaml(dir: string, fileName: string, persona: string): void {
  writeFileSync(
    join(dir, fileName),
    [
      `persona: ${persona}`,
      'tasks:',
      '  - id: t1',
      '    prompt: Summarize.',
      '    assertions:',
      '      - id: a1',
      '        tier: structural',
      '        type: contains',
      '        value: summary',
    ].join('\n'),
    'utf8',
  );
}

describe('suite loader persona-field fallback', () => {
  it('a suite listed by its persona field is loadable even when the filename differs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'persona-eval-suites-'));
    writeSuiteYaml(dir, 'comms.yaml', 'email-summarizer-v2');
    const listed = listPersonaEvalSuites(dir).filter((s) => !s.error);
    expect(listed.map((s) => s.persona)).toContain('email-summarizer-v2');
    const suite = loadPersonaEvalSuite('email-summarizer-v2', dir);
    expect(suite.persona).toBe('email-summarizer-v2');
    expect(suite.tasks).toHaveLength(1);
  });

  it('two suite files declaring the same persona is an authoring error naming both files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'persona-eval-suites-'));
    writeSuiteYaml(dir, 'first.yaml', 'dupe-persona');
    writeSuiteYaml(dir, 'second.yaml', 'dupe-persona');
    expect(() => loadPersonaEvalSuite('dupe-persona', dir)).toThrow(/multiple suite files.*first\.yaml.*second\.yaml/s);
  });

  it('a truly missing persona still throws not-found', () => {
    const dir = mkdtempSync(join(tmpdir(), 'persona-eval-suites-'));
    expect(() => loadPersonaEvalSuite('ghost', dir)).toThrow(/not found/);
  });
});

describe('PersonaEvalResultsStore save collision safety', () => {
  function fakeReport(): PersonaEvalReport {
    const now = new Date().toISOString();
    return {
      persona: 'test-persona',
      lane: { provider: 'noop', semanticCapable: false, laneNotice: 'unit test lane' },
      startedAt: now,
      finishedAt: now,
      tasks: [],
      summary: {
        tasks: { total: 0, passed: 0, failed: 0, skipped: 0, errored: 0 },
        assertions: { total: 0, passed: 0, failed: 0, skipped: 0, errored: 0 },
      },
      passed: false,
    };
  }

  it('same-instant saves of the same persona produce distinct files, none clobbered', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'persona-eval-results-'));
    const store = new PersonaEvalResultsStore(dir);
    const names = await Promise.all([store.save(fakeReport()), store.save(fakeReport()), store.save(fakeReport())]);
    expect(new Set(names).size).toBe(3);
    const rows = await store.list('test-persona');
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => !r.error)).toBe(true);
  });
});
