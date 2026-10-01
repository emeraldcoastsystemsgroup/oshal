/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | One deterministic filter for text fetched from the web before it enters a model prompt (operator decision 2026-09-22: oshal takes no instruction from outside websites). Removes invisible characters, hidden HTML (comments, script/style blocks, elements hidden by attribute, class or inline style), the remaining markup, chat-role markers, chat-template and prompt-structure lookalikes, and instruction-shaped clauses aimed at a model. Text with none of those comes back byte for byte, so a call site changes nothing for ordinary text. It is a first line only: callers still put what remains inside the containment delimiter.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The two character classes are written as escape sequences. Entry 1 had put the invisible and bidi-control characters into the source raw, which nobody can review by eye and is the Trojan Source pattern; the classes match exactly the same characters.
 */

/**
 * @description The shared stripping filter for fetched web text (RSS items, API free text, page
 * text) on its way into a model prompt.
 *
 * It only REMOVES. Nothing is rewritten, reordered, decoded or added, and plain text that matches
 * none of the classes below is returned unchanged, byte for byte. That is the property every call
 * site relies on to leave its prompt identical for ordinary input. HTML entities are not decoded:
 * an encoded tag stays visible literal text rather than becoming markup.
 *
 * Limits, stated so nobody mistakes this for the boundary itself: homoglyph and full-width
 * spellings of an instruction are not detected, and instruction-shaped text is matched by a short
 * list of high-precision patterns (chosen so ordinary news phrasing passes untouched). The
 * containment delimiter (`wrapUntrustedPromptContent`) and the prompt trust contract remain the
 * boundary; this filter keeps the obvious payloads from reaching the model at all.
 */

/** What the filter removed, by class. Counts only; the removed text is never returned. */
export interface FetchedTextFindings {
  /** Zero-width, bidi, tag, variation-selector-run, soft-hyphen and control characters. */
  invisible: number;
  /** HTML comments, script/style-like blocks, and elements hidden by attribute, class or style. */
  hidden: number;
  /** Remaining HTML tags (their visible text is kept). */
  markup: number;
  /** Chat-role markers ("System:", "### Assistant:", "[user]"). */
  roleMarkers: number;
  /** Chat-template tokens and prompt-structure lookalikes (<|im_start|>, [INST], UNTRUSTED_CONTENT). */
  promptTokens: number;
  /** Instruction-shaped clauses aimed at a model ("ignore all previous instructions ..."). */
  instructions: number;
}

/** The filtered text and what was removed from it. */
export interface FetchedTextResult {
  text: string;
  findings: FetchedTextFindings;
  /** True when anything was removed. */
  changed: boolean;
}

/** Characters that render as nothing (or reorder text) and carry smuggled content. Tab, newline and
 *  carriage return stay. A single variation selector after a character stays (emoji presentation);
 *  runs of them are removed by VARIATION_RUN. */
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFEFF\uFFA0\uFFF9-\uFFFB\u{1D173}-\u{1D17A}\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu;
const VARIATION_RUN = /(?<=[\uFE00-\uFE0F])[\uFE00-\uFE0F]+/g;

/** A real tag shape (`<name ...>` / `</name>` / `<!--`), not a bare "<" in prose such as "S&P < 4000". */
const LOOKS_LIKE_HTML = /<(?:[a-zA-Z][a-zA-Z0-9:-]*(?:\s[^<>]*)?\/?>|\/[a-zA-Z][a-zA-Z0-9:-]*\s*>|!--)/;
/** Elements whose whole content never renders as article text. */
const RAW_BLOCK = /<(script|style|noscript|template|iframe|object|svg|math|head|textarea|select)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi;
const COMMENT = /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<![a-zA-Z][^>]*>/g;
const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:\s[^<>]*)?)\/?>/g;
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const INLINE = new Set(['a', 'abbr', 'b', 'bdi', 'bdo', 'cite', 'code', 'data', 'dfn', 'em', 'font', 'i', 'kbd', 'mark', 'q', 's', 'samp', 'small', 'span', 'strike', 'strong', 'sub', 'sup', 'time', 'u', 'var']);
const HIDDEN_ATTR = /(?:^|\s)(?:hidden(?:\s|=|$)|aria-hidden\s*=\s*["']?true)/i;
const HIDDEN_CLASS = /\bclass\s*=\s*["'][^"']*\b(?:hidden|sr-only|visually-hidden|screen-reader-text|d-none|invisible)\b/i;
const HIDDEN_STYLE = /(?:^|[;"'\s])(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)|font-size\s*:\s*0(?:\.0+)?(?:[a-z%]+)?\s*(?:[;"'!]|$)|opacity\s*:\s*0(?:\.0+)?\s*(?:[;"'!]|$)|color\s*:\s*transparent|(?:max-)?height\s*:\s*0(?:px)?\s*(?:[;"'!]|$)|(?:text-indent|left|top)\s*:\s*-\d{3,})/i;

/** Chat-template tokens and lookalikes of this platform's own prompt structure. */
const PROMPT_TOKENS: RegExp[] = [
  /<\|[a-zA-Z0-9_]{1,40}\|>/g,
  /\[\/?INST\]|<<\/?SYS>>/gi,
  /<\/?\s*(?:UNTRUSTED_CONTENT|untrusted-work-product|trusted-provider-records)\s*>/gi,
  /^[ \t]*#{1,6}[ \t]*(?:PROMPT TRUST CONTRACT|TRUSTED POLICY|TRUSTED CONFIGURATION|UNTRUSTED CONTENT\b[^\n]*|SERVER AUTHORITY REBIND\b[^\n]*)[ \t]*$/gim,
  /\b(?:BEGIN|END)\s+(?:OF\s+)?(?:THE\s+)?(?:SYSTEM\s+PROMPT|SYSTEM\s+MESSAGE|INSTRUCTIONS|UNTRUSTED\s+CONTENT)\b/g,
];

/** "System:", "### Assistant:", "Developer message:" at a line or sentence start (a feed's title and
 *  description are joined into one line, so a description's first word follows ". "), and "[system]"
 *  anywhere. */
const ROLE_MARKERS: RegExp[] = [
  /(?<=^|[.!?]\s{1,3})[ \t]*(?:#{1,6}[ \t]*)?(?:system|assistant|human|user|developer)(?:[ \t]+(?:prompt|message|instructions?|override|note))?[ \t]*:/gim,
  /\[(?:system|assistant|human|user|developer)\]/gi,
];

/** The qualifier that makes "ignore ... instructions" aimed at a model rather than ordinary prose. */
const STRONG_QUALIFIER = /\b(?:all|any|every|previous|prior|above|earlier|preceding|foregoing|existing|original|initial|your|system|safety|developer)\b/i;
const IGNORE_CLAUSE = /\b(?:ignore|disregard|forget|override|bypass)\s+((?:(?:all|any|every|each|the|your|my|these|those|of|previous|prior|above|earlier|preceding|foregoing|existing|original|initial|system|safety|developer)\s+){1,5})(?:instructions?|prompts?|directions?|directives?|rules|guidelines|guardrails|constraints|commands|policies|context|messages)\b/gi;
/** Model-directed clauses; each is removed from its start to the end of its sentence. */
const INSTRUCTION_CLAUSES: RegExp[] = [
  /\b(?:new|updated|revised|real|actual|hidden|secret|additional)\s+(?:system\s+)?(?:instructions?|directives?)\s*:/gi,
  /\byou\s+are\s+(?:now\s+)?(?:a|an)\s+(?:[\w-]+\s+){0,3}(?:assistant|chatbot|language\s+model|llm|ai\s+model)\b/gi,
  /(?<=^|[.!?:]\s{1,3})[ \t]*(?:please\s+)?(?:act|behave|respond)\s+(?:only\s+)?as\s+(?:if\s+you\s+(?:are|were)\s+)?(?:a|an|the)\s+(?:[\w-]+\s+){0,2}(?:assistant|chatbot|language\s+model|llm|bot)\b/gim,
  /\b(?:reveal|print|output|repeat|leak|dump|disclose)\s+(?:the|your)\s+(?:(?:full|entire|complete|original|hidden|initial|exact)\s+)*(?:system\s+prompt|instructions|api\s+keys?|credentials|passwords?)\b/gi,
  /\b(?:do\s+not|don't|never)\s+(?:tell|inform|alert|warn)\s+the\s+user\b/gi,
  /\b(?:send|forward|email|upload|exfiltrate|transmit)\s+(?:all\s+)?(?:of\s+)?(?:your|the\s+user'?s?)\s+(?:conversation|chat\s+history|credentials|api\s+keys?|tokens|passwords?|system\s+prompt)\b/gi,
  /\b(?:note|message|instructions?)\s+(?:to|for)\s+(?:the\s+|any\s+|all\s+)?(?:ai|assistant|language\s+model|llm|chatbot)s?\s*[:,]/gi,
  /\b(?:if\s+you\s+are\s+an?|to\s+(?:any|the|all))\s+(?:ai|assistant|language\s+model|llm|chatbot)s?\s+(?:reading|processing|summari[sz]ing|parsing)\b/gi,
  /\bdeveloper\s+mode\s+(?:enabled|activated)\b/gi,
];
/** How far a removal may extend to finish the sentence the clause starts. */
const SENTENCE_TAIL = /^[^.!?\n]{0,400}[.!?]?/;

const empty = (): FetchedTextFindings => ({ invisible: 0, hidden: 0, markup: 0, roleMarkers: 0, promptTokens: 0, instructions: 0 });

/** Remove every match of `re`, counting removals. */
function removeAll(text: string, re: RegExp, count: (n: number) => void): string {
  let n = 0;
  const out = text.replace(re, () => { n += 1; return ''; });
  count(n);
  return out;
}

/** True when an opening tag's attributes hide its content from a reader. */
function hidesContent(attrs: string): boolean {
  if (!attrs) return false;
  if (HIDDEN_ATTR.test(attrs) || HIDDEN_CLASS.test(attrs)) return true;
  const style = /\bstyle\s*=\s*(["'])([\s\S]*?)\1/i.exec(attrs);
  return Boolean(style && HIDDEN_STYLE.test(`;${style[2]};`));
}

/** Walk the tags left after the block pass: drop hidden subtrees, keep visible text, drop the tags. */
function stripTags(html: string, f: FetchedTextFindings): string {
  const hiddenStack: string[] = [];
  let out = '';
  let last = 0;
  for (const m of html.matchAll(TAG)) {
    const text = html.slice(last, m.index);
    if (!hiddenStack.length) out += text;
    last = (m.index ?? 0) + m[0].length;
    const [, closing, rawName, attrs] = m;
    const name = rawName.toLowerCase();
    if (closing) {
      const at = hiddenStack.lastIndexOf(name);
      if (at >= 0) hiddenStack.length = at;
      else if (!hiddenStack.length) { f.markup += 1; out += INLINE.has(name) ? '' : ' '; }
      continue;
    }
    if (hiddenStack.length) { if (!VOID.has(name)) hiddenStack.push(name); continue; }
    if (!VOID.has(name) && hidesContent(attrs)) { f.hidden += 1; hiddenStack.push(name); continue; }
    f.markup += 1;
    out += INLINE.has(name) ? '' : ' ';
  }
  return hiddenStack.length ? out : out + html.slice(last);
}

/** The HTML pass: comments and non-rendering blocks first, then hidden elements and tags. */
function stripHtml(text: string, f: FetchedTextFindings): string {
  if (!LOOKS_LIKE_HTML.test(text)) return text;
  let out = removeAll(text, COMMENT, (n) => { f.hidden += n; });
  out = removeAll(out, RAW_BLOCK, (n) => { f.hidden += n; });
  return stripTags(out, f);
}

/** Remove a model-directed clause through the end of its sentence. */
function removeClauses(text: string, re: RegExp, f: FetchedTextFindings, keep?: (m: RegExpExecArray) => boolean): string {
  let out = '';
  let from = 0;
  re.lastIndex = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (keep && keep(m)) continue;
    const start = m.index + (m[0].length - m[0].trimStart().length);
    const tail = SENTENCE_TAIL.exec(text.slice(m.index + m[0].length))?.[0] ?? '';
    out += text.slice(from, start);
    from = m.index + m[0].length + tail.length;
    re.lastIndex = from;
    f.instructions += 1;
  }
  return from === 0 ? text : out + text.slice(from);
}

/** The instruction pass. "ignore ... instructions" counts only with a model-directed qualifier. */
function stripInstructions(text: string, f: FetchedTextFindings): string {
  let out = removeClauses(text, IGNORE_CLAUSE, f, (m) => !STRONG_QUALIFIER.test(m[1] ?? ''));
  for (const re of INSTRUCTION_CLAUSES) out = removeClauses(out, re, f);
  return out;
}

/** One pass over every class. Prompt tokens run on both sides of the HTML pass because removing an
 *  inline tag can join the halves of a token ("<|im_<b></b>start|>"). */
function onePass(text: string, f: FetchedTextFindings): string {
  let out = removeAll(text, INVISIBLE, (n) => { f.invisible += n; });
  out = removeAll(out, VARIATION_RUN, (n) => { f.invisible += n; });
  for (const re of PROMPT_TOKENS) out = removeAll(out, re, (n) => { f.promptTokens += n; });
  out = stripHtml(out, f);
  for (const re of PROMPT_TOKENS) out = removeAll(out, re, (n) => { f.promptTokens += n; });
  for (const re of ROLE_MARKERS) out = removeAll(out, re, (n) => { f.roleMarkers += n; });
  return stripInstructions(out, f);
}

/** Every changing pass makes the text strictly shorter, so the loop ends; the cap is a backstop. */
const MAX_PASSES = 16;

/**
 * @description Neutralize text fetched from the web before it enters a model prompt. Passes repeat
 * until nothing more is removed, so the result is a fixed point: filtering it again changes nothing.
 * @param input - The fetched text (anything else is coerced; null/undefined become '').
 * @returns The remaining text, what was removed by class, and whether anything was.
 */
export function neutralizeFetchedText(input: unknown): FetchedTextResult {
  const f = empty();
  let text = input == null ? '' : String(input);
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const next = onePass(text, f);
    if (next === text) break;
    text = next;
  }
  return { text, findings: f, changed: Object.values(f).some((n) => n > 0) };
}

/**
 * @description Convenience for call sites that only need the text.
 * @param input - The fetched text.
 * @returns The neutralized text.
 */
export function neutralizeFetchedTextOnly(input: unknown): string {
  return neutralizeFetchedText(input).text;
}
