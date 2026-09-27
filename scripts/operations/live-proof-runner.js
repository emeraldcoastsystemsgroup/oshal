/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - the host half every live acceptance proof shares: read the operator automation PAT from the environment or the box's .env BY NAME (never printed), stage the proof and its case module into the running api container under a private /tmp directory, run it there with the PAT forwarded by name (`docker exec -e NAME`, so the value is never on a command line), relay its single RESULT line, and remove the staged files. The same shape scripts/lib/deploy-verify.sh uses for the deploy probe.
 */

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

/** The operator automation identity the box's .env carries (docs/runbooks/deploy-parity.md). */
const PAT_ENV = 'OSHAL_VERIFY_OPERATOR_PAT';
/** Default api container name in the local compose stack; override with OSHAL_VERIFY_API_CONTAINER. */
const DEFAULT_API_CONTAINER = 'oshal-local-api';
/** Prefix of the one line an in-container proof prints as its verdict. */
const RESULT_PREFIX = 'RESULT ';

/**
 * @description Resolve the operator PAT without printing it: an exported environment value wins,
 * otherwise the first `OSHAL_VERIFY_OPERATOR_PAT=` line of the .env file, tolerating the quoting
 * and CRLF a hand-edited .env carries (the same rules as deploy-verify.sh).
 * @param {NodeJS.ProcessEnv} env - The process environment.
 * @param {string} envFile - Path of the .env file to fall back to.
 * @returns {string} The token, or '' when neither source has one.
 */
function readOperatorPat(env, envFile) {
  const direct = String(env[PAT_ENV] || '').trim();
  if (direct) return direct;
  let text = '';
  try { text = fs.readFileSync(envFile, 'utf8'); } catch { return ''; }
  const line = text.split(/\n/).find((row) => new RegExp(`^\\s*${PAT_ENV}=`).test(row));
  if (!line) return '';
  let value = line.slice(line.indexOf('=') + 1).replace(/\r$/, '').trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
  return value.trim();
}

/**
 * @description Run one docker CLI call. Arguments go straight to the executable (no shell, so no
 * quoting or path rewriting); the child environment carries the forwarded secret.
 * @param {string[]} args - docker arguments.
 * @param {NodeJS.ProcessEnv} env - Child environment.
 * @param {number} timeoutMs - Hard ceiling for this call.
 * @returns {{status: number|null, stdout: string, stderr: string}} The call's outcome.
 */
function docker(args, env, timeoutMs) {
  const run = spawnSync('docker', args, { env, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
  return { status: run.status, stdout: run.stdout || '', stderr: run.stderr || (run.error ? run.error.message : '') };
}

/**
 * @description Stage files into the api container, run the entry script there with `--in-container`,
 * and always remove the staging directory afterwards.
 * @param {object} spec - What to run.
 * @param {string} spec.container - The api container name.
 * @param {Array<{src: string, rel: string}>} spec.files - Host files and their path under the staging dir.
 * @param {string} spec.entry - The entry's path under the staging dir.
 * @param {Record<string, string>} spec.env - Non-secret NAME=value pairs for the proof.
 * @param {string} spec.pat - The operator PAT, forwarded by name only.
 * @param {number} spec.timeoutMs - Ceiling for the proof itself.
 * @param {typeof docker} [exec] - The docker runner (a seam for the argv/secret-handling tests).
 * @returns {{status: number, stdout: string, stderr: string}} The proof's outcome (status 2 on a staging failure).
 */
function stageAndRun(spec, exec = docker) {
  const dir = `/tmp/oshal-acceptance-${crypto.randomBytes(4).toString('hex')}`;
  const childEnv = { ...process.env, [PAT_ENV]: spec.pat };
  try {
    const dirs = [...new Set(spec.files.map((file) => path.posix.dirname(`${dir}/${file.rel}`)))];
    const made = exec(['exec', spec.container, 'mkdir', '-p', ...dirs], childEnv, 30_000);
    if (made.status !== 0) return { status: 2, stdout: '', stderr: `could not create ${dir} in ${spec.container}: ${made.stderr.trim()}` };
    for (const file of spec.files) {
      const copied = exec(['cp', file.src, `${spec.container}:${dir}/${file.rel}`], childEnv, 60_000);
      if (copied.status !== 0) return { status: 2, stdout: '', stderr: `docker cp ${file.rel} failed: ${copied.stderr.trim()}` };
    }
    const envArgs = Object.entries(spec.env).flatMap(([name, value]) => ['-e', `${name}=${value}`]);
    const run = exec(['exec', '-w', '/app', '-e', PAT_ENV, ...envArgs, spec.container, 'node', `${dir}/${spec.entry}`, '--in-container'],
      childEnv, spec.timeoutMs);
    return { status: run.status === null ? 1 : run.status, stdout: run.stdout, stderr: run.stderr };
  } finally {
    exec(['exec', spec.container, 'rm', '-rf', dir], childEnv, 30_000);
  }
}

/**
 * @description Pull the verdict line out of a proof's stdout.
 * @param {string} stdout - Everything the proof printed.
 * @returns {object|null} The parsed RESULT payload, or null when the proof printed none.
 */
function parseResult(stdout) {
  const line = String(stdout).split(/\r?\n/).reverse().find((row) => row.startsWith(RESULT_PREFIX));
  if (!line) return null;
  try { return JSON.parse(line.slice(RESULT_PREFIX.length)); } catch { return null; }
}

/**
 * @description Print one proof's verdict and evidence, plus the proof's other output when it did not
 * pass, and exit with the proof's own status. Nothing printed here can carry the PAT: the proof never
 * echoes it and this side never had it in anything it prints.
 * @param {{status: number, stdout: string, stderr: string}} run - The proof's outcome.
 * @returns {never} Exits the process.
 */
function reportAndExit(run) {
  const result = parseResult(run.stdout);
  if (result) {
    process.stdout.write(`${result.caseId} ${String(result.state).toUpperCase()}: ${result.detail}\n`);
    process.stdout.write(`evidence: ${JSON.stringify(result.evidence || {})}\n`);
  } else {
    process.stdout.write(`no verdict was produced (exit ${run.status})\n`);
  }
  if (!result || result.state !== 'pass') {
    const noise = `${run.stdout}\n${run.stderr}`.split(/\r?\n/).filter((row) => row.trim() && !row.startsWith(RESULT_PREFIX));
    for (const row of noise.slice(-40)) process.stdout.write(`  | ${row.slice(0, 400)}\n`);
  }
  process.exit(run.status);
}

/**
 * @description Print the RESULT line from inside the container and exit with the case's code.
 * @param {{caseId: string, state: string, detail: string, evidence?: object}} result - The verdict.
 * @returns {never} Exits the process.
 */
function emitResult(result) {
  process.stdout.write(`${RESULT_PREFIX}${JSON.stringify(result)}\n`);
  const code = { pass: 0, fail: 1, unavailable: 2, degraded: 3 }[result.state];
  process.exit(code === undefined ? 1 : code);
}

module.exports = { PAT_ENV, DEFAULT_API_CONTAINER, RESULT_PREFIX, readOperatorPat, stageAndRun, parseResult, reportAndExit, emitResult };
