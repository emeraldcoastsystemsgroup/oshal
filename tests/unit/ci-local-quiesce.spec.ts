/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Guard for the nightly worker quiesce (BACKLOG "The nightly gate runs against a saturated box"; operator decision 2026-09-21). The operator's conditions are each a case, run through the PRODUCTION text of scripts/ci-local.sh - its run-start block, run_gate, on_exit, both trap lines and its end-of-run block - and the shipped scripts/ci helpers, in Git Bash, over a stateful docker stand-in and an Alertmanager stand-in on a real loopback port: only named, running, `oshal.tier=worker`, non-routing-critical containers are stopped; the infrastructure tier, the api and the trading bot never are (also proven against the REAL compose file and the REAL routing-critical list); the stopped workers are restored after a passing gate, after a failing gate, on SIGTERM and on SIGINT; a run killed outright leaves a state file that the next run restores first and reports; a worker that will not start is reported and kept in the state file; and nothing is stopped without the SwarmContainerDown silence unless silencing is explicitly disabled.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadComposeYaml } from '@/shared/config';
import {
  END_BLOCK, QUIESCE_HELPER, ROOT, START_BLOCK, alertmanagerStandIn, dockerCalls, dockerStandIn,
  functionBody, probeArgs, probeEnv, probeHead, runBash, statusOf, toBash, trapLines,
  type FixtureContainer, type SilenceRequest,
} from '../helpers/ci-local-probe';

const SCRATCH = mkdtempSync(join(tmpdir(), 'oshal-ci-quiesce-'));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));
const CASE_TIMEOUT = 180_000;

/** The routing-critical ids, read from the shipped list rather than copied into this guard. */
const CRITICAL = readFileSync(join(ROOT, 'scripts', 'routability-critical-bots.txt'), 'utf8')
  .split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'))
  .map((line) => line.split('|').map((part) => part.trim()));
const TRADING_AGENT = CRITICAL.find((fields) => fields[1] === 'trading-analyst')?.[0] ?? '';

/** Every shape the selection has to tell apart. Only the first two may ever be stopped. */
const fixture = (overrides: Record<string, Partial<FixtureContainer>> = {}): Record<string, FixtureContainer> => {
  const base: Record<string, FixtureContainer> = {
    'fixture-worker-a': { status: 'running', tier: 'worker', env: ['AGENT_ID=f0000000-0000-0000-0000-00000000000a', 'BOT_NAME=fixture-a'] },
    'fixture-worker-b': { status: 'running', tier: 'worker', env: ['BOT_NAME=fixture-b'] },
    'fixture-db': { status: 'running' },
    'fixture-api': { status: 'running', tier: 'core' },
    'fixture-trading': { status: 'running', tier: 'worker', env: [`AGENT_ID=${TRADING_AGENT}`] },
    'fixture-idle': { status: 'exited', tier: 'worker' },
    'fixture-unnamed': { status: 'running', tier: 'worker' },
  };
  for (const [name, change] of Object.entries(overrides)) base[name] = { ...base[name], ...change };
  return base;
};
const NAMED = 'fixture-worker-a, fixture-worker-b fixture-db fixture-api fixture-trading fixture-idle fixture-missing Bad.Name';
const PAUSED = ['fixture-worker-a', 'fixture-worker-b'];
const NEVER_TOUCHED = ['fixture-db', 'fixture-api', 'fixture-trading', 'fixture-idle', 'fixture-unnamed'];

/** @description The settings one case runs with; every OSHAL_CI_* name is stated, never inherited. */
const settings = (alertmanager: string, extra: Record<string, string> = {}): Record<string, string> => ({
  OSHAL_CI_QUIESCE_WORKERS: NAMED,
  OSHAL_CI_QUIESCE_ALERTMANAGER_URL: alertmanager,
  OSHAL_CI_QUIESCE_RESUME_GRACE_SECONDS: '600',
  OSHAL_UP_BATCH_SIZE: '1',
  OSHAL_UP_BATCH_SETTLE: '0',
  OSHAL_CI_MIN_FREE_MB: '',
  ...extra,
});

/**
 * @description One nightly in miniature: the production run-start block, one gate through the
 * production run_gate, then the production end-of-run block and exit - with on_exit and both trap
 * lines installed exactly as ci-local.sh installs them.
 * @param gateBody the fixture gate's body.
 * @returns the probe script.
 */
function nightlyProbe(gateBody: string): string {
  return [
    probeHead(),
    'CI_LOCK_STALE_SECONDS=14400',
    'LOCK="$STATE_DIR/ci-local.lock"; mkdir -p "$LOCK"',
    'SMOKE=oshal-ci-smoke; DS_UP=0; E2E_PG=oshal-ci-pg; E2E_REDIS=oshal-ci-redis; CI_NET=oshal-ci-net',
    "finish_run_log() { printf '[log] finish_run_log\\n'; }",
    'CLEANED=0',
    functionBody('on_exit'),
    trapLines(),
    'FAILED_GATES=(); EXHAUSTED_GATES=()',
    functionBody('run_gate'),
    functionBody('gate_did_not_pass'),
    functionBody('record_skipped'),
    'QUIESCE=1; SCHEDULED=1; PUBLISH_IMAGE=0; SKIP_IMAGE=0; SKIP_E2E=0',
    'SOURCE_REF=HEAD; SOURCE_SHORT_SHA=fixture; SOURCE_POSTURE=probe; RUN_LOG=/dev/null',
    START_BLOCK(),
    `gate_fixture() {\n  ${gateBody}\n}`,
    'run_gate fixture gate_fixture',
    END_BLOCK(),
    'exit "${RUN_EXIT:-0}"',
    '',
  ].join('\n');
}

const GATE_PASS = 'return 0';
const GATE_FAIL = 'echo "fixture gate output: 3 specs failed"; return 1';
const GATE_BLOCK = ': > "$GATE_MARK"; while [ ! -f "$GATE_RELEASE" ]; do sleep 0.2; done';

interface Case { dir: string; stateDir: string; bin: string; state: string }

/** @description A fresh scratch case: its own state directory and docker stand-in. */
function newCase(containers: Record<string, FixtureContainer>): Case {
  const dir = mkdtempSync(join(SCRATCH, 'case-'));
  const stateDir = join(dir, 'state');
  mkdirSync(stateDir, { recursive: true });
  const { bin, state } = dockerStandIn(dir, containers);
  return { dir, stateDir, bin, state };
}

/** @description Run one miniature nightly to completion. */
async function runNightly(c: Case, gateBody: string, env: Record<string, string>): Promise<{ status: number | null; output: string }> {
  const probe = join(c.dir, `nightly-${Date.now()}.sh`);
  writeFileSync(probe, nightlyProbe(gateBody));
  return runBash([toBash(probe), ...probeArgs(c.stateDir, c.bin)], probeEnv(c.dir, env), join(c.dir, `out-${Date.now()}.log`), CASE_TIMEOUT);
}

/**
 * @description Run a miniature nightly whose gate blocks, signal it from a job-controlled parent
 * once the gate is running (a non-job-control background job would ignore SIGINT and prove
 * nothing), and record what the box looked like mid-run.
 * @param c the case.
 * @param signal TERM, INT or KILL.
 * @param env the settings.
 * @returns the orchestrator's output (MIDRUN lines and CHILD_EXIT) and the run's own output.
 */
async function interruptNightly(c: Case, signal: 'TERM' | 'INT' | 'KILL', env: Record<string, string>): Promise<{ orchestrator: string; run: string }> {
  const probe = join(c.dir, 'nightly-blocking.sh');
  writeFileSync(probe, nightlyProbe(GATE_BLOCK));
  const orch = join(c.dir, 'orchestrate.sh');
  const runOut = join(c.dir, 'run.log');
  writeFileSync(orch, [
    '#!/usr/bin/env bash',
    'set -m',
    'sig="$1"; probe="$2"; out="$3"; shift 3',
    'bash "$probe" "$@" > "$out" 2>&1 &',
    'pid=$!',
    'for i in $(seq 1 900); do [ -f "$GATE_MARK" ] && break; sleep 0.1; done',
    '[ -f "$GATE_MARK" ] || { echo "ORCH: the gate never started"; kill -KILL "$pid"; exit 98; }',
    'for c in fixture-worker-a fixture-worker-b fixture-trading fixture-unnamed; do printf "MIDRUN %s=%s\\n" "$c" "$(cat "$DOCKER_STANDIN_STATE/containers/$c/status")"; done',
    '[ -f "$ORCH_STATE_DIR/ci-quiesce.state" ] && echo "MIDRUN state-file=present"',
    'kill -"$sig" "$pid"',
    'wait "$pid"; echo "CHILD_EXIT=$?"',
    '',
  ].join('\n'));
  const marks = { GATE_MARK: toBash(join(c.dir, 'gate-running')), GATE_RELEASE: toBash(join(c.dir, 'never-released')), ORCH_STATE_DIR: toBash(c.stateDir) };
  const result = await runBash([toBash(orch), signal, toBash(probe), toBash(runOut), ...probeArgs(c.stateDir, c.bin)],
    probeEnv(c.dir, { ...env, ...marks }), join(c.dir, 'orchestrator.log'), CASE_TIMEOUT);
  return { orchestrator: result.output, run: existsSync(runOut) ? readFileSync(runOut, 'utf8') : '' };
}

const stateFile = (c: Case): string => join(c.stateDir, 'ci-quiesce.state');
const stops = (c: Case): string[] => dockerCalls(c.state).filter((call) => call.startsWith('stop '));
const starts = (c: Case): string[] => dockerCalls(c.state).filter((call) => call.startsWith('start '));
const silences = (requests: SilenceRequest[]): Array<Record<string, any>> => requests.filter((r) => r.method === 'POST').map((r) => r.body ?? {});

/** @description Both paused workers are running again and nothing else was ever stopped or started. */
function expectRestored(c: Case): void {
  for (const name of PAUSED) expect(statusOf(c.state, name), `${name} was not restored`).toBe('running');
  for (const name of NEVER_TOUCHED) {
    expect(dockerCalls(c.state).some((call) => call === `stop ${name}` || call === `start ${name}`), `${name} was touched`).toBe(false);
  }
  expect(existsSync(stateFile(c)), 'the state file outlived a complete restore').toBe(false);
}

describe('the nightly worker quiesce (scripts/ci-local.sh + scripts/ci/ci-quiesce.sh)', () => {
  it('stops only the named, running, non-critical workers, silences exactly them, and restores them after a passing gate', async () => {
    const am = await alertmanagerStandIn();
    try {
      const c = newCase(fixture());
      const run = await runNightly(c, GATE_PASS, settings(am.url));
      expect(run.status, run.output).toBe(0);
      expect(run.output).toContain('=== LOCAL CI: ALL GATES GREEN ===');
      expect(stops(c)).toEqual(PAUSED.map((name) => `stop ${name}`));
      expect(run.output).toMatch(/quiesce: fixture-db REFUSED \(tier 'none' is not worker/);
      expect(run.output).toMatch(/quiesce: fixture-api REFUSED \(tier 'core' is not worker/);
      expect(run.output).toContain(`quiesce: fixture-trading REFUSED (routing-critical agent ${TRADING_AGENT} in scripts/routability-critical-bots.txt)`);
      expect(run.output).toMatch(/quiesce: fixture-idle REFUSED \(status exited, not running/);
      expect(run.output).toContain('quiesce: fixture-missing REFUSED (no such container)');
      expect(run.output).toContain('quiesce: Bad.Name REFUSED (not a supported container name)');
      // Stopped before the gate ran, restored after it, and the restore is in the run's own log.
      expect(run.output.indexOf('quiesce: stopped fixture-worker-a')).toBeLessThan(run.output.indexOf('GATE fixture: start'));
      expect(run.output.indexOf('quiesce: restored fixture-worker-a')).toBeGreaterThan(run.output.indexOf('GATE fixture: PASS'));
      expectRestored(c);
      const [opened, lapsed] = silences(am.requests);
      expect(opened.matchers).toEqual([
        { name: 'alertname', value: 'SwarmContainerDown', isRegex: false, isEqual: true },
        { name: 'container', value: 'fixture-worker-a|fixture-worker-b', isRegex: true, isEqual: true },
      ]);
      expect(Date.parse(opened.endsAt) - Date.parse(opened.startsAt)).toBeGreaterThanOrEqual(14_390_000);
      // The restore shortens THAT silence to the recovery grace instead of leaving it for four hours.
      expect(lapsed.id).toBe('fixture-silence-1');
      expect(lapsed.matchers).toEqual(opened.matchers);
      const graceLeft = Date.parse(lapsed.endsAt) - Date.now();
      expect(graceLeft).toBeGreaterThan(400_000);
      expect(graceLeft).toBeLessThanOrEqual(600_000);
    } finally { await am.close(); }
  }, CASE_TIMEOUT);

  it('restores the workers after a FAILING gate and reports the failure as FAIL', async () => {
    const am = await alertmanagerStandIn();
    try {
      const c = newCase(fixture());
      const run = await runNightly(c, GATE_FAIL, settings(am.url));
      expect(run.status, run.output).toBe(1);
      expect(run.output).toContain('GATE fixture: FAIL');
      expect(run.output).toContain('=== LOCAL CI: FAILED gates: fixture ===');
      expectRestored(c);
    } finally { await am.close(); }
  }, CASE_TIMEOUT);

  for (const signal of ['TERM', 'INT'] as const) {
    it(`restores the workers when the run is interrupted by SIG${signal} mid-gate`, async () => {
      const am = await alertmanagerStandIn();
      try {
        const c = newCase(fixture());
        const { orchestrator, run } = await interruptNightly(c, signal, settings(am.url));
        // Mid-run the named workers really were down, and nothing else was.
        expect(orchestrator).toContain('MIDRUN fixture-worker-a=exited');
        expect(orchestrator).toContain('MIDRUN fixture-worker-b=exited');
        expect(orchestrator).toContain('MIDRUN fixture-trading=running');
        expect(orchestrator).toContain('MIDRUN fixture-unnamed=running');
        expect(orchestrator).toContain('MIDRUN state-file=present');
        expect(orchestrator, run).toContain('CHILD_EXIT=130');
        expect(run.indexOf('quiesce: restored fixture-worker-b')).toBeLessThan(run.indexOf('finish_run_log'));
        expectRestored(c);
        expect(silences(am.requests).map((body) => body.id ?? 'new')).toEqual(['new', 'fixture-silence-1']);
      } finally { await am.close(); }
    }, CASE_TIMEOUT);
  }

  it('leaves a state file when killed outright, and the NEXT run restores from it first and reports it', async () => {
    const c = newCase(fixture());
    const env = settings('none');
    const killed = await interruptNightly(c, 'KILL', env);
    expect(killed.orchestrator).toContain('CHILD_EXIT=137');
    // No trap runs on SIGKILL: the workers are still down, and only the state file knows.
    expect(statusOf(c.state, 'fixture-worker-a')).toBe('exited');
    expect(readFileSync(stateFile(c), 'utf8')).toMatch(/container=fixture-worker-a\ncontainer=fixture-worker-b\n/);
    rmSync(join(c.stateDir, 'ci-local.lock'), { recursive: true, force: true });

    const next = await runNightly(c, GATE_PASS, env);
    expect(next.output).toMatch(/quiesce: .*ci-quiesce\.state is left from a run started .* that never restored its workers/);
    const leftover = next.output.indexOf('quiesce: restored fixture-worker-a');
    expect(leftover).toBeGreaterThan(-1);
    expect(leftover, 'the leftover restore must come before this run quiesces again').toBeLessThan(next.output.indexOf('quiesce: stopped fixture-worker-a'));
    expect(next.output).toContain('=== LOCAL CI: FAILED gates: quiesce-leftover-restored ===');
    expect(next.status).toBe(1);
    expectRestored(c);
  }, CASE_TIMEOUT * 2);

  it('reports a worker that will not start again, and keeps it - only it - in the state file', async () => {
    const c = newCase(fixture({ 'fixture-worker-b': { failStart: true } }));
    const run = await runNightly(c, GATE_PASS, settings('none'));
    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain('quiesce: FAILED to restore fixture-worker-b');
    expect(run.output).toContain('=== LOCAL CI: FAILED gates: quiesce-resume-failed ===');
    expect(statusOf(c.state, 'fixture-worker-a')).toBe('running');
    expect(readFileSync(stateFile(c), 'utf8')).toContain('container=fixture-worker-b');
    expect(readFileSync(stateFile(c), 'utf8')).not.toContain('container=fixture-worker-a');
  }, CASE_TIMEOUT);

  it('stops nothing when the silence cannot be made: no URL, or Alertmanager refusing it', async () => {
    const unset = newCase(fixture());
    const noUrl = await runNightly(unset, GATE_PASS, settings(''));
    expect(noUrl.output).toContain('quiesce: REFUSED - OSHAL_CI_QUIESCE_ALERTMANAGER_URL is not set');
    expect(stops(unset)).toEqual([]);

    const am = await alertmanagerStandIn('fail');
    try {
      const refused = newCase(fixture());
      const run = await runNightly(refused, GATE_PASS, settings(am.url));
      expect(run.output).toMatch(/quiesce: REFUSED - Alertmanager did not accept the silence \(.+\); nothing stopped/);
      expect(stops(refused)).toEqual([]);
      expect(run.output).toContain('=== LOCAL CI: ALL GATES GREEN ===');
    } finally { await am.close(); }
  }, CASE_TIMEOUT);

  it('stops and restores without a silence only when silencing is explicitly disabled, and does nothing unconfigured', async () => {
    const disabled = newCase(fixture());
    const run = await runNightly(disabled, GATE_PASS, settings('none'));
    expect(run.output).toContain('quiesce: alert silence disabled (OSHAL_CI_QUIESCE_ALERTMANAGER_URL=none)');
    expect(stops(disabled)).toEqual(PAUSED.map((name) => `stop ${name}`));
    expectRestored(disabled);

    const unconfigured = newCase(fixture());
    const idle = await runNightly(unconfigured, GATE_PASS, settings('none', { OSHAL_CI_QUIESCE_WORKERS: '' }));
    expect(idle.output).toContain('quiesce: not configured (OSHAL_CI_QUIESCE_WORKERS is empty)');
    expect(dockerCalls(unconfigured.state).filter((call) => /^(inspect|stop|start) /.test(call))).toEqual([]);
  }, CASE_TIMEOUT);
});

describe('the quiesce against the REAL compose file and routing-critical list', () => {
  it('refuses the infrastructure tier, the api and every routing-critical bot - the trading bot among them - and plans read-only', async () => {
    const compose = loadComposeYaml(readFileSync(join(ROOT, 'docker-compose.oshal-local.yml'), 'utf8')) as {
      services: Record<string, { container_name?: string; labels?: Record<string, string>; environment?: Record<string, string> }>;
    };
    const containers: Record<string, FixtureContainer> = {};
    for (const service of Object.values(compose.services)) {
      if (!service.container_name) continue;
      const agent = service.environment?.AGENT_ID;
      containers[service.container_name] = { status: 'running', tier: service.labels?.['oshal.tier'], env: agent ? [`AGENT_ID=${agent}`] : [] };
    }
    const names = Object.keys(containers);
    const c = newCase(containers);
    const env = probeEnv(c.dir, { OSHAL_CI_STATE_DIR: toBash(c.stateDir), PATH: `${c.bin};${process.env.PATH ?? ''}` });
    const plan = await runBash([QUIESCE_HELPER, '--plan', ...names], env, join(c.dir, 'plan.log'), CASE_TIMEOUT);
    expect(plan.status, plan.output).toBe(0);
    // The stand-in answered every name (so nothing reached a real engine), and the plan changed nothing.
    expect(dockerCalls(c.state).filter((call) => call.startsWith('inspect '))).toHaveLength(names.length);
    expect(dockerCalls(c.state).filter((call) => !call.startsWith('inspect '))).toEqual([]);

    const verdict = (name: string): string => new RegExp(`quiesce-plan: ${name} (WOULD STOP|REFUSED)`).exec(plan.output)?.[1] ?? 'missing';
    // The operator's named protections, by name, so a relabel or a list edit cannot quietly lift them.
    for (const infra of ['db', 'redis', 'chromadb', 'tsdb', 'vault', 'arangodb']) {
      expect(verdict(`oshal-local-${infra}`), `oshal-local-${infra}`).toBe('REFUSED');
    }
    expect(verdict('oshal-local-api')).toBe('REFUSED');
    expect(plan.output).toContain(`quiesce-plan: oshal-local-trading-bot REFUSED (routing-critical agent ${TRADING_AGENT}`);
    // And the rule in general: exactly the non-critical workers are eligible.
    const criticalIds = new Set(CRITICAL.map((fields) => fields[0]));
    for (const [name, c2] of Object.entries(containers)) {
      const agent = (c2.env ?? [])[0]?.replace('AGENT_ID=', '');
      const eligible = c2.tier === 'worker' && !(agent && criticalIds.has(agent));
      expect(verdict(name), name).toBe(eligible ? 'WOULD STOP' : 'REFUSED');
    }
    expect(TRADING_AGENT, 'trading-analyst left the routing-critical list').toMatch(/^[0-9a-f-]{36}$/);
  }, CASE_TIMEOUT);

  it('silences the alert the rule file actually defines for a stopped worker', () => {
    const rules = readFileSync(join(ROOT, 'ops', 'monitoring', 'alert-rules.yml'), 'utf8');
    const helper = readFileSync(join(ROOT, 'scripts', 'ci', 'ci-quiesce.sh'), 'utf8');
    const silenced = /CI_QUIESCE_ALERTNAME='([^']+)'/.exec(helper)?.[1];
    expect(silenced).toBe('SwarmContainerDown');
    const rule = rules.slice(rules.indexOf(`- alert: ${silenced}`), rules.indexOf('- alert:', rules.indexOf(`- alert: ${silenced}`) + 1));
    expect(rule).toContain('job="oshal-swarm-bots"');
    expect(rule).toContain('intake: auto');
  });
});

describe('the hand restore (bash scripts/ci/ci-quiesce.sh --resume)', () => {
  /** @description A state file as a killed run leaves it, and the container it names stopped. */
  function killedRun(): Case {
    const c = newCase(fixture({ 'fixture-worker-a': { status: 'exited' } }));
    writeFileSync(stateFile(c), 'started=2026-10-01T23:30:05\npid=4242\nsilence=none\nsilence_starts=\ncontainer=fixture-worker-a\n');
    return c;
  }
  const cli = (c: Case, ...args: string[]): Promise<{ status: number | null; output: string }> => runBash(
    [QUIESCE_HELPER, ...args],
    probeEnv(c.dir, { ...settings('none'), OSHAL_CI_STATE_DIR: toBash(c.stateDir), PATH: `${c.bin};${process.env.PATH ?? ''}` }),
    join(c.dir, `cli-${Date.now()}.log`), CASE_TIMEOUT,
  );

  it('restores what a killed run left, and refuses while a run holds the lock unless forced', async () => {
    const held = killedRun();
    mkdirSync(join(held.stateDir, 'ci-local.lock'));
    const refused = await cli(held, '--resume');
    expect(refused.status).toBe(2);
    expect(statusOf(held.state, 'fixture-worker-a')).toBe('exited');
    const forced = await cli(held, '--resume', '--force');
    expect(forced.status, forced.output).toBe(0);
    expect(statusOf(held.state, 'fixture-worker-a')).toBe('running');
    expect(existsSync(stateFile(held))).toBe(false);

    const free = killedRun();
    const resumed = await cli(free, '--resume');
    expect(resumed.status, resumed.output).toBe(0);
    expect(resumed.output).toContain('quiesce: restored fixture-worker-a');
    expect(statusOf(free.state, 'fixture-worker-a')).toBe('running');
    const nothing = await cli(free, '--resume');
    expect(nothing.output).toContain('nothing to restore');
  }, CASE_TIMEOUT);
});
