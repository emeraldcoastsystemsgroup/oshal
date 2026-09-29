#!/usr/bin/env node
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - the shared host runner for the automated live-acceptance sweep: `node scripts/operations/live-acceptance.js <case|all|list> [--record-doc]`. As the operator automation identity (OSHAL_VERIFY_OPERATOR_PAT, read by name from the environment or the box's .env, never printed or put on a command line) it binds each case in scripts/lib/live-acceptance-cases.js to the running box: bearer HTTP against OSHAL_VERIFY_BASE_URL, a named-statement/ticket/workspace helper staged once into the api container and called with its request forwarded by name, the Jarvis bot's call log through `docker logs`, and a 390 x 844 headless Chromium whose same-origin requests carry the token and whose every other request is aborted. It prints PASS/FAIL/DEGRADED/UNAVAILABLE per case with the cleanup receipt, then one summary line, and exits 0 only when every selected case passed. `--record-doc` writes the Jarvis cache measurement into docs/architecture/jarvis-own-task-recall.md of this checkout.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | An `anonymous` port beside `api`: the same JSON request with NO credential (no Authorization header), so a case can prove a route refuses an unauthenticated caller (the dev-workspace query route must answer 401/403). The token never reaches that request.
 */

'use strict';

// Usage (from a core checkout on the box; no deploy needed - it drives the installed build):
//   node scripts/operations/live-acceptance.js list
//   node scripts/operations/live-acceptance.js congress
//   node scripts/operations/live-acceptance.js all
//   node scripts/operations/live-acceptance.js jarvis-cache --record-doc
// Knobs: OSHAL_VERIFY_BASE_URL (default http://127.0.0.1:35457), OSHAL_VERIFY_API_CONTAINER (default
// oshal-local-api), OSHAL_VERIFY_JARVIS_CONTAINER (default oshal-local-jarvis-bot), OSHAL_VERIFY_ENV_FILE.
// Exit: 0 all pass, 1 any fail, 2 not runnable (no token, unknown case), 3 no fail but not all pass.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const proofRunner = require('./live-proof-runner');
const common = require('../lib/live-acceptance-common.js');
const { CASES, selectCases } = require('../lib/live-acceptance-cases.js');
const jarvisCache = require('../lib/live-acceptance-jarvis-cache.js');

const REPO = path.resolve(__dirname, '..', '..');
const DEFAULT_BASE_URL = 'http://127.0.0.1:35457';
const REQUEST_ENV = 'OSHAL_LIVE_ACCEPTANCE_REQUEST';
const HELPER_FILES = Object.freeze(['live-acceptance-container.js', 'live-acceptance-common.js', 'live-acceptance-sql.js']);
const RECALL_NOTE = path.join('docs', 'architecture', 'jarvis-own-task-recall.md');
const CALL_TIMEOUT_MS = 30_000;

/**
 * @description Parse the command line.
 * @param {string[]} argv - process.argv.slice(2).
 * @returns {{selector: string|null, recordDoc: boolean}} The request.
 */
function parseArgs(argv) {
  const positional = argv.filter((arg) => !arg.startsWith('--'));
  return { selector: positional[0] || null, recordDoc: argv.includes('--record-doc') };
}

/**
 * @description Bearer JSON and multipart HTTP ports against the box, as the token's owner, plus an
 * `anonymous` JSON port that sends no credential at all.
 * @param {string} base - The box's base URL.
 * @param {string} token - The operator PAT (kept in this closure; never printed).
 * @param {typeof fetch} [fetchImpl] - Fetch (a seam for the header-handling tests).
 * @returns {{api: Function, anonymous: Function, upload: Function}} The ports.
 */
function httpPorts(base, token, fetchImpl = fetch) {
  const send = async (method, route, init, withToken = true) => {
    const headers = { ...(init.headers || {}), ...(withToken ? { authorization: `Bearer ${token}` } : {}) };
    const response = await fetchImpl(`${base}${route}`, { method, redirect: 'manual', signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      ...init, headers });
    const text = await response.text().catch(() => '');
    let json = {};
    try { json = text ? JSON.parse(text) : {}; } catch { json = {}; }
    return { status: response.status, json: json && typeof json === 'object' ? json : {}, text: text.slice(0, 65_536),
      contentType: String(response.headers.get('content-type') || ''), location: response.headers.get('location') || null };
  };
  const jsonInit = (body, options = {}) => ({
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(options.headers || {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return {
    api: (method, route, body, options) => send(method, route, jsonInit(body, options)),
    anonymous: (method, route, body, options) => send(method, route, jsonInit(body, options), false),
    upload: (route, fields, file) => {
      const form = new FormData();
      for (const [name, value] of Object.entries(fields || {})) form.append(name, String(value));
      form.append('file', new Blob([file.bytes], { type: file.type }), file.name);
      return send('POST', route, { body: form });
    },
  };
}

/**
 * @description The in-container helper: staged once, one docker exec per call, removed at the end.
 * @param {string} container - The api container.
 * @param {(args: string[], env: NodeJS.ProcessEnv) => {status: number|null, stdout: string, stderr: string}} [exec] - docker runner seam.
 * @returns {{call: (request: object) => Promise<object>, dispose: () => void}} The helper.
 */
function containerHelper(container, exec = dockerCall) {
  const dir = `/tmp/oshal-live-acceptance-${crypto.randomBytes(4).toString('hex')}`;
  let staged = false;
  const stage = () => {
    if (staged) return;
    const made = exec(['exec', container, 'mkdir', '-p', dir], process.env);
    if (made.status !== 0) throw new Error(`could not create ${dir} in ${container}: ${made.stderr.trim()}`);
    for (const name of HELPER_FILES) {
      const copied = exec(['cp', path.join(REPO, 'scripts', 'lib', name), `${container}:${dir}/${name}`], process.env);
      if (copied.status !== 0) throw new Error(`docker cp ${name} failed: ${copied.stderr.trim()}`);
    }
    staged = true;
  };
  return {
    call: async (request) => {
      stage();
      const env = { ...process.env, [REQUEST_ENV]: JSON.stringify(request) };
      const run = exec(['exec', '-w', '/app', '-e', REQUEST_ENV, '-e', 'LOG_LEVEL=silent', '-e', 'OSHAL_SCHEMA_BOOTSTRAP=validate-only',
        container, 'node', `${dir}/live-acceptance-container.js`], env);
      const result = proofRunner.parseResult(run.stdout);
      if (!result) throw new Error(`the container helper printed no result (exit ${run.status}): ${run.stderr.trim().slice(0, 300)}`);
      if (!result.ok) throw new Error(result.error || 'the container helper failed');
      return result;
    },
    dispose: () => { if (staged) exec(['exec', container, 'rm', '-rf', dir], process.env); },
  };
}

/**
 * @description One docker CLI call (no shell; the secret-free request rides in the child environment).
 * @param {string[]} args - docker arguments.
 * @param {NodeJS.ProcessEnv} env - Child environment.
 * @returns {{status: number|null, stdout: string, stderr: string}} The outcome.
 */
function dockerCall(args, env) {
  const run = spawnSync('docker', args, { env, encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
  return { status: run.status, stdout: run.stdout || '', stderr: run.stderr || (run.error ? run.error.message : '') };
}

/**
 * @description The named-statement, ticket and workspace ports over the helper, as the owner.
 * @param {ReturnType<typeof containerHelper>} helper - The helper.
 * @param {string} sub - The owner subject.
 * @returns {{sql: Function, tickets: object, workspace: object}} The ports.
 */
function containerPorts(helper, sub) {
  return {
    sql: async (name, params) => ({ rows: (await helper.call({ op: 'sql', sub, name, params })).rows || [] }),
    tickets: {
      get: async (id) => (await helper.call({ op: 'ticket-get', sub, id })).ticket,
      delete: async (id) => { await helper.call({ op: 'ticket-delete', sub, id }); },
    },
    workspace: {
      state: async (id) => (await helper.call({ op: 'workspace-state', sub, id })).state,
      remove: async (id) => (await helper.call({ op: 'workspace-remove', sub, id })).error || null,
    },
  };
}

/**
 * @description Read a container's log lines since a time, with docker's timestamps.
 * @param {string} container - The container (validated name).
 * @param {string} since - ISO time.
 * @returns {Promise<string[]>} The lines (stdout and stderr).
 */
async function readLogs(container, since) {
  if (!/^[\w.-]+$/.test(container)) throw new Error(`invalid container name ${container}`);
  const run = dockerCall(['logs', '--timestamps', '--since', since, container], process.env);
  if (run.status !== 0) throw new Error(`docker logs ${container} failed: ${run.stderr.trim().slice(0, 300)}`);
  return `${run.stdout}\n${run.stderr}`.split(/\r?\n/).filter(Boolean);
}

/**
 * @description A 390 x 844 headless Chromium session: same-origin requests carry the token (added at
 * the network layer, so no page script can read it); every other request is aborted; window.open is
 * recorded and never opens anything.
 * @param {string} origin - The box origin.
 * @param {string} token - The operator PAT.
 * @returns {{session: (fn: Function) => Promise<void>}} The browser port.
 */
function browserPort(origin, token) {
  return {
    session: async (fn) => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { chromium } = require(path.join(REPO, 'node_modules', 'playwright'));
      const browser = await chromium.launch({ headless: true });
      try {
        const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
        await context.route('**/*', (route) => {
          if (new URL(route.request().url()).origin !== origin) return route.abort();
          return route.continue({ headers: { ...route.request().headers(), authorization: `Bearer ${token}` } });
        });
        await context.addInitScript(() => { window.__opened = []; window.open = (...args) => { window.__opened.push(args.map(String)); return null; }; });
        await fn({ origin, newPage: () => context.newPage() });
      } finally {
        await browser.close();
      }
    },
  };
}

/**
 * @description Print one case's verdict, cleanup receipt and evidence.
 * @param {(line: string) => void} write - Output sink.
 * @param {string} key - The case key.
 * @param {object} result - The case result.
 * @returns {void}
 */
function printResult(write, key, result) {
  write(`${String(result.state).toUpperCase()} ${key} (${result.caseId}): ${result.detail}`);
  write(`  cleanup: ${common.receiptLine(result.cleanup || { removed: [], kept: [], outstanding: [], errors: [] })}`);
  write(`  evidence: ${JSON.stringify(result.evidence || {})}`);
}

/**
 * @description The process exit code for a set of results.
 * @param {Array<{state: string}>} results - Every case result.
 * @returns {number} 0 all pass, 1 any fail, 3 otherwise.
 */
function exitCodeFor(results) {
  if (results.some((r) => r.state === 'fail')) return 1;
  return results.length && results.every((r) => r.state === 'pass') ? 0 : 3;
}

/**
 * @description Write the Jarvis cache measurement into this checkout's recall note.
 * @param {object} result - The jarvis-cache result.
 * @param {{api: Function}} ports - To read the running core's commit.
 * @param {(line: string) => void} write - Output sink.
 * @returns {Promise<void>} Resolves once written.
 */
async function recordMeasurement(result, ports, write) {
  const version = await ports.api('GET', '/api/version').catch(() => ({ json: {} }));
  const commit = typeof version.json.commit === 'string' ? version.json.commit.slice(0, 8) : undefined;
  const block = jarvisCache.renderMeasurementBlock(result, { date: `${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`, commit });
  const file = path.join(REPO, RECALL_NOTE);
  fs.writeFileSync(file, jarvisCache.writeMeasurement(fs.readFileSync(file, 'utf8'), block));
  write(`  recorded: ${RECALL_NOTE}`);
}

/**
 * @description Resolve the caller and bind every port the cases may ask for.
 * @param {string} base - The box's base URL.
 * @param {string} token - The operator PAT.
 * @returns {Promise<{ports: object, dispose: () => void}|{error: string}>} The ports, or why not.
 */
async function bindPorts(base, token) {
  const http = httpPorts(base, token);
  const who = await http.api('GET', '/api/cli-tokens/whoami').catch((error) => ({ status: 0, json: {}, error }));
  const ownerSub = typeof who.json.sub === 'string' ? who.json.sub : '';
  if (who.status !== 200 || !ownerSub) return { error: `the operator token did not resolve to a caller at ${base} (HTTP ${who.status})` };
  const helper = containerHelper(process.env.OSHAL_VERIFY_API_CONTAINER || proofRunner.DEFAULT_API_CONTAINER);
  const logs = (container, since) => readLogs(process.env.OSHAL_VERIFY_JARVIS_CONTAINER || container, since);
  return { ports: { ...http, ...containerPorts(helper, ownerSub), ownerSub, origin: base, logs, browser: browserPort(base, token) }, dispose: helper.dispose };
}

/**
 * @description Entry: run the selected cases one at a time and report.
 * @param {string[]} argv - Arguments.
 * @param {(line: string) => void} [write] - Output sink.
 * @returns {Promise<number>} The exit code.
 */
async function main(argv, write = (line) => process.stdout.write(`${line}\n`)) {
  const args = parseArgs(argv);
  if (!args.selector || args.selector === 'list') {
    for (const entry of CASES) write(`${entry.module.KEY.padEnd(18)} ${entry.module.CASE_ID.padEnd(32)} ${entry.module.TITLE}`);
    return args.selector === 'list' ? 0 : 2;
  }
  const selected = selectCases(args.selector);
  if (!selected.length) { write(`unknown case: ${args.selector} (try: list)`); return 2; }
  const token = proofRunner.readOperatorPat(process.env, process.env.OSHAL_VERIFY_ENV_FILE || path.join(REPO, '.env'));
  if (!token) { write(`UNAVAILABLE: ${proofRunner.PAT_ENV} is neither exported nor in the .env; nothing was written.`); return 2; }
  const base = String(process.env.OSHAL_VERIFY_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const bound = await bindPorts(base, token);
  if (bound.error) { write(`UNAVAILABLE: ${bound.error}; nothing was written.`); return 2; }
  const results = [];
  try {
    for (const entry of selected) {
      const result = await entry.module.run(bound.ports).catch((error) => ({ caseId: entry.module.CASE_ID, state: 'fail',
        detail: `The case crashed: ${common.errorText(error)}`, evidence: {}, cleanup: null }));
      results.push(result);
      printResult(write, entry.module.KEY, result);
      if (args.recordDoc && entry.module === jarvisCache) await recordMeasurement(result, bound.ports, write);
    }
  } finally {
    bound.dispose();
  }
  const count = (state) => results.filter((r) => r.state === state).length;
  write(`live-acceptance: ${results.length} case(s) - ${count('pass')} pass, ${count('fail')} fail, ${count('degraded')} degraded, ${count('unavailable')} unavailable`);
  return exitCodeFor(results);
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    process.stdout.write(`live-acceptance crashed: ${common.errorText(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, httpPorts, containerHelper, containerPorts, browserPort, printResult, exitCodeFor, main };
