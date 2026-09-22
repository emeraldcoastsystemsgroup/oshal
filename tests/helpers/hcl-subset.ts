/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — a reader for the HCL native syntax deploy/terraform is written in, and an evaluator for the expressions its chart values use, so a unit guard can compute what the module hands helm_release WITHOUT a terraform binary, a provider download or a cluster. The tokenizer knows strings (escapes and ${} templates), heredocs and all three comment forms, so a brace inside any of them is text, never structure; the parser builds real blocks, attributes and expressions instead of matching lines. The evaluator covers literals, objects, tuples, var.* references (defaults and optional() type defaults taken from variables.tf), merge(), conditionals and ==/!=/&&/||/!, and THROWS on anything else: a module change it cannot follow fails the guard loudly instead of being guessed at.
 */

/** A parsed HCL expression. `src` is the exact source text, for failure messages. */
export type HclExpr =
  | { kind: 'literal'; value: string | number | boolean | null; src: string }
  | { kind: 'template'; src: string }
  | { kind: 'traversal'; root: string; path: Array<string | number>; src: string }
  | { kind: 'call'; name: string; args: HclExpr[]; src: string }
  | { kind: 'object'; items: Array<{ key: HclExpr; value: HclExpr }>; src: string }
  | { kind: 'tuple'; items: HclExpr[]; src: string }
  | { kind: 'conditional'; cond: HclExpr; then: HclExpr; else: HclExpr; src: string }
  | { kind: 'binary'; op: string; left: HclExpr; right: HclExpr; src: string }
  | { kind: 'unary'; op: string; operand: HclExpr; src: string }
  | { kind: 'opaque'; src: string };

/** A block body: its attributes by name and its nested blocks in order. */
export interface HclBody {
  attributes: Map<string, HclExpr>;
  blocks: HclBlock[];
}

/** One block, e.g. `resource "helm_release" "oshal" { … }`. */
export interface HclBlock {
  type: string;
  labels: string[];
  body: HclBody;
}

interface Token {
  type: 'ident' | 'number' | 'string' | 'heredoc' | 'punct' | 'newline' | 'eof';
  text: string;
  value?: string;
  interp?: boolean;
  start: number;
  end: number;
}

const PUNCT = ['...', '=>', '==', '!=', '<=', '>=', '&&', '||', '{', '}', '[', ']', '(', ')', '=', ',', '.', ':', '?', '!', '<', '>', '+', '-', '*', '/', '%'];
const BINARY = [['||'], ['&&'], ['==', '!='], ['<', '>', '<=', '>='], ['+', '-'], ['*', '/', '%']];
const IDENT = /[A-Za-z_][A-Za-z0-9_-]*/y;
const NUMBER = /[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?/y;
const ESCAPES: Record<string, string> = { n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' };

/**
 * @description Line:column of an offset, so a parse failure names where it happened.
 * @param src source text
 * @param at offset
 * @returns {string} "line:col"
 */
function where(src: string, at: number): string {
  const before = src.slice(0, at).split('\n');
  return `${before.length}:${before[before.length - 1].length + 1}`;
}

/**
 * @description Skip a `${ … }` / `%{ … }` template sequence, including nested strings and braces.
 * @param src source text
 * @param i offset just after the opening brace
 * @returns {number} offset just after the matching closing brace
 */
function skipTemplate(src: string, i: number): number {
  let depth = 1;
  while (i < src.length) {
    const c = src[i];
    if (c === '"') { i = readString(src, i).end; continue; }
    if (c === '{') depth += 1;
    if (c === '}' && --depth === 0) return i + 1;
    i += 1;
  }
  throw new Error(`unterminated template sequence before ${where(src, i)}`);
}

/**
 * @description Read one quoted string. `value` is the unescaped text; `interp` is true when it
 * holds a template sequence (its value is then not a constant).
 * @param src source text
 * @param start offset of the opening quote
 * @returns {Token} the string token
 */
function readString(src: string, start: number): Token {
  let i = start + 1;
  let value = '';
  let interp = false;
  while (i < src.length) {
    const c = src[i];
    const pair = src.slice(i, i + 3);
    if (c === '"') return { type: 'string', text: src.slice(start, i + 1), value, interp, start, end: i + 1 };
    if (c === '\n') break;
    if (c === '\\') {
      const e = src[i + 1];
      const hex = e === 'u' ? 4 : e === 'U' ? 8 : 0;
      value += hex ? String.fromCodePoint(parseInt(src.slice(i + 2, i + 2 + hex), 16)) : (ESCAPES[e] ?? e);
      i += 2 + hex;
    } else if (pair === '$${' || pair === '%%{') {
      value += pair.slice(1);
      i += 3;
    } else if ((c === '$' || c === '%') && src[i + 1] === '{') {
      interp = true;
      i = skipTemplate(src, i + 2);
    } else {
      value += c;
      i += 1;
    }
  }
  throw new Error(`unterminated string at ${where(src, start)}`);
}

/**
 * @description Read a heredoc (`<<EOF` or `<<-EOF`) up to its closing marker line.
 * @param src source text
 * @param start offset of `<<`
 * @returns {Token} a heredoc token ending at the end of the marker line
 */
function readHeredoc(src: string, start: number): Token {
  const head = /<<-?([A-Za-z_][A-Za-z0-9_]*)\r?\n/y;
  head.lastIndex = start;
  const m = head.exec(src);
  if (!m) throw new Error(`malformed heredoc at ${where(src, start)}`);
  let lineStart = head.lastIndex;
  while (lineStart < src.length) {
    const nl = src.indexOf('\n', lineStart);
    const lineEnd = nl < 0 ? src.length : nl;
    if (src.slice(lineStart, lineEnd).trim() === m[1]) {
      return { type: 'heredoc', text: src.slice(start, lineEnd), start, end: lineEnd };
    }
    lineStart = lineEnd + 1;
  }
  throw new Error(`heredoc ${m[1]} at ${where(src, start)} is never closed`);
}

/**
 * @description Match a sticky regex at an offset.
 * @param re sticky regex
 * @param src source text
 * @param i offset
 * @returns {string | null} the matched text
 */
function stickyAt(re: RegExp, src: string, i: number): string | null {
  re.lastIndex = i;
  return re.exec(src)?.[0] ?? null;
}

/**
 * @description Split HCL source into tokens. Comments vanish (a line comment leaves its newline,
 * which HCL treats as significant); strings and heredocs are single tokens.
 * @param src source text
 * @returns {Token[]} tokens, ending with one `eof`
 */
function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const two = src.slice(i, i + 2);
    let tok: Token | null = null;
    if (c === ' ' || c === '\t' || c === '\r') { i += 1; continue; }
    if (c === '#' || two === '//') { const nl = src.indexOf('\n', i); i = nl < 0 ? src.length : nl; continue; }
    if (two === '/*') {
      const close = src.indexOf('*/', i + 2);
      if (close < 0) throw new Error(`unterminated comment at ${where(src, i)}`);
      i = close + 2;
      continue;
    }
    if (c === '\n') tok = { type: 'newline', text: c, start: i, end: i + 1 };
    else if (c === '"') tok = readString(src, i);
    else if (two === '<<' && /<<-?[A-Za-z_]/y.test(src.slice(i, i + 4))) tok = readHeredoc(src, i);
    else {
      const word = stickyAt(IDENT, src, i);
      const num = word ? null : stickyAt(NUMBER, src, i);
      const punct = word || num ? undefined : PUNCT.find((p) => src.startsWith(p, i));
      const text = word ?? num ?? punct;
      if (!text) throw new Error(`unexpected character ${JSON.stringify(c)} at ${where(src, i)}`);
      tok = { type: word ? 'ident' : num ? 'number' : 'punct', text, start: i, end: i + text.length };
    }
    out.push(tok);
    i = tok.end;
  }
  out.push({ type: 'eof', text: '', start: src.length, end: src.length });
  return out;
}

/** Recursive-descent parser over the token stream. */
class Parser {
  private pos = 0;
  private lastEnd = 0;
  /** Top of stack true = newlines are insignificant here (inside () and []). */
  private readonly newlineFree: boolean[] = [false];

  constructor(private readonly toks: Token[], private readonly src: string) {}

  /** @description Parse a whole file. @returns {HclBody} the root body */
  parseFile(): HclBody {
    const body = this.parseBody(true);
    this.expectType('eof');
    return body;
  }

  private cur(): Token {
    if (this.newlineFree[this.newlineFree.length - 1]) this.skipNewlines();
    return this.toks[this.pos];
  }

  private skipNewlines(): void {
    while (this.toks[this.pos].type === 'newline') this.pos += 1;
  }

  private next(): Token {
    const t = this.cur();
    this.pos += 1;
    this.lastEnd = t.end;
    return t;
  }

  private isPunct(text: string): boolean {
    const t = this.cur();
    return t.type === 'punct' && t.text === text;
  }

  private fail(t: Token, what: string): never {
    throw new Error(`HCL parse: ${what} at ${where(this.src, t.start)} (found ${JSON.stringify(t.text)})`);
  }

  private expect(text: string): Token {
    if (!this.isPunct(text)) this.fail(this.cur(), `expected "${text}"`);
    return this.next();
  }

  private expectType(type: Token['type']): Token {
    if (this.cur().type !== type) this.fail(this.cur(), `expected ${type}`);
    return this.next();
  }

  private within<T>(newlineFree: boolean, fn: () => T): T {
    this.newlineFree.push(newlineFree);
    try { return fn(); } finally { this.newlineFree.pop(); }
  }

  private srcFrom(start: number): string {
    return this.src.slice(start, this.lastEnd);
  }

  private parseBody(atRoot: boolean): HclBody {
    const body: HclBody = { attributes: new Map(), blocks: [] };
    return this.within(false, () => {
      for (;;) {
        this.skipNewlines();
        const t = this.cur();
        if (atRoot ? t.type === 'eof' : this.isPunct('}')) return body;
        if (t.type !== 'ident') this.fail(t, 'expected an attribute or a block');
        const after = this.toks[this.pos + 1];
        if (after.type === 'punct' && after.text === '=') {
          if (body.attributes.has(t.text)) this.fail(t, `duplicate attribute "${t.text}"`);
          this.pos += 2;
          body.attributes.set(t.text, this.parseExpr());
          if (!['newline', 'eof'].includes(this.cur().type) && !this.isPunct('}')) this.fail(this.cur(), 'expected end of line');
        } else {
          body.blocks.push(this.parseBlock());
        }
      }
    });
  }

  private parseBlock(): HclBlock {
    const type = this.next().text;
    const labels: string[] = [];
    while (this.cur().type === 'string' || this.cur().type === 'ident') {
      const label = this.next();
      labels.push(label.value ?? label.text);
    }
    this.expect('{');
    const body = this.parseBody(false);
    this.expect('}');
    return { type, labels, body };
  }

  /** @description expr := binary ( "?" expr ":" expr )? @returns {HclExpr} */
  parseExpr(): HclExpr {
    const start = this.cur().start;
    const cond = this.parseBinary(0);
    if (!this.isPunct('?')) return cond;
    this.next();
    const then = this.parseExpr();
    this.expect(':');
    const otherwise = this.parseExpr();
    return { kind: 'conditional', cond, then, else: otherwise, src: this.srcFrom(start) };
  }

  private parseBinary(level: number): HclExpr {
    if (level === BINARY.length) return this.parseUnary();
    const start = this.cur().start;
    let left = this.parseBinary(level + 1);
    while (this.cur().type === 'punct' && BINARY[level].includes(this.cur().text)) {
      const op = this.next().text;
      const right = this.parseBinary(level + 1);
      left = { kind: 'binary', op, left, right, src: this.srcFrom(start) };
    }
    return left;
  }

  private parseUnary(): HclExpr {
    if (!this.isPunct('!') && !this.isPunct('-')) return this.parsePostfix();
    const start = this.cur().start;
    const op = this.next().text;
    const operand = this.parseUnary();
    return { kind: 'unary', op, operand, src: this.srcFrom(start) };
  }

  private parsePostfix(): HclExpr {
    const start = this.cur().start;
    let expr = this.parsePrimary();
    for (;;) {
      if (this.isPunct('.')) {
        this.next();
        const t = this.next();
        const step = t.type === 'ident' ? t.text : t.type === 'number' ? Number(t.text) : null; // null: a .* splat
        expr = expr.kind === 'traversal' && step !== null
          ? { ...expr, path: [...expr.path, step], src: this.srcFrom(start) }
          : { kind: 'opaque', src: this.srcFrom(start) };
      } else if (this.isPunct('[')) {
        const key = this.within(true, () => { this.next(); const k = this.isPunct('*') ? (this.next(), null) : this.parseExpr(); this.expect(']'); return k; });
        const literal = key?.kind === 'literal' && (typeof key.value === 'string' || typeof key.value === 'number') ? key.value : null;
        expr = expr.kind === 'traversal' && literal !== null
          ? { ...expr, path: [...expr.path, literal], src: this.srcFrom(start) }
          : { kind: 'opaque', src: this.srcFrom(start) };
      } else {
        return expr;
      }
    }
  }

  private parsePrimary(): HclExpr {
    const t = this.cur();
    const start = t.start;
    if (t.type === 'number') { this.next(); return { kind: 'literal', value: Number(t.text), src: t.text }; }
    if (t.type === 'string') { this.next(); return t.interp ? { kind: 'template', src: t.text } : { kind: 'literal', value: t.value ?? '', src: t.text }; }
    if (t.type === 'heredoc') { this.next(); return { kind: 'template', src: t.text }; }
    if (t.type === 'ident') {
      this.next();
      if (t.text === 'true' || t.text === 'false') return { kind: 'literal', value: t.text === 'true', src: t.text };
      if (t.text === 'null') return { kind: 'literal', value: null, src: t.text };
      if (this.toks[this.pos].type === 'punct' && this.toks[this.pos].text === '(') return this.parseCall(t.text, start);
      return { kind: 'traversal', root: t.text, path: [], src: t.text };
    }
    if (this.isPunct('(')) {
      return this.within(true, () => { this.next(); const inner = this.parseExpr(); this.expect(')'); return inner; });
    }
    if (this.isPunct('{')) return this.parseObject();
    if (this.isPunct('[')) return this.parseTuple();
    return this.fail(t, 'expected an expression');
  }

  private parseCall(name: string, start: number): HclExpr {
    return this.within(true, () => {
      this.expect('(');
      const args: HclExpr[] = [];
      while (!this.isPunct(')')) {
        args.push(this.parseExpr());
        if (this.isPunct('...')) this.next();
        if (!this.isPunct(')')) this.expect(',');
      }
      this.expect(')');
      return { kind: 'call', name, args, src: this.srcFrom(start) };
    });
  }

  /** @description A `for` expression is kept whole and opaque: the evaluator never needs one. */
  private isForAfterOpen(): boolean {
    let i = this.pos + 1;
    while (this.toks[i].type === 'newline') i += 1;
    return this.toks[i].type === 'ident' && this.toks[i].text === 'for';
  }

  private skipBalanced(start: number): HclExpr {
    let depth = 0;
    do {
      const t = this.toks[this.pos];
      if (t.type === 'eof') this.fail(t, 'unbalanced brackets');
      if (t.type === 'punct' && '{[('.includes(t.text)) depth += 1;
      if (t.type === 'punct' && '}])'.includes(t.text)) depth -= 1;
      this.pos += 1;
      this.lastEnd = t.end;
    } while (depth > 0);
    return { kind: 'opaque', src: this.srcFrom(start) };
  }

  private parseObject(): HclExpr {
    const start = this.cur().start;
    if (this.isForAfterOpen()) return this.skipBalanced(start);
    return this.within(false, () => {
      this.next();
      const items: Array<{ key: HclExpr; value: HclExpr }> = [];
      for (;;) {
        this.skipNewlines();
        if (this.isPunct('}')) break;
        const t = this.cur();
        const after = this.toks[this.pos + 1];
        const bare = t.type === 'ident' && after.type === 'punct' && (after.text === '=' || after.text === ':');
        const key: HclExpr = bare ? (this.next(), { kind: 'literal', value: t.text, src: t.text }) : this.parseExpr();
        if (!this.isPunct('=')) this.expect(':'); else this.next();
        items.push({ key, value: this.parseExpr() });
        if (this.isPunct(',')) this.next();
        else if (this.cur().type !== 'newline' && !this.isPunct('}')) this.fail(this.cur(), 'expected "," or a newline between object items');
      }
      this.expect('}');
      return { kind: 'object', items, src: this.srcFrom(start) };
    });
  }

  private parseTuple(): HclExpr {
    const start = this.cur().start;
    if (this.isForAfterOpen()) return this.skipBalanced(start);
    return this.within(true, () => {
      this.next();
      const items: HclExpr[] = [];
      while (!this.isPunct(']')) {
        items.push(this.parseExpr());
        if (!this.isPunct(']')) this.expect(',');
      }
      this.expect(']');
      return { kind: 'tuple', items, src: this.srcFrom(start) };
    });
  }
}

/**
 * @description Parse HCL native syntax into blocks, attributes and expressions.
 * @param src file contents
 * @returns {HclBody} the file's root body
 */
export function parseHcl(src: string): HclBody {
  return new Parser(tokenize(src), src).parseFile();
}

/**
 * @description Every block of a type (and leading labels) across one or more bodies.
 * @param bodies parsed files
 * @param type block type, e.g. "resource"
 * @param labels leading labels to match, e.g. ["helm_release", "oshal"]
 * @returns {HclBlock[]} the matching blocks, in file order
 */
export function blocksOf(bodies: HclBody[], type: string, ...labels: string[]): HclBlock[] {
  return bodies.flatMap((b) => b.blocks).filter((b) => b.type === type && labels.every((l, i) => b.labels[i] === l));
}

/** Plain-object check used by merge() and attribute access. */
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * @description Evaluate an expression. Supports literals, objects, tuples, `var.*` references,
 * merge(), conditionals and ==, !=, &&, ||, !. Anything else throws, naming the expression, so a
 * construct the guard cannot follow is a loud failure rather than a guessed value.
 * @param expr parsed expression
 * @param variables input variable values by name (a name absent here is an error, as in Terraform)
 * @returns {unknown} the value
 */
export function evaluate(expr: HclExpr, variables: Record<string, unknown>): unknown {
  const ev = (e: HclExpr) => evaluate(e, variables);
  switch (expr.kind) {
    case 'literal': return expr.value;
    case 'tuple': return expr.items.map(ev);
    case 'object': return Object.fromEntries(expr.items.map(({ key, value }) => [String(ev(key)), ev(value)]));
    case 'traversal': return evalTraversal(expr, variables);
    case 'conditional': {
      const c = ev(expr.cond);
      if (typeof c !== 'boolean') throw new Error(`condition is not a bool: ${expr.cond.src}`);
      return c ? ev(expr.then) : ev(expr.else);
    }
    case 'unary': {
      const v = ev(expr.operand);
      if (expr.op === '!' && typeof v === 'boolean') return !v;
      if (expr.op === '-' && typeof v === 'number') return -v;
      throw new Error(`unsupported unary operand: ${expr.src}`);
    }
    case 'binary': return evalBinary(expr, variables);
    case 'call': return evalCall(expr, variables);
    default: throw new Error(`unsupported expression for evaluation: ${expr.src}`);
  }
}

function evalTraversal(expr: Extract<HclExpr, { kind: 'traversal' }>, variables: Record<string, unknown>): unknown {
  const [name, ...rest] = expr.path;
  if (expr.root !== 'var' || typeof name !== 'string') throw new Error(`unsupported reference (only var.* is evaluated): ${expr.src}`);
  if (!(name in variables)) throw new Error(`var.${name} has no value: not declared in variables.tf, or declared without a default and not supplied`);
  let v: unknown = variables[name];
  for (const step of rest) {
    if (!isObject(v) || !(String(step) in v)) throw new Error(`unsupported attribute "${step}" in ${expr.src}`);
    v = v[String(step)];
  }
  return v;
}

function evalBinary(expr: Extract<HclExpr, { kind: 'binary' }>, variables: Record<string, unknown>): unknown {
  const l = evaluate(expr.left, variables);
  const r = evaluate(expr.right, variables);
  if (expr.op === '==' || expr.op === '!=') return (JSON.stringify(l) === JSON.stringify(r)) === (expr.op === '==');
  if ((expr.op === '&&' || expr.op === '||') && typeof l === 'boolean' && typeof r === 'boolean') {
    return expr.op === '&&' ? l && r : l || r;
  }
  throw new Error(`unsupported operator for evaluation: ${expr.src}`);
}

function evalCall(expr: Extract<HclExpr, { kind: 'call' }>, variables: Record<string, unknown>): unknown {
  if (expr.name !== 'merge') throw new Error(`unsupported function for evaluation: ${expr.src}`);
  const merged: Record<string, unknown> = {};
  for (const arg of expr.args) {
    const v = evaluate(arg, variables);
    if (v === null) continue;
    if (!isObject(v)) throw new Error(`merge() argument is not an object or map: ${arg.src}`);
    Object.assign(merged, v);
  }
  return merged;
}

/**
 * @description Fill `optional(T, default)` attributes the way Terraform does when it converts a
 * value to a variable's type: an absent or null attribute takes the declared default.
 * @param type the variable's `type` expression
 * @param value the value being converted
 * @returns {unknown} the value with type defaults applied
 */
function applyTypeDefaults(type: HclExpr | undefined, value: unknown): unknown {
  if (!type || type.kind !== 'call' || value === null || value === undefined) return value;
  const [arg] = type.args;
  if ((type.name === 'list' || type.name === 'set') && Array.isArray(value)) return value.map((v) => applyTypeDefaults(arg, v));
  if (type.name === 'map' && isObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, applyTypeDefaults(arg, v)]));
  }
  if (type.name !== 'object' || !isObject(value) || arg?.kind !== 'object') return value;
  const out: Record<string, unknown> = { ...value };
  for (const { key, value: attrType } of arg.items) {
    const name = String(evaluate(key, {}));
    const optional = attrType.kind === 'call' && attrType.name === 'optional' ? attrType : null;
    if (optional && (out[name] === undefined || out[name] === null)) {
      out[name] = optional.args[1] ? evaluate(optional.args[1], {}) : null;
    }
    out[name] = applyTypeDefaults(optional ? optional.args[0] : attrType, out[name]);
  }
  return out;
}

/**
 * @description The value every `variable` block resolves to, as Terraform would resolve it for a
 * plan with the given inputs: the input when supplied (a null input to a `nullable = false`
 * variable takes the default), otherwise the default; optional() type defaults applied to both.
 * A variable with neither is left out, so referencing it throws.
 * @param bodies parsed module files
 * @param inputs input values by variable name (the -var / tfvars equivalent)
 * @returns {Record<string, unknown>} resolved values by name
 */
export function resolveVariables(bodies: HclBody[], inputs: Record<string, unknown> = {}): Record<string, unknown> {
  const declared = blocksOf(bodies, 'variable');
  const unknown = Object.keys(inputs).filter((name) => !declared.some((b) => b.labels[0] === name));
  if (unknown.length) throw new Error(`inputs name undeclared variables: ${unknown.join(', ')}`);
  const resolved: Record<string, unknown> = {};
  for (const block of declared) {
    const [name] = block.labels;
    const attrs = block.body.attributes;
    const nonNullable = attrs.get('nullable')?.kind === 'literal' && (attrs.get('nullable') as { value: unknown }).value === false;
    const supplied = name in inputs && !(inputs[name] === null && nonNullable);
    const def = attrs.get('default');
    if (!supplied && !def) continue;
    const raw = supplied ? inputs[name] : evaluate(def as HclExpr, {});
    resolved[name] = applyTypeDefaults(attrs.get('type'), raw);
  }
  return resolved;
}
