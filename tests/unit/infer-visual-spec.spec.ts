/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Cover the deterministic default
 *            | visual picker: shape detection, the text-only floor, and the fact-locked guarantee.
 */

import { describe, expect, it } from 'vitest';
import { inferVisualSpec } from '@/features/visual-response';
import { renderVisualResponse } from '@/features/visual-response';

describe('inferVisualSpec — shape detection', () => {
  it('turns a markdown table into a table spec', () => {
    const spec = inferVisualSpec({
      answer: [
        'Here are your top matches.',
        '| Role | Company | Fit |',
        '|---|---|---|',
        '| Staff AI Architect | Northwind | 94 |',
        '| Lead ML Engineer | Globex | 88 |',
      ].join('\n'),
      request: 'What are my top job matches?',
    });
    expect(spec?.kind).toBe('table');
    if (spec?.kind !== 'table') throw new Error('expected table');
    expect(spec.columns).toEqual(['Role', 'Company', 'Fit']);
    expect(spec.rows).toEqual([
      ['Staff AI Architect', 'Northwind', '94'],
      ['Lead ML Engineer', 'Globex', '88'],
    ]);
    expect(spec.title).toBe('What are my top job matches');
  });

  it('turns checkbox lines into a checklist spec', () => {
    const spec = inferVisualSpec({
      answer: ['Remaining work:', '- [x] Tailored resume', '- [ ] Two references', '- [x] Cover letter'].join('\n'),
    });
    expect(spec?.kind).toBe('checklist');
    if (spec?.kind !== 'checklist') throw new Error('expected checklist');
    expect(spec.items).toEqual([
      { label: 'Tailored resume', status: 'done' },
      { label: 'Two references', status: 'todo' },
      { label: 'Cover letter', status: 'done' },
    ]);
  });

  it('reads trailing status words as a checklist', () => {
    const spec = inferVisualSpec({
      answer: ['- Portfolio link — in progress', '- Salary band (blocked)', '- Resume: done'].join('\n'),
    });
    expect(spec?.kind).toBe('checklist');
    if (spec?.kind !== 'checklist') throw new Error('expected checklist');
    expect(spec.items.map((item) => item.status)).toEqual(['in-progress', 'blocked', 'done']);
  });

  it('turns three or more label:number lines into a chart spec', () => {
    const spec = inferVisualSpec({
      answer: ['Spend by category:', '- Groceries: 420.50', '- Fuel: 180', '- Dining: 96.25'].join('\n'),
      title: 'Spend',
    });
    expect(spec?.kind).toBe('chart');
    if (spec?.kind !== 'chart') throw new Error('expected chart');
    expect(spec.categories).toEqual(['Groceries', 'Fuel', 'Dining']);
    expect(spec.series[0].values).toEqual([420.5, 180, 96.25]);
  });

  it('handles currency and thousands separators without inventing numbers', () => {
    const spec = inferVisualSpec({
      answer: ['Mon: $1,200', 'Tue: $980.50', 'Wed: $1,450'].join('\n'),
    });
    if (spec?.kind !== 'chart') throw new Error('expected chart');
    expect(spec.series[0].values).toEqual([1200, 980.5, 1450]);
  });

  it('falls back to a summary for metrics and bullets', () => {
    const spec = inferVisualSpec({
      answer: [
        'Meetings today: 2',
        'Priority email: 2',
        '- Contract from Legal needs a signature.',
        '- Invoice #10432 is due Friday.',
        '- Portfolio review moved to Monday.',
      ].join('\n'),
    });
    expect(spec?.kind).toBe('summary');
    if (spec?.kind !== 'summary') throw new Error('expected summary');
    expect(spec.metrics).toEqual([
      { label: 'Meetings today', value: '2' },
      { label: 'Priority email', value: '2' },
    ]);
    expect(spec.bullets).toHaveLength(3);
  });
});

describe('inferVisualSpec — the text-only floor', () => {
  it.each([
    ['empty', ''],
    ['a greeting', 'Hello! How can I help today?'],
    ['plain prose', 'It is sunny out and I think you will enjoy the walk to the coffee shop.'],
    ['a single bullet', '- Only one point here.'],
    ['one metric', 'Total: 12'],
    // Bare "Label: value" prose must not masquerade as metrics just because it has a colon.
    ['prose with colons', ['Note: remember to call him back', 'Warning: the road is closed'].join('\n')],
  ])('stays text-only for %s', (_label, answer) => {
    expect(inferVisualSpec({ answer })).toBeNull();
  });

  it('does treat two data-like figures as a small summary', () => {
    const spec = inferVisualSpec({ answer: ['Mon: 1', 'Tue: 2'].join('\n') });
    expect(spec?.kind).toBe('summary');
  });
});

describe('inferVisualSpec — fact-locked guarantee', () => {
  it('every string it emits already appears in the answer', () => {
    const answer = [
      '| Role | Company |',
      '|---|---|',
      '| Staff AI Architect | Northwind |',
    ].join('\n');
    const spec = inferVisualSpec({ answer, title: 'Top matches' });
    if (spec?.kind !== 'table') throw new Error('expected table');
    for (const value of [...spec.columns, ...spec.rows.flat()]) {
      expect(answer).toContain(value);
    }
  });

  it('produces a spec the real schema accepts and the real renderer draws', () => {
    const spec = inferVisualSpec({
      answer: ['- [x] One', '- [ ] Two', '- [ ] Three'].join('\n'),
      title: 'Steps',
    });
    expect(spec).not.toBeNull();
    const rendered = renderVisualResponse({
      factLocked: true,
      sourceSurface: 'test',
      sourceSessionId: 's',
      sourceJobId: 'j',
      request: 'what is left?',
      answer: 'anything',
      visualSpec: spec!,
    });
    expect(rendered.mimeType).toBe('image/svg+xml');
    expect(rendered.content.toString('utf8')).toContain('<svg');
    expect(rendered.kind).toBe('checklist');
  });

  it('clamps an oversized table to the schema bounds rather than emitting an invalid spec', () => {
    const rows = Array.from({ length: 20 }, (_, i) => `| Row ${i} | ${i} |`);
    const spec = inferVisualSpec({
      answer: ['| Name | N |', '|---|---|', ...rows].join('\n'),
    });
    if (spec?.kind !== 'table') throw new Error('expected table');
    expect(spec.rows.length).toBeLessThanOrEqual(8);
  });

  it('ignores a table whose column count exceeds the renderer bound', () => {
    const wide = '| a | b | c | d | e | f | g |';
    const spec = inferVisualSpec({ answer: [wide, '|---|---|---|---|---|---|---|', wide].join('\n') });
    expect(spec?.kind).not.toBe('table');
  });
});
