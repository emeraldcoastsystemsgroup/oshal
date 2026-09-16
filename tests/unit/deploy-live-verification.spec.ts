/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guards the post-deploy live verification. On 2026-09-15 a deploy printed DEPLOYED while Jarvis answered nothing and an operator ticket escalated on manifest_worker_dispatch_failed: every existing gate measures containers, none measured the product. Two boundaries are crossed for real here — the actual scripts/lib/deploy-verify.sh executed by the real Git Bash with a stubbed docker binary (ordering, loudness, the skip switch, the exact remedy text), and the actual probe checks run by the real Node against a real loopback HTTP server speaking the api's contracts (verdicts, cleanup, and no secret in the output) — in ONE process, because this host's firewall refuses a cross-process connection to a Node listener. What is NOT crossed, and is stated rather than implied: the real api, the real queue manager and the real Jarvis bot. Only a deploy reaches those, which is why the deploy is where this runs. 
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Guard the cleanup itself, in both directions. The Jarvis check used to close its thread and leave the chat-ticket, the chat_tasks row and its chat_messages behind on every deploy - and leave the row WITHOUT closing anything when the ask was refused, which is the path this gate exists to hit. So: the pass path must delete the thread's ticket and its task, the refused path must still delete the task it caused to be written, and a cleanup step that fails must report at error level naming what was left behind while the already-decided verdict survives untouched. Plus the runbook honesty the deploy's no-rollback policy depends on: what a deploy spends, and the manual rollback for the one failure class exit 4 does not cure.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Cross the argument boundary the cases below are blind to. They shadow docker with a bash FUNCTION, so the command never leaves the shell and its arguments are never marshalled into a native process - which is exactly the boundary that broke the gate on its first real deploy: Git Bash rewrote the staged container path on its way into docker.exe, node resolved the Windows host path it received against the image's /app working directory, and both product checks died MODULE_NOT_FOUND while every case here stayed green. The new cases put a copy of the real node binary on PATH as `docker` - a genuine native executable, which is the property that makes the host runtime convert the argument at all - and assert that the path the runtime was handed resolves, under the image's own WORKDIR, to the file that was staged in the container. One case is the negative control: it drives the pre-fix call shape and requires the harness to SEE the rewrite, so the suite can never pass by being blind again.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Guard the third verdict, and guard it AGAINST ITSELF. With delegation signing configured this gate could not pass at all - the service-secret PAT it mints records no principal issuer by design, so the controller refuses the Jarvis ask AND the queued dispatch, and the 'task' ticket's call-out winner was an inline bot that signed delegation refuses outright. The fix adds an UNVERIFIED state, and the ONLY thing that makes an unverifiable state safe is how narrow it is: a third state wide enough to swallow a product outage reads as green and is worse than no check. So the cases below pin the narrowness from four sides - the byte-identical refusal is a FAIL when an operator token was supplied, a FAIL when no signing material is configured, and a FAIL for any other refusal under signing; only the self-minted-PAT-under-signing case is UNVERIFIED, and it is never printed as PASS and never masks a real failure in the same run. Plus the two halves the live box cannot demonstrate headlessly: a genuine PASS under signing on a session-minted token, and the knob forwarding that makes that remedy runnable at all (the probe reads its environment inside the container, not in the deploy's shell).
 * 5 | maintainer@emeraldcoastsystemsgroup.com | Two findings from this change's own review. The deploy's terminal headline said 'live verification passed' over a run where both product checks proved NOTHING, and THIS FILE pinned that wording - so the case now asserts the tally-driven tail and both of its branches. And the 'swallows nothing else' rows gained the two sibling refusals that contain the substring 'principal issuer': without them, widening the classifier from the pinned constant to that substring passed the whole suite.
 * 6 | maintainer@emeraldcoastsystemsgroup.com | Follow the bot contract to the privilege it actually grants. These cases pinned has_table_privilege on public.oshal_authorization_applications and a remedy naming scripts/migrations/140-bot-role-ownership-reads.sql. That table is withheld from oshal_bot by the governed contract and that migration is gone: the posture guard reads the derived helper oshal_application_execution_claims (migration 142) instead, so the old assertion would have demanded a privilege a correctly provisioned box must NOT have, and pinned a remedy that could not run. The cases now pin has_function_privilege on the helper, the remedy that applies migration 142, and the sentence saying this grant survives the next boot - the property that distinguishes the fix from the workaround it replaced.
 * 7 | maintainer@emeraldcoastsystemsgroup.com | Hand the shell harness to tests/helpers so the exit-code-contract cases can drive the SAME one from their own file. Adding them here would have pushed this file past the 800-code-line decomposition threshold, and a second private copy of the harness is how the two files would quietly start driving a different shell, a different stub or a different environment baseline. What moved is only the plumbing - the Git Bash identity probe, the docker function that shadows the binary, and the spawn - and one behavioural change comes with it: the three switches the gate reads are now pinned empty in the child, so no case here can inherit a verdict from whatever the operator happens to have exported. Two anchors also moved because the contract did: the deploy no longer negates the gate's return, it READS it, because the gate now has two distinct non-zero returns and `if !` would fold them into one. tests/unit/deploy-verify-exit-contract.spec.ts guards what those returns do.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';
import {
  DEPLOY_SCRIPT, DOCKER_STUB, VERIFY_LIB, resolveHostBash, runPostVerify,
} from '../helpers/deploy-verify-shell';

const LIB = VERIFY_LIB;
const DEPLOY = DEPLOY_SCRIPT;
const PROBE = path.resolve('scripts/operations/deploy-live-verification.js');
const libSource = readFileSync(LIB, 'utf8');
const deploySource = readFileSync(DEPLOY, 'utf8');
const SECRET = 'fixture-service-secret-never-printed';
const SUBJECT = 'fixture|operator-subject-never-printed';
const BASH_TIMEOUT_MS = 20_000;
const PROBE_TIMEOUT_MS = 30_000;

const BASH = resolveHostBash();

let scratch: string;
let stub: string;

beforeAll(() => {
  scratch = mkdtempSync(path.join(tmpdir(), 'deploy-verify-'));
  stub = path.join(scratch, 'docker-stub.sh');
  writeFileSync(stub, DOCKER_STUB);
});

afterAll(() => {
  expect(path.dirname(path.resolve(scratch))).toBe(path.resolve(tmpdir()));
  rmSync(scratch, { recursive: true, force: true });
});

/** Run the REAL verification library in a real shell with the docker binary shadowed. */
function verify(env: Record<string, string> = {}) {
  return runPostVerify(BASH, stub, scratch, env);
}

describe('scripts/lib/deploy-verify.sh — the three checks a deploy is not finished without', () => {
  it('passes, in order, when the grant is present and both probes succeed', () => {
    const run = verify();
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain('RC=0');
    const lines = run.stdout.split('\n').filter((line) => line.startsWith('VERIFY '));
    expect(lines.map((line) => line.split(/\s+/)[2])).toEqual(['bot-role-grant', 'jarvis-ask', 'ticket-dispatch']);
    expect(lines.every((line) => line.startsWith('VERIFY PASS'))).toBe(true);
    expect(run.calls[0]).toMatch(/psql .*has_function_privilege/);
    expect(run.calls.some((call) => call.endsWith(' jarvis'))).toBe(true);
    expect(run.calls.some((call) => call.endsWith(' ticket'))).toBe(true);
  });

  it('fails LOUD and non-zero on a missing grant, naming the exact re-apply command', () => {
    const run = verify({ DOCKER_STUB_GRANT: 'f' });
    expect(run.stdout).toContain('RC=1');
    expect(run.stdout).toContain('VERIFY FAIL  bot-role-grant');
    // The remedy has to be runnable as typed, not a pointer to "the migration" - and it has to name
    // a file that exists, which the migration-140 remedy stopped doing when that migration was removed.
    expect(run.stdout).toContain('docker cp scripts/migrations/142-application-execution-claims-helper.sql');
    expect(run.stdout).toMatch(/psql -U \w+ -d \w+ -f \/tmp\/ownership-helper\.sql/);
    // And it has to say what the next api boot does to it. The grants this replaced were stripped on
    // every boot; this one is converged BACK by the same provisioner, so a grant still missing after a
    // boot means the provisioner did not run - the opposite diagnosis, and the operator needs it.
    expect(run.stdout).toContain('scripts/governance/provision-app-role.mjs');
    expect(run.stdout).toContain('SURVIVES the next api boot');
    expect(run.stdout).toContain('authorization_bot_posture_unavailable');
  });

  it('asserts the privilege the ADR-149 posture guard actually needs: EXECUTE on the derived helper', () => {
    const run = verify();
    expect(run.calls[0]).toContain(
      "has_function_privilege('oshal_bot', 'public.oshal_application_execution_claims(text,text,text,boolean)', 'EXECUTE')");
    // The tables behind the helper are withheld from oshal_bot by the governed contract. A check that
    // demanded SELECT on one of them would fail on every correctly provisioned box, forever.
    expect(run.calls[0]).not.toContain('has_table_privilege');
    expect(run.calls[0]).not.toContain('oshal_authorization_applications');
  });

  it.each([
    ['jarvis-ask', { DOCKER_STUB_JARVIS_RC: '1', DOCKER_STUB_JARVIS_OUT: "Jarvis returned status 'error'" }],
    ['ticket-dispatch', { DOCKER_STUB_TICKET_RC: '1', DOCKER_STUB_TICKET_OUT: "landed in 'escalated'" }],
  ])('makes a failing %s check fatal rather than advisory', (check, env) => {
    const run = verify(env as Record<string, string>);
    expect(run.stdout).toContain('RC=1');
    expect(run.stdout).toContain(`VERIFY FAIL  ${check}`);
    expect(run.stdout).toContain('post-deploy live verification: 1 check(s) FAILED');
  });

  it('never reports success when the probe could not be staged', () => {
    const run = verify({ DOCKER_STUB_CP_RC: '1' });
    expect(run.stdout).toContain('RC=1');
    expect(run.stdout).toContain('VERIFY FAIL  probe-staging');
    expect(run.stdout).not.toContain('VERIFY PASS  jarvis-ask');
  });

  it('honours exactly one documented skip switch, and runs nothing at all when it is set', () => {
    const run = verify({ OSHAL_DEPLOY_SKIP_LIVE_VERIFY: '1' });
    expect(run.stdout).toContain('RC=0');
    expect(run.stdout).toContain('SKIPPED by OSHAL_DEPLOY_SKIP_LIVE_VERIFY');
    expect(run.stdout).toContain('UNVERIFIED as a product');
    expect(run.calls, 'a skipped verification must not touch docker').toEqual([]);
    // One reader of the switch, and no second skip-shaped variable anywhere in the library.
    expect(libSource.match(/\$\{OSHAL_DEPLOY_SKIP_LIVE_VERIFY:-0\}/g) ?? []).toHaveLength(1);
    const skipVars = new Set(libSource.match(/\bOSHAL_[A-Z_]*SKIP[A-Z_]*\b/g) ?? []);
    expect([...skipVars]).toEqual(['OSHAL_DEPLOY_SKIP_LIVE_VERIFY']);
  });

  /* ── The third state, at the shell ────────────────────────────────────────────────────────────
   * Exit 3 from the probe means "not verifiable from automation" - see the probe cases below for
   * exactly how narrow that is. Here the question is only whether this library keeps it visibly
   * distinct from both of the other two: a run that prints PASS for it is a lie, and a run that
   * fails the deploy on it makes the gate permanently red on every signing-enabled box. */
  it('prints UNVERIFIED - not PASS, not FAIL - when a product check exits 3, and does not fail the deploy', () => {
    const run = verify({ DOCKER_STUB_JARVIS_RC: '3', DOCKER_STUB_JARVIS_OUT: 'NOT VERIFIABLE FROM AUTOMATION: ...' });
    expect(run.stdout).toContain('RC=0');
    expect(run.stdout).toContain('VERIFY UNVERIFIED  jarvis-ask');
    expect(run.stdout, 'an unverified check must never be reported as a pass').not.toContain('VERIFY PASS  jarvis-ask');
    expect(run.stdout).not.toContain('VERIFY FAIL  jarvis-ask');
    // And the summary must not read as green either.
    expect(run.stdout).toContain('1 check(s) NOT VERIFIABLE from automation - this deploy is UNPROVEN as a product');
    expect(run.stdout, 'a run with an unverified check has not verified all of them').not.toContain('all checks passed');
  });

  it('names the remedy that makes an UNVERIFIED check verifiable, and why it is refused', () => {
    const run = verify({ DOCKER_STUB_TICKET_RC: '3', DOCKER_STUB_TICKET_OUT: 'NOT VERIFIABLE FROM AUTOMATION: ...' });
    expect(run.stdout).toContain('VERIFY UNVERIFIED  ticket-dispatch');
    expect(run.stdout).toContain('OSHAL_VERIFY_OPERATOR_PAT');
    expect(run.stdout).toContain('src/app/routes/cli-token-routes.ts');
    expect(run.stdout, 'the operator has to be told where to get an issuer-carrying token').toContain('SIGNED-IN browser session');
  });

  it('never lets an UNVERIFIED check mask a real failure in the same run', () => {
    const run = verify({
      DOCKER_STUB_JARVIS_RC: '3', DOCKER_STUB_JARVIS_OUT: 'NOT VERIFIABLE FROM AUTOMATION: ...',
      DOCKER_STUB_TICKET_RC: '1', DOCKER_STUB_TICKET_OUT: "landed in 'escalated'",
    });
    expect(run.stdout, 'a failure beside an unverified check is still a failure').toContain('RC=1');
    expect(run.stdout).toContain('VERIFY UNVERIFIED  jarvis-ask');
    expect(run.stdout).toContain('VERIFY FAIL  ticket-dispatch');
    expect(run.stdout).toContain('post-deploy live verification: 1 check(s) FAILED');
    expect(run.stdout).toContain('1 check(s) NOT VERIFIABLE');
  });

  it('forwards a caller-exported knob into the container BY NAME, never as a value on the command line', () => {
    // The probe reads its configuration from the environment of the process it runs in - the api
    // container - so without this the documented knobs, and the UNVERIFIED remedy that tells the
    // operator to re-run with one, reached nothing at all. `-e NAME` with no `=value` is what keeps
    // a token off the command line and out of `ps` and the run log.
    const run = verify({ OSHAL_VERIFY_OPERATOR_PAT: 'fixture-operator-pat-never-printed' });
    const probeCalls = run.calls.filter((call) => / (jarvis|ticket)$/.test(call));
    expect(probeCalls.length, run.stdout).toBe(2);
    for (const call of probeCalls) {
      expect(call).toContain('-e OSHAL_VERIFY_OPERATOR_PAT');
      expect(call, 'a forwarded token must never be spelled on the command line').not.toContain('fixture-operator-pat-never-printed');
    }
    // The grant check talks to psql, not to the probe, and has no business carrying the token.
    const grantCall = run.calls.find((call) => call.includes('psql'));
    expect(grantCall).toBeDefined();
    expect(grantCall).not.toContain('OSHAL_VERIFY_OPERATOR_PAT');
  });

  it('is named in the runbook the failure messages point at', () => {
    const runbook = readFileSync(path.resolve('docs/runbooks/deploy-parity.md'), 'utf8');
    expect(runbook).toContain('OSHAL_DEPLOY_SKIP_LIVE_VERIFY');
    expect(runbook).toContain('scripts/lib/deploy-verify.sh');
  });

  it('is honest in the runbook about the cost it spends and the rollback it does NOT do', () => {
    const runbook = readFileSync(path.resolve('docs/runbooks/deploy-parity.md'), 'utf8');
    // Every deploy now buys a real LLM turn and a real dispatch. That has to be a conscious trade.
    expect(runbook, 'a deploy that spends real money must say so').toMatch(/real LLM call|real Jarvis turn/);
    expect(runbook).toContain('one real ticket dispatch');
    // Two sequential checks at the default budget can add ~10 minutes before failing closed.
    expect(runbook).toMatch(/OSHAL_VERIFY_BUDGET_MS[\s\S]{0,400}?5 \+ 5 minutes/);
    // exit 4 leaves the new image running. The runbook must not imply a rollback that never happens,
    // and must hand over the manual one for the failure class no-rollback does not cure.
    expect(runbook).toMatch(/leaves that broken image live and serving/);
    expect(runbook).toContain('docker tag oshal-bot:deploy-rollback oshal-bot:latest');
    expect(runbook).toContain('bash scripts/deploy-parity-check.sh');
    // The cleanup claim has to match what the probe actually does.
    expect(runbook).toContain('DELETE /api/tasks/<sessionId>');
    expect(runbook).toContain('CLEANUP FAILED');
    expect(runbook, 'the old "one chat row per deploy, by design" claim is no longer true')
      .not.toMatch(/one chat row per deploy/);
  });

  it('documents the third state, what it does NOT prove, and the one way to prove it', () => {
    const runbook = readFileSync(path.resolve('docs/runbooks/deploy-parity.md'), 'utf8');
    expect(runbook).toContain('VERIFY UNVERIFIED');
    expect(runbook, 'an operator reading a green-looking run must be told it proved nothing')
      .toContain('UNPROVEN as a product');
    expect(runbook).toContain('OSHAL_VERIFY_OPERATOR_PAT');
    expect(runbook).toContain('User-bound delegation requires a verified principal issuer');
    // The narrowness is the safety property; a runbook that omits it invites widening the state.
    // Prose wraps; the claim is what matters, so match it with the line breaks collapsed.
    const prose = runbook.replace(/\s+/g, ' ');
    expect(prose, 'a runbook that omits the narrowness invites widening the state')
      .toContain('**Any** other refusal is still `VERIFY FAIL` and still exit 4');
    expect(prose, 'including the case that is easiest to get wrong')
      .toContain('this same refusal when an operator token *was* supplied');
    // And the dispatch check's target has to be documented as a dedicated node, with the reason.
    expect(runbook).toContain('dedicated bot node');
    expect(runbook).toContain('Signed HTTP delegation requires a dedicated bot-node endpoint');
    expect(runbook).toContain('OSHAL_VERIFY_TICKET_WORKER');
  });

  it('is syntactically valid bash', () => {
    for (const file of [LIB, DEPLOY]) {
      const parsed = spawnSync(BASH, ['--noprofile', '--norc', '-n', file], { encoding: 'utf8', timeout: 10_000 });
      expect(parsed.stderr || '').toBe('');
      expect(parsed.status, file).toBe(0);
    }
  });
});

/* -- The argument boundary the cases above cannot see --------------------------------------------
 * Every case above shadows `docker` with a bash FUNCTION. The command never leaves the shell, so its
 * arguments are never marshalled into a native process - and that marshalling is the boundary that
 * broke this gate on its first real deploy. Git Bash rewrites a POSIX-absolute argument on its way
 * into docker.exe, so the staged container path arrived inside the api as a Windows host path, node
 * resolved it against the image's /app working directory, and BOTH product checks died
 * MODULE_NOT_FOUND without ever reaching the product. Every case above stayed green through it.
 *
 * These cases cross it for real. `docker` on PATH here is a COPY OF THE REAL NODE BINARY: a genuine
 * native, non-MSYS executable, which is the property that makes the host runtime convert the
 * argument at all - a shell function or a .sh stub is not converted, which is precisely why the
 * harness above could not see the defect. The copy records the argv it was actually handed, and the
 * assertion is the one the failure was about: resolve that path the way node inside the container
 * resolves it, and require it to be the file that was staged there. */

/** The image's own working directory - what a path node cannot resolve gets resolved against. */
const CONTAINER_CWD = (/^WORKDIR\s+(\S+)\s*$/m.exec(readFileSync(path.resolve('Dockerfile.oshal'), 'utf8')) ?? [])[1];
const STAGED_PROBE = '/tmp/oshal-deploy-live-verification.js';
/** Each case spawns a real shell and a real native binary, on a box that runs at load 6-39. */
const NATIVE_CASE_TIMEOUT_MS = 60_000;
/** Record argv, then stop before the native binary tries to run `exec` as a script. */
const ARGV_RECORDER = `const fs = require('node:fs');
const path = require('node:path');
fs.writeFileSync(process.env.OSHAL_RECORDED_ARGV, JSON.stringify({
  subcommand: path.basename(process.argv[1] || ''),
  args: process.argv.slice(2),
}));
process.exit(0);
`;

/** A path this host's Git Bash accepts inside PATH and after `source`. */
function toShellPath(target: string): string {
  return process.platform === 'win32'
    ? `/${target[0].toLowerCase()}${target.slice(2).replace(/\\/g, '/')}`
    : target;
}

let nativeDir: string;
let recorderPath: string;
let recordPath: string;

/** What a native child was actually handed, after the host runtime finished with the argv. */
type Handed = { subcommand: string; args: string[] };

/**
 * @description Run one line of the REAL library in the REAL shell with `docker` resolved to a native
 * executable that records its own argv, and return what that executable was handed.
 * @param line - The shell line to run once the library has been sourced.
 * @returns The subcommand and the arguments the native `docker` actually received.
 */
function handedToDocker(line: string): Handed {
  rmSync(recordPath, { force: true });
  const run = spawnSync(BASH, ['--noprofile', '--norc', '-c',
    `set -uo pipefail\nPATH="$1:$PATH"\nsource "$2"\n${line}\n`,
    'deploy-verify-native', toShellPath(nativeDir), toShellPath(LIB)],
  { cwd: process.cwd(), encoding: 'utf8', timeout: BASH_TIMEOUT_MS,
    env: {
      ...process.env,
      NODE_OPTIONS: `--require "${recorderPath.replace(/\\/g, '/')}"`,
      OSHAL_RECORDED_ARGV: recordPath.replace(/\\/g, '/'),
    } });
  let raw = '';
  try { raw = readFileSync(recordPath, 'utf8'); } catch { raw = ''; }
  expect(raw, `the native docker recorded nothing for: ${line}\n${run.stdout}\n${run.stderr}`).not.toBe('');
  return JSON.parse(raw) as Handed;
}

describe('scripts/lib/deploy-verify.sh - the path the container runtime is actually handed', () => {
  beforeAll(() => {
    nativeDir = path.join(scratch, 'native-bin');
    mkdirSync(nativeDir, { recursive: true });
    // The real node binary, renamed. Native and non-MSYS is the whole point: that property is what
    // decides whether this host's runtime rewrites the argument on the way in.
    const fake = path.join(nativeDir, process.platform === 'win32' ? 'docker.exe' : 'docker');
    copyFileSync(process.execPath, fake);
    if (process.platform !== 'win32') chmodSync(fake, 0o755);
    // Run it once here: the first execution of a freshly written binary pays a one-off on-access
    // scan on a Windows host (measured ~8s), and that belongs in setup, not in a case's budget.
    spawnSync(fake, ['--version'], { encoding: 'utf8', timeout: 120_000 });
    recorderPath = path.join(scratch, 'record-argv.cjs');
    writeFileSync(recorderPath, ARGV_RECORDER);
    recordPath = path.join(scratch, 'recorded-argv.json');
  }, 60_000);

  it('reads the resolution base off the image that runs the probe', () => {
    // Not a magic string: /app is where node resolves from, which is why the failure read
    // "Cannot find module '/app/C:/Users/...'". If the image moves, this guard moves with it.
    expect(CONTAINER_CWD, 'Dockerfile.oshal must declare the WORKDIR this guard resolves against').toBe('/app');
  });

  it('hands the probe runner a path that resolves, inside the container, to the staged probe', () => {
    const handed = handedToDocker('oshal_verify_run_probe jarvis');
    expect(handed.subcommand).toBe('exec');
    // Caller-exported OSHAL_VERIFY_* knobs are forwarded ahead of the container as `-e NAME` pairs
    // (no `=value`, so a token never reaches the command line). Everything before the container has
    // to be exactly that shape - a stray bare argument here would be an injection, not a knob.
    const container = handed.args.indexOf('oshal-local-api');
    expect(container % 2, 'the forwarded flags must be whole -e NAME pairs').toBe(0);
    for (let index = 0; index < container; index += 2) {
      expect(handed.args[index]).toBe('-e');
      expect(handed.args[index + 1]).toMatch(/^OSHAL_VERIFY_[A-Z_]+$/);
    }
    expect(handed.args.slice(container, container + 2)).toEqual(['oshal-local-api', 'node']);
    expect(handed.args[container + 3], 'the check name has to survive the crossing too').toBe('jarvis');
    // THE assertion: node in the container resolves what it was handed against CONTAINER_CWD. A host
    // path resolves to /app/<host path> and dies MODULE_NOT_FOUND; the staged path resolves to itself.
    expect(path.posix.resolve(CONTAINER_CWD, handed.args[container + 2].replace(/\\/g, '/'))).toBe(STAGED_PROBE);
  }, NATIVE_CASE_TIMEOUT_MS);

  it('hands the staging copy a relative source and a destination that stays in the container', () => {
    const handed = handedToDocker('oshal_verify_stage_probe');
    expect(handed.subcommand).toBe('cp');
    // The load-bearing half. A relative source has nothing for the host runtime to eat; the moment
    // anyone spells it absolutely - $(pwd)/scripts/..., or an absolute OSHAL_VERIFY_PROBE_SRC - it
    // is rewritten on the way in exactly like the runner's path was.
    expect(handed.args[0], 'a relative source has nothing for the host runtime to eat')
      .toBe('scripts/operations/deploy-live-verification.js');
    // Measured on this host, not assumed: `name:/path` is NOT rewritten - removing the cp's
    // MSYS_NO_PATHCONV leaves this argument byte-identical. So this pins the destination contract
    // and the cp's own guard stays as belt-and-braces; it is the source above that carries the risk.
    expect(handed.args[1]).toBe(`oshal-local-api:${STAGED_PROBE}`);
  }, NATIVE_CASE_TIMEOUT_MS);

  it('SEES the host runtime rewrite an unguarded container path - the defect itself', () => {
    // The pre-fix call shape, spelled out. If this host does not rewrite it, the two cases above are
    // vacuous - so this one asserts the rewrite rather than letting the suite pass by being blind.
    const handed = handedToDocker(`docker exec oshal-local-api node "${STAGED_PROBE}" jarvis`);
    const resolved = path.posix.resolve(CONTAINER_CWD, handed.args[2].replace(/\\/g, '/'));
    if (process.platform === 'win32') {
      expect(handed.args[2], 'Git Bash must be rewriting this, or the guard proves nothing').not.toBe(STAGED_PROBE);
      // The exact shape of the production failure: /app/<drive>:/<host path>.
      expect(resolved).toMatch(/^\/app\/[A-Za-z]:\//);
    } else {
      // A Linux operator's runtime never rewrote it, and the guarded call is byte-for-byte this one.
      expect(handed.args[2]).toBe(STAGED_PROBE);
      expect(resolved).toBe(STAGED_PROBE);
    }
  }, NATIVE_CASE_TIMEOUT_MS);
});

describe('scripts/oshal-deploy.sh — where the verification sits in the run', () => {
  const at = (needle: string) => {
    const index = deploySource.indexOf(needle);
    expect(index, `missing anchor: ${needle}`).toBeGreaterThan(-1);
    return index;
  };

  it('runs AFTER the health, parity and census gates and BEFORE the DEPLOYED line', () => {
    // The deploy READS the gate's return code rather than negating it: the gate has two distinct
    // non-zero returns now, and `if !` would fold them into one with nothing to say it happened.
    const call = at('oshal_deploy_post_verify; VERIFY_RC=$?');
    expect(call).toBeGreaterThan(at('bash scripts/deploy-parity-check.sh --quiet >>'));
    expect(call).toBeGreaterThan(at('host /health not answering'));
    expect(call).toBeGreaterThan(at('unhealthy after grace window'));
    expect(call).toBeGreaterThan(at('log "census:'));
    expect(call).toBeLessThan(at('log "DEPLOYED '));
  });

  it('refuses at preflight when the verification helper is absent (never silently skipped)', () => {
    expect(deploySource).toContain('source "$VERIFY_HELPER" || fail2');
    expect(at('source "$VERIFY_HELPER"')).toBeLessThan(at('docker info >/dev/null'));
  });

  it('exits 4 — its own code — and does NOT roll back on a verification failure', () => {
    const block = deploySource.slice(at('if [ "$VERIFY_RC" -eq 1 ]; then'), at('if [ "$VERIFY_RC" -eq 3 ]; then'));
    expect(block).toContain('exit 4');
    expect(block, 'rolling back on a product failure replaces an outage with an outage plus a version surprise')
      .not.toMatch(/\brollback\b/);
    expect(block).toMatch(/NOT rolled back/i);
    // Reachable from nowhere else, or the code stops meaning anything.
    expect(deploySource.match(/exit 4/g) ?? []).toHaveLength(1);
    expect(deploySource.slice(0, deploySource.indexOf('set -uo pipefail'))).toMatch(/EXIT:[\s\S]*\b4\b/);
  });

  it('tells the truth in its own last line: "passed" only when nothing was left unverified', () => {
    const deployedLine = deploySource.slice(at('log "DEPLOYED ')).split(String.fromCharCode(10))[0];
    // The headline interpolates a tally-driven tail rather than asserting a pass outright.
    expect(deployedLine).toContain('${VERIFY_TAIL}');
    expect(deployedLine, 'the pass wording must not be hard-coded into the headline').not.toMatch(/live verification passed/);
    // Both branches exist, and the unverified one says what it is.
    const tail = deploySource.slice(at('if [ "${OSHAL_VERIFY_UNVERIFIED:-0}" -eq 0 ]'), at('log "DEPLOYED '));
    expect(tail).toMatch(/VERIFY_TAIL="live verification passed"/);
    expect(tail).toMatch(/UNVERIFIED . UNPROVEN as a product/);
  });

  it('leaves the existing rollback exit contract untouched', () => {
    expect(deploySource).toMatch(/fail2\(\) \{[^}]*exit 2/);
    expect(deploySource).toMatch(/NO_ROLLBACK" -eq 1 \] && \{[^}]*exit 1/);
  });
});


/* ── The probe's own verdicts, against a REAL loopback server speaking the api's contracts ──
 * The fixture server and the checks run in ONE process on purpose: this host's firewall refuses a
 * cross-process connection to a Node listener (curl reproduces it against the same socket that
 * answers a same-process fetch), so a spawned probe could only ever be tested against a doubled
 * fetch. Here the HTTP stack, the real `fetch`, the real headers and the real JSON are crossed.
 * What is NOT crossed, and is stated rather than implied: the real api, the real queue manager and
 * the real Jarvis bot. Only a deploy reaches those — which is why this ships as a deploy gate. */

type Reply = { status: number; body: unknown };
const probe = createRequire(import.meta.url)(PROBE) as {
  runCheck: (name: string) => Promise<{ ok: boolean; code: number; detail: string }>;
};

let server: Server;
let requests: string[] = [];
let replies: Record<string, Reply | Reply[]> = {};

/** Route one fixture request: drain and record it, then answer from the per-case `replies` table. */
function handle(request: IncomingMessage, response: ServerResponse): void {
  request.resume();
  const route = `${request.method} ${(request.url || '').split('?')[0]}`;
  requests.push(route);
  const key = Object.keys(replies).find((candidate) => route.startsWith(candidate));
  const configured = key ? replies[key] : undefined;
  const reply = Array.isArray(configured)
    ? (configured.length > 1 ? configured.shift()! : configured[0]!)
    : configured;
  response.writeHead(reply?.status ?? 200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(reply?.body ?? {}));
}

beforeAll(async () => {
  server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  Object.assign(process.env, {
    PORT: String(port),
    SWARM_SERVICE_SECRET: SECRET,
    OSHAL_OPERATOR_SUBS: SUBJECT,
    OSHAL_VERIFY_SUB: '',
    OSHAL_VERIFY_POLL_MS: '5',
    OSHAL_VERIFY_BUDGET_MS: '400',
    OSHAL_VERIFY_REQUEST_TIMEOUT_MS: '4000',
    // Fixture baseline: no controller signing material, no operator token. Every case written
    // before the third state existed therefore keeps exactly the meaning it had, and a case that
    // wants the signing world has to say so through withEnv() below.
    OSHAL_DELEGATION_SIGNING_KID: '',
    OSHAL_DELEGATION_SIGNING_PRIVATE_KEY: '',
    OSHAL_VERIFY_OPERATOR_PAT: '',
  });
});

afterAll(async () => { await new Promise<void>((resolve) => { server.close(() => resolve()); }); });
afterEach(() => { requests = []; replies = {}; });

const MINT: Reply = { status: 201, body: { id: 'pat-1', token: 'never-printed-token-value' } };
const ASK_ACCEPTED: Reply = { status: 202, body: { jobId: 'job-1' } };
/** The registry lookup the dispatch check resolves its pinned worker through, BY NAME. */
const AGENTS: Reply = { status: 200, body: { agents: [{ name: 'general-bot', agentId: 'agent-general-bot' }] } };
/** Controller signing material, presence only - the probe never reads either value. */
const SIGNING = { OSHAL_DELEGATION_SIGNING_KID: 'fixture-kid', OSHAL_DELEGATION_SIGNING_PRIVATE_KEY: 'fixture-key' };
/** The refusal the controller raises for a user-bound delegation with no verified issuer. */
const NO_ISSUER = 'User-bound delegation requires a verified principal issuer';
/** The refusal signed delegation raises for a worker that runs inline on the api. */
const INLINE_REFUSAL = 'Signed HTTP delegation requires a dedicated bot-node endpoint';
/** Stands in for an operator's session-minted token; asserted never to reach any output. */
const OPERATOR_PAT = 'fixture-operator-pat-never-printed';

/** Run one case with extra environment, restoring exactly what was there before. */
async function withEnv<T>(vars: Record<string, string>, run: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  Object.assign(process.env, vars);
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

describe('scripts/operations/deploy-live-verification.js — verdicts and cleanup', () => {
  it('passes when Jarvis answers, and closes the thread and revokes the token afterwards', async () => {
    replies = {
      'POST /api/cli-tokens': MINT,
      'POST /api/jarvis/ask': ASK_ACCEPTED,
      'GET /api/jarvis/ask/result': [{ status: 200, body: { status: 'pending' } }, { status: 200, body: { status: 'done', answer: 'ready' } }],
    };
    const verdict = await probe.runCheck('jarvis');
    expect(verdict, verdict.detail).toMatchObject({ ok: true, code: 0 });
    expect(verdict.detail).toContain('Jarvis answered');
    expect(requests).toContain('POST /api/jarvis/thread/close');
    expect(requests).toContain('DELETE /api/cli-tokens/pat-1');
  });

  /* ── Cleanup: a deploy must leave the board and the database as it found them ──────────
   * POST /api/jarvis/ask registers the thread as a `chat_tasks` row (ensureSessionTask) and opens a
   * chat-ticket for it, returning that ticket's id. /thread/close only marks the ticket complete, so
   * closing alone leaves a chat row, a board card and the thread's chat_messages behind on EVERY
   * deploy. Nothing is reused between runs, so none of this meets the bookmarked-thread refusal. */
  const ASK_WITH_TICKET: Reply = { status: 202, body: { jobId: 'job-1', chatTicketId: 'chat-ticket-1' } };
  const ANSWERED: Reply = { status: 200, body: { status: 'done', answer: 'ready' } };

  /** Capture stderr for one case: cleanup reports at error level, and stdout stays the verdict. */
  async function withErrorLog(run: () => Promise<{ ok: boolean; code: number; detail: string }>) {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const verdict = await run();
      return { verdict, errors: spy.mock.calls.map((call) => String(call[0])) };
    } finally {
      spy.mockRestore();
    }
  }

  it('deletes the thread it opened — the chat-ticket AND the chat_tasks row, not just a close', async () => {
    replies = { 'POST /api/cli-tokens': MINT, 'POST /api/jarvis/ask': ASK_WITH_TICKET, 'GET /api/jarvis/ask/result': ANSWERED };
    const { verdict, errors } = await withErrorLog(() => probe.runCheck('jarvis'));
    expect(verdict, verdict.detail).toMatchObject({ ok: true, code: 0 });
    expect(requests).toContain('POST /api/jarvis/thread/close');
    expect(requests).toContain('DELETE /api/tickets/chat-ticket-1');
    const taskDelete = requests.find((route) => route.startsWith('DELETE /api/tasks/'));
    expect(taskDelete, 'the chat_tasks row this ask wrote must be deleted, not left for the operator').toBeDefined();
    expect(taskDelete).toMatch(/^DELETE \/api\/tasks\/deploy-verify-/);
    expect(errors, 'a clean run must report no leak').toEqual([]);
  });

  it('still deletes the row a REFUSED ask wrote — the path this gate exists to hit', async () => {
    // ensureSessionTask writes the row BEFORE the ownership gate, so a refused thread sits at
    // status 'created'. Returning early without cleanup leaked one row per FAILED verification.
    replies = { 'POST /api/cli-tokens': MINT, 'POST /api/jarvis/ask': { status: 404, body: { error: 'session_not_found' } } };
    const verdict = await probe.runCheck('jarvis');
    expect(verdict.code).toBe(1);
    expect(verdict.detail).toContain('session_not_found');
    expect(requests.some((route) => route.startsWith('DELETE /api/tasks/deploy-verify-'))).toBe(true);
  });

  it('reports a failed thread cleanup at error level, and the verdict survives it untouched', async () => {
    replies = {
      'POST /api/cli-tokens': MINT,
      'POST /api/jarvis/ask': ASK_WITH_TICKET,
      'GET /api/jarvis/ask/result': ANSWERED,
      'DELETE /api/tasks/': { status: 500, body: { error: 'task_delete_failed' } },
    };
    const { verdict, errors } = await withErrorLog(() => probe.runCheck('jarvis'));
    // Cleanup runs after the verdict is decided; it must never be able to rewrite one.
    expect(verdict, verdict.detail).toMatchObject({ ok: true, code: 0 });
    expect(verdict.detail).toContain('Jarvis answered');
    const leak = errors.find((line) => line.startsWith('CLEANUP FAILED:'));
    expect(leak, 'a cleanup that failed silently accumulates a row per deploy with nothing in the log').toBeDefined();
    expect(leak).toContain('HTTP 500');
    expect(leak).toContain('task_delete_failed');
    expect(leak, 'the report has to name what was left behind, not just that something failed').toContain('chat_messages');
  });

  it('reports a failed synthetic-ticket delete at error level, and the verdict survives it untouched', async () => {
    replies = {
      'POST /api/cli-tokens': MINT,
      'GET /api/agents': AGENTS,
      'POST /api/tickets': { status: 201, body: { ticketId: 'ticket-1' } },
      'GET /api/tickets/': [{ status: 200, body: { status: 'approved' } }, { status: 200, body: { status: 'complete' } }],
      'DELETE /api/tickets/': { status: 500, body: { error: 'Failed to delete ticket' } },
    };
    const { verdict, errors } = await withErrorLog(() => probe.runCheck('ticket'));
    expect(verdict, verdict.detail).toMatchObject({ ok: true, code: 0 });
    const leak = errors.find((line) => line.startsWith('CLEANUP FAILED:'));
    expect(leak, 'a leftover synthetic ticket must never accumulate invisibly').toBeDefined();
    expect(leak).toContain('DELETE /api/tickets/ticket-1');
    expect(leak).toContain('ticket-1 is still on the board');
  });

  it.each([
    ['an error verdict', { status: 200, body: { status: 'error', error: 'authorization_bot_posture_unavailable' } }, 'authorization_bot_posture_unavailable'],
    ['a done verdict with no answer text', { status: 200, body: { status: 'done', answer: '' } }, 'no answer text'],
    ['an expired job', { status: 200, body: { status: 'expired' } }, "status 'expired'"],
  ])('fails on %s, and still revokes the token', async (_label, result, expected) => {
    replies = { 'POST /api/cli-tokens': MINT, 'POST /api/jarvis/ask': ASK_ACCEPTED, 'GET /api/jarvis/ask/result': result as Reply };
    const verdict = await probe.runCheck('jarvis');
    expect(verdict.code).toBe(1);
    expect(verdict.detail).toContain(expected as string);
    expect(requests).toContain('DELETE /api/cli-tokens/pat-1');
  });

  it('fails when Jarvis never answers inside the budget', async () => {
    replies = { 'POST /api/cli-tokens': MINT, 'POST /api/jarvis/ask': ASK_ACCEPTED, 'GET /api/jarvis/ask/result': { status: 200, body: { status: 'pending' } } };
    const verdict = await probe.runCheck('jarvis');
    expect(verdict.code).toBe(1);
    expect(verdict.detail).toContain('never answered within');
    expect(requests).toContain('POST /api/jarvis/thread/close');
  });

  it('fails when the ask itself is refused, naming the status', async () => {
    replies = { 'POST /api/cli-tokens': MINT, 'POST /api/jarvis/ask': { status: 404, body: { error: 'session_not_found' } } };
    const verdict = await probe.runCheck('jarvis');
    expect(verdict.code).toBe(1);
    expect(verdict.detail).toContain('404');
    expect(verdict.detail).toContain('session_not_found');
  });

  it('queues the synthetic ticket at the only state the queue manager polls', async () => {
    const bodies: unknown[] = [];
    replies = { 'POST /api/cli-tokens': MINT, 'GET /api/agents': AGENTS, 'POST /api/tickets': { status: 201, body: { ticketId: 'ticket-1' } }, 'GET /api/tickets/': { status: 200, body: { status: 'complete' } } };
    const capture = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => { bodies.push(Buffer.concat(chunks).toString('utf8')); handle(request, response); });
    });
    await new Promise<void>((resolve) => capture.listen(0, '127.0.0.1', resolve));
    const previous = process.env.PORT;
    process.env.PORT = String((capture.address() as { port: number }).port);
    try {
      await probe.runCheck('ticket');
    } finally {
      process.env.PORT = previous;
      await new Promise<void>((resolve) => { capture.close(() => resolve()); });
    }
    const created = JSON.parse(bodies.find((body) => String(body).includes('ticketType')) as string);
    expect(created).toMatchObject({ status: 'approved', ticketType: 'task' });
  });

  it('passes when the queue moves the synthetic ticket, then cancels and deletes it', async () => {
    replies = {
      'POST /api/cli-tokens': MINT,
      'GET /api/agents': AGENTS,
      'POST /api/tickets': { status: 201, body: { ticketId: 'ticket-1' } },
      'GET /api/tickets/': [{ status: 200, body: { status: 'approved' } }, { status: 200, body: { status: 'complete' } }],
    };
    const verdict = await probe.runCheck('ticket');
    expect(verdict, verdict.detail).toMatchObject({ ok: true, code: 0 });
    expect(verdict.detail).toContain("'approved' -> 'complete'");
    expect(requests).toContain('PUT /api/tickets/ticket-1/cancel');
    expect(requests).toContain('DELETE /api/tickets/ticket-1');
  });

  it('fails when the ticket escalates — the exact 2026-09-15 shape — and still cleans up', async () => {
    replies = {
      'POST /api/cli-tokens': MINT,
      'GET /api/agents': AGENTS,
      'POST /api/tickets': { status: 201, body: { ticketId: 'ticket-1' } },
      'GET /api/tickets/': { status: 200, body: { status: 'escalated' } },
    };
    const verdict = await probe.runCheck('ticket');
    expect(verdict.code).toBe(1);
    expect(verdict.detail).toContain("landed in 'escalated'");
    expect(requests).toContain('DELETE /api/tickets/ticket-1');
  });

  it('fails when the queue never dispatches the ticket at all', async () => {
    replies = {
      'POST /api/cli-tokens': MINT,
      'GET /api/agents': AGENTS,
      'POST /api/tickets': { status: 201, body: { ticketId: 'ticket-1' } },
      'GET /api/tickets/': { status: 200, body: { status: 'approved' } },
    };
    const verdict = await probe.runCheck('ticket');
    expect(verdict.code).toBe(1);
    expect(verdict.detail).toContain('the queue never dispatched it');
    expect(requests).toContain('DELETE /api/tickets/ticket-1');
  });

  it('fails without leaking anything when the token cannot be minted', async () => {
    replies = { 'POST /api/cli-tokens': { status: 401, body: { error: 'service_secret_rejected' } } };
    const verdict = await probe.runCheck('ticket');
    expect(verdict.code).toBe(1);
    expect(verdict.detail).toContain('could not mint an operator token');
    expect(requests).toEqual(['POST /api/cli-tokens']);
  });

  it('pins the refusal string against the probe\u2019s own constant, so the two cannot drift apart', () => {
    // If the controller ever rewords that error, this guard and the classification it drives would
    // silently start describing a refusal that no longer occurs - and every signing box would go
    // back to a permanently red gate with no case failing to say so.
    expect(probe.UNVERIFIABLE_REFUSAL).toBe(NO_ISSUER);
    const clientSource = readFileSync(
      path.resolve('src/features/agent-management/services/bot-node-client.ts'), 'utf8');
    expect(clientSource, 'the refusal this gate classifies must still be the one the controller raises')
      .toContain(`throw new Error('${NO_ISSUER}')`);
    const dispatchSource = readFileSync(
      path.resolve('src/features/swarm-orchestration/services/dispatch-manifest-worker.ts'), 'utf8');
    expect(dispatchSource, 'and the inline refusal the FAIL path names must still exist too')
      .toContain(`throw new Error('${INLINE_REFUSAL}')`);
  });

  it('never puts the service secret, the minted token or the operator subject in its output', async () => {
    replies = {
      'POST /api/cli-tokens': MINT,
      'POST /api/jarvis/ask': ASK_ACCEPTED,
      'GET /api/jarvis/ask/result': { status: 200, body: { status: 'done', answer: 'ready' } },
    };
    const verdict = await probe.runCheck('jarvis');
    for (const secret of [SECRET, SUBJECT, 'never-printed-token-value']) {
      expect(verdict.detail, `the probe leaked ${secret.slice(0, 8)}…`).not.toContain(secret);
    }
  });

  /* -- The dispatch check's target: a DEDICATED bot node, chosen deterministically --------------
   * Unpinned, a 'task' ticket routes by the ADR-083 call-out, and the bid winner is whichever
   * knowledge owner happens to be online - an INLINE bot on this box on 2026-09-15 and 2026-09-16,
   * which signed delegation refuses outright. The pin is what makes the check's target the
   * workflow's own declared owner (general-bot, requiresOwnNode -> a real node endpoint), and the
   * agent id comes from the deployment's registry by NAME so nothing here goes stale silently. */
  it('pins the synthetic ticket to the worker it resolved BY NAME from the deployment registry', async () => {
    const bodies: unknown[] = [];
    replies = {
      'POST /api/cli-tokens': MINT,
      'GET /api/agents': AGENTS,
      'POST /api/tickets': { status: 201, body: { ticketId: 'ticket-1' } },
      'GET /api/tickets/': { status: 200, body: { status: 'complete' } },
    };
    const capture = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => { bodies.push(Buffer.concat(chunks).toString('utf8')); handle(request, response); });
    });
    await new Promise<void>((resolve) => capture.listen(0, '127.0.0.1', resolve));
    const previous = process.env.PORT;
    process.env.PORT = String((capture.address() as { port: number }).port);
    let verdict: { ok: boolean; code: number; detail: string };
    try {
      verdict = await probe.runCheck('ticket');
    } finally {
      process.env.PORT = previous;
      await new Promise<void>((resolve) => { capture.close(() => resolve()); });
    }
    expect(verdict, verdict.detail).toMatchObject({ ok: true, code: 0 });
    expect(requests, 'the worker is resolved from the registry, not written into the probe').toContain('GET /api/agents');
    const created = JSON.parse(bodies.find((body) => String(body).includes('ticketType')) as string);
    expect(created.metadata).toEqual({ targetAgentId: 'agent-general-bot' });
    // The verdict line has to name the worker, or a gate that silently re-targets looks identical.
    expect(verdict.detail).toContain('task -> general-bot');
  });

  it('fails loudly when the deployment has no agent under the pinned name, rather than filing an unpinned ticket', async () => {
    replies = {
      'POST /api/cli-tokens': MINT,
      'GET /api/agents': { status: 200, body: { agents: [{ name: 'someone-else', agentId: 'other' }] } },
    };
    const verdict = await probe.runCheck('ticket');
    expect(verdict.code).toBe(1);
    expect(verdict.detail).toContain("no active agent named 'general-bot'");
    expect(requests, 'no ticket may be filed when the target could not be resolved')
      .not.toContain('POST /api/tickets/');
  });

  it('quotes the reason the queue recorded when a ticket parks, instead of only the status', async () => {
    replies = {
      'POST /api/cli-tokens': MINT,
      'GET /api/agents': AGENTS,
      'POST /api/tickets': { status: 201, body: { ticketId: 'ticket-1' } },
      'GET /api/tickets/': { status: 200, body: { status: 'escalated',
        metadata: { lastStatusTransition: { reason: 'manifest_worker_dispatch_failed', message: INLINE_REFUSAL } } } },
    };
    const verdict = await probe.runCheck('ticket');
    expect(verdict.code).toBe(1);
    expect(verdict.detail).toContain('manifest_worker_dispatch_failed');
    expect(verdict.detail).toContain(INLINE_REFUSAL);
  });

  /* -- The third state, and the four sides that keep it narrow ----------------------------------
   * Exit 3 says "not verifiable from automation". It exists because with controller signing on, the
   * only identity this check can mint for itself - a service-secret PAT - records no principal
   * issuer BY DESIGN, so the controller refuses the delegation and the gate can never pass. The
   * danger is obvious: a third state that swallows anything else reads as green. These cases hold
   * it to exactly one refusal, under exactly one set of conditions. */
  const jarvisRefused = (error: string): Record<string, Reply | Reply[]> => ({
    'POST /api/cli-tokens': MINT,
    'POST /api/jarvis/ask': ASK_ACCEPTED,
    'GET /api/jarvis/ask/result': { status: 200, body: { status: 'error', error } },
  });

  it('reports the missing-issuer refusal as NOT VERIFIABLE (exit 3) when signing is on and it minted its own PAT', async () => {
    replies = jarvisRefused(NO_ISSUER);
    const verdict = await withEnv(SIGNING, () => probe.runCheck('jarvis'));
    expect(verdict.ok, 'exit 3 is not a pass').toBe(false);
    expect(verdict.code).toBe(3);
    expect(verdict.detail).toContain('NOT VERIFIABLE FROM AUTOMATION');
    expect(verdict.detail, 'it must say what it did NOT prove').toContain('Nothing is proved either way');
    expect(verdict.detail).toContain('OSHAL_VERIFY_OPERATOR_PAT');
  });

  it('reports the SAME refusal for the queued dispatch the same way - one rule, both product checks', async () => {
    replies = {
      'POST /api/cli-tokens': MINT,
      'GET /api/agents': AGENTS,
      'POST /api/tickets': { status: 201, body: { ticketId: 'ticket-1' } },
      'GET /api/tickets/': { status: 200, body: { status: 'escalated',
        metadata: { lastStatusTransition: { reason: 'manifest_worker_dispatch_failed', message: NO_ISSUER } } } },
    };
    const verdict = await withEnv(SIGNING, () => probe.runCheck('ticket'));
    expect(verdict.code).toBe(3);
    expect(verdict.detail).toContain('NOT VERIFIABLE FROM AUTOMATION');
    expect(requests, 'the synthetic ticket is still removed on the unverifiable path').toContain('DELETE /api/tickets/ticket-1');
  });

  it('FAILS on the byte-identical refusal when an operator token was supplied - then the token is the fault', async () => {
    replies = jarvisRefused(NO_ISSUER);
    const verdict = await withEnv({ ...SIGNING, OSHAL_VERIFY_OPERATOR_PAT: OPERATOR_PAT },
      () => probe.runCheck('jarvis'));
    expect(verdict.code, 'an operator who supplied a token asserted a verified identity').toBe(1);
    expect(verdict.detail).toContain('carries no verified principal issuer');
    expect(verdict.detail).not.toContain('NOT VERIFIABLE FROM AUTOMATION');
    // A supplied token is the operator's own credential: used as-is, never minted around, never revoked.
    expect(requests).not.toContain('POST /api/cli-tokens');
    expect(requests.some((route) => route.startsWith('DELETE /api/cli-tokens'))).toBe(false);
    expect(verdict.detail).not.toContain(OPERATOR_PAT);
  });

  it('FAILS on the same refusal when this controller has no signing material - nothing should be demanding an issuer', async () => {
    replies = jarvisRefused(NO_ISSUER);
    const verdict = await probe.runCheck('jarvis');
    expect(verdict.code).toBe(1);
    expect(verdict.detail).toContain('no signing material configured');
    expect(verdict.detail).not.toContain('NOT VERIFIABLE FROM AUTOMATION');
  });

  it.each([
    ['a bot-posture outage', 'authorization_bot_posture_unavailable'],
    ['an inline worker signed delegation refuses', INLINE_REFUSAL],
    // The two SIBLING refusals in bot-node-client.ts that also contain 'principal issuer'. Without
    // these rows, widening the comparison from the pinned constant to that substring passes the whole
    // suite - and a real authorization regression would then report as 'not verifiable'.
    ['a principal issuer that does not match the request identity', 'Delegation principal issuer does not match the trusted request identity'],
    ['an untrusted system delegation issuer', 'System delegation principal issuer is not trusted'],
    ['a subject that does not match the trusted identity', 'Delegation subject does not match the trusted request identity'],
  ])('still FAILS under signing on %s - the third state swallows nothing else', async (_label, error) => {
    replies = jarvisRefused(error);
    const verdict = await withEnv(SIGNING, () => probe.runCheck('jarvis'));
    expect(verdict.code, `${error} is a product failure, not an unverifiable one`).toBe(1);
    expect(verdict.detail).toContain(error);
    expect(verdict.detail).not.toContain('NOT VERIFIABLE FROM AUTOMATION');
  });

  it('PASSES for real under signing when the operator supplies a session-minted token', async () => {
    // The half the live box cannot show headlessly: every PAT on it was minted from the service
    // secret, and only a signed-in session mint records an issuer. Here the api answers the way it
    // does for an issuer-carrying caller, and the check has to come back a plain, unqualified PASS.
    replies = {
      'POST /api/jarvis/ask': { status: 202, body: { jobId: 'job-1', chatTicketId: 'chat-ticket-1' } },
      'GET /api/jarvis/ask/result': { status: 200, body: { status: 'done', answer: 'ready' } },
    };
    const verdict = await withEnv({ ...SIGNING, OSHAL_VERIFY_OPERATOR_PAT: OPERATOR_PAT },
      () => probe.runCheck('jarvis'));
    expect(verdict, verdict.detail).toMatchObject({ ok: true, code: 0 });
    expect(verdict.detail).toContain('Jarvis answered');
    expect(requests, 'a supplied token means no bootstrap mint at all').not.toContain('POST /api/cli-tokens');
    expect(requests, 'and the thread is still cleaned up').toContain('DELETE /api/tickets/chat-ticket-1');
  });

  it('dispatches for real under signing on a supplied token, to the pinned dedicated node', async () => {
    replies = {
      'GET /api/agents': AGENTS,
      'POST /api/tickets': { status: 201, body: { ticketId: 'ticket-1' } },
      'GET /api/tickets/': [{ status: 200, body: { status: 'approved' } }, { status: 200, body: { status: 'in_process_build' } }],
    };
    const verdict = await withEnv({ ...SIGNING, OSHAL_VERIFY_OPERATOR_PAT: OPERATOR_PAT },
      () => probe.runCheck('ticket'));
    expect(verdict, verdict.detail).toMatchObject({ ok: true, code: 0 });
    expect(verdict.detail).toContain("'approved' -> 'in_process_build'");
    expect(requests).toContain('DELETE /api/tickets/ticket-1');
  });

  it('refuses an unknown check name rather than doing something', async () => {
    const verdict = await probe.runCheck('something-else');
    expect(verdict.code).toBe(1);
    expect(verdict.detail).toContain('unknown check');
    expect(requests).toEqual([]);
  });
});

describe('scripts/operations/deploy-live-verification.js — the CLI wrapper', () => {
  /** Run the REAL script as the deploy runs it. NODE_TEST_CONTEXT is stripped so a child can
   *  never inherit a harness variable that rewrites its exit code. This case needs no network:
   *  a box with no operator identity is refused before the first request. */
  it('exits 2 and says so when the box carries no operator identity to ask as', () => {
    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    delete childEnv.NODE_TEST_CONTEXT;
    delete childEnv.OSHAL_OPERATOR_SUBS;
    delete childEnv.OSHAL_VERIFY_SUB;
    const run = spawnSync(process.execPath, [PROBE, 'jarvis'], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, env: childEnv });
    expect(run.status, run.stdout + run.stderr).toBe(2);
    expect(run.stdout).toContain('OSHAL_OPERATOR_SUBS is empty');
    expect(run.stdout.trim().split('\n')).toHaveLength(1);
  });
});
