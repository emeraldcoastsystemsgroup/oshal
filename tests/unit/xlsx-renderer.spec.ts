import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { THEME_IDS } from '../../src/features/presentation-generation';
// The renderer + theme projection are exercised directly (not yet on the feature barrel).
import { renderXlsx } from '../../src/features/presentation-generation/services/xlsx-renderer';
import { xlsxTheme } from '../../src/features/presentation-generation/services/office-themes';
import type { DeckThemeId } from '../../src/shared/types';

/** Round-trip: read the rendered buffer BACK with exceljs, the way a consumer would. */
async function load(buf: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  return wb;
}

/** Every col-A value on a sheet, stringified — for "is this row present" assertions. */
function colA(ws: ExcelJS.Worksheet): string[] {
  const out: string[] = [];
  ws.eachRow((row) => {
    const v = row.getCell(1).value;
    out.push(typeof v === 'object' && v !== null && 'text' in v ? String((v as { text: unknown }).text) : String(v ?? ''));
  });
  return out;
}

/** An outline exercising every projection the renderer knows. */
const KITCHEN_SINK = [
  { title: 'Where we are', content: 'shipped the runtime\nsigned three design partners' },
  { title: 'The numbers', content: '94% :: uptime last quarter\n$1.2M :: pipeline created' },
  { title: 'Revenue by quarter', content: 'Q1: 120\nQ2: 180\nQ3: 240\nQ4: 310' },
  { title: 'By segment', content: '| Segment | Revenue | Growth |\n| --- | --- | --- |\n| Enterprise | 4100000 | 22% |\n| Mid-market | 1800000 | 41% |\n| Self-serve | 900000 | 63% |' },
  { title: 'What they said', content: '> It cut our close time from days to minutes.\n— Jane Roe, CFO' },
];

describe('rendered .xlsx', () => {
  it('opens with a themed Overview: title band, subtitle/byline, and an index of every section', async () => {
    const t = xlsxTheme('executive');
    const wb = await load(await renderXlsx('Q3 Review', KITCHEN_SINK, {
      theme: 'executive', subtitle: 'Quarterly business review', byline: 'oshal maintainers',
    }));

    const ov = wb.getWorksheet('Overview');
    expect(ov).toBeDefined();
    expect(wb.worksheets[0].name).toBe('Overview'); // first sheet — what Excel opens on

    const a1 = ov!.getCell('A1');
    expect(a1.value).toBe('Q3 Review');
    expect(a1.font?.bold).toBe(true);
    expect(a1.font?.size).toBe(20);
    expect(a1.font?.name).toBe(t.font);
    expect(a1.font?.color?.argb).toBe(t.headerInk);
    expect((a1.fill as ExcelJS.FillPattern)?.fgColor?.argb).toBe(t.headerFill);
    expect(ov!.getCell('A3').value).toBe('Quarterly business review');
    expect(ov!.getCell('A3').font?.color?.argb).toBe(t.inkSoft);
    expect(ov!.getCell('A4').value).toBe('oshal maintainers');

    // Index: one row per authored section, with a live internal link where a sheet exists.
    const names = colA(ov!);
    for (const s of KITCHEN_SINK) expect(names).toContain(s.title);
    let link: string | undefined;
    ov!.eachRow((row) => row.eachCell((cell) => {
      const v = cell.value;
      if (typeof v === 'object' && v !== null && 'hyperlink' in v && String((v as { text: unknown }).text) === 'By segment') {
        link = String((v as { hyperlink: unknown }).hyperlink);
      }
    }));
    expect(link).toBe("#'By segment'!A1");
  });

  it('renders a table slide as its own live worksheet: themed frozen header, bands, Number cells', async () => {
    const t = xlsxTheme('midnight');
    const wb = await load(await renderXlsx('T', KITCHEN_SINK));
    const ws = wb.getWorksheet('By segment');
    expect(ws).toBeDefined();

    const head = ws!.getRow(1);
    expect([head.getCell(1).value, head.getCell(2).value, head.getCell(3).value])
      .toEqual(['Segment', 'Revenue', 'Growth']);
    expect((head.getCell(1).fill as ExcelJS.FillPattern)?.fgColor?.argb).toBe(t.headerFill);
    expect(head.getCell(1).font?.color?.argb).toBe(t.headerInk);
    expect(head.getCell(1).font?.bold).toBe(true);
    expect(ws!.views?.[0]?.state).toBe('frozen');
    expect(ws!.views?.[0]?.ySplit).toBe(1);
    expect(ws!.properties?.tabColor?.argb).toBe(t.accent);

    // Bare numerics became REAL numbers; formatted strings stayed the authored text.
    expect(typeof ws!.getCell('B2').value).toBe('number');
    expect(ws!.getCell('B2').value).toBe(4_100_000);
    expect(ws!.getCell('C2').value).toBe('22%');
    // Banded body: the second body row carries the band fill.
    expect((ws!.getRow(3).getCell(1).fill as ExcelJS.FillPattern)?.fgColor?.argb).toBe(t.bandFill);
  });

  it('renders a series slide with real Number cells and a live SUM total', async () => {
    const wb = await load(await renderXlsx('T', KITCHEN_SINK));
    const ws = wb.getWorksheet('Revenue by quarter');
    expect(ws).toBeDefined();

    expect(ws!.getCell('A2').value).toBe('Q1');
    for (let r = 2; r <= 5; r += 1) expect(typeof ws!.getCell(`B${r}`).value).toBe('number');
    expect(ws!.getCell('B2').numFmt).toBe('#,##0.##');

    let sum: string | undefined;
    ws!.eachRow((row) => row.eachCell((cell) => {
      if (cell.formula && String(cell.formula).includes('SUM')) sum = String(cell.formula);
    }));
    expect(sum).toBe('SUM(B2:B5)');
  });

  it('pools metric pairs onto a shared Metrics sheet with accented bold labels', async () => {
    const t = xlsxTheme('midnight');
    const wb = await load(await renderXlsx('T', KITCHEN_SINK));
    const ws = wb.getWorksheet('Metrics');
    expect(ws).toBeDefined();
    const names = colA(ws!);
    expect(names).toContain('The numbers');
    expect(names).toContain('94%');
    ws!.eachRow((row) => {
      if (row.getCell(1).value === '94%') {
        expect(row.getCell(1).font?.bold).toBe(true);
        expect(row.getCell(1).font?.color?.argb).toBe(t.accent);
        expect(row.getCell(2).value).toBe('uptime last quarter');
      }
    });
  });

  it('sanitises sheet names: illegal characters stripped, 31-char cap, unique on duplicates', async () => {
    const nasty = {
      title: 'Q3/Q4: metrics * really? [draft] with an extremely long tail',
      content: '| A | B |\n| --- | --- |\n| 1 | 2 |',
    };
    const wb = await load(await renderXlsx('T', [nasty, { ...nasty }]));
    const names = wb.worksheets.map((w) => w.name).filter((n) => n !== 'Overview');
    expect(names).toHaveLength(2);
    for (const n of names) {
      expect(n.length).toBeLessThanOrEqual(31);
      expect(/[[\]:*?/\\]/.test(n)).toBe(false);
    }
    expect(new Set(names).size).toBe(2);
    expect(names[1]).toMatch(/\(2\)$/);
    // The index still links both, with the sanitised names.
    const ov = wb.getWorksheet('Overview')!;
    let links = 0;
    ov.eachRow((row) => row.eachCell((cell) => {
      const v = cell.value;
      if (typeof v === 'object' && v !== null && 'hyperlink' in v) links += 1;
    }));
    expect(links).toBe(2);
  });

  it('renders every theme without throwing', async () => {
    for (const id of THEME_IDS) {
      const buf = await renderXlsx(`${id} workbook`, KITCHEN_SINK, { theme: id as DeckThemeId, byline: 'oshal maintainers' });
      expect(buf.subarray(0, 2).toString(), `${id} is not a zip`).toBe('PK');
      const wb = await load(buf);
      expect(wb.getWorksheet('Overview'), `${id} lost its Overview`).toBeDefined();
      expect(wb.worksheets.length, `${id} lost its data sheets`).toBeGreaterThanOrEqual(4);
    }
  }, 60_000);

  it('survives hostile input: always a valid workbook with at least the Overview', async () => {
    await expect(renderXlsx('', [])).resolves.toBeInstanceOf(Buffer);
    const empty = await load(await renderXlsx('', []));
    expect(empty.getWorksheet('Overview')).toBeDefined();

    const weird = await load(await renderXlsx('Angle < & > "quoted"', [
      { title: '', content: '' },
      { title: "O'Brien's [Q1/Q2] *raw* data?", content: '| A | B |\n| --- | --- |\n| 1 | 2 |' },
      { title: 'x'.repeat(5000), content: 'y'.repeat(20000) },
      { title: '<script>alert(1)</script>', content: 'Q1: 1\nQ2: 2' },
    ]));
    expect(weird.getWorksheet('Overview')).toBeDefined();
    expect(weird.worksheets.length).toBeGreaterThanOrEqual(3); // Overview + table + series
    for (const ws of weird.worksheets) expect(ws.name.length).toBeLessThanOrEqual(31);
  });

  it('carries a plain notes slide onto the Overview under its heading, indented in soft ink', async () => {
    const t = xlsxTheme('midnight');
    const wb = await load(await renderXlsx('T', KITCHEN_SINK));
    const ov = wb.getWorksheet('Overview')!;
    const names = colA(ov);
    expect(names).toContain('shipped the runtime');
    ov.eachRow((row) => {
      if (row.getCell(1).value === 'shipped the runtime') {
        expect(row.getCell(1).font?.color?.argb).toBe(t.inkSoft);
        expect(row.getCell(1).alignment?.indent).toBe(1);
      }
    });
  });
});
