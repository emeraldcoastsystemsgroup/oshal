/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — GitHub Actions workflow parser for gha-local: normalize any workflow YAML into typed jobs/steps/services, expand strategy.matrix (product + include/exclude), and topologically order jobs by `needs`.
 */

import fs from 'node:fs';
import yaml from 'js-yaml';

/** One service container a job declares (postgres/redis in the repo's real ci.yml). */
export interface GhaService {
  name: string;
  image: string;
  env: Record<string, string>;
  ports: string[];
  options: string;
}

/** One step, normalized. Exactly one of `run` / `uses` is set. */
export interface GhaStep {
  id?: string;
  name: string;
  if?: string;
  run?: string;
  uses?: string;
  with: Record<string, string>;
  env: Record<string, string>;
  shell?: string;
  workingDirectory?: string;
  continueOnError: boolean;
  timeoutMinutes?: number;
}

/** One job instance (post-matrix-expansion — a matrix job yields several of these). */
export interface GhaJob {
  id: string;
  /** The workflow-declared job id (matrix instances share it; `needs` context keys on this). */
  baseId: string;
  name: string;
  runsOn: string;
  needs: string[];
  if?: string;
  env: Record<string, string>;
  services: GhaService[];
  steps: GhaStep[];
  /** jobs.<id>.outputs — expressions (often `steps.X.outputs.Y`) later jobs read via `needs`. */
  outputs: Record<string, string>;
  matrix?: Record<string, string | number | boolean>;
  timeoutMinutes?: number;
}

/** The normalized workflow. */
export interface GhaWorkflow {
  name: string;
  file: string;
  triggers: string[];
  env: Record<string, string>;
  /** workflow_dispatch input declared defaults (name → default value, '' when none). */
  inputDefaults: Record<string, string>;
  jobs: GhaJob[];
}

/** Coerces a YAML scalar map into Record<string,string> (numbers/bools stringified). */
function strMap(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) out[k] = v === null || v === undefined ? '' : String(v);
  }
  return out;
}

function parseStep(raw: Record<string, unknown>, index: number): GhaStep {
  return {
    id: typeof raw.id === 'string' ? raw.id : undefined,
    name: typeof raw.name === 'string' ? raw.name : (typeof raw.uses === 'string' ? raw.uses : `step ${index + 1}`),
    if: typeof raw.if === 'string' ? raw.if : (raw.if !== undefined ? String(raw.if) : undefined),
    run: typeof raw.run === 'string' ? raw.run : undefined,
    uses: typeof raw.uses === 'string' ? raw.uses : undefined,
    with: strMap(raw.with),
    env: strMap(raw.env),
    shell: typeof raw.shell === 'string' ? raw.shell : undefined,
    workingDirectory: typeof raw['working-directory'] === 'string' ? (raw['working-directory'] as string) : undefined,
    continueOnError: raw['continue-on-error'] === true,
    timeoutMinutes: typeof raw['timeout-minutes'] === 'number' ? (raw['timeout-minutes'] as number) : undefined,
  };
}

function parseServices(raw: unknown): GhaService[] {
  const out: GhaService[] = [];
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [name, svcRaw] of Object.entries(raw as Record<string, unknown>)) {
      const svc = (svcRaw ?? {}) as Record<string, unknown>;
      out.push({
        name,
        image: typeof svc.image === 'string' ? svc.image : String(svcRaw ?? ''),
        env: strMap(svc.env),
        ports: Array.isArray(svc.ports) ? svc.ports.map(String) : [],
        options: typeof svc.options === 'string' ? svc.options : '',
      });
    }
  }
  return out;
}

/** Cartesian product of the matrix axes + `include` rows appended + `exclude` rows removed. */
export function expandMatrix(raw: unknown): Array<Record<string, string | number | boolean>> {
  if (!raw || typeof raw !== 'object') return [];
  const m = raw as Record<string, unknown>;
  const axes = Object.entries(m).filter(([k, v]) => k !== 'include' && k !== 'exclude' && Array.isArray(v)) as Array<[string, unknown[]]>;
  let combos: Array<Record<string, string | number | boolean>> = [{}];
  for (const [axis, values] of axes) {
    combos = combos.flatMap((c) => values.map((v) => ({ ...c, [axis]: v as string | number | boolean })));
  }
  if (axes.length === 0) combos = [];
  const excludes = Array.isArray(m.exclude) ? (m.exclude as Array<Record<string, unknown>>) : [];
  combos = combos.filter((c) => !excludes.some((ex) => Object.entries(ex).every(([k, v]) => String(c[k]) === String(v))));
  const includes = Array.isArray(m.include) ? (m.include as Array<Record<string, unknown>>) : [];
  for (const inc of includes) combos.push(Object.fromEntries(Object.entries(inc).map(([k, v]) => [k, v as string | number | boolean])));
  return combos;
}

/** Kahn topological order over `needs`; unknown needs are dropped with the cycle reported by throw. */
export function orderJobs(jobs: GhaJob[]): GhaJob[] {
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const indeg = new Map(jobs.map((j) => [j.id, j.needs.filter((n) => byId.has(n)).length]));
  const queue = jobs.filter((j) => (indeg.get(j.id) ?? 0) === 0).map((j) => j.id);
  const out: GhaJob[] = [];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(byId.get(id)!);
    for (const j of jobs) {
      if (!j.needs.includes(id) || seen.has(j.id)) continue;
      indeg.set(j.id, (indeg.get(j.id) ?? 1) - 1);
      if ((indeg.get(j.id) ?? 0) <= 0) queue.push(j.id);
    }
  }
  if (out.length !== jobs.length) {
    const stuck = jobs.filter((j) => !seen.has(j.id)).map((j) => j.id);
    throw new Error(`jobs have a needs-cycle or unresolvable dependency: ${stuck.join(', ')}`);
  }
  return out;
}

/**
 * @description Parses a GitHub Actions workflow file into the normalized, matrix-expanded,
 * needs-ordered job list gha-local executes.
 * @param file - path to the workflow YAML
 * @returns the normalized workflow
 */
export function parseWorkflow(file: string): GhaWorkflow {
  const raw = yaml.load(fs.readFileSync(file, 'utf-8'));
  if (!raw || typeof raw !== 'object') throw new Error(`${file}: not a YAML mapping`);
  const wf = raw as Record<string, unknown>;
  const jobsRaw = (wf.jobs ?? {}) as Record<string, Record<string, unknown>>;
  if (Object.keys(jobsRaw).length === 0) throw new Error(`${file}: workflow declares no jobs`);

  const onRaw = wf.on ?? wf[true as unknown as string]; // YAML 1.1 parses bare `on:` as boolean true
  const triggers = typeof onRaw === 'string' ? [onRaw]
    : Array.isArray(onRaw) ? onRaw.map(String)
      : onRaw && typeof onRaw === 'object' ? Object.keys(onRaw) : [];

  // workflow_dispatch declared inputs → their defaults (callers overlay real values).
  const inputDefaults: Record<string, string> = {};
  const dispatch = onRaw && typeof onRaw === 'object' && !Array.isArray(onRaw)
    ? (onRaw as Record<string, unknown>).workflow_dispatch : undefined;
  const inputsRaw = dispatch && typeof dispatch === 'object' ? (dispatch as Record<string, unknown>).inputs : undefined;
  if (inputsRaw && typeof inputsRaw === 'object') {
    for (const [k, v] of Object.entries(inputsRaw as Record<string, unknown>)) {
      const d = v && typeof v === 'object' ? (v as Record<string, unknown>).default : undefined;
      inputDefaults[k] = d === undefined || d === null ? '' : String(d);
    }
  }

  const jobs: GhaJob[] = [];
  for (const [id, jr] of Object.entries(jobsRaw)) {
    const needsRaw = jr.needs;
    const needs = typeof needsRaw === 'string' ? [needsRaw] : Array.isArray(needsRaw) ? needsRaw.map(String) : [];
    const stepsRaw = Array.isArray(jr.steps) ? (jr.steps as Array<Record<string, unknown>>) : [];
    const base: Omit<GhaJob, 'matrix'> = {
      id,
      baseId: id,
      name: typeof jr.name === 'string' ? jr.name : id,
      runsOn: typeof jr['runs-on'] === 'string' ? (jr['runs-on'] as string) : JSON.stringify(jr['runs-on'] ?? ''),
      needs,
      if: typeof jr.if === 'string' ? jr.if : (jr.if !== undefined ? String(jr.if) : undefined),
      env: strMap(jr.env),
      services: parseServices(jr.services),
      steps: stepsRaw.map(parseStep),
      outputs: strMap(jr.outputs),
      timeoutMinutes: typeof jr['timeout-minutes'] === 'number' ? (jr['timeout-minutes'] as number) : undefined,
    };
    const strategy = (jr.strategy ?? {}) as Record<string, unknown>;
    const combos = expandMatrix(strategy.matrix);
    if (combos.length === 0) {
      jobs.push(base);
    } else {
      for (const combo of combos) {
        const label = Object.values(combo).join(', ');
        jobs.push({ ...base, id: combos.length > 1 ? `${id} (${label})` : id, name: `${base.name} (${label})`, matrix: combo });
      }
    }
  }
  // Matrix instances share the base id for `needs` resolution: map needs onto every instance id.
  const instanceIds = (baseId: string) => jobs.filter((j) => j.id === baseId || j.id.startsWith(`${baseId} (`)).map((j) => j.id);
  for (const j of jobs) j.needs = j.needs.flatMap(instanceIds);

  return {
    name: typeof wf.name === 'string' ? wf.name : file,
    file,
    triggers,
    env: strMap(wf.env),
    inputDefaults,
    jobs: orderJobs(jobs),
  };
}
