#!/usr/bin/env node
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Status notation for docs/BACKLOG.md, so an operator opening the file sees how many entries are open, in which state, what is being worked RIGHT NOW, and what closed recently - instead of a 3,500-line file whose size never visibly moves. Every `### ` entry gets one `- **Status:** ...` line directly under its heading, seeded from the 2026-09-15 triage ledger's verdict (title-keyed, as that ledger is) and `untriaged` for anything filed since. The counts block at the top is GENERATED from those lines - never typed, per the anti-drift rule - between markers, with a --check mode so a gate can refuse a drifted header. Closed entries are removed from the queue (the file's own rule) and recorded in the closed ledger the block also renders, so the record of WHAT closed survives the removal. Two weeks of history motivated this: 176 entries were filed and 73 closed and nobody could see either number without git archaeology.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Normalize CRLF line endings in parse() and allow optional \r in STATUS_LINE regex so Windows line endings do not break status detection or produce duplicate status lines.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BACKLOG = path.join(ROOT, 'docs', 'BACKLOG.md');
const TRIAGE = path.join(ROOT, 'docs', 'backlog', 'triage-2026-09-15.json');
const LEDGER = path.join(ROOT, 'docs', 'backlog', 'closed-ledger.json');

const BEGIN = '<!-- BEGIN GENERATED: backlog-status -->';
const END = '<!-- END GENERATED: backlog-status -->';

/** The closed vocabulary. Anything else on a Status line is a mistake the checker names. */
const STATUSES = Object.freeze({
  'IN PROGRESS': 'being worked in the current session',
  'OPEN — actionable': 'no decision, no live box needed; can be closed by an agent',
  'OPEN — needs operator': 'a decision, credential, account or purchase only the operator can make',
  'OPEN — needs live proof': 'needs the running box, a deploy, hardware, or a human at a browser',
  'OPEN — blocked': 'waiting on something outside this repo',
  'OPEN — needs review': 'the triage could not decide; somebody has to read it',
  'OPEN — untriaged': 'filed after the 2026-09-15 triage; has no verdict yet',
});

/** Triage verdict → status label. */
const VERDICT_TO_STATUS = {
  actionable: 'OPEN — actionable',
  operator: 'OPEN — needs operator',
  'live-proof': 'OPEN — needs live proof',
  blocked: 'OPEN — blocked',
  'needs-review': 'OPEN — needs review',
};

// The note separator is a middle dot, not an em dash: the vocabulary labels themselves contain
// ' — ' (OPEN — actionable), so an em-dash separator split every label in two.
const STATUS_LINE = /^- \*\*Status:\*\* (.+?)(?: · (.*))?\r?$/;

/**
 * @description Splits the backlog into its preamble and its entries, preserving text exactly.
 * @param {string} text - The whole file.
 * @returns {{ preamble: string, entries: Array<{ heading: string, body: string[] }> }} Parsed file.
 */
function parse(text) {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  const entries = [];
  let preamble = [];
  let current = null;
  for (const line of lines) {
    if (line.startsWith('### ')) {
      current = { heading: line.slice(4).trim(), body: [] };
      entries.push(current);
    } else if (current) {
      current.body.push(line);
    } else {
      preamble.push(line);
    }
  }
  return { preamble: preamble.join('\n'), entries };
}

/**
 * @description Reads the status an entry already carries, if any.
 * @param {string[]} body - The entry's lines below its heading.
 * @returns {{ status: string, note: string, index: number } | null} The parsed line or null.
 */
function readStatus(body) {
  for (let i = 0; i < body.length; i++) {
    const m = STATUS_LINE.exec(body[i]);
    if (m) return { status: m[1].trim(), note: (m[2] || '').trim(), index: i };
    if (body[i].startsWith('- ') || body[i].startsWith('## ')) break;
  }
  return null;
}

/**
 * @description Looks an entry up in the triage ledger the way that ledger is keyed: by title.
 * Titles get edited, so the match is on a prefix long enough to be unique and short enough to
 * survive a re-dated heading.
 * @param {Array<{title: string, verdict: string}>} triage - The ledger's entries.
 * @param {string} heading - This entry's heading.
 * @returns {string | null} The verdict, or null when the entry post-dates the triage.
 */
function triageVerdict(triage, heading) {
  const key = heading.slice(0, 50);
  const hit = triage.find((t) => t.title.slice(0, 50) === key);
  return hit ? hit.verdict : null;
}

/**
 * @description Ensures every entry carries exactly one Status line as its first bullet, keeping
 * any status a human already set and only seeding the missing ones.
 * @param {Array<{ heading: string, body: string[] }>} entries - Parsed entries, mutated in place.
 * @param {Array<{title: string, verdict: string}>} triage - The triage ledger.
 * @returns {number} How many entries were newly seeded.
 */
function seedStatuses(entries, triage) {
  let seeded = 0;
  for (const e of entries) {
    if (readStatus(e.body)) continue;
    const verdict = triageVerdict(triage, e.heading);
    const status = (verdict && VERDICT_TO_STATUS[verdict]) || 'OPEN — untriaged';
    e.body.unshift(`- **Status:** ${status}`);
    seeded += 1;
  }
  return seeded;
}

/**
 * @description Renders the generated block: the counts table, what is in progress, the closed
 * ledger. Derived entirely from the entries and the ledger file, never typed.
 * @param {Array<{ heading: string, body: string[] }>} entries - Parsed entries.
 * @param {Array<{ date: string, title: string, pr: string }>} closed - The closed ledger.
 * @returns {string} Markdown between the markers.
 */
function renderBlock(entries, closed) {
  const counts = new Map(Object.keys(STATUSES).map((s) => [s, 0]));
  const inProgress = [];
  const unknown = [];
  for (const e of entries) {
    const s = readStatus(e.body);
    const label = s ? s.status : 'OPEN — untriaged';
    if (!counts.has(label)) { unknown.push(`${e.heading} → "${label}"`); continue; }
    counts.set(label, counts.get(label) + 1);
    if (label === 'IN PROGRESS') inProgress.push(s && s.note ? `${e.heading} · ${s.note}` : e.heading);
  }
  const total = entries.length;
  const rows = [...counts.entries()].map(([s, n]) => `| ${s} | **${n}** | ${STATUSES[s]} |`);
  const recent = closed.slice(-15).reverse()
    .map((c) => `| ${c.date} | ${c.title} | ${c.pr ? `#${c.pr}` : ''} |`);
  return [
    BEGIN,
    '<!-- Generated by scripts/backlog-status.js from the Status lines below. Do not edit between these markers: run `node scripts/backlog-status.js`. -->',
    '',
    `**${total} entries open.** ${closed.length} closed and recorded in the ledger since it began on 2026-09-20.`,
    '',
    '| Status | Count | Meaning |',
    '|---|---|---|',
    ...rows,
    '',
    inProgress.length
      ? `**Being worked right now (${inProgress.length}):**\n${inProgress.map((t) => `- ${t}`).join('\n')}`
      : '**Being worked right now:** nothing.',
    '',
    recent.length
      ? `**Closed most recently** (full ledger: [backlog/closed-ledger.json](backlog/closed-ledger.json)):\n\n| Date | Entry | PR |\n|---|---|---|\n${recent.join('\n')}`
      : '**Closed most recently:** nothing yet.',
    ...(unknown.length ? ['', `**⚠ ${unknown.length} entr${unknown.length === 1 ? 'y carries' : 'ies carry'} a status outside the vocabulary:**`, ...unknown.map((u) => `- ${u}`)] : []),
    END,
  ].join('\n');
}

/**
 * @description Splices the generated block into the preamble, replacing an existing one or
 * inserting before the first `## ` section.
 * @param {string} preamble - Everything before the first entry.
 * @param {string} block - The rendered block.
 * @returns {string} The new preamble.
 */
function splice(preamble, block) {
  const b = preamble.indexOf(BEGIN);
  const e = preamble.indexOf(END);
  if (b !== -1 && e !== -1) return preamble.slice(0, b) + block + preamble.slice(e + END.length);
  const firstSection = preamble.indexOf('\n## ');
  if (firstSection === -1) return `${preamble.trimEnd()}\n\n${block}\n`;
  return `${preamble.slice(0, firstSection).trimEnd()}\n\n${block}\n${preamble.slice(firstSection)}`;
}

/**
 * @description Re-assembles the file from its parts, byte-stable when nothing changed.
 * @param {string} preamble - Preamble text.
 * @param {Array<{ heading: string, body: string[] }>} entries - Entries.
 * @returns {string} The whole file.
 */
function assemble(preamble, entries) {
  const parts = [preamble];
  for (const e of entries) parts.push(`### ${e.heading}\n${e.body.join('\n')}`);
  return parts.join('\n');
}

/**
 * @description Builds the up-to-date file text from what is on disk.
 * @returns {{ current: string, next: string, seeded: number, total: number }} Before/after texts and counts.
 */
function build() {
  const current = fs.readFileSync(BACKLOG, 'utf8');
  const triage = JSON.parse(fs.readFileSync(TRIAGE, 'utf8')).entries;
  const closed = fs.existsSync(LEDGER) ? JSON.parse(fs.readFileSync(LEDGER, 'utf8')) : [];
  const { preamble, entries } = parse(current);
  const seeded = seedStatuses(entries, triage);
  const next = assemble(splice(preamble, renderBlock(entries, closed)), entries);
  return { current, next, seeded, total: entries.length };
}

function main() {
  const check = process.argv.includes('--check');
  const { current, next, seeded, total } = build();
  if (next === current) {
    console.log(`backlog-status: current — ${total} entries, header derived, nothing to write`);
    return 0;
  }
  if (check) {
    console.error(`backlog-status: STALE — the header or ${seeded} unseeded status line(s) differ from what the entries derive. Run: node scripts/backlog-status.js`);
    return 1;
  }
  fs.writeFileSync(BACKLOG, next);
  console.log(`backlog-status: wrote — ${total} entries, ${seeded} newly seeded, header regenerated`);
  return 0;
}

if (require.main === module) process.exit(main());

module.exports = { parse, readStatus, seedStatuses, renderBlock, build, STATUSES, VERDICT_TO_STATUS };
