/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — minimal GitHub Actions ${{ }} expression evaluator for gha-local: context lookups (env/github/secrets/vars/needs/steps/matrix/runner), literals, ==/!=/&&/||/!, parentheses, hashFiles()/success()/failure()/always()/cancelled(). Covers every form the repo's real workflows use; unknown constructs surface as a recorded warning, never a silent wrong value.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** The contexts an expression can read. All optional — a missing context resolves to undefined. */
export interface ExprContexts {
  env?: Record<string, string>;
  secrets?: Record<string, string>;
  vars?: Record<string, string>;
  github?: Record<string, string>;
  runner?: Record<string, string>;
  /** workflow_dispatch inputs — declared defaults overlaid with caller-supplied values. */
  inputs?: Record<string, string>;
  matrix?: Record<string, string | number | boolean>;
  needs?: Record<string, { outputs: Record<string, string>; result?: string }>;
  steps?: Record<string, { outputs: Record<string, string>; outcome?: string }>;
  /** Job status so far — drives success()/failure(). */
  jobStatus?: 'success' | 'failure';
  /** Directory hashFiles() resolves patterns against (default cwd). */
  workspace?: string;
}

type Value = string | number | boolean | null | undefined;

/** Collected while evaluating — unknown functions/contexts are recorded, not silently nulled. */
export interface ExprWarnings { warnings: string[]; }

const TOKEN_RE = /\s*('(?:[^']|'')*'|[0-9]+(?:\.[0-9]+)?|[A-Za-z_][A-Za-z0-9_.-]*|==|!=|&&|\|\||[!()])/y;

function tokenize(src: string): string[] {
  const out: string[] = [];
  let pos = 0;
  while (pos < src.length) {
    TOKEN_RE.lastIndex = pos;
    const m = TOKEN_RE.exec(src);
    if (!m) {
      if (src.slice(pos).trim() === '') break;
      throw new Error(`unparseable expression at "${src.slice(pos, pos + 20)}"`);
    }
    out.push(m[1]);
    pos = TOKEN_RE.lastIndex;
  }
  return out;
}

/** GitHub Actions truthiness: false/null/''/0 are falsy; everything else truthy. */
export function truthy(v: Value): boolean {
  if (v === false || v === null || v === undefined) return false;
  if (v === '' || v === 0) return false;
  return true;
}

/** Loose equality the way GHA compares (string-coerced unless both are the same primitive type). */
function looseEq(a: Value, b: Value): boolean {
  if (typeof a === typeof b) return a === b;
  return String(a ?? '') === String(b ?? '');
}

/** sha256 over the (sorted) contents of literal file paths; a minimal subset of GHA's hashFiles. */
function hashFiles(workspace: string, patterns: string[], warn: (m: string) => void): string {
  const files: string[] = [];
  for (const p of patterns) {
    if (p.includes('*')) { warn(`hashFiles: glob "${p}" not supported locally — treated as no match`); continue; }
    const full = path.resolve(workspace, p);
    if (fs.existsSync(full) && fs.statSync(full).isFile()) files.push(full);
  }
  if (files.length === 0) return '';
  const h = createHash('sha256');
  for (const f of files.sort()) h.update(fs.readFileSync(f));
  return h.digest('hex');
}

/** Recursive-descent parser/evaluator over the token list. Grammar: or → and → unary → primary. */
class Evaluator {
  private i = 0;
  constructor(
    private readonly toks: string[],
    private readonly ctx: ExprContexts,
    private readonly warn: (m: string) => void,
  ) {}

  private peek(): string | undefined { return this.toks[this.i]; }
  private next(): string | undefined { return this.toks[this.i++]; }

  evaluate(): Value {
    const v = this.parseOr();
    if (this.i < this.toks.length) this.warn(`trailing tokens ignored: ${this.toks.slice(this.i).join(' ')}`);
    return v;
  }

  private parseOr(): Value {
    let left = this.parseAnd();
    while (this.peek() === '||') { this.next(); const right = this.parseAnd(); left = truthy(left) ? left : right; }
    return left;
  }

  private parseAnd(): Value {
    let left = this.parseEq();
    while (this.peek() === '&&') { this.next(); const right = this.parseEq(); left = truthy(left) ? right : left; }
    return left;
  }

  private parseEq(): Value {
    let left = this.parseUnary();
    for (;;) {
      const op = this.peek();
      if (op !== '==' && op !== '!=') return left;
      this.next();
      const right = this.parseUnary();
      left = op === '==' ? looseEq(left, right) : !looseEq(left, right);
    }
  }

  private parseUnary(): Value {
    if (this.peek() === '!') { this.next(); return !truthy(this.parseUnary()); }
    return this.parsePrimary();
  }

  private parsePrimary(): Value {
    const t = this.next();
    if (t === undefined) { this.warn('unexpected end of expression'); return undefined; }
    if (t === '(') { const v = this.parseOr(); if (this.next() !== ')') this.warn('missing )'); return v; }
    if (t.startsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
    if (/^[0-9]/.test(t)) return Number(t);
    if (t === 'true') return true;
    if (t === 'false') return false;
    if (t === 'null') return null;
    if (this.peek() === '(') return this.callFunction(t);
    return this.lookup(t);
  }

  /** Function calls: hashFiles('a','b'), success(), failure(), always(), cancelled(). */
  private callFunction(name: string): Value {
    this.next(); // consume (
    const args: Value[] = [];
    while (this.peek() !== ')' && this.peek() !== undefined) args.push(this.parseOr());
    this.next(); // consume )
    const fn = name.toLowerCase();
    if (fn === 'hashfiles') return hashFiles(this.ctx.workspace ?? process.cwd(), args.map(String), this.warn);
    if (fn === 'always') return true;
    if (fn === 'cancelled') return false;
    if (fn === 'success') return (this.ctx.jobStatus ?? 'success') === 'success';
    if (fn === 'failure') return (this.ctx.jobStatus ?? 'success') === 'failure';
    this.warn(`unknown function ${name}() — evaluated as empty`);
    return '';
  }

  /** Dotted context lookup: github.ref, needs.job.outputs.x, matrix.node, env.FOO. */
  private lookup(pathExpr: string): Value {
    const [root, ...rest] = pathExpr.split('.');
    const roots: Record<string, unknown> = {
      env: this.ctx.env, secrets: this.ctx.secrets, vars: this.ctx.vars,
      github: this.ctx.github, runner: this.ctx.runner, matrix: this.ctx.matrix,
      needs: this.ctx.needs, steps: this.ctx.steps, inputs: this.ctx.inputs,
    };
    if (!(root in roots)) { this.warn(`unknown context "${root}" in ${pathExpr} — evaluated as empty`); return ''; }
    let cur: unknown = roots[root];
    for (const seg of rest) {
      if (cur === null || typeof cur !== 'object') return undefined;
      cur = (cur as Record<string, unknown>)[seg];
    }
    return cur as Value;
  }
}

/**
 * @description Evaluates one bare GHA expression (the inside of `${{ }}`, or an `if:` condition,
 * which GHA treats as an expression even without the braces).
 * @param src - the expression source
 * @param ctx - available contexts
 * @param warnings - sink for non-fatal evaluation warnings
 * @returns the evaluated value
 */
export function evalExpr(src: string, ctx: ExprContexts, warnings: ExprWarnings): Value {
  const inner = src.trim().replace(/^\$\{\{\s*/, '').replace(/\s*\}\}$/, '');
  try {
    return new Evaluator(tokenize(inner), ctx, (m) => warnings.warnings.push(m)).evaluate();
  } catch (err) {
    warnings.warnings.push(`expression "${inner}": ${err instanceof Error ? err.message : String(err)}`);
    return '';
  }
}

/**
 * @description Interpolates every `${{ … }}` occurrence in a string. Non-string passthrough.
 * Expressions matching `defer` (e.g. `steps.` / `needs.` references, whose values only exist
 * mid-run) are left verbatim for a later interpolation pass with live contexts.
 * @param text - the raw string (a run command, an env value, a with: value)
 * @param ctx - available contexts
 * @param warnings - sink for non-fatal warnings
 * @param defer - expressions matching this pattern are left un-replaced
 * @returns the string with each (non-deferred) expression replaced by its stringified value
 */
export function interpolate(text: string, ctx: ExprContexts, warnings: ExprWarnings, defer?: RegExp): string {
  return text.replace(/\$\{\{([^}]*)\}\}/g, (whole: string, inner: string) => {
    if (defer && defer.test(inner)) return whole;
    const v = evalExpr(inner, ctx, warnings);
    return v === undefined || v === null ? '' : String(v);
  });
}

/** The standard defer pattern: contexts whose values only exist while the job runs. */
export const RUNTIME_CONTEXTS = /\b(steps|needs)\s*\./;
