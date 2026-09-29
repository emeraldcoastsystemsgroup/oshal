#!/usr/bin/env node
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - the shared host runner for the automated live-acceptance sweep: `node scripts/operations/live-acceptance.js <case|all|list> [--record-doc]`. As the operator automation identity (OSHAL_VERIFY_OPERATOR_PAT, read by name from the environment or the box's .env, never printed or put on a command line) it binds each case in scripts/lib/live-acceptance-cases.js to the running box: bearer HTTP against OSHAL_VERIFY_BASE_URL, a named-statement/ticket/workspace helper staged once into the api container and called with its request forwarded by name, the Jarvis bot's call log through `docker logs`, and a 390 x 844 headless Chromium whose same-origin requests carry the token and whose every other request is aborted. It prints PASS/FAIL/DEGRADED/UNAVAILABLE per case with the cleanup receipt, then one summary line, and exits 0 only when every selected case passed. `--record-doc` writes the Jarvis cache measurement into docs/architecture/jarvis-own-task-recall.md of this checkout.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | An `anonymous` port beside `api`: the same JSON request with NO credential (no Authorization header), so a case can prove a route refuses an unauthenticated caller (the dev-workspace query route must answer 401/403). The token never reaches that request.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Every HTTP reply also carries `byteLength` and `sha256` of its raw body (the text is decoded from the same bytes, as fetch's text() would), so a case can prove a binary route served exact bytes: the vids-publish case compares the anonymous public read with the MP4 it uploaded. And a `files` port over the helper's new `file-state` op: whether a NAMED probe's file (never a path) exists in the api container.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | `--expect-store-bound`: the flag every selected case receives as the `expectStoreBound` option (caseOptions). The token-chase-replay case then also requires a store-bound captured run and storeVersion {bound: true, reproduced: true}; the deploy lane sets it after TOKEN_CHASE_OWNER_STORE_SNAPSHOT=on on one bot. Every other case ignores the option.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | A `raw` HTTP port beside `api` and `upload`: exact bytes under one content type, the way the files browser uploads (`POST /api/files/upload` reads the raw body), so the class-material case can put its PDF into the caller's own oshal storage through the route the surface uses. The browser session takes an optional viewport (`session(fn, { viewport })`): the default stays the 390 x 844 phone, and the cockpit shell, which the class-material dispatch navigates through, is opened at a desktop width.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | A `second` port, bound only when OSHAL_VERIFY_SECOND_PAT is present: that token is read by name from the environment or the box's .env exactly as the operator token is, and the port sends the same JSON and multipart requests as ITS owner, never the operator. The class-material case files a document as that caller to prove a non-teacher's share is a request; no runner bound the port, so that leg could only ever report itself unavailable. The port also carries its owner's subject, so a case can refuse a token that is the operator's own. Without the variable nothing changes: no port, no extra request.
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | For the create-region-edit case: `--allow-paid`, the operator's consent to one paid image edit, parsed into the `allowPaid` option every selected case receives (only that case reads it; without the flag a paid provider is a named gap and nothing is generated). Every reply also carries its raw body as `bytes`, so a case can decode a binary answer (the region-edit case compares PNG pixels); `text` stays the decoded copy. The multipart `upload` port names its file part `file.field` when the case gives one (Create's upload route reads exactly one part, `image`), and `file` otherwise, as before.
 */

'use strict';

// Usage (from a core checkout on the box; no deploy needed - it drives the installed build):
//   node scripts/operations/live-acceptance.js list
//   node scripts/operations/live-acceptance.js congress
//   node scripts/operations/live-acceptance.js all
//   node scripts/operations/live-acceptance.js jarvis-cache --record-doc
//   node scripts/operations/live-acceptance.js token-chase-replay --expect-store-bound
//   node scripts/operations/live-acceptance.js create-region-edit --allow-paid   (consents to one paid image edit)
// Knobs: OSHAL_VERIFY_BASE_URL (default http://127.0.0.1:35457), OSHAL_VERIFY_API_CONTAINER (default
// oshal-local-api), OSHAL_VERIFY_JARVIS_CONTAINER (default oshal-local-jarvis-bot), OSHAL_VERIFY_ENV_FILE.
// Optional: OSHAL_VERIFY_SECOND_PAT, another caller's token (environment or .env, read by name like the
// operator's). When present the cases get a `second` port that acts as that caller.
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
 * @returns {{selector: string|null, recordDoc: boolean, expectStoreBound: boolean, allowPaid: boolean}} The request.
 */
function parseArgs(argv) {
  const positional = argv.filter((arg) => !arg.startsWith('--'));
  return { selector: positional[0] || null, recordDoc: argv.includes('--record-doc'), expectStoreBound: argv.includes('--expect-store-bound'),
    allowPaid: argv.includes('--allow-paid') };
}

/**
 * @description The options every selected case receives from the command line. `allowPaid` is the
 * operator's consent to a real charge, so it is true only when the flag was typed.
 * @param {ReturnType<typeof parseArgs>} args - The parsed request.
 * @returns {{expectStoreBound: boolean, allowPaid: boolean}} The case options (cases ignore what they do not read).
 */
function caseOptions(args) {
  return { expectStoreBound: args.expectStoreBound === true, allowPaid: args.allowPaid === true };
}

/**
 * @description Bearer JSON and multipart HTTP ports against the box, as the token's owner, plus an
 * `anonymous` JSON port that sends no credential at all.
 * @param {string} base - The box's base URL.
 * @param {string} token - The operator PAT (kept in this closure; never printed).
 * @param {typeof fetch} [fetchImpl] - Fetch (a seam for the header-handling tests).
 * @returns {{api: Function, anonymous: Function, upload: Function, raw: Function}} The ports.
 */
function httpPorts(base, token, fetchImpl = fetch) {
  const send = async (method, route, init, withToken = true) => {
    const headers = { ...(init.headers || {}), ...(withToken ? { authorization: `Bearer ${token}` } : {}) };
    const response = await fetchImpl(`${base}${route}`, { method, redirect: 'manual', signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      ...init, headers });
    const raw = Buffer.from(await response.arrayBuffer().catch(() => new ArrayBuffer(0)));
    const text = new TextDecoder().decode(raw);
    let json = {};
    try { json = text ? JSON.parse(text) : {}; } catch { json = {}; }
    return { status: response.status, json: json && typeof json === 'object' ? json : {}, text: text.slice(0, 65_536),
      contentType: String(response.headers.get('content-type') || ''), location: response.headers.get('location') || null,
      bytes: raw, byteLength: raw.length, sha256: crypto.createHash('sha256').update(raw).digest('hex') };
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
      form.append(file.field || 'file', new Blob([file.bytes], { type: file.type }), file.name);
      return send('POST', route, { body: form });
    },
    raw: (method, route, bytes, contentType) => send(method, route, { headers: { 'content-type': String(contentType || 'application/octet-stream') }, body: new Uint8Array(bytes) }),
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
 * @description The named-statement, ticket, workspace and named-file ports over the helper, as the owner.
 * @param {ReturnType<typeof containerHelper>} helper - The helper.
 * @param {string} sub - The owner subject.
 * @returns {{sql: Function, tickets: object, workspace: object, files: object}} The ports.
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
    files: {
      state: async (name, id) => (await helper.call({ op: 'file-state', sub, name, id })).state,
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

/** The default browser session: a 390 x 844 phone. A case may ask for another viewport (desktop shell). */
const PHONE_VIEWPORT = Object.freeze({ width: 390, height: 844 });

/**
 * @description A headless Chromium session, a 390 x 844 phone unless the case asks for a viewport:
 * same-origin requests carry the token (added at the network layer, so no page script can read it);
 * every other request is aborted; window.open is recorded and never opens anything.
 * @param {string} origin - The box origin.
 * @param {string} token - The operator PAT.
 * @returns {{session: (fn: Function, options?: {viewport?: {width: number, height: number}}) => Promise<void>}} The browser port.
 */
function browserPort(origin, token) {
  return {
    session: async (fn, options = {}) => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { chromium } = require(path.join(REPO, 'node_modules', 'playwright'));
      const browser = await chromium.launch({ headless: true });
      try {
        const phone = !options.viewport;
        const viewport = phone ? { ...PHONE_VIEWPORT } : { width: Number(options.viewport.width), height: Number(options.viewport.height) };
        const context = await browser.newContext({ viewport, isMobile: phone, hasTouch: phone });
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
 * @description The `second` port: the same JSON and multipart requests as ANOTHER caller, the owner of
 * OSHAL_VERIFY_SECOND_PAT, so a case can act as someone who is not the operator. It carries that
 * caller's subject only so a case can tell the two callers apart; an unresolved token leaves it
 * empty and the case's first request as that caller reports the refusal.
 * @param {string} base - The box's base URL.
 * @param {string} secondToken - The second caller's token ('' when the runner has none).
 * @param {typeof fetch} [fetchImpl] - Fetch (a seam for the binding test).
 * @returns {Promise<{api: Function, upload: Function, ownerSub: string}|null>} The port, or null without a token.
 */
async function secondCallerPort(base, secondToken, fetchImpl = fetch) {
  if (!secondToken) return null;
  const http = httpPorts(base, secondToken, fetchImpl);
  const who = await http.api('GET', '/api/cli-tokens/whoami').catch((error) => ({ status: 0, json: {}, error }));
  return { api: http.api, upload: http.upload, ownerSub: who.status === 200 && typeof who.json.sub === 'string' ? who.json.sub : '' };
}

/**
 * @description Resolve the caller and bind every port the cases may ask for.
 * @param {string} base - The box's base URL.
 * @param {string} token - The operator PAT.
 * @param {string} [secondToken] - A second caller's token; binds the `second` port when present.
 * @param {typeof fetch} [fetchImpl] - Fetch (a seam for the binding test).
 * @returns {Promise<{ports: object, dispose: () => void}|{error: string}>} The ports, or why not.
 */
async function bindPorts(base, token, secondToken = '', fetchImpl = fetch) {
  const http = httpPorts(base, token, fetchImpl);
  const who = await http.api('GET', '/api/cli-tokens/whoami').catch((error) => ({ status: 0, json: {}, error }));
  const ownerSub = typeof who.json.sub === 'string' ? who.json.sub : '';
  if (who.status !== 200 || !ownerSub) return { error: `the operator token did not resolve to a caller at ${base} (HTTP ${who.status})` };
  const helper = containerHelper(process.env.OSHAL_VERIFY_API_CONTAINER || proofRunner.DEFAULT_API_CONTAINER);
  const logs = (container, since) => readLogs(process.env.OSHAL_VERIFY_JARVIS_CONTAINER || container, since);
  const second = await secondCallerPort(base, secondToken, fetchImpl);
  return { ports: { ...http, ...containerPorts(helper, ownerSub), ownerSub, origin: base, logs, browser: browserPort(base, token), ...(second ? { second } : {}) },
    dispose: helper.dispose };
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
  const envFile = process.env.OSHAL_VERIFY_ENV_FILE || path.join(REPO, '.env');
  const token = proofRunner.readOperatorPat(process.env, envFile);
  if (!token) { write(`UNAVAILABLE: ${proofRunner.PAT_ENV} is neither exported nor in the .env; nothing was written.`); return 2; }
  const base = String(process.env.OSHAL_VERIFY_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const bound = await bindPorts(base, token, proofRunner.readNamedToken(process.env, envFile, common.SECOND_PAT_ENV));
  if (bound.error) { write(`UNAVAILABLE: ${bound.error}; nothing was written.`); return 2; }
  const results = [];
  try {
    for (const entry of selected) {
      const result = await entry.module.run(bound.ports, caseOptions(args)).catch((error) => ({ caseId: entry.module.CASE_ID, state: 'fail',
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

module.exports = { parseArgs, caseOptions, httpPorts, containerHelper, containerPorts, browserPort, secondCallerPort, bindPorts, printResult, exitCodeFor, main };
