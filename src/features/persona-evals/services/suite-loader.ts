/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Suite loader for persona regression evals: parses + validates ai-lab/persona-evals/<persona>.yaml (js-yaml, same stack as the persona loader). Validation is strict-at-load so an authoring mistake fails the run visibly instead of executing as a weakened gate.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Review fix: loadPersonaEvalSuite now falls back to matching the YAML `persona:` field when no file named <personaId>.yaml exists, so every suite the catalog lists as runnable actually runs (previously a filename/persona mismatch listed fine but threw file-not-found at run time). Ambiguous matches (two files declaring the same persona) throw naming both files.
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { basename, join, resolve } from 'path';
import yaml from 'js-yaml';
import { createChildLogger } from '@/shared/logger';
import { validateAssertion } from './assertion-engine';
import type { EvalAssertion, EvalTask, PersonaEvalSuite } from '../types';

const logger = createChildLogger({ module: 'persona-eval-suite-loader' });

/** Default suite directory, sibling to ai-lab/bot-personas. */
const DEFAULT_SUITE_DIR = 'ai-lab/persona-evals';

/**
 * @description Error carrying every validation problem found in a suite file, so the author
 * fixes the file in one pass instead of whack-a-mole.
 */
export class PersonaEvalSuiteError extends Error {
  /** All problems found in the suite file. */
  readonly problems: string[];

  constructor(file: string, problems: string[]) {
    super(`Invalid persona-eval suite ${file}:\n- ${problems.join('\n- ')}`);
    this.name = 'PersonaEvalSuiteError';
    this.problems = problems;
  }
}

/**
 * @description Resolves the suite directory: explicit param > PERSONA_EVALS_DIR env > the
 * repo-relative default. Mirrors the persona-file-loader's project-root fallback so the loader
 * works both from the api container (cwd=/app) and host-side CLI runs.
 * @param dir - Optional explicit directory.
 * @returns Absolute suite directory path.
 */
export function resolveSuiteDir(dir?: string): string {
  if (dir) return resolve(dir);
  const fromEnv = process.env.PERSONA_EVALS_DIR?.trim();
  if (fromEnv) return resolve(fromEnv);
  const cwdCandidate = resolve(process.cwd(), DEFAULT_SUITE_DIR);
  if (existsSync(cwdCandidate)) return cwdCandidate;
  // Walk up from src/features/persona-evals/services to the project root (persona-loader pattern).
  return join(resolve(__dirname, '..', '..', '..', '..'), DEFAULT_SUITE_DIR);
}

/**
 * @description Lists the available golden suites (persona id, description, task count) by
 * scanning the suite directory. Unparseable files are reported as entries with an `error`
 * field rather than silently dropped — a broken suite is a broken gate and must be visible.
 * @param dir - Optional suite directory override.
 * @returns One entry per suite YAML found.
 */
export function listPersonaEvalSuites(
  dir?: string,
): Array<{ persona: string; description?: string; taskCount: number; file: string; error?: string }> {
  const suiteDir = resolveSuiteDir(dir);
  let files: string[] = [];
  try {
    files = readdirSync(suiteDir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml')).sort();
  } catch (err) {
    logger.error({ err, suiteDir }, 'persona-eval suite directory is not readable');
    return [];
  }
  return files.map((file) => {
    const personaId = basename(file).replace(/\.ya?ml$/i, '');
    try {
      const suite = loadPersonaEvalSuite(personaId, suiteDir);
      return { persona: suite.persona, description: suite.description, taskCount: suite.tasks.length, file };
    } catch (err) {
      logger.error({ err, file }, 'persona-eval suite failed to load');
      return { persona: personaId, taskCount: 0, file, error: err instanceof Error ? err.message : String(err) };
    }
  });
}

/**
 * @description Loads and STRICTLY validates one persona's golden suite from
 * `<suiteDir>/<personaId>.yaml`, falling back to any suite file whose YAML `persona:` field
 * matches (see {@link resolveSuitePath}) so the catalog and the run path agree on what is
 * runnable. Throws {@link PersonaEvalSuiteError} listing every problem — a suite that
 * half-parses must never run, because missing assertions weaken the gate silently.
 * @param personaId - Persona name (normally also the suite file name without extension).
 * @param dir - Optional suite directory override.
 * @returns The validated suite.
 */
export function loadPersonaEvalSuite(personaId: string, dir?: string): PersonaEvalSuite {
  const suiteDir = resolveSuiteDir(dir);
  const path = resolveSuitePath(personaId, suiteDir);
  const doc = yaml.load(readFileSync(path, 'utf8'));
  const suite = coerceSuite(doc);
  const problems = validateSuite(suite);
  if (problems.length > 0) throw new PersonaEvalSuiteError(path, problems);
  logger.info({ personaId, path, tasks: suite.tasks.length }, 'Loaded persona-eval suite');
  return suite;
}

/**
 * @description Resolves a persona id to its suite file. Filename match wins
 * (`<personaId>.yaml`/`.yml`); when absent, the directory is scanned for a file whose YAML
 * `persona:` field equals the id — the catalog (listPersonaEvalSuites) keys on that field, so
 * without this fallback a suite whose filename differs from its persona field would be listed
 * as runnable yet never run. Exactly-one match is required; two files declaring the same
 * persona is an authoring error and throws naming both.
 * @param personaId - Requested persona/suite id.
 * @param suiteDir - Absolute suite directory.
 * @returns Absolute path to the suite file.
 */
function resolveSuitePath(personaId: string, suiteDir: string): string {
  const candidates = [join(suiteDir, `${personaId}.yaml`), join(suiteDir, `${personaId}.yml`)];
  const direct = candidates.find((p) => existsSync(p));
  if (direct) return direct;
  let files: string[] = [];
  try {
    files = readdirSync(suiteDir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml')).sort();
  } catch (err) {
    logger.error({ err, suiteDir }, 'persona-eval suite directory is not readable');
    throw new PersonaEvalSuiteError(candidates[0], [`suite directory not readable: ${suiteDir}`]);
  }
  const matches: string[] = [];
  for (const file of files) {
    try {
      const doc = yaml.load(readFileSync(join(suiteDir, file), 'utf8'));
      const persona = doc && typeof doc === 'object' ? String((doc as Record<string, unknown>).persona ?? '') : '';
      if (persona === personaId) matches.push(file);
    } catch (err) {
      // Unparseable files are already surfaced as broken entries by listPersonaEvalSuites.
      logger.error({ err, file }, 'persona-eval suite file unparseable during persona-field resolution');
    }
  }
  if (matches.length === 1) return join(suiteDir, matches[0]);
  if (matches.length > 1) {
    throw new PersonaEvalSuiteError(candidates[0], [
      `persona '${personaId}' is declared by multiple suite files (${matches.join(', ')}) — rename so exactly one file owns it`,
    ]);
  }
  throw new PersonaEvalSuiteError(candidates[0], [
    `suite file not found (looked for ${candidates.join(', ')}, then for a suite whose \`persona:\` field is '${personaId}')`,
  ]);
}

/** Shapes the raw YAML document into the suite type (types verified by validateSuite). */
function coerceSuite(doc: unknown): PersonaEvalSuite {
  const d = (doc && typeof doc === 'object' ? doc : {}) as Record<string, unknown>;
  const rawTasks = Array.isArray(d.tasks) ? d.tasks : [];
  return {
    persona: String(d.persona ?? ''),
    description: typeof d.description === 'string' ? d.description : undefined,
    tasks: rawTasks.map((t) => coerceTask(t)),
  };
}

/** Shapes one raw task entry. */
function coerceTask(raw: unknown): EvalTask {
  const t = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const rawAssertions = Array.isArray(t.assertions) ? t.assertions : [];
  return {
    id: String(t.id ?? ''),
    title: typeof t.title === 'string' ? t.title : undefined,
    prompt: String(t.prompt ?? ''),
    fixture: t.fixture,
    assertions: rawAssertions.map((a) => (a && typeof a === 'object' ? a : {}) as EvalAssertion),
  };
}

/**
 * @description Validates a whole suite: persona set, tasks present with unique ids, prompts
 * non-empty, and every assertion well-formed per {@link validateAssertion}. Exported for unit
 * tests over authoring-mistake coverage.
 * @param suite - The coerced suite.
 * @returns Every problem found (empty = valid).
 */
export function validateSuite(suite: PersonaEvalSuite): string[] {
  const problems: string[] = [];
  if (!suite.persona.trim()) problems.push('suite is missing `persona` (the persona YAML name in ai-lab/bot-personas)');
  if (suite.tasks.length === 0) problems.push('suite has no tasks');
  const seenTaskIds = new Set<string>();
  for (const task of suite.tasks) {
    const where = task.id ? `task '${task.id}'` : 'task (missing id)';
    if (!task.id.trim()) problems.push('a task is missing an id');
    else if (seenTaskIds.has(task.id)) problems.push(`duplicate task id '${task.id}'`);
    seenTaskIds.add(task.id);
    if (!task.prompt.trim()) problems.push(`${where}: prompt is empty`);
    if (task.assertions.length === 0) problems.push(`${where}: has no assertions`);
    const seenAssertionIds = new Set<string>();
    for (const a of task.assertions) {
      if (a.id && seenAssertionIds.has(a.id)) problems.push(`${where}: duplicate assertion id '${a.id}'`);
      if (a.id) seenAssertionIds.add(a.id);
      problems.push(...validateAssertion(a).map((p) => `${where}: ${p}`));
    }
  }
  return problems;
}
