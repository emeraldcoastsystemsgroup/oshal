/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Structural assertion engine for persona regression evals. Pure, mechanically-checkable evaluators (substring/regex/JSON shape/citation/artifact/size) with per-assertion evidence in every result, plus load-time validation so a mistyped assertion fails the suite load instead of running as a vacuous always-pass.
 */

import { existsSync } from 'fs';
import { resolve, sep } from 'path';
import type { AssertionResult, EvalAssertion } from '../types';

/** Default citation pattern: a doc_id provenance marker as required by the RAG citation rule. */
const DEFAULT_CITATION_PATTERN = /doc_id\s*[:=]?\s*["'`]?[\w.:/-]+/i;

/**
 * @description Context handed to the structural evaluator. `workspaceDir` is only present in
 * lanes that captured a real workspace (e.g. a CLI run pointed at a ticket workspace); without
 * it, `artifact-exists` assertions are SKIPPED with a notice rather than failed or faked —
 * the lane genuinely cannot observe artifacts, and the report must say so.
 */
export interface StructuralEvalContext {
  /** Directory holding the run's artifacts, when the lane captured one. */
  workspaceDir?: string;
}

/**
 * @description Validates one assertion's parameter shape for its declared type/tier. Called by
 * the suite loader so an authoring mistake (missing pattern, semantic type under structural
 * tier) is a load-time error — a malformed assertion must never run as a silent no-op check.
 * @param a - The assertion as parsed from YAML.
 * @returns A list of human-readable problems; empty when the assertion is well-formed.
 */
export function validateAssertion(a: EvalAssertion): string[] {
  const problems: string[] = [];
  if (!a.id || !a.id.trim()) problems.push('assertion is missing an id');
  const where = a.id ? `assertion '${a.id}'` : 'assertion';
  if (a.tier !== 'structural' && a.tier !== 'semantic') {
    problems.push(`${where}: tier must be 'structural' or 'semantic' (got '${String(a.tier)}')`);
    return problems;
  }
  if (a.tier === 'semantic') {
    if (a.type !== 'rubric') problems.push(`${where}: semantic tier only supports type 'rubric' (got '${a.type}')`);
    if (!a.rubric || !a.rubric.trim()) problems.push(`${where}: rubric text is required for semantic assertions`);
    if (a.minScore !== undefined && (typeof a.minScore !== 'number' || a.minScore < 0 || a.minScore > 100)) {
      problems.push(`${where}: minScore must be a number 0-100`);
    }
    return problems;
  }
  switch (a.type) {
    case 'contains': case 'not-contains':
      if (!a.value || !String(a.value).trim()) problems.push(`${where}: '${a.type}' requires a non-empty 'value'`);
      break;
    case 'regex': case 'not-regex':
      problems.push(...validatePattern(a, where));
      break;
    case 'json-keys':
      if (!Array.isArray(a.keys) || a.keys.length === 0) problems.push(`${where}: 'json-keys' requires a non-empty 'keys' array`);
      break;
    case 'artifact-exists':
      if (!a.path || !a.path.trim()) problems.push(`${where}: 'artifact-exists' requires a 'path'`);
      break;
    case 'max-lines':
      if (typeof a.max !== 'number' || a.max < 1) problems.push(`${where}: 'max-lines' requires a positive 'max'`);
      break;
    case 'min-words':
      if (typeof a.min !== 'number' || a.min < 1) problems.push(`${where}: 'min-words' requires a positive 'min'`);
      break;
    case 'json-parses': case 'citation-block':
      break; // no required params (citation-block may override `pattern`, validated below)
    default:
      problems.push(`${where}: unknown structural type '${String(a.type)}'`);
  }
  if (a.type === 'citation-block' && a.pattern) problems.push(...validatePattern(a, where));
  return problems;
}

/** Compiles the assertion's pattern to surface bad regexes at load time. */
function validatePattern(a: EvalAssertion, where: string): string[] {
  if (!a.pattern || !a.pattern.trim()) return [`${where}: '${a.type}' requires a non-empty 'pattern'`];
  try {
    void new RegExp(a.pattern, a.flags);
    return [];
  } catch (err) {
    return [`${where}: pattern does not compile: ${err instanceof Error ? err.message : String(err)}`];
  }
}

/**
 * @description Evaluates one STRUCTURAL assertion against the persona's raw output. Pure and
 * deterministic — this is the tier that runs identically in every lane, including noop. Every
 * result carries evidence (`detail`) so a red report is reviewable without a re-run.
 * @param a - The (already-validated) structural assertion.
 * @param output - The persona's raw output text for the task.
 * @param ctx - Evaluation context (workspace dir for artifact checks).
 * @returns The assertion outcome with evidence.
 */
export function evaluateStructuralAssertion(
  a: EvalAssertion,
  output: string,
  ctx: StructuralEvalContext = {},
): AssertionResult {
  const base = { id: a.id, tier: a.tier, type: a.type };
  try {
    const outcome = dispatchStructural(a, output, ctx);
    return { ...base, ...outcome };
  } catch (err) {
    // An evaluator crash is an ERROR, never a pass — surfaced per-assertion.
    return { ...base, status: 'error', detail: `evaluator threw: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Routes a structural assertion to its evaluator. */
function dispatchStructural(
  a: EvalAssertion,
  output: string,
  ctx: StructuralEvalContext,
): Pick<AssertionResult, 'status' | 'detail'> {
  switch (a.type) {
    case 'contains': return evalContains(a, output, true);
    case 'not-contains': return evalContains(a, output, false);
    case 'regex': return evalRegex(a, output, true);
    case 'not-regex': return evalRegex(a, output, false);
    case 'json-parses': return evalJsonParses(output);
    case 'json-keys': return evalJsonKeys(a, output);
    case 'citation-block': return evalCitationBlock(a, output);
    case 'artifact-exists': return evalArtifactExists(a, ctx);
    case 'max-lines': return evalMaxLines(a, output);
    case 'min-words': return evalMinWords(a, output);
    default:
      return { status: 'error', detail: `unknown structural assertion type '${String(a.type)}'` };
  }
}

/** Substring presence/absence; case-insensitive by default. */
function evalContains(a: EvalAssertion, output: string, wantPresent: boolean): Pick<AssertionResult, 'status' | 'detail'> {
  const ci = a.caseInsensitive !== false;
  const haystack = ci ? output.toLowerCase() : output;
  const needle = ci ? String(a.value).toLowerCase() : String(a.value);
  const present = haystack.includes(needle);
  if (present === wantPresent) {
    return { status: 'pass', detail: wantPresent ? `output contains "${a.value}"` : `output correctly omits "${a.value}"` };
  }
  return { status: 'fail', detail: wantPresent ? `output is missing "${a.value}"` : `output must NOT contain "${a.value}" but does` };
}

/** Regex match/absence. */
function evalRegex(a: EvalAssertion, output: string, wantMatch: boolean): Pick<AssertionResult, 'status' | 'detail'> {
  const re = new RegExp(String(a.pattern), a.flags);
  const m = output.match(re);
  if (Boolean(m) === wantMatch) {
    return {
      status: 'pass',
      detail: wantMatch ? `matched /${a.pattern}/${a.flags ?? ''}: "${truncate(m?.[0] ?? '', 120)}"` : `no match for /${a.pattern}/${a.flags ?? ''} (as required)`,
    };
  }
  return {
    status: 'fail',
    detail: wantMatch
      ? `no match for /${a.pattern}/${a.flags ?? ''}`
      : `output must NOT match /${a.pattern}/${a.flags ?? ''} but matched "${truncate(m?.[0] ?? '', 120)}"`,
  };
}

/** JSON document present + parseable. */
function evalJsonParses(output: string): Pick<AssertionResult, 'status' | 'detail'> {
  const parsed = extractFirstJson(output);
  if (parsed !== undefined) {
    const kind = Array.isArray(parsed) ? `array[${parsed.length}]` : typeof parsed;
    return { status: 'pass', detail: `output contains parseable JSON (${kind})` };
  }
  return { status: 'fail', detail: 'no parseable JSON document found in the output' };
}

/** JSON present AND every required key exists (on the object, or on every array element). */
function evalJsonKeys(a: EvalAssertion, output: string): Pick<AssertionResult, 'status' | 'detail'> {
  const parsed = extractFirstJson(output);
  if (parsed === undefined) return { status: 'fail', detail: 'no parseable JSON document found in the output' };
  const keys = a.keys ?? [];
  const targets: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  if (targets.length === 0) return { status: 'fail', detail: 'JSON array is empty — no elements to carry the required keys' };
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    if (t === null || typeof t !== 'object' || Array.isArray(t)) {
      return { status: 'fail', detail: `JSON element ${i} is not an object — cannot carry keys [${keys.join(', ')}]` };
    }
    const missing = keys.filter((k) => !(k in (t as Record<string, unknown>)));
    if (missing.length > 0) return { status: 'fail', detail: `JSON element ${i} is missing key(s): ${missing.join(', ')}` };
  }
  return { status: 'pass', detail: `JSON carries required key(s) [${keys.join(', ')}] on ${targets.length} object(s)` };
}

/** A doc_id citation marker is present (provenance rule for RAG-grounded personas). */
function evalCitationBlock(a: EvalAssertion, output: string): Pick<AssertionResult, 'status' | 'detail'> {
  const re = a.pattern ? new RegExp(a.pattern, a.flags) : DEFAULT_CITATION_PATTERN;
  const m = output.match(re);
  if (m) return { status: 'pass', detail: `citation present: "${truncate(m[0], 120)}"` };
  return { status: 'fail', detail: `no citation block found (expected ${a.pattern ? `/${a.pattern}/` : 'a doc_id marker'})` };
}

/**
 * Artifact presence under the captured workspace. Lanes without a workspace SKIP with a notice
 * (the lane cannot observe files); a traversal outside the workspace is an error, never a probe.
 */
function evalArtifactExists(a: EvalAssertion, ctx: StructuralEvalContext): Pick<AssertionResult, 'status' | 'detail'> {
  if (!ctx.workspaceDir) {
    return { status: 'skipped', detail: `artifact check '${a.path}' skipped: this lane captured no workspace directory (run the CLI with --workspace to evaluate artifacts)` };
  }
  const root = resolve(ctx.workspaceDir);
  const target = resolve(root, String(a.path));
  if (target !== root && !target.startsWith(root + sep)) {
    return { status: 'error', detail: `artifact path '${a.path}' escapes the workspace directory — refusing to check` };
  }
  if (existsSync(target)) return { status: 'pass', detail: `artifact exists: ${a.path}` };
  return { status: 'fail', detail: `artifact missing: ${a.path} (looked in ${root})` };
}

/** Bounded output length (non-empty lines). */
function evalMaxLines(a: EvalAssertion, output: string): Pick<AssertionResult, 'status' | 'detail'> {
  const lines = output.split(/\r?\n/).filter((l) => l.trim().length > 0).length;
  if (lines <= Number(a.max)) return { status: 'pass', detail: `${lines} non-empty line(s) <= max ${a.max}` };
  return { status: 'fail', detail: `${lines} non-empty line(s) exceeds max ${a.max}` };
}

/** Minimum substance (word count). */
function evalMinWords(a: EvalAssertion, output: string): Pick<AssertionResult, 'status' | 'detail'> {
  const words = output.split(/\s+/).filter((w) => w.length > 0).length;
  if (words >= Number(a.min)) return { status: 'pass', detail: `${words} word(s) >= min ${a.min}` };
  return { status: 'fail', detail: `${words} word(s) below min ${a.min}` };
}

/**
 * @description Extracts the first parseable JSON document from free-form model output. Tries,
 * in order: the whole trimmed text, fenced ```json blocks, then the widest brace/bracket span.
 * Returns `undefined` (not null — null is a valid JSON value) when nothing parses. Exported for
 * unit tests and for suite authors reasoning about what `json-parses` accepts.
 * @param text - Raw model output.
 * @returns The parsed JSON value, or `undefined` when no candidate parses.
 */
export function extractFirstJson(text: string): unknown {
  const candidates: string[] = [];
  const trimmed = text.trim();
  if (trimmed) candidates.push(trimmed);
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) candidates.push(fence[1].trim());
  for (const open of ['{', '[']) {
    const close = open === '{' ? '}' : ']';
    const start = text.indexOf(open);
    const end = text.lastIndexOf(close);
    if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));
  }
  for (const c of candidates) {
    try {
      return JSON.parse(c) as unknown;
    } catch {
      /* try the next candidate */
    }
  }
  return undefined;
}

/** Bounded excerpt for evidence strings. */
function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
