/**
 * News-materiality reader contract — the NOISE FILTER for the event-pop goal ("cut to the real
 * insight news": a new partnership, a supply-route closure, a jobs miss, a Fed surprise).
 *
 * Two stages, per the sweep-#5 post-mortem (keyword-regex scoring is DEAD; the surviving path is
 * an LLM READER on a pre-filtered stream):
 *   1. `prefilterHeadline` — deterministic structural noise gate (the shared sweep-#5 exclusions
 *      plus the classes measured worthless: bare big-dollar-figure stories, estimate/preview
 *      chatter, price-action commentary). Cheap, testable, cuts the wire before any tokens burn.
 *   2. `buildReaderPrompt` / `parseReaderVerdicts` — the strict-JSON contract for the LLM reader
 *      that judges MATERIALITY on the survivors. This module owns the contract; the caller owns
 *      the model invocation (gate study: claude CLI headless; future live leg: a bot node).
 *
 * Pure functions, no I/O — same discipline as the analyst-actions classifier.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — stage-1 prefilter (shared noise gate + big-dollar/estimate/commentary drops), reader prompt with the materiality rules from the 07-10/07-12 evidence, fenced-JSON verdict parser with id reconciliation.
 *
 * @module news-materiality
 */

import { isRealNewsHeadline } from '@/shared/utils/headline-noise';

/** The event classes the reader may assign (his examples map directly: partnership, contract,
 *  approval, macro-rate/jobs, geopolitical-supply). */
export type MaterialClass =
  | 'partnership' | 'contract' | 'ma' | 'approval' | 'guidance' | 'product'
  | 'legal' | 'analyst' | 'macro-rate' | 'macro-jobs' | 'geopolitical-supply' | 'other';

/** One reader verdict for one headline id. */
export interface ReaderVerdict {
  id: number;
  material: boolean;
  cls: MaterialClass;
  dir: 'up' | 'down' | 'unclear';
  conf: number; // 0..1
  sym: string | null;
}

/**
 * @description Stage-1 deterministic keep/drop for the reader stream — the shared real-news gate
 * (@/shared/utils/headline-noise), which the world-data ingest also uses to strain its sentiment
 * series. Everything kept goes to the reader; the READER, not a regex, judges materiality (the
 * regex approach to MATERIALITY is dead — sweep #5). The regexes here only remove what the
 * evidence proved is NEVER material.
 * @param headline - Raw wire headline.
 * @returns True to KEEP (send to the reader), false to drop.
 */
export function prefilterHeadline(headline: string): boolean {
  return isRealNewsHeadline(headline);
}

/**
 * @description Builds the strict-JSON reader prompt for a batch of headlines. The rules encode
 * the evidence: a headline is material ONLY if it itself reports a NEW concrete fact that should
 * move the named company meaningfully TODAY; dollar size alone is noise; previews/commentary are
 * noise; macro surprises classify with market-wide scope.
 * @param items - The batch (id + headline + wire-tagged symbols).
 * @returns The prompt string (the caller pipes it to the model).
 */
export function buildReaderPrompt(items: Array<{ id: number; headline: string; symbols: string[] }>): string {
  return [
    'You are a deterministic news-materiality judge for intraday equity trading. For EACH numbered',
    'headline decide: does the headline itself report a NEW, CONCRETE fact that should move the',
    'primary named company\'s stock noticeably (roughly 2%+) TODAY?',
    '',
    'Material classes: partnership, contract (major win/loss), ma (acquisition target/merger),',
    'approval (regulatory/FDA), guidance (raised/cut/warning), product (major launch/failure),',
    'legal (verdict/settlement/probe), analyst (rating/PT action), macro-rate (central-bank',
    'surprise), macro-jobs (employment surprise), geopolitical-supply (supply-route/commodity',
    'shock), other.',
    'NOT material: commentary, previews, recaps, listicles, price-action stories, routine filings,',
    'conference appearances, a big dollar figure with no new decision or outcome, old news restated.',
    'dir: "up"/"down" for the PRIMARY symbol\'s expected move; "unclear" if genuinely ambiguous.',
    'conf: 0..1 (your confidence in material+dir). sym: the primary ticker from the provided list.',
    '',
    'Answer with EXACTLY one fenced json block, an array with ONE object PER id, no prose:',
    '```json',
    '[{"id":1,"material":true,"cls":"partnership","dir":"up","conf":0.8,"sym":"NVDA"}]',
    '```',
    '',
    'HEADLINES:',
    ...items.map((it) => `${it.id}. [${it.symbols.join(',') || '—'}] ${it.headline.replace(/\s+/g, ' ').slice(0, 220)}`),
  ].join('\n');
}

const CLASSES = new Set<MaterialClass>(['partnership', 'contract', 'ma', 'approval', 'guidance', 'product', 'legal', 'analyst', 'macro-rate', 'macro-jobs', 'geopolitical-supply', 'other']);

/**
 * @description Parses the reader's fenced-JSON reply into validated verdicts, reconciled against
 * the ids that were asked. Malformed rows and unknown ids are dropped (never guessed).
 * @param raw - The model's raw text reply.
 * @param expectedIds - The ids that were in the batch.
 * @returns id → verdict for every well-formed row.
 */
export function parseReaderVerdicts(raw: string, expectedIds: Set<number>): Map<number, ReaderVerdict> {
  const out = new Map<number, ReaderVerdict>();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(String(raw || ''));
  const body = (fenced ? fenced[1] : raw || '').trim();
  let arr: unknown;
  try { arr = JSON.parse(body); } catch {
    const m = /\[[\s\S]*\]/.exec(body);
    if (!m) return out;
    try { arr = JSON.parse(m[0]); } catch { return out; }
  }
  if (!Array.isArray(arr)) return out;
  for (const r of arr) {
    const o = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
    const id = Number(o.id);
    if (!expectedIds.has(id) || out.has(id)) continue;
    const cls = CLASSES.has(o.cls as MaterialClass) ? (o.cls as MaterialClass) : 'other';
    const dir = o.dir === 'up' || o.dir === 'down' ? o.dir : 'unclear';
    const conf = Math.max(0, Math.min(1, Number(o.conf) || 0));
    const sym = typeof o.sym === 'string' && /^[A-Z.]{1,6}$/.test(o.sym.toUpperCase()) ? o.sym.toUpperCase() : null;
    out.set(id, { id, material: o.material === true, cls, dir, conf, sym });
  }
  return out;
}
