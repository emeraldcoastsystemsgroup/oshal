/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | BACKLOG P6 guard: the incident-RCA cost head-to-head ($1.30 vs $4.05) was published on nine surfaces as a bare number. This module holds the rule that the number never travels alone — its n in the same sentence/table row, its limits in the same block — and renders the per-ticket-type census table from the generated artifact so the published table cannot be hand-typed.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Review of #623: the n was tested once per SEGMENT, so a bare "$1.30" passed whenever "$4.05 (n=7 …)" sat in the same sentence. The n is now required per FIGURE — in the span from that figure up to the next one, or the text before it when it is the first — and the census artifact must tie to the ledger it was read from (totals.costUsd == ledger.costUsd), so a join that charges one task to several tickets cannot publish an inflated total again.
 */

/**
 * Cost-claim honesty checker.
 *
 *   node scripts/cost-claim-check.js          # exit 4 when a published cost figure is unqualified
 *
 * Two rules, both from the BACKLOG "Benchmark and cost claims are still un-earned" entry:
 *
 *   1. Every FIGURE (`$1.30` or `$4.05`) states the n behind it in its own span of the segment
 *      (a sentence, or a markdown table row) — the text from that figure up to the next figure,
 *      plus whatever precedes the first one — and the block around it states the limits. The
 *      figures are a SINGLE-workload persona-iteration measurement; without the n a reader takes
 *      them for a benchmark, which is exactly what the entry says they are not. Per figure, not
 *      per segment: "$1.30 against a $4.05 (n=7)" leaves the $1.30 bare and is a failure.
 *   2. The multi-ticket-type census published in docs/business/cost-per-ticket-type.md is
 *      rendered from docs/business/cost-per-ticket-type.json, not hand-typed — the same
 *      "counts are generated" discipline BUG-9 imposed on the doc counts.
 *
 * Deliberately NOT an allowlist of files: the surfaces are DISCOVERED by scanning the tracked
 * documentation, persona and manifest trees for the figures, so a tenth surface that quotes the
 * number without its n goes red the day it is written.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');

/** Roots whose tracked text files can publish the claim (docs, personas, manifests, the site). */
const SURFACE_ROOTS = ['README.md', 'ROADMAP.md', 'docs', 'ai-lab/bot-personas', 'swarm-apps', 'site'];
/** Text extensions worth scanning inside those roots. */
const SURFACE_EXT = /\.(md|py|ya?ml|html|js|ts)$/;

/** The two figures the entry names. Written as `$1.30`, `~$1.30`, `**$1.30**`, `$1.30/RCA`. */
const FIGURE = /\$(?:1\.30|4\.05)(?![0-9])/;
/** Every occurrence, for the per-figure split. */
const EVERY_FIGURE = new RegExp(FIGURE.source, 'g');
/** The n that has to travel with the figure: `n=1`, `n = 7`, `n=7 historical incident tickets`. */
const N_MARKER = /\bn\s*=\s*\d+/i;
/**
 * The limits vocabulary. One of these must appear in the same block as the figure, because
 * "$1.30 (n=1)" is still read as a benchmark unless the reader is told it is one workload on
 * one corpus. Kept deliberately small so the phrase is a real statement, not a keyword.
 */
const LIMIT_MARKERS = [
  'one workload',
  'one corpus',
  'one model',
  'not a benchmark',
  'small-n',
  'single run',
];

/** The generated census artifact and the page that publishes it. */
const CENSUS_JSON = 'docs/business/cost-per-ticket-type.json';
const CENSUS_DOC = 'docs/business/cost-per-ticket-type.md';
const TABLE_START = '<!-- CENSUS:START -->';
const TABLE_END = '<!-- CENSUS:END -->';

/**
 * @description Lists the tracked text files that could publish the cost claim.
 * @param {string} [repo] - Repository root; defaults to this checkout.
 * @returns {string[]} Repo-relative paths, sorted by git's own ordering.
 * @throws Error when `git ls-files` cannot run — a silent empty list would make this gate vacuous.
 */
function surfaceFiles(repo = REPO) {
  const result = spawnSync('git', ['ls-files', '-z', ...SURFACE_ROOTS], { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`cost-claim-check: git ls-files failed: ${result.stderr || result.status}`);
  const files = result.stdout.split('\0').filter((file) => file && SURFACE_EXT.test(file));
  if (files.length === 0) throw new Error('cost-claim-check: no surface files found — the scan would pass vacuously');
  return files;
}

/** A markdown block whose lines are table rows or list items is read one line at a time. */
const ROWWISE_LINE = /^\s*(\||[-*+]\s|\d+\.\s)/;

/**
 * @description Splits one file into the segments the n has to appear in. A markdown table row or
 * list item is its own segment; running prose is joined across soft line wraps and split into
 * sentences; anything else (persona YAML, a deck generator) is read line by line, because those
 * wrap by hand and a joined sentence would let a neighbouring line supply the n.
 * @param {string} file - Repo-relative path, used only to pick the splitting mode.
 * @param {string} text - File contents.
 * @returns {Array<{block: string, text: string, line: number}>} Segments with their block and 1-based line.
 */
function claimSegments(file, text) {
  const segments = [];
  let line = 1;
  for (const block of text.split(/\r?\n[ \t]*\r?\n/)) {
    const lines = block.split(/\r?\n/);
    const rowwise = !file.endsWith('.md') || lines.some((entry) => ROWWISE_LINE.test(entry));
    if (rowwise) {
      lines.forEach((entry, index) => segments.push({ block, text: entry, line: line + index }));
    } else {
      for (const sentence of lines.join(' ').split(/(?<=[.!?])\s+/)) segments.push({ block, text: sentence, line });
    }
    // The separator consumed by split() is one blank line plus the newline that ended the block.
    line += lines.length + 1;
  }
  return segments;
}

/**
 * @description Splits one segment into one span per figure it states. A figure owns the text
 * from itself up to the next figure; the first figure also owns whatever precedes it, so a row
 * such as `median of n=7 tickets | $4.05` still carries its n. Testing the n per span is what
 * stops a bare `$1.30` borrowing the n of a `$4.05 (n=7)` later in the same sentence.
 * @param {string} text - One segment.
 * @returns {Array<{figure: string, text: string}>} The figure each span states and the span itself.
 */
function figureSpans(text) {
  const starts = [...text.matchAll(EVERY_FIGURE)].map((match) => ({ figure: match[0], at: match.index }));
  return starts.map((entry, index) => ({
    figure: entry.figure,
    text: text.slice(index === 0 ? 0 : entry.at, index + 1 < starts.length ? starts[index + 1].at : text.length),
  }));
}

/**
 * @description Every published cost figure that travels without its n or without its limits.
 * @param {(file: string) => string} [readFile] - Reads a repo-relative file; defaults to disk.
 * @param {string[]} [files] - Surfaces to scan; defaults to the discovered tracked set.
 * @returns {string[]} Failure messages naming file, line and what is missing; empty when clean.
 */
function claimErrors(readFile = (file) => fs.readFileSync(path.join(REPO, file), 'utf8'), files = surfaceFiles()) {
  const errors = [];
  for (const file of files) {
    const text = readFile(file);
    if (!FIGURE.test(text)) continue;
    for (const segment of claimSegments(file, text)) {
      if (!FIGURE.test(segment.text)) continue;
      for (const span of figureSpans(segment.text)) {
        if (!N_MARKER.test(span.text)) {
          errors.push(`${file}:${segment.line} states ${span.figure} with no n in the same segment attached to that figure: ${segment.text.trim().slice(0, 120)}`);
        }
      }
      if (!LIMIT_MARKERS.some((marker) => segment.block.toLowerCase().includes(marker))) {
        errors.push(`${file}:${segment.line} states a cost figure whose block carries none of the limits [${LIMIT_MARKERS.join(', ')}]`);
      }
    }
  }
  return errors;
}

/**
 * @description Renders the per-ticket-type census as the exact markdown table the page publishes.
 * @param {object} census - The parsed census artifact.
 * @returns {string} A markdown table, no trailing newline.
 */
function renderCensusTable(census) {
  const rows = census.ticketTypes.map((entry) => [
    `\`${entry.ticketType}\``,
    `n=${entry.tickets}`,
    `$${entry.medianCostUsd.toFixed(4)}`,
    `$${entry.minCostUsd.toFixed(4)} – $${entry.maxCostUsd.toFixed(4)}`,
    String(entry.llmRequests),
    `${entry.firstSeen} → ${entry.lastSeen}`,
  ].join(' | '));
  return [
    '| ticket type | tickets with cost | median $/ticket | range | LLM calls | window |',
    '|---|--:|--:|---|--:|---|',
    ...rows.map((row) => `| ${row} |`),
  ].join('\n');
}

/** A summed census may differ from the ledger only by the per-row rounding it publishes at. */
const COST_TIE_TOLERANCE_USD = 0.01;

/**
 * @description The census total must be the ledger total. Each cost-bearing task is read once
 * from `chat_tasks`; the census splits it across the tickets it is linked to, so the sum over
 * ticket types has to come back to what the ledger holds. #623 first published $149.82 against a
 * $92.05 ledger because the join charged one task to every ticket it was linked to — this is the
 * check that would have gone red.
 * @param {object} census - Parsed census artifact.
 * @param {number} typeCount - Number of ticket types, which bounds the rounding drift on calls.
 * @returns {string[]} Failure messages; empty when the totals tie.
 */
function ledgerTieErrors(census, typeCount) {
  const errors = [];
  const ledger = census.ledger;
  const totals = census.totals;
  if (!ledger || typeof ledger.costUsd !== 'number' || typeof ledger.llmRequests !== 'number' || !(ledger.tasks >= 1)) {
    errors.push(`${CENSUS_JSON}: missing ledger {tasks, llmRequests, costUsd} — the census total cannot be shown to tie to the rows it was read from`);
    return errors;
  }
  if (!totals || typeof totals.costUsd !== 'number' || typeof totals.llmRequests !== 'number') {
    errors.push(`${CENSUS_JSON}: missing totals {costUsd, llmRequests}`);
    return errors;
  }
  if (Math.abs(totals.costUsd - ledger.costUsd) > COST_TIE_TOLERANCE_USD) {
    errors.push(`${CENSUS_JSON}: the census sums to $${totals.costUsd} but the ledger holds $${ledger.costUsd} across ${ledger.tasks} tasks — a task is being charged to more than one ticket, or dropped`);
  }
  if (Math.abs(totals.llmRequests - ledger.llmRequests) > 0.5 * typeCount) {
    errors.push(`${CENSUS_JSON}: the census counts ${totals.llmRequests} LLM calls but the ledger holds ${ledger.llmRequests}`);
  }
  return errors;
}

/**
 * @description Everything wrong with the census artifact or the page that publishes it.
 * @param {object} census - Parsed census artifact.
 * @param {string} doc - Contents of the census page.
 * @returns {string[]} Failure messages; empty when the census is real and the table is generated.
 */
function censusErrors(census, doc) {
  const errors = [];
  const types = Array.isArray(census.ticketTypes) ? census.ticketTypes : [];
  if (types.length < 2) errors.push(`${CENSUS_JSON}: the cost claim must cover more than one ticket type, found ${types.length}`);
  for (const entry of types) {
    if (!(entry.tickets >= 1)) errors.push(`${CENSUS_JSON}: ${entry.ticketType} carries no n`);
    if (typeof entry.medianCostUsd !== 'number') errors.push(`${CENSUS_JSON}: ${entry.ticketType} carries no median cost`);
  }
  for (const field of ['capturedAt', 'source', 'generator']) {
    if (!census[field]) errors.push(`${CENSUS_JSON}: missing ${field} — an undated, unsourced number is the defect this replaces`);
  }
  if (!Array.isArray(census.limits) || census.limits.length === 0) errors.push(`${CENSUS_JSON}: missing limits`);
  errors.push(...ledgerTieErrors(census, types.length));
  const start = doc.indexOf(TABLE_START);
  const end = doc.indexOf(TABLE_END);
  if (start < 0 || end < start) {
    errors.push(`${CENSUS_DOC}: missing the ${TABLE_START} / ${TABLE_END} markers — the table would be hand-typed`);
    return errors;
  }
  const published = doc.slice(start + TABLE_START.length, end).replace(/\r/g, '').trim();
  if (published !== renderCensusTable(census)) {
    errors.push(`${CENSUS_DOC}: the published census table is not what ${CENSUS_JSON} renders — regenerate with scripts/evidence/cost-per-ticket-type.ts`);
  }
  return errors;
}

/** `node scripts/cost-claim-check.js` — the CLI gate. */
function main() {
  const readFile = (file) => fs.readFileSync(path.join(REPO, file), 'utf8');
  const errors = [
    ...claimErrors(readFile),
    ...censusErrors(JSON.parse(readFile(CENSUS_JSON)), readFile(CENSUS_DOC)),
  ];
  if (errors.length) {
    console.error('[cost-claim] UNEARNED COST CLAIMS:\n' + errors.join('\n'));
    process.exit(4);
  }
  console.log(`[cost-claim] verified: every published $1.30/$4.05 carries its n and limits across ${surfaceFiles().length} scanned surfaces`);
}

module.exports = {
  CENSUS_DOC, CENSUS_JSON, FIGURE, LIMIT_MARKERS, N_MARKER, SURFACE_ROOTS, TABLE_END, TABLE_START,
  claimErrors, claimSegments, censusErrors, figureSpans, ledgerTieErrors, renderCensusTable, surfaceFiles,
};

if (require.main === module) main();
