/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — gha-local execution engine: runs a Plan locally. needs-gated jobs, service containers (docker run + health-wait + guaranteed teardown), per-step live interpolation (steps./needs. contexts), GITHUB_OUTPUT/GITHUB_ENV plumbing, if-conditions with success()/failure()/always(), continue-on-error, timeouts, artifact copy to .gha-local/artifacts. Secrets come only from the caller.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | SECURITY: workflow shell steps inherit only OS/runtime values plus declared workflow/caller inputs, matching the documented secrets contract instead of exposing the launcher's entire environment.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Plan, PlannedJob, PlannedStep } from './plan';
import { evalExpr, interpolate, truthy, type ExprContexts, type ExprWarnings } from './expr';
import type { GhaService } from './parse';

export interface StepResult { name: string; kind: string; status: 'ok' | 'fail' | 'skipped'; note: string; durationMs: number; }
export interface JobResult { id: string; status: 'success' | 'failure' | 'skipped'; steps: StepResult[]; }
export interface RunSummary { jobs: JobResult[]; ok: boolean; warnings: string[]; }

export interface RunOptions {
  cwd?: string;
  secrets?: Record<string, string>;
  /** Fail (instead of warn) when a step maps to 'unknown'. */
  strict?: boolean;
  /** Line sink for progress output (default stdout). */
  log?: (line: string) => void;
}

const GHA_STEP_RUNTIME_ENV_KEYS = [
  'PATH', 'Path', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT',
  'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'APPDATA', 'LOCALAPPDATA', 'LANG', 'LC_ALL', 'TZ',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
  'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS',
] as const;

/** Build one local workflow step's environment without ambient host secrets. */
export function buildGhaStepProcessEnv(
  stepEnv: Record<string, string>,
  extraEnv: Record<string, string>,
  parent: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { CI: 'true' };
  for (const key of GHA_STEP_RUNTIME_ENV_KEYS) {
    const value = parent[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...stepEnv, ...extraEnv };
}

/** Executes a command under the step's shell via a temp script (multiline-safe on Windows). */
function executeCmd(step: PlannedStep, cwd: string, extraEnv: Record<string, string>): number {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gha-local-'));
  try {
    const env = buildGhaStepProcessEnv(step.env, extraEnv);
    const timeoutMs = (step.timeoutMinutes ?? 60) * 60_000;
    const runCwd = step.cwd ? path.resolve(cwd, step.cwd) : cwd;
    let file: string; let cmd: string; let args: string[];
    if (step.shell === 'pwsh') {
      file = path.join(dir, 'step.ps1'); cmd = 'powershell'; args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file];
    } else if (step.shell === 'cmd') {
      file = path.join(dir, 'step.cmd'); cmd = 'cmd'; args = ['/c', file];
    } else {
      file = path.join(dir, 'step.sh'); cmd = 'bash'; args = ['-e', file]; // GHA's default bash mode
    }
    fs.writeFileSync(file, step.cmd ?? '', 'utf-8');
    const res = spawnSync(cmd, args, { cwd: runCwd, env, stdio: 'inherit', timeout: timeoutMs });
    return res.status ?? 1;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Starts one service container; returns its container name (empty string on failure). */
function startService(svc: GhaService, runId: string, log: (l: string) => void): string {
  const name = `gha-local-${svc.name}-${runId}`;
  const args = ['run', '-d', '--name', name];
  for (const [k, v] of Object.entries(svc.env)) args.push('-e', `${k}=${v}`);
  for (const p of svc.ports) args.push('-p', p.includes(':') ? p : `${p}:${p}`);
  if (svc.options) args.push(...svc.options.split(/\s+/).filter(Boolean));
  args.push(svc.image);
  const res = spawnSync('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  if (res.status !== 0) {
    log(`  service ${svc.name}: FAILED to start — ${String(res.stderr ?? '').trim().slice(0, 200)}`);
    return '';
  }
  return name;
}

/** Waits for a service to become healthy (when it defines a healthcheck) or briefly settles. */
function waitService(container: string, hasHealthCmd: boolean, log: (l: string) => void): boolean {
  if (!hasHealthCmd) { spawnSync('sleep', ['2']); return true; }
  for (let i = 0; i < 45; i++) {
    const res = spawnSync('docker', ['inspect', '-f', '{{.State.Health.Status}}', container], { stdio: ['ignore', 'pipe', 'ignore'] });
    if (String(res.stdout ?? '').trim() === 'healthy') return true;
    spawnSync('sleep', ['2']);
  }
  log(`  service ${container}: never became healthy (90s)`);
  return false;
}

/** Copies an upload-artifact step's paths into .gha-local/artifacts/<name>/. Globs are warned+skipped. */
function copyArtifacts(step: PlannedStep, cwd: string, log: (l: string) => void): void {
  const dest = path.join(cwd, '.gha-local', 'artifacts', step.artifact!.name);
  fs.mkdirSync(dest, { recursive: true });
  for (const p of step.artifact!.paths) {
    if (p.includes('*')) { log(`  artifact glob "${p}" not supported locally — skipped`); continue; }
    const src = path.resolve(cwd, p);
    if (!fs.existsSync(src)) { log(`  artifact path "${p}" does not exist — skipped`); continue; }
    fs.cpSync(src, path.join(dest, path.basename(p)), { recursive: true, force: true });
  }
}

/** Parses GITHUB_OUTPUT / GITHUB_ENV k=v lines (the plain form; heredoc blocks are ignored with a note). */
function parseKvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf-8').split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_-]*)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** Should this step run, per GHA semantics (no `if` ⇒ only when the job is still succeeding)? */
function stepShouldRun(step: PlannedStep, ctx: ExprContexts, warnings: ExprWarnings): boolean {
  if (!step.if) return (ctx.jobStatus ?? 'success') === 'success';
  return truthy(evalExpr(step.if, ctx, warnings));
}

function runJob(job: PlannedJob, plan: Plan, opts: Required<Pick<RunOptions, 'cwd' | 'log'>> & RunOptions,
  needsCtx: Record<string, { outputs: Record<string, string>; result?: string }>): JobResult {
  const { cwd, log } = opts;
  const warnings: ExprWarnings = { warnings: plan.warnings };
  const stepsCtx: Record<string, { outputs: Record<string, string> }> = {};
  const runId = `${process.pid}-${Math.floor(Date.now() / 1000)}`;
  const results: StepResult[] = [];
  let jobStatus: 'success' | 'failure' = 'success';
  const dynamicEnv: Record<string, string> = {};

  // Services up (with guaranteed teardown).
  const containers: string[] = [];
  try {
    for (const svc of job.services) {
      log(`  service ${svc.name} (${svc.image})…`);
      const c = startService(svc, runId, log);
      if (!c || !waitService(c, svc.options.includes('--health-cmd'), log)) { jobStatus = 'failure'; }
      if (c) containers.push(c);
    }

    for (const step of job.steps) {
      const ctx: ExprContexts = {
        env: { ...step.env, ...dynamicEnv }, secrets: opts.secrets ?? {}, github: {}, matrix: job.matrix,
        needs: needsCtx, steps: stepsCtx, jobStatus, workspace: cwd,
      };
      if (!stepShouldRun(step, ctx, warnings)) {
        results.push({ name: step.name, kind: step.kind, status: 'skipped', note: 'if-condition / job status', durationMs: 0 });
        continue;
      }
      const t0 = Date.now();
      const r = runStep(step, ctx, { cwd, log, strict: opts.strict }, dynamicEnv, stepsCtx, warnings);
      results.push({ name: step.name, kind: step.kind, status: r ? 'ok' : 'fail', note: step.note, durationMs: Date.now() - t0 });
      log(`  [${r ? 'ok' : 'FAIL'}] ${step.name} (${step.kind}, ${Math.round((Date.now() - t0) / 1000)}s)`);
      if (!r && !step.continueOnError) jobStatus = 'failure';
    }
  } finally {
    for (const c of containers) spawnSync('docker', ['rm', '-f', c], { stdio: 'ignore' });
  }

  // Resolve jobs.<id>.outputs (usually steps.X.outputs.Y expressions) for downstream `needs`.
  const outputs: Record<string, string> = {};
  for (const [k, v] of Object.entries(job.outputs)) {
    outputs[k] = interpolate(v, { steps: stepsCtx, needs: needsCtx, env: dynamicEnv }, warnings);
  }
  needsCtx[job.baseId] = { outputs, result: jobStatus };
  return { id: job.id, status: jobStatus, steps: results };
}

function runStep(step: PlannedStep, ctx: ExprContexts,
  opts: { cwd: string; log: (l: string) => void; strict?: boolean },
  dynamicEnv: Record<string, string>, stepsCtx: Record<string, { outputs: Record<string, string> }>,
  warnings: ExprWarnings): boolean {
  if (step.kind === 'noop' || step.kind === 'skip') { opts.log(`  [--] ${step.name} — ${step.note}`); return true; }
  if (step.kind === 'unknown') {
    opts.log(`  [??] ${step.name} — ${step.note}`);
    return !opts.strict;
  }
  if (step.kind === 'outputs') {
    if (step.stepId) stepsCtx[step.stepId] = { outputs: step.outputs ?? {} };
    return true;
  }
  if (step.kind === 'artifact') { copyArtifacts(step, opts.cwd, opts.log); return true; }

  // run / shell: live pass resolves the deferred steps./needs. references, then execute.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gha-out-'));
  try {
    const outFile = path.join(dir, 'output');
    const envFile = path.join(dir, 'env');
    fs.writeFileSync(outFile, ''); fs.writeFileSync(envFile, '');
    const liveCmd = interpolate(step.cmd ?? '', ctx, warnings);
    const liveEnv = Object.fromEntries(Object.entries(step.env).map(([k, v]) => [k, interpolate(v, ctx, warnings)]));
    const code = executeCmd({ ...step, cmd: liveCmd, env: liveEnv }, opts.cwd,
      { GITHUB_OUTPUT: outFile, GITHUB_ENV: envFile, GITHUB_WORKSPACE: opts.cwd, RUNNER_OS: 'Linux' });
    if (step.stepId) stepsCtx[step.stepId] = { outputs: parseKvFile(outFile) };
    Object.assign(dynamicEnv, parseKvFile(envFile));
    return code === 0;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * @description Executes a Plan job-by-job in needs order. A failed job marks its dependents
 * skipped (GHA default). Never throws for a step/job failure — the summary carries it.
 * @param plan - the built plan
 * @param opts - cwd, secrets (local only), strict mode, log sink
 * @returns the run summary (ok = every non-skipped job succeeded)
 */
export function runPlan(plan: Plan, opts: RunOptions = {}): RunSummary {
  const cwd = opts.cwd ?? process.cwd();
  const log = opts.log ?? ((l: string) => process.stdout.write(`${l}\n`));
  const needsCtx: Record<string, { outputs: Record<string, string>; result?: string }> = {};
  const statusById = new Map<string, JobResult['status']>();
  const results: JobResult[] = [];

  for (const job of plan.jobs) {
    // GHA default: a job whose needed job failed (or was itself skipped) is skipped.
    const depNotOk = job.needs.some((n) => statusById.get(n) !== undefined && statusById.get(n) !== 'success');
    if (depNotOk) {
      log(`JOB ${job.id}: skipped (a needed job did not succeed)`);
      statusById.set(job.id, 'skipped');
      results.push({ id: job.id, status: 'skipped', steps: [] });
      continue;
    }
    log(`JOB ${job.id}${job.matrix ? ` matrix=${JSON.stringify(job.matrix)}` : ''}`);
    const r = runJob(job, plan, { cwd, log, secrets: opts.secrets, strict: opts.strict }, needsCtx);
    statusById.set(job.id, r.status);
    results.push(r);
  }

  return { jobs: results, ok: results.every((r) => r.status !== 'failure'), warnings: plan.warnings };
}
