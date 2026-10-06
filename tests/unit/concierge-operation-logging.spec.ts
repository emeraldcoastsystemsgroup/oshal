/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove concierge operation logs retain outcomes, durations and error identity without exposing context, result or error secrets; guard documentation and observed catches only in the named repair boundaries.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Enforce exact Change Log headers and sequential unique entries in the same bounded repair files, with missing-header and repeated-sequence negative controls.
 */
import { readFileSync } from 'node:fs';
import pino from 'pino';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOG_REDACT_OPTIONS, logOperationError, observeAsyncOperation, observeOperation } from '@/shared/logger';

const TASK_ID = '00c0da5e-651c-43e8-8f96-d6fca92a2bc7';
const AGENT_ID = '16e29083-6fa6-4f45-b535-c547aac6a277';
const EXECUTION_ID = '5a2124cb-333a-46f2-bac1-dc6ae545a144';
const CLIENT_ID = '8364f0b9-cd6b-43cf-867c-4567da2e4ab7';
const WORKSPACE_ID = 'ad23a32f-8401-4ca9-acb2-0974a9dd5b10';
type LogRecord = Record<string, unknown>;

/**
 * @description Capture real Pino serialization synchronously with the shipped redaction policy.
 * @returns A child logger and accessors for its complete output and parsed records.
 */
function recordingLogger() {
  const chunks: string[] = [];
  const destination = {
    /**
     * @description Record every serialized line without launching a transport worker.
     * @param chunk JSON log bytes from Pino.
     * @returns Nothing; the recording remains local to this test.
     */
    write(chunk: string): void { chunks.push(chunk); },
  };
  const log = pino({ level: 'info', redact: LOG_REDACT_OPTIONS, base: null, timestamp: false,
    serializers: { err: pino.stdSerializers.err } }, destination).child({ module: 'concierge-operation-regression' });
  return { log, output: () => chunks.join(''), records: () => chunks.map(chunk => JSON.parse(chunk) as LogRecord) };
}

/**
 * @description Plant messages and provider URL details that field redaction alone cannot conceal.
 * @returns An original error whose safe name/code/frames can survive while its payload cannot.
 */
function secretError(): Error & { code: string; nested: unknown } {
  const error = Object.assign(new TypeError('RAW_MESSAGE_SENTINEL\nMULTILINE_MESSAGE_SENTINEL'), {
    code: 'FIXTURE_REFUSAL', nested: { credentials: { token: 'ERROR_OBJECT_SENTINEL-sentinel' } },
  });
  error.stack = [
    'TypeError: RAW_MESSAGE_SENTINEL', 'MULTILINE_MESSAGE_SENTINEL',
    '    at remote (https://private.invalid/resource?token=URL_QUERY_SENTINEL:8:2)',
    '    at local (file:///fixture/turn.ts?key=FILE_QUERY_SENTINEL#FRAGMENT_SENTINEL:12:3)',
    '    at safe (file:///fixture/clean.ts:14:5)',
  ].join('\n');
  return error;
}

/**
 * @description Detect a helper call in executable syntax rather than matching comments or strings.
 * @param node Source subtree being inspected.
 * @param name Required directly called helper name.
 * @returns Whether the subtree contains that call.
 */
function calls(node: ts.Node, name: string): boolean {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) return true;
  return ts.forEachChild(node, child => calls(child, name) || undefined) ?? false;
}

/**
 * @description Require explanatory own-line tags for each named function and all of its parameters.
 * @param node Actual function declaration, including private binding helpers.
 * @param source Parsed source containing its attached documentation.
 * @returns Missing or incorrectly placed tag diagnostics.
 */
function documentationFailures(node: ts.FunctionDeclaration, source: ts.SourceFile): string[] {
  const name = node.name?.text ?? '<anonymous>';
  const docs = ts.getJSDocCommentsAndTags(node).filter(item => item.kind === ts.SyntaxKind.JSDocComment)
    .map(item => item.getText(source)).join('\n');
  const tags = ['description', 'returns', ...node.parameters.map(param => `param ${param.name.getText(source)}`)];
  return tags.filter(tag => !new RegExp(`^\\s*\\* @${tag}\\b`, 'm').test(docs)).map(tag => `doc:${name}:${tag}`);
}

/**
 * @description Keep enforcement bounded to the repair modules, with inline entry documentation/wrapping only.
 * @param text Source text from a named module or a planted negative control.
 * @param wrappers Public functions that must return the shared observer directly.
 * @param onlyFunctions Optional declaration filter; excludes legacy unrelated helpers and catches.
 * @returns Documentation, silent-catch or missing-wrapper diagnostics.
 */
function sourceFailures(text: string, wrappers: string[] = [], onlyFunctions?: string[]): string[] {
  const source = ts.createSourceFile('concierge-repair.ts', text, ts.ScriptTarget.Latest, true);
  const failures: string[] = [], found = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.body && (!onlyFunctions || onlyFunctions.includes(node.name?.text ?? ''))) {
      failures.push(...documentationFailures(node, source));
      const name = node.name?.text ?? '';
      if (wrappers.includes(name)) {
        found.add(name);
        const observed = node.body.statements.some(statement => ts.isReturnStatement(statement)
          && statement.expression && ts.isCallExpression(statement.expression)
          && ts.isIdentifier(statement.expression.expression) && statement.expression.expression.text === 'observeAsyncOperation');
        if (!observed) failures.push(`wrapper:${name}`);
      }
    }
    if (!onlyFunctions && ts.isCatchClause(node) && !calls(node.block, 'logOperationError')) failures.push('catch:unlogged-error');
    ts.forEachChild(node, visit);
  };
  visit(source);
  for (const name of wrappers) if (!found.has(name)) failures.push(`wrapper:${name}`);
  return failures;
}

/**
 * @description Prevent a repair file from losing its maintained header or duplicating change sequences.
 * @param text Complete source of one explicitly scoped repair module.
 * @returns Exact-header, malformed-entry or nonsequential-entry diagnostics.
 */
function changeLogFailures(text: string): string[] {
  const header = ['/**', ' * CHANGE LOG', ' * -----------------------------------------------------------------------------',
    ' * SEQ                 | AUTHOR                      | DESCRIPTION', ' * -----------------------------------------------------------------------------'].join('\n');
  const source = text.replace(/\r\n/g, '\n');
  if (!source.startsWith(header + '\n')) return ['changelog:header'];
  const end = source.indexOf('\n */', header.length);
  if (end === -1) return ['changelog:header'];
  const rows = source.slice(header.length + 1, end).split('\n');
  const entries = rows.map(row => /^ \* ([1-9]\d*) \| maintainer@emeraldcoastsystemsgroup\.com +\| \S.+$/.exec(row));
  if (!entries.length || entries.some(entry => !entry)) return ['changelog:entry'];
  const sequence = entries.map(entry => Number(entry![1]));
  return sequence.some((value, index) => value !== index + 1) || new Set(sequence).size !== sequence.length
    ? ['changelog:sequence'] : [];
}

afterEach(() => vi.restoreAllMocks());

describe('concierge operation logging through real Pino', () => {
  it.each(['async', 'sync'])('keeps %s success identity, safe bindings and elapsed duration without logging the result', async mode => {
    const record = recordingLogger(), clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const result = { nested: { token: 'RESULT_SECRET_SENTINEL-sentinel' } };
    const context = { taskId: TASK_ID, agentId: AGENT_ID, executionId: EXECUTION_ID, clientId: CLIENT_ID,
      workspaceId: WORKSPACE_ID, phase: 'work', attempt: 2 };
    const execute = () => { clock.mockReturnValue(1027); return result; };
    const returned = mode === 'async'
      ? await observeAsyncOperation(record.log, 'concierge.success', context, async () => execute())
      : observeOperation(record.log, 'concierge.success', context, execute);
    expect(returned).toBe(result);
    expect(record.records()).toEqual([
      expect.objectContaining({ level: 30, operation: 'concierge.success', event: 'entry', ...context, hasWorkspace: true }),
      expect.objectContaining({ level: 30, operation: 'concierge.success', event: 'exit', outcome: 'completed', durationMs: 27 }),
    ]);
    expect(record.output()).not.toContain('SENTINEL');
  });

  it.each([false, 0, null, undefined])('classifies only literal false as denied (%s)', async value => {
    const record = recordingLogger(), clock = vi.spyOn(Date, 'now').mockReturnValue(2000);
    const result = await observeAsyncOperation(record.log, 'concierge.decision', { taskId: TASK_ID }, async () => {
      clock.mockReturnValue(2013); return value;
    });
    expect(result).toBe(value);
    expect(record.records()).toHaveLength(2);
    expect(record.records()[1]).toMatchObject({ event: 'exit', outcome: value === false ? 'denied' : 'completed', durationMs: 13 });
  });
});

describe('concierge operation failure logging through real Pino', () => {
  it.each(['async', 'sync'])('rethrows the exact %s failure with scrubbed ERROR frames and a terminal duration', async mode => {
    const record = recordingLogger(), error = secretError(), clock = vi.spyOn(Date, 'now').mockReturnValue(3000);
    const execute = () => { clock.mockReturnValue(3031); throw error; };
    const run = mode === 'async'
      ? () => observeAsyncOperation(record.log, 'concierge.failure', { taskId: TASK_ID }, async () => execute())
      : () => Promise.resolve().then(() => observeOperation(record.log, 'concierge.failure', { taskId: TASK_ID }, execute));
    await expect(run()).rejects.toBe(error);
    const records = record.records();
    expect(records).toHaveLength(3);
    expect(records[1]).toMatchObject({ level: 50, event: 'error', operation: 'concierge.failure', taskId: TASK_ID, durationMs: 31,
      err: { name: 'TypeError', code: 'FIXTURE_REFUSAL', frames: [
        'at remote (<url>)', 'at local (file:///fixture/turn.ts:12:3)', 'at safe (file:///fixture/clean.ts:14:5)',
      ] } });
    expect(records[2]).toMatchObject({ level: 30, event: 'exit', outcome: 'failed', durationMs: 31 });
    expect(record.output()).not.toContain('SENTINEL');
    expect(record.output()).not.toContain('private.invalid');
  });

  it('logs a caught gate fault once before retaining its false refusal and denied exit', async () => {
    const record = recordingLogger(), error = secretError(), clock = vi.spyOn(Date, 'now').mockReturnValue(4000);
    const result = await observeAsyncOperation(record.log, 'concierge.gate', { taskId: TASK_ID }, async () => {
      try { clock.mockReturnValue(4007); throw error; }
      catch (caught) { logOperationError(record.log, 'concierge.gate', { taskId: TASK_ID }, caught, 4000); return false; }
    });
    expect(result).toBe(false);
    expect(record.records().map(item => [item.level, item.event])).toEqual([[30, 'entry'], [50, 'error'], [30, 'exit']]);
    expect(record.records()[2]).toMatchObject({ outcome: 'denied', durationMs: 7 });
    expect(record.output()).not.toContain('SENTINEL');
  });
});

describe('concierge operation context projection through real Pino', () => {
  it('projects hostile nested context instead of relying on shallow field redaction', async () => {
    const record = recordingLogger();
    const context = { agentId: 'AGENT_SENTINEL', taskId: 'https://private.invalid/TASK_SENTINEL',
      executionId: { nested: { token: 'EXECUTION_SENTINEL-sentinel' } } as unknown as string, clientId: CLIENT_ID,
      workspaceId: '/private/WORKSPACE_SENTINEL', phase: 'work', attempt: 4,
      actor: { issuer: 'ISSUER_SENTINEL', sub: 'OWNER_SENTINEL' },
      payload: { deeper: { credentials: { token: 'NESTED_CONTEXT_SENTINEL-sentinel' } } }, prompt: 'PROMPT_SENTINEL' };
    const result = { content: 'RESULT_SENTINEL' };
    expect(await observeAsyncOperation(record.log, 'concierge.project', context, async () => result)).toBe(result);
    const entry = record.records()[0];
    expect(entry).toMatchObject({ clientId: CLIENT_ID, phase: 'work', attempt: 4, hasWorkspace: true });
    for (const key of ['agentId', 'taskId', 'executionId', 'workspaceId', 'actor', 'payload', 'prompt', 'result']) expect(entry).not.toHaveProperty(key);
    expect(record.output()).not.toContain('SENTINEL');
    expect(record.output()).not.toContain('private.invalid');
  });

  it.each([-1, 5, 1.5])('omits invalid attempt %s and arbitrary phase content', async attempt => {
    const record = recordingLogger();
    await observeAsyncOperation(record.log, 'concierge.bounds', { attempt, phase: 'PHASE_SENTINEL' }, async () => true);
    for (const entry of record.records()) {
      expect(entry).not.toHaveProperty('attempt'); expect(entry).not.toHaveProperty('phase');
    }
    expect(record.output()).not.toContain('SENTINEL');
  });
});

describe('bounded concierge repair documentation and logging source guard', () => {
  it('checks only both gates, the operation helper and the exported protected inline entry', () => {
    const sources = [
      { path: 'src/shared/logger/operation-logging.ts', wrappers: [] },
      { path: 'src/app/routes/protected-empty-task-access.ts', wrappers: ['callerCanReadEmptyProtectedTask'] },
      { path: 'src/app/routes/protected-task-control-access.ts', wrappers: ['callerCanReadTaskControlEvent'] },
      { path: 'src/app/routes/protected-inline-execution.ts', wrappers: ['runProtectedInlineTurn'], onlyFunctions: ['runProtectedInlineTurn'] },
    ];
    for (const item of sources) expect(sourceFailures(readFileSync(item.path, 'utf8'), item.wrappers, item.onlyFunctions), item.path).toEqual([]);
  });

  it.each(['description', 'param ctx', 'returns'])('detects the missing own-line @%s tag without relying on snapshots', tag => {
    const original = readFileSync('src/app/routes/protected-empty-task-access.ts', 'utf8');
    const planted = original.replace(new RegExp(`^ \\* @${tag}[^\\n]*$`, 'm'), ' * Documentation tag removed.');
    expect(planted).not.toBe(original);
    expect(sourceFailures(planted, ['callerCanReadEmptyProtectedTask'])).toContain(`doc:callerCanReadEmptyProtectedTask:${tag}`);
  });

  it('rejects a caught refusal with only a comment claiming it logged the error', () => {
    const original = readFileSync('src/app/routes/protected-task-control-access.ts', 'utf8');
    const planted = original.replace('logOperationError(logger, operation, context, error, startedAt);', '/* logOperationError was removed */ void error;');
    expect(planted).not.toBe(original);
    expect(sourceFailures(planted, ['callerCanReadTaskControlEvent'])).toContain('catch:unlogged-error');
  });

  it('rejects a lost public observer even if its import and comments remain', () => {
    const original = readFileSync('src/app/routes/protected-empty-task-access.ts', 'utf8');
    const planted = original.replace('return observeAsyncOperation(', 'return unobservedOperation(');
    expect(planted).not.toBe(original);
    expect(sourceFailures(planted, ['callerCanReadEmptyProtectedTask'])).toContain('wrapper:callerCanReadEmptyProtectedTask');
  });
});

describe('bounded concierge repair Change Log guard', () => {
  it('requires exact maintained headers and sequential unique entries in the same four repair sources', () => {
    for (const path of ['src/shared/logger/operation-logging.ts', 'src/app/routes/protected-empty-task-access.ts',
      'src/app/routes/protected-task-control-access.ts', 'src/app/routes/protected-inline-execution.ts']) {
      expect(changeLogFailures(readFileSync(path, 'utf8')), path).toEqual([]);
    }
  });

  it('rejects a missing initial header even when later JSDoc remains', () => {
    const original = readFileSync('src/app/routes/protected-empty-task-access.ts', 'utf8');
    const planted = original.replace(/^\/\*\*[\s\S]*?\*\/\n/, '');
    expect(planted).not.toBe(original);
    expect(changeLogFailures(planted)).toContain('changelog:header');
  });

  it('rejects a repeated sequence without relying on a description snapshot', () => {
    const original = readFileSync('src/app/routes/protected-task-control-access.ts', 'utf8');
    const planted = original.replace(/^ \* 2 \| /m, ' * 1 | ');
    expect(planted).not.toBe(original);
    expect(changeLogFailures(planted)).toContain('changelog:sequence');
  });
});
