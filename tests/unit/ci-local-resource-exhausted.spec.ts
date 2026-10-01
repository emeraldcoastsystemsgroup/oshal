/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Guard for run_gate's RESOURCE-EXHAUSTED outcome (BACKLOG "The nightly gate runs against a saturated box"). A scripted host - a /proc/meminfo stand-in the gates rewrite while they run - under the PRODUCTION run_gate, outcome block, gate sequence and traps of scripts/ci-local.sh with the shipped scripts/ci/ci-resource.sh. Proves: a host that stays below the operator's floor keeps a gate from starting and reports it RESOURCE-EXHAUSTED (never PASS, never FAIL, never silent), and a run with only that exits 3; a host that recovers inside the wait is admitted; a gate that fails while the host dips below the floor is RESOURCE-EXHAUSTED and one that passes through the dip is PASS; a failure on a healthy host stays FAIL even when its output says ENOMEM and `cannot allocate memory` (text is not evidence - specs in the unit gate print those words); skip markers inherit their cause; an unset floor is announced and classifies nothing; and the sampler dies with its run, on SIGTERM and on SIGKILL.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | The recovery case flipped the scripted host from a background writer that raced the admission's read (1 failure in 12 runs on an unchanged tree - a nightly false red, the very thing this entry exists to stop). The host now recovers from inside the admission's own sleep, so the case is sequential and asserts the exact `admitted after 1s`.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  END_BLOCK, blockBetween, dockerStandIn, functionBody, probeArgs, probeEnv, probeHead, runBash, toBash, trapLines,
} from '../helpers/ci-local-probe';

const SCRATCH = mkdtempSync(join(tmpdir(), 'oshal-ci-resource-'));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));
const CASE_TIMEOUT = 120_000;

/** @description A /proc/meminfo with this much available host memory, in MB. */
const meminfo = (freeMb: number): string => `MemTotal:       16417332 kB\nMemFree:        ${freeMb * 1024} kB\nHighTotal:             0 kB\n`;

/** Floor 1024 MB, wait 2 s, sample every second: small enough for a spec, the same code paths. */
const FLOOR = { OSHAL_CI_MIN_FREE_MB: '1024', OSHAL_CI_RESOURCE_WAIT_SECONDS: '2', OSHAL_CI_RESOURCE_SAMPLE_SECONDS: '1' };

interface Case { dir: string; stateDir: string; bin: string; meminfo: string; ran: string }

/** @description A fresh case: scripted host at `freeMb`, an empty docker stand-in, a ran-gates record. */
function newCase(freeMb: number): Case {
  const dir = mkdtempSync(join(SCRATCH, 'case-'));
  const stateDir = join(dir, 'state');
  mkdirSync(stateDir, { recursive: true });
  const { bin } = dockerStandIn(dir, {});
  const file = join(dir, 'meminfo');
  writeFileSync(file, meminfo(freeMb));
  return { dir, stateDir, bin, meminfo: file, ran: join(dir, 'ran.txt') };
}

/** Test plumbing the gates use to move the scripted host; never part of what is judged. */
const PLUMBING = [
  "set_free() { printf 'MemTotal: 16417332 kB\\nMemFree: %s kB\\n' \"$(( $1 * 1024 ))\" > \"$CI_RESOURCE_MEMINFO\"; }",
  'ran() { printf \'%s\\n\' "$1" >> "$RAN_RECORD"; }',
  // A starved host that stays starved, a dip during the gate, and a host that is fine.
  'gate_record() { ran "$CURRENT_GATE"; return 0; }',
  'gate_dip_then_fail() { ran "$CURRENT_GATE"; set_free 300; sleep 3; set_free 4000; echo "fixture: 2 specs failed"; return 1; }',
  'gate_dip_then_pass() { ran "$CURRENT_GATE"; set_free 300; sleep 3; set_free 4000; return 0; }',
  // The words a starved host prints, on a host that is NOT starved: a real failure stays FAIL.
  "gate_words_but_healthy() { ran \"$CURRENT_GATE\"; echo \"Error: ENOMEM: not enough memory, scandir '/app/swarm-apps/connectors'\"; echo 'skipping file: cannot allocate memory'; return 1; }",
  'gate_block() { ran "$CURRENT_GATE"; set_free 900; : > "$GATE_MARK"; while :; do sleep 0.2; done; }',
].join('\n');

/**
 * @description A probe that runs the given gates through the production run_gate, with the
 * production on_exit and traps installed and the production end-of-run block after them.
 * @param gates `name:function` pairs, run in order.
 * @returns the probe script.
 */
function gatesProbe(gates: string[]): string {
  return [
    probeHead(),
    PLUMBING,
    'CI_LOCK_STALE_SECONDS=14400; LOCK="$STATE_DIR/ci-local.lock"; mkdir -p "$LOCK"',
    'SMOKE=oshal-ci-smoke; DS_UP=0; E2E_PG=oshal-ci-pg; E2E_REDIS=oshal-ci-redis; CI_NET=oshal-ci-net',
    "finish_run_log() { printf '[log] finish_run_log\\n'; }",
    'CLEANED=0',
    functionBody('on_exit'),
    trapLines(),
    'FAILED_GATES=(); EXHAUSTED_GATES=()',
    functionBody('run_gate'),
    functionBody('gate_did_not_pass'),
    functionBody('record_skipped'),
    'QUIESCE=0; SCHEDULED=1; PUBLISH_IMAGE=0; SKIP_IMAGE=0; SKIP_E2E=0',
    'SOURCE_REF=HEAD; SOURCE_SHORT_SHA=fixture; SOURCE_POSTURE=probe; RUN_LOG=/dev/null',
    'ci_resource_init',
    ...gates.map((pair) => {
      const [name, fn] = pair.split(':');
      return `CURRENT_GATE=${name}; run_gate ${name} ${fn}`;
    }),
    END_BLOCK(),
    'exit "${RUN_EXIT:-0}"',
    '',
  ].join('\n');
}

/** @description Run a probe script to completion against the case's scripted host. */
async function run(c: Case, script: string, env: Record<string, string>): Promise<{ status: number | null; output: string; ran: string[] }> {
  const probe = join(c.dir, `probe-${Date.now()}.sh`);
  writeFileSync(probe, script);
  const result = await runBash([toBash(probe), ...probeArgs(c.stateDir, c.bin)],
    probeEnv(c.dir, { CI_RESOURCE_MEMINFO: toBash(c.meminfo), RAN_RECORD: toBash(c.ran), ...env }),
    join(c.dir, `out-${Date.now()}.log`), CASE_TIMEOUT);
  const ran = existsSync(c.ran) ? readFileSync(c.ran, 'utf8').split('\n').filter(Boolean) : [];
  return { ...result, ran };
}

describe("run_gate's RESOURCE-EXHAUSTED outcome (scripts/ci-local.sh + scripts/ci/ci-resource.sh)", () => {
  it('does not start a gate while the host stays below the floor, reports it as its own outcome, and exits 3', async () => {
    const c = newCase(200);
    const r = await run(c, gatesProbe(['starved:gate_record']), FLOOR);
    expect(r.ran, 'a gate ran on a host below the floor').toEqual([]);
    expect(r.output).toMatch(/GATE starved: RESOURCE-EXHAUSTED \(\d+s; not started: host free 200MB stayed below the 1024MB floor for 2s\)/);
    expect(r.output).not.toMatch(/GATE starved: (PASS|FAIL)/);
    expect(r.output).toContain('=== LOCAL CI: RESOURCE-EXHAUSTED gates: starved ===');
    expect(r.output).not.toContain('ALL GATES GREEN');
    expect(r.status).toBe(3);
  }, CASE_TIMEOUT);

  it('admits a gate once the host recovers inside the wait', async () => {
    const c = newCase(200);
    // The host recovers from INSIDE the admission's own wait - its sleep - never from a concurrent
    // writer: a background writer can truncate the scripted file under the admission's read, which
    // then claims nothing and admits silently (1 failure in 12 runs). Sequential, so deterministic.
    const script = gatesProbe(['recovering:gate_record'])
      .replace('ci_resource_init\n', 'ci_resource_init\nsleep() { set_free 4000; command sleep "$@"; }\n');
    const r = await run(c, script, { ...FLOOR, OSHAL_CI_RESOURCE_WAIT_SECONDS: '10' });
    expect(r.ran).toEqual(['recovering']);
    expect(r.output).toContain('resource-check: recovering admitted after 1s (host free 4000MB)');
    expect(r.output).toContain('GATE recovering: PASS');
    expect(r.status).toBe(0);
  }, CASE_TIMEOUT);

  it('classifies a gate that FAILS while the host dips below the floor as resource-exhausted, and one that passes through it as PASS', async () => {
    const c = newCase(4000);
    const r = await run(c, gatesProbe(['starved-fail:gate_dip_then_fail', 'starved-pass:gate_dip_then_pass']), FLOOR);
    expect(r.ran).toEqual(['starved-fail', 'starved-pass']);
    expect(r.output).toMatch(/GATE starved-fail: RESOURCE-EXHAUSTED \(\d+s; failed while host free fell to 300MB, below the 1024MB floor\)/);
    expect(r.output).toMatch(/GATE starved-pass: PASS \(\d+s\)/);
    expect(r.output).toContain('=== LOCAL CI: RESOURCE-EXHAUSTED gates: starved-fail ===');
    expect(r.status).toBe(3);
  }, CASE_TIMEOUT);

  it('keeps a failure on a healthy host FAIL even when its output says ENOMEM and cannot allocate memory', async () => {
    const c = newCase(4000);
    const r = await run(c, gatesProbe(['real-failure:gate_words_but_healthy', 'starved:gate_dip_then_fail']), FLOOR);
    expect(r.output).toMatch(/GATE real-failure: FAIL \(\d+s\)/);
    expect(r.output).toContain('=== LOCAL CI: FAILED gates: real-failure; RESOURCE-EXHAUSTED gates: starved ===');
    expect(r.status, 'a run with a real failure in it is a failed run').toBe(1);
  }, CASE_TIMEOUT);

  it('announces an unset floor and classifies nothing as exhausted without one', async () => {
    const c = newCase(100);
    const r = await run(c, gatesProbe(['unjudged:gate_dip_then_fail']), { OSHAL_CI_MIN_FREE_MB: '' });
    expect(r.output).toContain('resource-check: NOT CONFIGURED - OSHAL_CI_MIN_FREE_MB is unset');
    expect(r.ran).toEqual(['unjudged']);
    expect(r.output).toContain('=== LOCAL CI: FAILED gates: unjudged ===');
    expect(r.status).toBe(1);
  }, CASE_TIMEOUT);

  it('records the skipped chain under the cause of its first link: a starved head-src and a starved image-build', async () => {
    const c = newCase(200);
    const stubs = ['typecheck', 'typecheck_tests', 'store_compatibility', 'unit', 'lint', 'connectors', 'manifests', 'kernel_skills',
      'workflow_triggers', 'security_policy', 'repo_separation', 'javascript_logging', 'ai_usage_ledger', 'spec_database_default',
      'worktree_strays', 'argo_manifests', 'terraform', 'secrets', 'local_secret_hygiene', 'unpushed_commits', 'e2e',
      'kernel_skills_image', 'smoke', 'trivy', 'alert_residue']
      .map((g) => `gate_${g}() { ran ${g}; return 0; }`);
    const script = [
      probeHead(),
      PLUMBING,
      // The host recovers right after head-src is refused, and starves again inside image-build.
      "log() { printf '[log] %s\\n' \"$*\"; case \"$*\" in 'GATE head-src: RESOURCE-EXHAUSTED'*) set_free 4000 ;; esac; }",
      'prepare_head_src() { ran head-src; return 0; }',
      'gate_image() { ran image-build; set_free 300; sleep 3; set_free 4000; return 1; }',
      'prune_scoped() { :; }',
      ...stubs,
      'FAILED_GATES=(); EXHAUSTED_GATES=()',
      functionBody('run_gate'),
      functionBody('gate_did_not_pass'),
      functionBody('record_skipped'),
      'HEAD_MODE=1; DO_INSTALL=0; SKIP_E2E=0; SKIP_IMAGE=0; PUBLISH_IMAGE=0; QUIESCE=0; SCHEDULED=1',
      "CLUSTER_GATES=0; K8S_CLUSTER_GATES_NOT_REQUESTED='cluster gates not requested'",
      'SOURCE_REF=HEAD; SOURCE_SHORT_SHA=fixture; SOURCE_POSTURE=probe; RUN_LOG=/dev/null',
      'ci_resource_init',
      blockBetween('NODE_GATES_OK=1\n', 'log "=== LOCAL CI: $OUTCOME ==="'),
      'exit "${RUN_EXIT:-0}"',
      '',
    ].join('\n');
    const r = await run(c, script, FLOOR);
    expect(r.ran, 'the starved export never started, so no node gate may have run').not.toContain('head-src');
    expect(r.ran).not.toContain('typecheck');
    expect(r.ran).not.toContain('kernel_skills_image');
    expect(r.ran).toEqual(expect.arrayContaining(['secrets', 'image-build', 'alert_residue']));
    expect(r.output).toContain('=== LOCAL CI: RESOURCE-EXHAUSTED gates: head-src node-gates-skipped image-build'
      + ' kernel-skills-image-skipped image-smoke-skipped trivy-skipped ===');
    expect(r.output).not.toContain('FAILED gates:');
    expect(r.status).toBe(3);
  }, CASE_TIMEOUT);
});

describe('the sampler never outlives its run', () => {
  /**
   * @description Block inside a sampled gate, signal the run from a job-controlled parent, then
   * starve the scripted host further: a sampler that survived would record the new low.
   * @param signal TERM (on_exit stops the sampler) or KILL (it must notice its run is gone).
   * @returns the orchestrator output and the case.
   */
  async function signalMidGate(signal: 'TERM' | 'KILL'): Promise<{ output: string; c: Case }> {
    const c = newCase(4000);
    const probe = join(c.dir, 'blocking.sh');
    writeFileSync(probe, gatesProbe(['sampled:gate_block']));
    const orch = join(c.dir, 'orchestrate.sh');
    writeFileSync(orch, [
      '#!/usr/bin/env bash',
      'set -m',
      'sig="$1"; probe="$2"; out="$3"; shift 3',
      'bash "$probe" "$@" > "$out" 2>&1 &',
      'pid=$!',
      'for i in $(seq 1 600); do [ -f "$GATE_MARK" ] && break; sleep 0.1; done',
      '[ -f "$GATE_MARK" ] || { echo "ORCH: the gate never started"; kill -KILL "$pid"; exit 98; }',
      'sleep 3',
      'kill -"$sig" "$pid"; wait "$pid"; echo "CHILD_EXIT=$?"',
      "printf 'MemTotal: 16417332 kB\\nMemFree: %s kB\\n' 102400 > \"$CI_RESOURCE_MEMINFO\"",
      'sleep 4',
      'for f in "$ORCH_STATE_DIR"/ci-resource-min.*; do [ -f "$f" ] && printf "MINFILE %s\\n" "$(cat "$f")"; done',
      'echo "ORCH: done"',
      '',
    ].join('\n'));
    const env = probeEnv(c.dir, {
      ...FLOOR, CI_RESOURCE_MEMINFO: toBash(c.meminfo), RAN_RECORD: toBash(c.ran),
      GATE_MARK: toBash(join(c.dir, 'gate-running')), ORCH_STATE_DIR: toBash(c.stateDir),
    });
    const result = await runBash([toBash(orch), signal, toBash(probe), toBash(join(c.dir, 'run.log')), ...probeArgs(c.stateDir, c.bin)],
      env, join(c.dir, 'orchestrator.log'), CASE_TIMEOUT);
    return { output: result.output, c };
  }

  it('is stopped by on_exit when the run is interrupted (SIGTERM)', async () => {
    const { output, c } = await signalMidGate('TERM');
    expect(output).toContain('CHILD_EXIT=130');
    expect(output).not.toContain('MINFILE');
    expect(readdirSync(c.stateDir).filter((name) => name.startsWith('ci-resource-min.'))).toEqual([]);
  }, CASE_TIMEOUT);

  it('exits by itself when the run is killed outright (SIGKILL), recording nothing after it', async () => {
    const { output } = await signalMidGate('KILL');
    expect(output).toContain('CHILD_EXIT=137');
    // The killed run cannot remove its file, but the sampler must not keep writing to it:
    // it saw 900 MB while the run lived and must never record the 100 MB that came after.
    expect(output).toContain('MINFILE 900');
    expect(output).not.toContain('MINFILE 100');
  }, CASE_TIMEOUT);
});
