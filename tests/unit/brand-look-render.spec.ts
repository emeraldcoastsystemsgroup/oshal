/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — brand looks (backlog 2026-09-14, approved 2026-09-22). brandTheme derives a complete look from a kit's five role colors and two faces on a base look's structure; resolveTheme, docxTheme and xlsxTheme take an id exactly as before or a look; a deck, a document and a workbook drawn in a brand look are opened and their colors and faces read back; an invalid kit or a tampered look is refused with a readable BrandLookError and renders nothing. The ten built-in looks are pinned separately by deck-looks-unchanged.spec.ts.
 */

import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import {
  brandTheme, resolveTheme, docxTheme, xlsxTheme, renderPptx, renderDocx, renderXlsx,
  DECK_THEMES, THEME_IDS, OFFICE_SAFE_FONTS, BrandLookError, isBrandLookError,
} from '../../src/features/presentation-generation';
import type { DeckTheme, RenderableSlide } from '../../src/shared/types';

/** A brand whose every color and face differs from the base look's, so a read-back proves the source. */
const KIT = {
  base: 'executive',
  colors: { primary: '#7d2ae8', secondary: '#00a6a6', accent: '#ff7a59', dark: '#1d1733', light: '#fffdf7' },
  fonts: { heading: 'Georgia', body: 'Trebuchet MS' },
};
const BRAND = { primary: '7D2AE8', secondary: '00A6A6', accent: 'FF7A59', dark: '1D1733', light: 'FFFDF7' };
/** The executive look's own colors (all but white) — none may reach a file drawn in the brand look. */
const BASE_ONLY = ['F5F7FA', '12233F', '5A6B85', 'C9A227', 'DCE3ED', 'AFC0D8', '4A7AB5', '9BB4D0', '7A6A3A', '2E4A6E'];

const OUTLINE: RenderableSlide[] = [
  { title: 'Where we are', content: 'shipped the runtime\nsigned three design partners' },
  { title: 'The numbers', content: '94% :: uptime last quarter\n$1.2M :: pipeline created' },
  { title: 'Revenue mix', content: 'Enterprise: 55\nMid-market: 30\nSelf-serve: 15' },
  { title: 'By segment', content: '| Segment | Revenue |\n| --- | --- |\n| Enterprise | 4100000 |\n| Mid-market | 1800000 |' },
  { title: 'What they said', content: '> It cut our close time from days to minutes.\n— Jane Roe, CFO' },
];

/** WCAG contrast between two bare hex colors. */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const ch = [0, 2, 4].map((i) => {
      const s = parseInt(hex.slice(i, i + 2), 16) / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Every XML part of a rendered package, joined. */
async function xmlOf(buf: Buffer): Promise<Record<string, string>> {
  const zip = await JSZip.loadAsync(buf);
  const out: Record<string, string> = {};
  for (const name of Object.keys(zip.files)) {
    if (!zip.files[name].dir && /\.(xml|rels)$/.test(name)) out[name] = await zip.files[name].async('string');
  }
  return out;
}

/** A look with one field replaced — the shape a hand-edited or forged look takes. */
function tampered(look: DeckTheme, patch: Record<string, unknown>): DeckTheme {
  return { ...look, ...patch } as DeckTheme;
}

/** Run `fn` and return the BrandLookError it throws (failing when it throws nothing else). */
function refusal(fn: () => unknown): BrandLookError {
  try { fn(); } catch (err) {
    expect(err).toBeInstanceOf(BrandLookError);
    expect(isBrandLookError(err)).toBe(true);
    expect((err as BrandLookError).code).toBe('invalid_brand_look');
    return err as BrandLookError;
  }
  throw new Error('expected a BrandLookError, nothing was thrown');
}

describe('brandTheme', () => {
  it('derives a complete look: roles mapped by purpose, the kit faces, the base structure', () => {
    const look = brandTheme(KIT);
    const base = DECK_THEMES.executive;
    expect(look.id).toBe('brand:executive');
    expect(look.colors).toMatchObject({
      canvas: BRAND.light, ink: BRAND.dark, accent: BRAND.primary, accent2: BRAND.secondary,
      deep: BRAND.dark, deepInk: BRAND.light,
    });
    expect(look.fonts).toEqual({ heading: 'Georgia', body: 'Trebuchet MS', mono: base.fonts.mono });
    expect([look.cover, look.decor, look.radius, look.headingCase]).toEqual([base.cover, base.decor, base.radius, base.headingCase]);
    expect(look.darkCanvas).toBe(false);
    expect(look.chartColors.slice(0, 3)).toEqual([BRAND.primary, BRAND.secondary, BRAND.accent]);
    expect(new Set(look.chartColors).size).toBe(6);
    for (const hex of [...Object.values(look.colors), ...look.chartColors]) expect(hex).toMatch(/^[0-9A-F]{6}$/);
    expect(Object.isFrozen(look) && Object.isFrozen(look.colors) && Object.isFrozen(look.fonts)).toBe(true);
  });

  it('keeps every derived text color readable on its surface', () => {
    for (const kit of [KIT, { ...KIT, colors: { ...KIT.colors, dark: '#777777', light: '#888888' } }]) {
      const c = brandTheme(kit).colors;
      expect(contrast(c.ink, c.canvas)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(c.inkSoft, c.canvas)).toBeGreaterThanOrEqual(3);
      expect(contrast(c.deepInk, c.deep)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(c.deepInkSoft, c.deep)).toBeGreaterThanOrEqual(3);
    }
    // Gray on gray: neither brand color reads, so the text falls back to black or white.
    const gray = brandTheme({ ...KIT, colors: { ...KIT.colors, dark: '#777777', light: '#888888' } });
    expect(['000000', 'FFFFFF']).toContain(gray.colors.ink);
  });

  it('accepts hex with or without "#", in either case', () => {
    const bare = brandTheme({ ...KIT, colors: { primary: '7D2AE8', secondary: '00a6a6', accent: '#FF7A59', dark: '1d1733', light: '#FFFDF7' } });
    expect(bare.colors).toEqual(brandTheme(KIT).colors);
  });

  it('draws a dark brand on a dark canvas', () => {
    const dark = brandTheme({ ...KIT, base: 'midnight', colors: { ...KIT.colors, dark: '#e8eaf6', light: '#0b1020' } });
    expect(dark.darkCanvas).toBe(true);
    expect(dark.colors.canvas).toBe('0B1020');
    expect(dark.colors.ink).toBe('E8EAF6');
  });

  it('still finds six distinct chart series when the brand colors coincide', () => {
    for (const same of ['#1d1733', '#fffdf7', '#808080']) {
      const look = brandTheme({ ...KIT, colors: { ...KIT.colors, primary: same, secondary: same, accent: same } });
      expect(new Set(look.chartColors).size, same).toBe(6);
    }
  });

  it('builds on every one of the ten base looks', () => {
    for (const id of THEME_IDS) {
      const look = brandTheme({ ...KIT, base: id });
      expect(look.id).toBe(`brand:${id}`);
      expect(look.cover).toBe(DECK_THEMES[id].cover);
      expect(OFFICE_SAFE_FONTS).toContain(look.fonts.mono);
    }
  });

  it('refuses an invalid kit with a readable reason, never echoing the value', () => {
    const cases: Array<[unknown, RegExp]> = [
      [null, /must be an object/], [[], /must be an object/], ['executive', /must be an object/],
      [{ ...KIT, extra: 1 }, /unsupported field/], [{ colors: KIT.colors, fonts: KIT.fonts }, /missing "base"/],
      [{ ...KIT, base: 'nope' }, /ten built-in looks/], [{ ...KIT, base: 'constructor' }, /ten built-in looks/],
      [{ ...KIT, base: 'brand:executive' }, /ten built-in looks/], [{ ...KIT, base: 'Executive' }, /ten built-in looks/],
      [{ ...KIT, colors: { primary: '#7d2ae8', secondary: '#00a6a6', accent: '#ff7a59', dark: '#1d1733' } }, /missing "light"/],
      [{ ...KIT, colors: { ...KIT.colors, light: undefined } }, /light color must be a six-digit hex/],
      [{ ...KIT, colors: { ...KIT.colors, tertiary: '#000000' } }, /unsupported field/],
      [{ ...KIT, colors: { ...KIT.colors, primary: 'red' } }, /primary color must be a six-digit hex/],
      [{ ...KIT, colors: { ...KIT.colors, primary: '#7d2ae' } }, /primary color must be a six-digit hex/],
      [{ ...KIT, colors: { ...KIT.colors, primary: '#7d2ae8"/><x:evil' } }, /primary color must be a six-digit hex/],
      [{ ...KIT, colors: { ...KIT.colors, dark: 0x1d1733 } }, /dark color must be a six-digit hex/],
      [{ ...KIT, fonts: { heading: 'Comic Sans MS', body: 'Calibri' } }, /heading font must be one of the Office fonts/],
      [{ ...KIT, fonts: { heading: 'Georgia', body: 'calibri' } }, /body font must be one of the Office fonts/],
      [{ ...KIT, fonts: { ...KIT.fonts, mono: 'Consolas' } }, /unsupported field/],
    ];
    for (const [input, reason] of cases) {
      const err = refusal(() => brandTheme(input));
      expect(err.message, JSON.stringify(input)).toMatch(reason);
      expect(err.message).toMatch(/^Brand look refused: /);
      expect(err.message).not.toMatch(/evil|Comic Sans/);
    }
  });
});

describe('resolveTheme, docxTheme and xlsxTheme', () => {
  it('resolve an id exactly as before: own keys only, unknown ids are the house look', () => {
    for (const id of THEME_IDS) expect(resolveTheme(id)).toBe(DECK_THEMES[id]);
    expect(resolveTheme(' EXECUTIVE ')).toBe(DECK_THEMES.executive);
    for (const unknown of ['nope', '', undefined, null, 'constructor', '__proto__', 'toString', 'brand:executive']) {
      expect(resolveTheme(unknown), String(unknown)).toBe(DECK_THEMES.midnight);
      expect(docxTheme(unknown), String(unknown)).toEqual(docxTheme('midnight'));
      expect(xlsxTheme(unknown), String(unknown)).toEqual(xlsxTheme('midnight'));
    }
    // The Office projections never trimmed or lower-cased an id; they still do not.
    expect(docxTheme('EXECUTIVE')).toEqual(docxTheme('midnight'));
    expect(xlsxTheme('EXECUTIVE')).toEqual(xlsxTheme('midnight'));
    expect(resolveTheme(DECK_THEMES.executive)).toBe(DECK_THEMES.executive);
  });

  it('take a brand look and project its own colors and faces', () => {
    const look = brandTheme(KIT);
    expect(resolveTheme(look)).toEqual(look);
    expect(resolveTheme({ ...look })).toEqual(look);
    expect(docxTheme(look)).toMatchObject({
      id: 'brand:executive', headingFont: 'Georgia', bodyFont: 'Trebuchet MS', ink: BRAND.dark,
      accent: BRAND.primary, accent2: BRAND.secondary, serifHeadings: true,
    });
    expect(xlsxTheme(look)).toMatchObject({
      id: 'brand:executive', font: 'Trebuchet MS', headerFill: `FF${BRAND.dark}`, headerInk: `FF${BRAND.light}`,
      accent: `FF${BRAND.primary}`, ink: `FF${BRAND.dark}`,
    });
  });

  it('refuse a tampered look in every entry point — it never becomes the default look', () => {
    const look = brandTheme(KIT);
    const cases: Array<[DeckTheme, RegExp]> = [
      [tampered(look, { colors: { ...look.colors, ink: 'zzz' } }), /ink color must be a six-digit hex/],
      [tampered(look, { colors: { ...look.colors, accent: '#7D2AE8' } }), /accent color must be a six-digit hex/],
      [tampered(look, { id: 'executive' }), /"brand:"/], [tampered(look, { id: 'brand:nope' }), /"brand:"/],
      [tampered(look, { cover: 'wash' }), /cover must be the Executive look's/],
      [tampered(look, { radius: 0.5 }), /radius must be the Executive look's/],
      [tampered(look, { fonts: { ...look.fonts, mono: 'Fira Code' } }), /mono font/],
      [tampered(look, { chartColors: look.chartColors.slice(0, 5) }), /six chart colors/],
      [tampered(look, { chartColors: [...look.chartColors.slice(0, 5), 'url(x)'] }), /Chart color 6/],
      [tampered(look, { name: 'x'.repeat(81) }), /look name/],
      [tampered(look, { darkCanvas: 'no' }), /canvas is dark/],
      [tampered(look, { extra: true }), /unsupported field/],
    ];
    for (const [bad, reason] of cases) {
      for (const entry of [resolveTheme, docxTheme, xlsxTheme] as Array<(l: DeckTheme) => unknown>) {
        expect(refusal(() => entry(bad)).message).toMatch(reason);
      }
    }
  });
});

describe('rendering a brand look', () => {
  it('draws the .pptx in the brand colors and faces', async () => {
    const p = await xmlOf(await renderPptx('Brand deck', OUTLINE, { theme: brandTheme(KIT), byline: 'Northwind' }));
    const all = Object.values(p).join('\n');
    expect(p['ppt/theme/theme1.xml']).toMatch(/<a:majorFont><a:latin typeface="Georgia"\/>/);
    expect(p['ppt/theme/theme1.xml']).toMatch(/<a:minorFont><a:latin typeface="Trebuchet MS"\/>/);
    const slides = Object.keys(p).filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k)).map((k) => p[k]).join('\n');
    expect(slides).toContain('typeface="Georgia"');
    expect(slides).toContain('typeface="Trebuchet MS"');
    for (const hex of Object.values(BRAND)) expect(all, hex).toContain(`val="${hex}"`);
    const charts = Object.keys(p).filter((k) => /^ppt\/charts\/chart\d+\.xml$/.test(k)).map((k) => p[k]).join('\n');
    for (const hex of [BRAND.primary, BRAND.secondary, BRAND.accent]) expect(charts, hex).toContain(hex);
    for (const hex of BASE_ONLY) expect(all, hex).not.toContain(hex);
  });

  it('draws the .docx in the brand colors and faces', async () => {
    const p = await xmlOf(await renderDocx('Brand document', OUTLINE, { theme: brandTheme(KIT), byline: 'Northwind' }));
    const heading1 = /<w:style [^>]*w:styleId="Heading1"[\s\S]*?<\/w:style>/.exec(p['word/styles.xml'])?.[0] ?? '';
    expect(heading1).toContain('w:ascii="Georgia"');
    expect(p['word/styles.xml']).toContain('w:ascii="Trebuchet MS"');
    const all = `${p['word/styles.xml']}\n${p['word/document.xml']}`;
    for (const hex of [BRAND.primary, BRAND.secondary, BRAND.dark]) expect(all, hex).toContain(`w:val="${hex}"`);
    for (const hex of BASE_ONLY) expect(all, hex).not.toContain(hex);
  });

  it('draws the .xlsx in the brand colors and faces', async () => {
    const wb = new ExcelJS.Workbook();
    // exceljs types its input as its own ArrayBuffer-shaped Buffer; a Node Buffer is what it reads.
    const workbook = await renderXlsx('Brand workbook', OUTLINE, { theme: brandTheme(KIT), byline: 'Northwind' });
    await wb.xlsx.load(workbook as unknown as ArrayBuffer);
    const a1 = wb.getWorksheet('Overview')!.getCell('A1');
    expect(a1.font?.name).toBe('Trebuchet MS');
    expect(a1.font?.color?.argb).toBe(`FF${BRAND.light}`);
    expect((a1.fill as ExcelJS.FillPattern).fgColor?.argb).toBe(`FF${BRAND.dark}`);
    const table = wb.getWorksheet('By segment')!;
    expect(table.properties.tabColor?.argb).toBe(`FF${BRAND.primary}`);
    expect((table.getCell('A1').fill as ExcelJS.FillPattern).fgColor?.argb).toBe(`FF${BRAND.dark}`);
    expect(table.getCell('A2').font?.color?.argb).toBe(`FF${BRAND.dark}`);
    const styles = (await xmlOf(await renderXlsx('Brand workbook', OUTLINE, { theme: brandTheme(KIT) })))['xl/styles.xml'];
    for (const hex of BASE_ONLY) expect(styles, hex).not.toContain(hex);
  });

  it('draws every format on every base look without throwing', async () => {
    for (const id of THEME_IDS) {
      const look = brandTheme({ ...KIT, base: id });
      for (const render of [renderPptx, renderDocx, renderXlsx]) {
        const buf = await render(`${id} brand`, OUTLINE, { theme: look });
        expect(buf.subarray(0, 2).toString(), `${id}`).toBe('PK');
      }
    }
  }, 120_000);

  it('renders nothing for a refused look', async () => {
    const look = brandTheme(KIT);
    const forged = tampered(look, { colors: { ...look.colors, accent: '7D2AE8"/><a:evil' } });
    for (const render of [renderPptx, renderDocx, renderXlsx]) {
      const outcome = await render('Forged', OUTLINE, { theme: forged }).then(
        (buf) => `rendered ${buf.length} bytes`, (err: unknown) => err,
      );
      expect(outcome).toBeInstanceOf(BrandLookError);
    }
  });
});
