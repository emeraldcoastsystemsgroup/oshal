/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — the Word projection's contract: real OOXML, theme-driven styles (not inline runs), Heading1 per section so the navigation pane/TOC work, real tables, a real page-number field, dark deck themes coming out dark-ON-white, and the never-throw degradation floor.
 */

import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { THEME_IDS } from '../../src/features/presentation-generation';
import { renderDocx } from '../../src/features/presentation-generation/services/docx-renderer';
import { docxTheme } from '../../src/features/presentation-generation/services/office-themes';
import type { DeckThemeId } from '../../src/shared/types';

/** Unzip a rendered document into its OOXML parts. */
async function parts(buf: Buffer): Promise<Record<string, string>> {
  const zip = await JSZip.loadAsync(buf);
  const out: Record<string, string> = {};
  for (const name of Object.keys(zip.files)) {
    if (name.endsWith('.xml') || name.endsWith('.rels')) out[name] = await zip.files[name].async('string');
  }
  return out;
}

/** The `<w:style …>` block for one style id, cut out of styles.xml. */
function styleBlock(stylesXml: string, id: string): string {
  const m = new RegExp(`<w:style [^>]*w:styleId="${id}"[\\s\\S]*?</w:style>`).exec(stylesXml);
  return m ? m[0] : '';
}

/** A 1x1 PNG — a real image, so the embed path is exercised end to end. */
const PNG_1X1 = 'data:image/png;base64,'
  + 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** An outline exercising every content shape the parser understands. */
const KITCHEN_SINK = [
  { title: 'Where we are', content: 'shipped the runtime\nsigned three design partners' },
  { title: 'The numbers', content: '94% :: uptime last quarter\n$1.2M :: pipeline created' },
  { title: 'Revenue by quarter', content: 'Q1: 120\nQ2: 180\nQ3: 240' },
  { title: 'Build vs buy', content: '## Build\nfull control\nour IP\n## Buy\nlive next week' },
  { title: 'By segment', content: '| Segment | Revenue |\n| --- | --- |\n| Enterprise | 4.1M |\n| Mid-market | 1.8M |' },
  { title: 'What they said', content: '> It cut our close time from days to minutes.\n— Jane Roe, CFO' },
  { title: 'Thank you', content: 'the operator@example.com' },
];

describe('rendered .docx', () => {
  it('is a valid OOXML package with a document and a style sheet', async () => {
    const buf = await renderDocx('Q3 Review', KITCHEN_SINK, { theme: 'executive' });
    expect(buf.subarray(0, 2).toString()).toBe('PK'); // a .docx is a zip
    const p = await parts(buf);
    expect(p['word/document.xml']).toBeDefined();
    expect(p['word/styles.xml']).toBeDefined();
  });

  it('carries the theme fonts in real styles — heading font on Heading1, body font as the default', async () => {
    // Restyling in Word must mean editing a style, not two hundred inline runs — so the fonts
    // have to live in styles.xml, not be sprayed across document.xml.
    const t = docxTheme('executive');
    const p = await parts(await renderDocx('T', KITCHEN_SINK, { theme: 'executive' }));
    const h1 = styleBlock(p['word/styles.xml'], 'Heading1');
    expect(h1).not.toBe('');
    expect(h1).toContain(`w:ascii="${t.headingFont}"`);
    expect(p['word/styles.xml']).toContain(`w:ascii="${t.bodyFont}"`);
  });

  it('emits one Heading1 per slide so the navigation pane and a TOC work', async () => {
    const p = await parts(await renderDocx('T', KITCHEN_SINK));
    const doc = p['word/document.xml'];
    for (const s of KITCHEN_SINK) expect(doc).toContain(s.title);
    const h1Count = (doc.match(/<w:pStyle w:val="Heading1"\/?>/g) ?? []).length;
    expect(h1Count).toBeGreaterThanOrEqual(KITCHEN_SINK.length);
  });

  it('renders a parsed table as a real Word table', async () => {
    const p = await parts(await renderDocx('T', [
      { title: 'T', content: '| A | B |\n| --- | --- |\n| 1 | 2 |' },
    ]));
    expect(p['word/document.xml']).toContain('<w:tbl>');
    expect(p['word/document.xml']).toContain('>A<'); // header cell text made it into the grid
  });

  it('numbers pages with a real PAGE field that renumbers — not literal text', async () => {
    const p = await parts(await renderDocx('T', KITCHEN_SINK));
    const all = Object.values(p).join('\n');
    expect(all).toMatch(/w:instrText[^>]*>[^<]*PAGE|w:fldSimple[^>]*PAGE/);
  });

  it('projects dark deck themes as dark-ON-white documents', async () => {
    // Inverting a whole Word page is a novelty, not a document: midnight's deck ink (F4F6FF,
    // near-white) must NOT be the document's body color — the pageInk mapping swaps in near-black.
    const t = docxTheme('midnight');
    expect(t.ink).toBe('1A1D29');
    const p = await parts(await renderDocx('T', KITCHEN_SINK, { theme: 'midnight' }));
    expect(p['word/styles.xml']).toContain('w:val="1A1D29"');
    expect(p['word/styles.xml']).not.toContain('w:val="F4F6FF"');
    expect(p['word/document.xml']).not.toContain('w:val="F4F6FF"');
  });

  it('renders every one of the ten themes without throwing', async () => {
    expect(THEME_IDS).toHaveLength(10);
    for (const id of THEME_IDS) {
      const buf = await renderDocx(`${id} doc`, KITCHEN_SINK, {
        theme: id as DeckThemeId, subtitle: 'A quarterly read-out', byline: 'oshal maintainers',
      });
      expect(buf.length, `${id} produced an empty file`).toBeGreaterThan(4_000);
    }
  });

  it('embeds a data-URI image and ignores a non-data URL', async () => {
    // The deck pipeline resolves remote URLs upstream; the Word path must never fetch on an
    // author's behalf, so a raw URL reaching the renderer renders as nothing.
    const withImage = await JSZip.loadAsync(await renderDocx('T', [{ title: 'Shot', content: `#image: ${PNG_1X1}` }]));
    expect(Object.keys(withImage.files).some((n) => n.startsWith('word/media/') && !withImage.files[n].dir)).toBe(true);

    const withUrl = await JSZip.loadAsync(await renderDocx('T', [{ title: 'Shot', content: '#image: https://example.com/x.png' }]));
    expect(Object.keys(withUrl.files).some((n) => n.startsWith('word/media/') && !withUrl.files[n].dir)).toBe(false);
  });

  it('survives hostile input without throwing', async () => {
    await expect(renderDocx('', [])).resolves.toBeInstanceOf(Buffer);
    await expect(renderDocx('T', [{ title: '', content: '' }])).resolves.toBeInstanceOf(Buffer);
    await expect(renderDocx('T', [{ title: 'x'.repeat(5000), content: 'y'.repeat(20000) }])).resolves.toBeInstanceOf(Buffer);
    await expect(renderDocx('T', [{ title: 'Angle < & > brackets "quoted"', content: '<script>alert(1)</script>' }]))
      .resolves.toBeInstanceOf(Buffer);
    await expect(renderDocx('T', [null as unknown as { title: string }, { title: 'ok', content: 'a' }]))
      .resolves.toBeInstanceOf(Buffer);
  });

  it('escapes XML metacharacters rather than corrupting the package', async () => {
    const p = await parts(await renderDocx('T', [{ title: 'A & B <tag>', content: 'x' }]));
    expect(p['word/document.xml']).toContain('A &amp; B &lt;tag&gt;');
    expect(p['word/document.xml']).not.toContain('<tag>');
  });
});
