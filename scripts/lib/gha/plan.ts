/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — gha-local execution planner: resolve each job/step into a concrete local action (shell command with merged env + shell + cwd, mapped uses:, service containers), with every skip/unknown surfaced in the plan. Pure — no process spawning here.
 */

import { execSync } from 'node:child_process';
import type { GhaWorkflow, GhaJob, GhaStep, GhaService } from './parse';
import { mapAction, type MappedAction } from './actions-map';
import { interpolate, RUNTIME_CONTEXTS, type ExprContexts, type ExprWarnings } from './expr';

/** One executable unit of the plan. */
export interface PlannedStep {
  jobId: string;
  name: string;
  kind: MappedAction['kind'] | 'run';
  note: string;
  /** For run/shell: the command text. */
  cmd?: string;
  shell: 'bash' | 'pwsh' | 'cmd';
  env: Record<string, string>;
  cwd?: string;
  if?: string;
  continueOnError: boolean;
  timeoutMinutes?: number;
  stepId?: string;
  artifact?: { name: string; paths: string[] };
  outputs?: Record<string, string>;
}

/** One planned job: its services + ordered steps. */
export interface PlannedJob {
  id: string;
  baseId: string;
  name: string;
  runsOn: string;
  needs: string[];
  if?: string;
  services: GhaService[];
  steps: PlannedStep[];
  /** jobs.<id>.outputs expressions — runner resolves them against live steps context on completion. */
  outputs: Record<string, string>;
  matrix?: Record<string, string | number | boolean>;
}

export interface Plan {
  workflow: string;
  file: string;
  jobs: PlannedJob[];
  warnings: string[];
  /** Counts by kind, for the summary line. */
  stats: Record<string, number>;
}

/** Local stand-ins for the github.* context, resolved from the actual repo. */
export function localGithubContext(cwd = process.cwd()): Record<string, string> {
  const git = (args: string): string => {
    try { return execSync(`git ${args}`, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return ''; }
  };
  const branch = git('rev-parse --abbrev-ref HEAD') || 'main';
  return {
    sha: git('rev-parse HEAD') || 'local',
    ref: `refs/heads/${branch}`,
    ref_name: branch,
    repository: 'local/checkout',
    actor: 'gha-local',
    event_name: 'workflow_dispatch',
    workspace: cwd,
    run_id: '0',
    run_number: '0',
  };
}

/** Picks the execution shell for a run step (workflow `shell:` wins; bash is the GHA linux default). */
function pickShell(step: GhaStep): 'bash' | 'pwsh' | 'cmd' {
  const s = (step.shell || 'bash').toLowerCase();
  if (s === 'pwsh' || s === 'powershell') return 'pwsh';
  if (s === 'cmd') return 'cmd';
  return 'bash';
}

/**
 * @description Builds the executable plan for a workflow: jobs in needs-order, each step resolved
 * to a concrete local action with fully-merged env (workflow → job → step) and interpolated
 * expressions. `secrets` come ONLY from the caller (local env/file) — never fetched from anywhere.
 * @param wf - the parsed workflow
 * @param opts - secrets/vars for interpolation, an optional job filter, and the workspace dir
 * @returns the plan, with every warning the interpolation raised
 */
export function buildPlan(
  wf: GhaWorkflow,
  opts: { secrets?: Record<string, string>; vars?: Record<string, string>; inputs?: Record<string, string>; onlyJob?: string; cwd?: string } = {},
): Plan {
  const cwd = opts.cwd ?? process.cwd();
  const github = localGithubContext(cwd);
  const warnings: ExprWarnings = { warnings: [] };
  const stats: Record<string, number> = {};
  const jobs: PlannedJob[] = [];
  // Declared workflow_dispatch defaults, overlaid with whatever the caller supplied.
  const inputs = { ...wf.inputDefaults, ...(opts.inputs ?? {}) };

  for (const job of wf.jobs) {
    if (opts.onlyJob && job.id !== opts.onlyJob && !job.id.startsWith(`${opts.onlyJob} (`)) continue;
    jobs.push(planJob(wf, job, { github, secrets: opts.secrets ?? {}, vars: opts.vars ?? {}, inputs, cwd }, warnings, stats));
  }

  return { workflow: wf.name, file: wf.file, jobs, warnings: warnings.warnings, stats };
}

function planJob(
  wf: GhaWorkflow,
  job: GhaJob,
  base: { github: Record<string, string>; secrets: Record<string, string>; vars: Record<string, string>; inputs: Record<string, string>; cwd: string },
  warnings: ExprWarnings,
  stats: Record<string, number>,
): PlannedJob {
  const jobEnv = { ...wf.env, ...job.env };
  const ctx: ExprContexts = {
    env: jobEnv, secrets: base.secrets, vars: base.vars, github: base.github, inputs: base.inputs,
    runner: { os: 'Linux', arch: 'X64' }, matrix: job.matrix, workspace: base.cwd,
  };
  const steps: PlannedStep[] = [];

  for (const step of job.steps) {
    // Static contexts resolve now; steps./needs. references stay verbatim for the runner's
    // live-context pass (their values only exist mid-run — GITHUB_OUTPUT, prior-job outputs).
    const stepEnv = Object.fromEntries(Object.entries({ ...jobEnv, ...step.env })
      .map(([k, v]) => [k, interpolate(v, ctx, warnings, RUNTIME_CONTEXTS)]));
    const common = {
      jobId: job.id,
      name: step.name,
      shell: pickShell(step),
      env: stepEnv,
      cwd: step.workingDirectory,
      if: step.if,
      continueOnError: step.continueOnError,
      timeoutMinutes: step.timeoutMinutes,
      stepId: step.id,
    };
    if (step.run !== undefined) {
      steps.push({ ...common, kind: 'run', note: 'run step', cmd: interpolate(step.run, { ...ctx, env: stepEnv }, warnings, RUNTIME_CONTEXTS) });
      stats.run = (stats.run ?? 0) + 1;
    } else if (step.uses) {
      const withArgs = Object.fromEntries(Object.entries(step.with).map(([k, v]) => [k, interpolate(v, ctx, warnings, RUNTIME_CONTEXTS)]));
      const mapped = mapAction(step.uses, withArgs, base.github.sha);
      steps.push({ ...common, kind: mapped.kind, note: mapped.note, cmd: mapped.cmd, artifact: mapped.artifact, outputs: mapped.outputs });
      stats[mapped.kind] = (stats[mapped.kind] ?? 0) + 1;
    }
  }

  // Interpolate service env/images too (ci.yml services use plain values, but be complete).
  const services = job.services.map((s) => ({
    ...s,
    image: interpolate(s.image, ctx, warnings),
    env: Object.fromEntries(Object.entries(s.env).map(([k, v]) => [k, interpolate(v, ctx, warnings)])),
  }));

  return {
    id: job.id, baseId: job.baseId, name: job.name, runsOn: job.runsOn, needs: job.needs, if: job.if,
    services, steps, outputs: job.outputs, matrix: job.matrix,
  };
}
