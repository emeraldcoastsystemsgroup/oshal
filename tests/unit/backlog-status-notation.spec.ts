/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The guard for the backlog status notation. Three things that would otherwise rot silently: the generated counts header must match what the Status lines derive (a typed number is the anti-drift defect this repo already has a rule about), every entry must carry exactly one Status line from the closed vocabulary (a misspelled status is an entry that vanishes from the counts), and the generator must be byte-stable so running it twice changes nothing. The vocabulary and the parser are tested on fixtures too, so a regression in the script is caught here rather than by the operator noticing the header is wrong.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const status = require(join(process.cwd(), 'scripts', 'backlog-status.js')) as {
  parse(text: string): { preamble: string; entries: Array<{ heading: string; body: string[] }> };
  readStatus(body: string[]): { status: string; note: string; index: number } | null;
  seedStatuses(entries: Array<{ heading: string; body: string[] }>, triage: Array<{ title: string; verdict: string }>): number;
  renderBlock(entries: Array<{ heading: string; body: string[] }>, closed: Array<{ date: string; title: string; pr: string }>): string;
  build(): { current: string; next: string; seeded: number; total: number };
  STATUSES: Record<string, string>;
};

const BACKLOG = readFileSync(join(process.cwd(), 'docs', 'BACKLOG.md'), 'utf8');

describe('docs/BACKLOG.md status notation', () => {
  it('the committed file is exactly what the generator derives — header and every status line', () => {
    const { current, next, seeded } = status.build();
    expect(seeded, 'entries with no Status line — run node scripts/backlog-status.js').toBe(0);
    expect(next === current, 'the generated header has drifted from the entries — run node scripts/backlog-status.js').toBe(true);
  });

  it('every entry carries exactly one Status line, from the vocabulary, as its first bullet', () => {
    const { entries } = status.parse(BACKLOG);
    expect(entries.length).toBeGreaterThan(100);
    const bad: string[] = [];
    for (const e of entries) {
      const s = status.readStatus(e.body);
      if (!s) { bad.push(`${e.heading}: no Status line`); continue; }
      if (!(s.status in status.STATUSES)) bad.push(`${e.heading}: "${s.status}" is not in the vocabulary`);
      const firstBullet = e.body.findIndex((l) => l.startsWith('- '));
      if (firstBullet !== s.index) bad.push(`${e.heading}: Status is not the first bullet`);
      const count = e.body.filter((l) => /^- \*\*Status:\*\*/.test(l)).length;
      if (count !== 1) bad.push(`${e.heading}: ${count} Status lines`);
    }
    expect(bad).toEqual([]);
  });

  it('the header counts sum to the number of entries', () => {
    const block = BACKLOG.slice(BACKLOG.indexOf('<!-- BEGIN GENERATED: backlog-status -->'), BACKLOG.indexOf('<!-- END GENERATED: backlog-status -->'));
    const total = Number(/\*\*(\d+) entries open\.\*\*/.exec(block)?.[1]);
    const rows = [...block.matchAll(/^\| (?:IN PROGRESS|OPEN — [^|]+) \| \*\*(\d+)\*\* \|/gm)].map((m) => Number(m[1]));
    expect(rows.length).toBe(Object.keys(status.STATUSES).length);
    expect(rows.reduce((a, b) => a + b, 0)).toBe(total);
    expect(total).toBe(status.parse(BACKLOG).entries.length);
  });

  it('seeding is idempotent and honours a status a human already set', () => {
    const entries = status.parse([
      '# x', '', '## S',
      '### One', '- **Status:** IN PROGRESS · agent on it', '- **Done when:** y',
      '### Two', '- **Done when:** z',
    ].join('\n')).entries;
    expect(status.seedStatuses(entries, [{ title: 'Two', verdict: 'operator' }])).toBe(1);
    expect(status.readStatus(entries[0].body)?.status).toBe('IN PROGRESS');
    expect(status.readStatus(entries[0].body)?.note).toBe('agent on it');
    expect(status.readStatus(entries[1].body)?.status).toBe('OPEN — needs operator');
    expect(status.seedStatuses(entries, [])).toBe(0);
  });

  it('an entry the triage never saw is seeded untriaged, not silently actionable', () => {
    const entries = status.parse('### Brand new\n- **Done when:** q').entries;
    status.seedStatuses(entries, []);
    expect(status.readStatus(entries[0].body)?.status).toBe('OPEN — untriaged');
  });

  it('a status outside the vocabulary is named in the header rather than dropped from the counts', () => {
    const entries = status.parse('### Odd\n- **Status:** DONE-ISH\n- **Done when:** q').entries;
    const block = status.renderBlock(entries, []);
    expect(block).toContain('outside the vocabulary');
    expect(block).toContain('Odd');
  });
});
