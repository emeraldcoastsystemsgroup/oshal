/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Reproduce importer compatibility boundaries in the actual compiler and engine with explicit local service fixtures.
 */
'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { compileWorkflowSpec } = require('../../../src/features/swarm-apps/services/workflow-publish-compiler.ts');
const { ProcessDefinitionExecutionEngine: Engine } = require('../../../src/features/workflow-studio/engine/process-definition-execution-engine.ts');
const { evaluateExpression } = require('../../../src/features/workflow-studio/engine/expression-evaluator.ts');

const results = [];
const n = (id, type, config = {}) => ({ id, type, title: id, config });
const e = (source, target, label) => ({ id: `${source}-${target}`, source, target, ...(label ? { label } : {}) });
const start = () => n('start', 'start');
const bot = (id = 'bot') => n(id, 'execute-agent', { agentId: `fixture-${id}` });
const deliver = () => n('deliver', 'deliver');
const graphSpec = (nodes, edges) => ({ name: 'assessment-only', mode: 'graph', graph: { nodes, edges } });
const compiled = (nodes, edges) => compileWorkflowSpec(graphSpec(nodes, edges), 'person').workflow.processDefinition;

function services(overrides = {}) {
  const unexpected = async () => { throw new Error('Unexpected fixture service call'); };
  return {
    intakeAndScore: unexpected, runPlanning: unexpected, runTesting: unexpected,
    runReview: unexpected, runSpecialistInput: unexpected, escalate: unexpected,
    runExecution: async (_ticket, config) => ({ outcome: { dispatched: true },
      agentId: config.agentId, strategy: 'local-assessment-fixture' }),
    runDelivery: async () => ({ delivered: true }),
    ...overrides,
  };
}

async function probe(id, callback) {
  try { results.push({ id, status: 'pass', observed: await callback() }); }
  catch (error) { results.push({ id, status: 'fail', error: String(error.stack ?? error) }); }
}

async function compilerProbes() {
  await probe('deterministic-only-graph-rejected', async () => {
    assert.throws(() => compiled([start(), deliver()], [e('start', 'deliver')]), /at least one agent/);
    return 'Publisher requires a bot/cluster node even for an otherwise valid graph.';
  });
  await probe('port-metadata-not-emitted', async () => {
    const edge = { ...e('start', 'bot'), sourceOutputIndex: 1, targetInputIndex: 1, channel: 'main' };
    const definition = compiled([start(), bot(), deliver()], [edge, e('bot', 'deliver')]);
    assert.deepEqual(definition.nodeGraph.edges[0], e('start', 'bot'));
    return 'Extra channel/input/output metadata on a synthetic edge is dropped by the existing compiler.';
  });
  await probe('unsupported-expression-is-false', async () => {
    assert.equal(evaluateExpression('={{ $json.admin }}', { admin: true }), false);
    assert.equal(evaluateExpression('admin === true', { admin: true }), true);
    assert.equal(evaluateExpression('admin === true', { admin: 1 }), false);
    return 'Raw n8n expression returns false; strict OSHAL Boolean does not match the public loose-Boolean fixture for numeric 1.';
  });
}

async function supportedBranchProbe() {
  await probe('mapped-native-branches-execute', async () => {
    const definition = compiled([start(), n('intake', 'intake-source'),
      n('gate', 'logic-gate', { expression: "complexity === 'high'" }),
      bot('yes'), bot('no'), deliver()], [e('start', 'intake'), e('intake', 'gate'),
      e('gate', 'yes', 'true'), e('gate', 'no', 'false'), e('yes', 'deliver'), e('no', 'deliver')]);
    const observations = [];
    for (const complexity of ['high', 'low']) {
      const called = [];
      const engine = new Engine(services({
        intakeAndScore: async () => ({ complexity, complexityScore: 50, activePhases: [], workUnitCount: 1 }),
        runExecution: async (_ticket, config) => {
          called.push(config.agentId);
          return { outcome: { dispatched: true }, agentId: config.agentId, strategy: 'local-fixture' };
        },
      }));
      const result = await engine.execute(definition, { title: 'Local branch fixture' });
      assert.equal(result.success, true);
      assert.deepEqual(called, [complexity === 'high' ? 'fixture-yes' : 'fixture-no']);
      observations.push({ complexity, called, outcome: result.outcome });
    }
    return observations;
  });
}

async function retryProbe() {
  await probe('declared-node-retry-and-error-branch-not-applied', async () => {
    const definition = compiled([start(), bot(), bot('handler'), deliver()],
      [e('start', 'bot'), e('bot', 'deliver'), e('handler', 'deliver')]);
    definition.nodeRetryConfig = { bot: { retryOnFail: true, maxTries: 3, waitBetweenTriesMs: 0, backoffMode: 'linear' } };
    definition.errorBranches = [{ sourceNodeId: 'bot', errorTargetNodeId: 'handler', condition: 'any-error' }];
    const calls = [];
    const engine = new Engine(services({ runExecution: async (_ticket, config) => {
      calls.push(config.agentId); throw new Error('fixture failure');
    } }));
    await assert.rejects(() => engine.execute(definition), /fixture failure/);
    assert.deepEqual(calls, ['fixture-bot']);
    return { configuredTries: 3, actualCalls: calls, result: 'exception propagated; error handler not called' };
  });
}

async function missingExecutorProbes() {
  await probe('subprocess-placeholder-still-reaches-deliver', async () => {
    const definition = compiled([start(), bot(), n('child', 'sub-process', { processDefinitionId: 'fixture-child' }), deliver()],
      [e('start', 'bot'), e('bot', 'child'), e('child', 'deliver')]);
    const events = [];
    const result = await new Engine(services()).execute(definition, undefined, undefined, { onStep: (event) => events.push(event) });
    assert.equal(result.success, true);
    assert.deepEqual(events.find((event) => event.nodeId === 'child').output, { subProcess: 'not-implemented' });
    return 'Compiler accepts sub-process, but the default executor returns not-implemented and the graph completes.';
  });
  await probe('unknown-direct-runtime-node-skipped', async () => {
    const nodes = [start(), bot(), n('unknown', 'n8n-nodes-base.httpRequest'), deliver()];
    const edges = [e('start', 'bot'), e('bot', 'unknown'), e('unknown', 'deliver')];
    assert.throws(() => compiled(nodes, edges), /unsupported type/);
    const result = await new Engine(services()).execute({ nodeGraph: { nodes, edges } });
    assert.equal(result.success, true);
    assert.equal(result.trace.find((step) => step.nodeId === 'unknown').outcome, 'skipped');
    return 'Only a direct engine call bypassing publish validation skips the unsupported node; publisher correctly rejects it.';
  });
}

async function dataModelProbes() {
  await probe('step-output-binding-not-applied', async () => {
    const definition = compiled([start(), bot(), deliver()], [e('start', 'bot'), e('bot', 'deliver')]);
    definition.stepOutputBindings = [{ nodeId: 'bot', outputKey: 'rows', schema: 'json', description: '' }];
    const engine = new Engine(services({ runExecution: async () => ({ outcome: { dispatched: true, rows: [{ value: 7 }] },
      agentId: 'fixture-bot', strategy: 'local-fixture' }) }));
    const result = await engine.execute(definition);
    assert.equal(result.variables.rows, undefined);
    return 'The named output binding did not populate variables; outputs still exist under engine nodeOutputs.';
  });
  await probe('ticket-item-array-does-not-drive-per-item-execution', async () => {
    let calls = 0;
    const engine = new Engine(services({ runExecution: async () => {
      calls++; return { outcome: { dispatched: true }, agentId: 'fixture-bot', strategy: 'local-fixture' };
    } }));
    const definition = compiled([start(), bot(), deliver()], [e('start', 'bot'), e('bot', 'deliver')]);
    const result = await engine.execute(definition, { items: [true, false, 'false', '0', 1].map((admin) => ({ json: { admin } })) });
    assert.equal(result.success, true);
    assert.equal(calls, 1);
    return { inputItems: 5, executionCalls: calls, note: 'No automatic n8n item-stream semantics.' };
  });
}

async function traversalProbes() {
  await probe('ordinary-fanout-takes-first-edge', async () => {
    const calls = [];
    const definition = compiled([start(), bot('a'), bot('b'), deliver()],
      [e('start', 'a'), e('start', 'b'), e('a', 'deliver'), e('b', 'deliver')]);
    const engine = new Engine(services({ runExecution: async (_ticket, config) => {
      calls.push(config.agentId); return { outcome: { dispatched: true }, agentId: config.agentId, strategy: 'local-fixture' };
    } }));
    await engine.execute(definition);
    assert.deepEqual(calls, ['fixture-a']);
    return 'Plain fanout follows only the first edge; parallel-split is concurrent, not n8n v1 branch ordering.';
  });
  await probe('cycle-is-regression-not-item-loop', async () => {
    let calls = 0;
    const engine = new Engine(services({ runExecution: async () => {
      calls++; return { outcome: { dispatched: true }, agentId: 'fixture-bot', strategy: 'local-fixture' };
    } }));
    const definition = compiled([start(), bot()], [e('start', 'bot'), e('bot', 'bot')]);
    const result = await engine.execute(definition);
    assert.equal(calls, 4);
    assert.equal(result.outcome, 'escalated');
    return { actualCalls: calls, outcome: result.outcome, reason: result.reason };
  });
}

function sourceHashes() {
  const relativePaths = [
    'src/features/swarm-apps/services/workflow-publish-compiler.ts',
    'src/features/workflow-studio/engine/process-definition-execution-engine.ts',
    'src/features/workflow-studio/engine/expression-evaluator.ts',
    'src/features/workflow-studio/engine/engine-state.ts',
    'src/features/workflow-studio/schemas/process-definition-schema.ts',
    'src/app/routes/swarm-app-routes.ts',
  ];
  const root = path.resolve(__dirname, '../../..');
  return Object.fromEntries(relativePaths.map((name) => [name,
    createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex')]));
}

async function main() {
  await compilerProbes();
  await supportedBranchProbe();
  await retryProbe();
  await missingExecutorProbes();
  await dataModelProbes();
  await traversalProbes();
  console.log(JSON.stringify({ observedAt: new Date().toISOString(),
    head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path.resolve(__dirname, '../../..'), encoding: 'utf8' }).trim(),
    node: process.version, evidenceKind: 'Actual compiler/graph walker; fixture service callbacks; no DB, provider or n8n execution',
    sourceSha256: sourceHashes(), passed: results.filter((r) => r.status === 'pass').length,
    failed: results.filter((r) => r.status === 'fail').length, results }, null, 2));
  if (results.some((r) => r.status === 'fail')) process.exitCode = 1;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
