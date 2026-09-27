#!/usr/bin/env node
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - live acceptance for "Jarvis cannot see the user's other conversations": run the shared recall case (scripts/lib/jarvis-recall-acceptance.js, the same code the Test Lab card runs) against the deployed box as the operator automation identity. On the host it stages itself and the case into the api container and re-runs there with OSHAL_VERIFY_OPERATOR_PAT forwarded by name; in the container it seeds through the image's own compiled task/message stores under the caller's database identity, drives the real loopback routes with the PAT, and prints one RESULT line. Works on an image that predates the Test Lab card.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The answer budget knob is now OSHAL_RECALL_DELIVERY_BUDGET_MS (deliveryBudgetMs): the case waits for the codeword to be written into thread B, not for the route's first word, so a late answer that lands counts.
 */

'use strict';

// Usage (from a core checkout on the box, after a deploy):
//   node scripts/operations/jarvis-recall-live-proof.js
// Knobs: OSHAL_VERIFY_OPERATOR_PAT (else read by name from OSHAL_VERIFY_ENV_FILE or ./.env),
// OSHAL_VERIFY_API_CONTAINER (default oshal-local-api), OSHAL_RECALL_DELIVERY_BUDGET_MS,
// OSHAL_RECALL_SETTLE_BUDGET_MS, OSHAL_RECALL_POLL_MS. Exit 0 pass, 1 fail, 2 not runnable, 3 degraded.
// Spends ONE real model turn on the operator's configured Jarvis brain.

const path = require('node:path');
const runner = require('./live-proof-runner');

const CASE_ID = 'jarvis-cross-thread-recall';
/** Live default for waiting on the bot after the answer: long enough for a slow headless CLI turn. */
const LIVE_SETTLE_BUDGET_MS = 15 * 60_000;
/** The persona whose agent id the seeded thread carries, resolved by name - never a literal id. */
const JARVIS_AGENT_NAME = 'oshal-assistant';

/**
 * @description Host mode: stage the proof, its runner and the shared case into the api container and
 * run it there, then relay the verdict.
 * @returns {never} Exits with the proof's status.
 */
function runOnHost() {
  const repo = path.resolve(__dirname, '..', '..');
  const pat = runner.readOperatorPat(process.env, process.env.OSHAL_VERIFY_ENV_FILE || path.join(repo, '.env'));
  if (!pat) {
    process.stdout.write(`${CASE_ID} UNAVAILABLE: ${runner.PAT_ENV} is neither exported nor in the .env; nothing was written.\n`);
    process.exit(2);
  }
  const passthrough = ['OSHAL_RECALL_DELIVERY_BUDGET_MS', 'OSHAL_RECALL_SETTLE_BUDGET_MS', 'OSHAL_RECALL_POLL_MS'];
  const env = { LOG_LEVEL: 'silent', OSHAL_SCHEMA_BOOTSTRAP: 'validate-only' };
  for (const name of passthrough) if (process.env[name]) env[name] = process.env[name];
  runner.reportAndExit(runner.stageAndRun({
    container: process.env.OSHAL_VERIFY_API_CONTAINER || runner.DEFAULT_API_CONTAINER,
    files: [
      { src: __filename, rel: 'operations/jarvis-recall-live-proof.js' },
      { src: path.join(__dirname, 'live-proof-runner.js'), rel: 'operations/live-proof-runner.js' },
      { src: path.join(repo, 'scripts', 'lib', 'jarvis-recall-acceptance.js'), rel: 'lib/jarvis-recall-acceptance.js' },
    ],
    entry: 'operations/jarvis-recall-live-proof.js',
    env,
    pat,
    timeoutMs: 25 * 60_000,
  }));
}

/**
 * @description One loopback call as the PAT's owner.
 * @param {string} base - Loopback base URL.
 * @param {string} token - The operator PAT.
 * @returns {(method: string, route: string, body?: unknown) => Promise<{status: number, json: object}>} The api port.
 */
function bearerApi(base, token) {
  return async (method, route, body) => {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20_000),
      redirect: 'manual',
    });
    const json = await response.json().catch(() => ({}));
    return { status: response.status, json: json && typeof json === 'object' ? json : {} };
  };
}

/**
 * @description The image's own compiled modules the seed and residue ports run on.
 * @returns {object} Store classes, identity helper, pool factory and workspace root resolver.
 */
function loadDist() {
  const dist = process.env.OSHAL_ACCEPTANCE_DIST_DIR || path.join(process.cwd(), 'dist');
  /* eslint-disable @typescript-eslint/no-require-imports */
  return {
    InMemoryTaskStore: require(path.join(dist, 'entities/task/services/in-memory-task-store.js')).InMemoryTaskStore,
    InMemoryMessageStore: require(path.join(dist, 'entities/message/services/in-memory-message-store.js')).InMemoryMessageStore,
    runWithRequestIdentity: require(path.join(dist, 'shared/services/database/request-identity.js')).runWithRequestIdentity,
    createOptionalPostgresPool: require(path.join(dist, 'shared/services/database/optional-postgres-pool.js')).createOptionalPostgresPool,
    resolveSharedWorkspaceRoot: require(path.join(dist, 'shared/workspace-root.js')).resolveSharedWorkspaceRoot,
  };
  /* eslint-enable @typescript-eslint/no-require-imports */
}

/**
 * @description Resolve the Jarvis persona's agent id by name from the deployment's own registry.
 * @param {Function} api - The api port.
 * @returns {Promise<string|null>} The agent id, or null when the registry does not list it.
 */
async function resolveJarvisAgentId(api) {
  const { status, json } = await api('GET', '/api/agents');
  if (status !== 200) return null;
  const agents = Array.isArray(json) ? json : (Array.isArray(json.agents) ? json.agents : []);
  const match = agents.find((agent) => agent && agent.name === JARVIS_AGENT_NAME);
  return match && typeof match.agentId === 'string' ? match.agentId : null;
}

/**
 * @description Container mode: resolve the PAT's owner, bind the case's ports to the image's stores
 * and loopback routes, run the case once, print the RESULT line.
 * @returns {Promise<never>} Exits with the case's status.
 */
async function runInContainer() {
  const acceptance = require('../lib/jarvis-recall-acceptance.js');
  const unavailable = (detail) => runner.emitResult({ caseId: CASE_ID, state: 'unavailable', detail, evidence: {} });
  const token = String(process.env[runner.PAT_ENV] || '').trim();
  if (!token) return unavailable(`${runner.PAT_ENV} was not forwarded into the container; nothing was written.`);
  const api = bearerApi(`http://127.0.0.1:${process.env.PORT || '5000'}`, token);
  const who = await api('GET', '/api/cli-tokens/whoami');
  const ownerSub = typeof who.json.sub === 'string' ? who.json.sub : '';
  if (who.status !== 200 || !ownerSub) return unavailable(`The operator PAT did not resolve to a caller (HTTP ${who.status}); nothing was written.`);
  const dist = loadDist();
  const pool = dist.createOptionalPostgresPool('jarvis-recall-live-proof');
  if (!pool) return unavailable('This container has no PostgreSQL configuration; nothing was written.');
  const withOwner = (fn) => dist.runWithRequestIdentity({ sub: ownerSub, isOperator: false }, fn);
  const result = await acceptance.runJarvisRecallAcceptance({
    ownerSub, api, withOwner,
    taskStore: new dist.InMemoryTaskStore(),
    messageStore: new dist.InMemoryMessageStore(),
    query: (sql, params) => pool.query(sql, params),
    agentId: await resolveJarvisAgentId(api),
    workspaceRoot: dist.resolveSharedWorkspaceRoot(),
  }, {
    deliveryBudgetMs: process.env.OSHAL_RECALL_DELIVERY_BUDGET_MS,
    // The bot keeps running after Jarvis's decision timeout answers; the first live run's headless
    // CLI turn took 10m45s. Wait for it (bounded) so the ask workspace is removed, not raced.
    settleBudgetMs: process.env.OSHAL_RECALL_SETTLE_BUDGET_MS || LIVE_SETTLE_BUDGET_MS,
    pollMs: process.env.OSHAL_RECALL_POLL_MS,
  });
  return runner.emitResult(result);
}

if (require.main === module) {
  if (process.argv.includes('--in-container')) {
    runInContainer().catch((error) => runner.emitResult({ caseId: CASE_ID, state: 'fail',
      detail: `The proof crashed: ${error instanceof Error ? error.message : String(error)}`, evidence: {} }));
  } else {
    runOnHost();
  }
}

module.exports = { bearerApi, resolveJarvisAgentId, runInContainer };
