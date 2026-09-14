/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | BUG-10 guard: the ADR index and the ADR files must agree. Every decision record has an index row and every row resolves; a row that says Superseded is matched by the file's own status; an ADR carrying a "Superseded By" section, or named in another ADR's "Supersedes" section, says so in its status. ADR-016 read Accepted for months while ADR-017 and the index both called it superseded, and ADR-142/143 were never indexed.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ADR_DIR = join(__dirname, '..', '..', 'docs', 'adr');
const INDEX = readFileSync(join(ADR_DIR, 'README.md'), 'utf8');
const ADR_FILES = readdirSync(ADR_DIR).filter((f) => /^\d{3}.*\.md$/.test(f)).sort();

/** One index row: the file it links and its Status cell (second-to-last column, so a title may hold a pipe). */
interface IndexRow { file: string; status: string }

/**
 * @description Reads the index table rows that link an ADR file.
 * @param index - The docs/adr/README.md source.
 * @returns One entry per row.
 */
function indexRows(index: string): IndexRow[] {
  return index.split(/\r?\n/).flatMap((line) => {
    const link = /^\|\s*\[[^\]]+\]\((\d{3}[^)]*\.md)\)/.exec(line);
    if (!link) return [];
    const cells = line.split('|').map((c) => c.trim());
    return [{ file: link[1], status: cells[cells.length - 3] ?? '' }];
  });
}

/** A new metadata line (`**Date:**`, `- Date:`, `**Extends:**`) ends an inline status. */
const METADATA_KEY = /^\s*(?:[-*]\s*)?(?:\*\*)?[A-Z][\w /-]{1,40}(?:\*\*)?\s*:/;

/**
 * @description The ADR's own status: the body of a `## Status` heading, or else the first
 * `Status:` line and its continuation lines. ADRs use both shapes.
 * @param text - The ADR source.
 * @returns The status text, or '' when the ADR has none.
 */
function statusBlock(text: string): string {
  const lines = text.split(/\r?\n/);
  const heading = lines.findIndex((l) => /^#{2,3}\s+Status\b/i.test(l));
  if (heading >= 0) {
    const out: string[] = [];
    for (const l of lines.slice(heading + 1)) {
      if (/^#{1,3}\s/.test(l)) break;
      out.push(l);
    }
    return out.join('\n');
  }
  const inline = lines.findIndex((l) => /^\s*(?:[-*]\s*)?(?:\*\*)?Status(?:\*\*)?\s*:/i.test(l));
  if (inline < 0) return '';
  const out = [lines[inline]];
  for (const l of lines.slice(inline + 1)) {
    if (!l.trim() || /^#/.test(l) || METADATA_KEY.test(l)) break;
    out.push(l);
  }
  return out.join('\n');
}

/**
 * @description The body of a named `##` section, up to the next heading of the same or higher level.
 * @param text - The ADR source.
 * @param title - Heading text, matched case-insensitively and exactly.
 * @returns The section body, or null when the ADR has no such section.
 */
function section(text: string, title: string): string | null {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^##\\s+${title}\\s*$`, 'i').test(l));
  if (start < 0) return null;
  const out: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (/^#{1,2}\s/.test(l)) break;
    out.push(l);
  }
  return out.join('\n');
}

const read = (file: string): string => readFileSync(join(ADR_DIR, file), 'utf8');
const saysSuperseded = (status: string): boolean => /supersed/i.test(status);

describe('ADR index and ADR files agree (BUG-10)', () => {
  const rows = indexRows(INDEX);

  it('every decision record has an index row, and every row resolves to a file', () => {
    const indexed = new Set(rows.map((r) => r.file));
    expect(ADR_FILES.filter((f) => !indexed.has(f))).toEqual([]);
    expect([...indexed].filter((f) => !ADR_FILES.includes(f))).toEqual([]);
  });

  it('the index is one table — a blank line between rows ends it, and the rows after render as text', () => {
    const lines = INDEX.split(/\r?\n/);
    const rowAt = lines.flatMap((l, i) => (/^\|\s*\[/.test(l) ? [i] : []));
    const gaps = lines
      .slice(rowAt[0], rowAt[rowAt.length - 1] + 1)
      .flatMap((l, k) => (l.trim() ? [] : [`README.md:${rowAt[0] + k + 1}`]));
    expect(gaps).toEqual([]);
  });

  it('a row the index marks Superseded is marked superseded in the file as well', () => {
    const disagree = rows
      .filter((r) => /^\**superseded/i.test(r.status) && ADR_FILES.includes(r.file))
      .filter((r) => !saysSuperseded(statusBlock(read(r.file))))
      .map((r) => r.file);
    expect(disagree).toEqual([]);
  });

  it('a file whose status says Superseded is marked superseded in the index as well', () => {
    const byFile = new Map(rows.map((r) => [r.file, r.status]));
    const disagree = ADR_FILES
      .filter((f) => /^[\s*-]*(?:status\s*:?\s*)?[\s*]*superseded/i.test(statusBlock(read(f)).trim()))
      .filter((f) => !saysSuperseded(byFile.get(f) ?? ''));
    expect(disagree).toEqual([]);
  });

  it('an ADR with a "Superseded By" section says so in its status', () => {
    const silent = ADR_FILES
      .filter((f) => section(read(f), 'Superseded By') !== null)
      .filter((f) => !saysSuperseded(statusBlock(read(f))));
    expect(silent).toEqual([]);
  });

  it('an ADR named in another ADR\'s "Supersedes" section says so in its status', () => {
    const byNumber = new Map<string, string[]>();
    for (const f of ADR_FILES) {
      const list = byNumber.get(f.slice(0, 3)) ?? [];
      list.push(f);
      byNumber.set(f.slice(0, 3), list);
    }
    const unstamped: string[] = [];
    for (const f of ADR_FILES) {
      const body = section(read(f), 'Supersedes');
      if (!body) continue;
      for (const [, n] of body.matchAll(/ADR[- ](\d{3})\b/g)) {
        for (const target of byNumber.get(n) ?? []) {
          if (!saysSuperseded(statusBlock(read(target)))) unstamped.push(`${target} (named by ${f})`);
        }
      }
    }
    expect(unstamped).toEqual([]);
  });

  it('an ADR that another ADR\'s status says it supersedes says so in its own status', () => {
    const unstamped: string[] = [];
    for (const f of ADR_FILES) {
      const claim = /\bsupersedes\b([^.]*)/i.exec(statusBlock(read(f)));
      if (!claim) continue;
      for (const [, n] of claim[1].matchAll(/ADR[- ](\d{3})\b/g)) {
        for (const target of ADR_FILES.filter((t) => t.startsWith(n))) {
          if (!saysSuperseded(statusBlock(read(target)))) unstamped.push(`${target} (named by ${f})`);
        }
      }
    }
    expect(unstamped).toEqual([]);
  });

  it('reads both status shapes the ADRs use, so the checks above are not vacuous', () => {
    expect(statusBlock('# ADR\n\n## Status\nAccepted\n\n## Context\nx')).toContain('Accepted');
    expect(statusBlock('# ADR\n**Status:** Superseded by ADR-9\n**Date:** 1')).toContain('Superseded');
    expect(statusBlock('# ADR\n- **Status:** Accepted\n- **Date:** 1')).not.toContain('Date');
    expect(statusBlock('# ADR\n**Status:** Accepted\n**Date:** 1')).not.toContain('Date');
    expect(indexRows('| [016](016-x.md) | A | B | Superseded by 017 | 2026-01-01 |')[0].status).toBe('Superseded by 017');
  });
});
