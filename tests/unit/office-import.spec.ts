/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — the import lane's contract, proven as ROUND TRIPS against our own renderers: what renderDocx/renderXlsx/renderPptx write, office-import must read back (titles, sections, bullets, groups, tables, series numbers, quotes, notes). Plus byte-level format sniffing (bytes beat a lying filename hint), the never-throw floor on hostile input, and the full CRUD circle: import → re-render without throwing.
 */

import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { renderDocx, renderPptx, renderXlsx } from '../../src/features/presentation-generation';
import {
  importDocx, importOffice, importPptx, importXlsx,
} from '../../src/features/presentation-generation/services/office-import';

/** An outline exercising every shape the docx round trip must preserve. */
const DOCX_SECTIONS = [
  { title: 'Where we are', content: 'shipped the runtime\nsigned three design partners' },
  { title: 'Build vs buy', content: '## Build\nfull control\nour IP\n## Buy\nlive next week' },
  { title: 'By segment', content: '| Segment | Revenue |\n| --- | --- |\n| Enterprise | 4.1M |\n| Mid-market | 1.8M |' },
  { title: 'What they said', content: '> It cut our close time from days to minutes.\n— Jane Roe, CFO' },
];

/** Slides whose auto-picked pptx layouts all fill a real title placeholder. */
const PPTX_SLIDES = [
  { title: 'Where we are', content: 'shipped the runtime\nsigned three design partners', notes: 'keep it short' },
  { title: 'Build vs buy', content: '## Build\nfull control\n## Buy\nlive next week' },
  { title: 'By segment', content: '| Segment | Revenue |\n| Enterprise | 4.1M |' },
];

describe('importDocx round trip', () => {
  it('recovers title, sections, bullets, groups, tables, and quotes from our own .docx', async () => {
    const out = await importDocx(await renderDocx('Q3 Review', DOCX_SECTIONS));
    expect(out.format).toBe('docx');
    expect(out.title).toBe('Q3 Review');
    // One section per input section — the Heading1 walk found each and nothing extra.
    expect(out.sections.map((s) => s.title)).toEqual(DOCX_SECTIONS.map((s) => s.title));
    expect(out.sections[0].content).toContain('shipped the runtime');
    expect(out.sections[0].content).toContain('signed three design partners');
    expect(out.sections[1].content).toMatch(/^## Build$/m);
    expect(out.sections[1].content).toMatch(/^## Buy$/m);
    expect(out.sections[1].content).toContain('full control');
    expect(out.sections[2].content).toContain('| Segment | Revenue |');
    expect(out.sections[2].content).toContain('| Enterprise | 4.1M |');
    expect(out.sections[3].content).toMatch(/^> It cut our close time from days to minutes\./m);
    expect(out.sections[3].content).toContain('— Jane Roe, CFO');
  });
});

describe('importXlsx round trip', () => {
  it('recovers a table sheet as pipe rows and a series sheet as Label: value lines', async () => {
    const buf = await renderXlsx('Q3 Numbers', [
      { title: 'By segment', content: '| Segment | Revenue | Region |\n| Enterprise | 4.1M | NA |\n| Mid-market | 1.8M | EU |' },
      { title: 'Revenue by quarter', content: 'Q1: 120\nQ2: 180.5\nQ3: 240' },
    ]);
    const out = await importXlsx(buf);
    expect(out.format).toBe('xlsx');

    const table = out.sections.find((s) => s.title === 'By segment');
    expect(table?.content).toContain('| Segment | Revenue | Region |');
    expect(table?.content).toContain('| Enterprise | 4.1M | NA |');

    const series = out.sections.find((s) => s.title === 'Revenue by quarter');
    expect(series?.content).toMatch(/^Q1: 120$/m);
    expect(series?.content).toMatch(/^Q2: 180\.5$/m);
    expect(series?.content).toMatch(/^Q3: 240$/m);
    // The renderer's live SUM total row is derived data — it must NOT come back as a point.
    expect(series?.content).not.toMatch(/total/i);
    expect(series?.content).not.toContain('540');
  });
});

describe('importPptx round trip', () => {
  it('recovers slide titles in order (minus the cover), bullets, tables, and notes', async () => {
    const out = await importPptx(await renderPptx('Q3 Review', PPTX_SLIDES));
    expect(out.format).toBe('pptx');
    expect(out.title).toBe('Q3 Review');
    // The cover restates the deck title, so it is skipped — content slides only, in order.
    expect(out.sections.map((s) => s.title)).toEqual(PPTX_SLIDES.map((s) => s.title));
    expect(out.sections[0].content).toContain('shipped the runtime');
    expect(out.sections[2].content).toContain('| Segment | Revenue |');
    expect(out.sections[2].content).toContain('Enterprise');
    // Notes carry over WITHOUT the slide-number placeholder text pptxgenjs writes beside them.
    expect(out.sections[0].notes?.trim()).toBe('keep it short');
    expect(out.sections[1].notes).toBeUndefined();
  });
});

describe('importOffice format sniffing', () => {
  it('identifies all three formats from bytes alone', async () => {
    const [docx, xlsx, pptx] = await Promise.all([
      renderDocx('D', [{ title: 'S', content: 'a line' }]),
      renderXlsx('X', [{ title: 'S', content: 'Q1: 1\nQ2: 2' }]),
      renderPptx('P', [{ title: 'S', content: 'a line' }]),
    ]);
    expect((await importOffice(docx)).format).toBe('docx');
    expect((await importOffice(xlsx)).format).toBe('xlsx');
    expect((await importOffice(pptx)).format).toBe('pptx');
  });

  it('lets the bytes win over a wrong filename hint', async () => {
    const docx = await renderDocx('Real Doc', [{ title: 'S', content: 'a line' }]);
    const out = await importOffice(docx, 'renamed-deck.pptx');
    expect(out.format).toBe('docx');
    expect(out.title).toBe('Real Doc');
  });
});

describe('hostile input never throws', () => {
  it('returns an empty outline for an empty buffer, random bytes, and a part-less zip', async () => {
    const empty = await importOffice(Buffer.alloc(0));
    expect(empty).toEqual({ title: '', sections: [], format: 'docx' });

    const random = await importOffice(Buffer.from('definitely not a zip file at all'), 'notes.xlsx');
    expect(random.sections).toEqual([]);
    expect(random.format).toBe('xlsx'); // hint is the only identity left when the bytes say nothing

    const zip = new JSZip();
    zip.file('hello.txt', 'hi');
    const noParts = await importOffice(await zip.generateAsync({ type: 'nodebuffer' }));
    expect(noParts.title).toBe('');
    expect(noParts.sections).toEqual([]);
  });

  it('per-format importers survive garbage directly', async () => {
    const junk = Buffer.from([0x50, 0x4b, 0x00, 0x01, 0xff, 0xfe, 0x00]); // PK magic, broken body
    expect((await importDocx(junk)).sections).toEqual([]);
    expect((await importXlsx(junk)).sections).toEqual([]);
    expect((await importPptx(junk)).sections).toEqual([]);
  });
});

describe('full circle (the CRUD loop closes)', () => {
  it('renderDocx → importDocx → renderDocx renders the recovered outline without throwing', async () => {
    const first = await importDocx(await renderDocx('Q3 Review', DOCX_SECTIONS));
    const rerendered = await renderDocx(first.title, first.sections);
    expect(rerendered).toBeInstanceOf(Buffer);
    expect(rerendered.subarray(0, 2).toString()).toBe('PK');
    // And the regenerated document still carries every section — nothing fell out of the loop.
    const second = await importDocx(rerendered);
    expect(second.sections.map((s) => s.title)).toEqual(DOCX_SECTIONS.map((s) => s.title));
    expect(second.sections[0].content).toContain('shipped the runtime');
  });
});

describe('pptx chart data round-trip (regression: adversarial verify 2026-07-18)', () => {
  it('recovers series numbers that the renderer wrote into a native chart part', async () => {
    // The renderer turns `Label: value` lines into a real chart (the double-click-editable
    // point), so the slide's own XML holds no numbers — the importer must follow the slide
    // rels into ppt/charts/chartN.xml or the data silently vanishes, which is exactly what
    // the live adversarial verify caught. Losing formatting is fine; losing numbers is not.
    const { renderPptx, importPptx } = await import('../../src/features/presentation-generation');
    const buf = await renderPptx('Chart RT', [
      { title: 'Signal Series', content: 'Alpha: 11\nBeta: 22\nGamma: 33' },
    ]);
    const back = await importPptx(buf);
    const all = back.sections.map((s) => `${s.title}\n${s.content ?? ''}`).join('\n');
    for (const line of ['Alpha: 11', 'Beta: 22', 'Gamma: 33']) {
      expect(all, `chart point "${line}" must survive the round trip`).toContain(line);
    }
    // And the loop closes: the recovered outline re-renders without throwing.
    await expect(renderPptx(back.title || 'x', back.sections)).resolves.toBeInstanceOf(Buffer);
  });
});
