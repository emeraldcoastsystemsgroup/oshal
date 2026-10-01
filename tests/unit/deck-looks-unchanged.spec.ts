/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — the ten built-in looks render unchanged in .pptx, .docx and .xlsx. A digest of every OOXML part of every look in every format, plus the picker catalog, is compared with a fixture generated from core main before the renderers learned to draw a brand look (backlog 2026-09-14, operator decision 2026-09-22: "the ten built-in looks render byte-identically to before").
 */

import { describe, expect, it } from 'vitest';
import { createHash } from 'crypto';
import { readFileSync, writeFileSync } from 'fs';
import * as path from 'path';
import JSZip from 'jszip';
import {
  THEME_IDS, themeCatalog, renderPptx, renderDocx, renderXlsx,
} from '../../src/features/presentation-generation';
import type { DeckRenderOptions, RenderableSlide } from '../../src/shared/types';

/**
 * The golden fixture. Regenerate ONLY from a tree whose looks are meant to change, with
 * `OSHAL_WRITE_DECK_LOOK_DIGESTS=1`; every other run compares and a missing file fails.
 */
const FIXTURE = path.resolve(__dirname, '..', 'fixtures', 'deck-look-digests-2026-10-01.json');
const WRITE = process.env.OSHAL_WRITE_DECK_LOOK_DIGESTS === '1';

/** One outline that reaches every content shape the three renderers project. */
const OUTLINE: RenderableSlide[] = [
  { title: 'Where we are', content: 'shipped the runtime\nsigned three design partners' },
  { title: 'The numbers', content: '94% :: uptime last quarter\n$1.2M :: pipeline created\n3.4x :: faster than baseline' },
  { title: 'Revenue by quarter', content: 'Q1: 120\nQ2: 180\nQ3: 240\nQ4: 310' },
  { title: 'Revenue mix', content: 'Enterprise: 55\nMid-market: 30\nSelf-serve: 15' },
  { title: 'Build vs buy', content: '## Build\nfull control\nour IP\n## Buy\nlive next week\nvendor lock-in' },
  { title: 'By segment', content: '| Segment | Revenue | Growth |\n| --- | --- | --- |\n| Enterprise | 4100000 | 22% |\n| Mid-market | 1800000 | 41% |' },
  { title: 'What they said', content: '> It cut our close time from days to minutes.\n— Jane Roe, CFO' },
  { title: 'Roadmap', content: 'Q1 2026 :: Private preview\nQ2 2026 :: General availability\nQ3 2026 :: Scale' },
  { title: 'How it works', content: 'Discover :: gather inputs\nDecide :: pick an approach\nDeliver :: ship it' },
  { title: 'Thank you', content: 'the operator@example.com', notes: 'close on the ask' },
];

const OPTIONS: DeckRenderOptions = { subtitle: 'A quarterly read-out', byline: 'oshal maintainers' };

const RENDER = { pptx: renderPptx, docx: renderDocx, xlsx: renderXlsx } as const;
type Kind = keyof typeof RENDER;

/** Every part of an OOXML package, with embedded workbooks (chart data) unpacked in place. */
async function unpack(buf: Buffer, prefix = ''): Promise<Map<string, Buffer>> {
  const zip = await JSZip.loadAsync(buf);
  const out = new Map<string, Buffer>();
  for (const name of Object.keys(zip.files)) {
    const file = zip.files[name];
    if (file.dir) continue;
    const data = await file.async('nodebuffer');
    if (/\.xlsx$/i.test(name)) {
      for (const [inner, bytes] of await unpack(data, `${prefix}${name}!`)) out.set(inner, bytes);
    } else {
      out.set(prefix + name, data);
    }
  }
  return out;
}

/**
 * The only bytes that differ between two renders of the same code: the package timestamps,
 * and pptxgenjs's chart numbering, which is a module-global counter (a deck's charts are named
 * by how many charts the process drew before it). Both are normalised; nothing else is.
 */
function normalise(parts: Map<string, Buffer>): Array<[string, string]> {
  const CHART = /\b(chart|Microsoft_Excel_Worksheet)(\d+)(\.xml|\.xlsx)/g;
  const numbers = [...parts.keys()].flatMap((n) => [...n.matchAll(CHART)].map((m) => Number(m[2])));
  const base = numbers.length ? Math.min(...numbers) - 1 : 0;
  const renumber = (s: string) => s.replace(CHART, (_m, stem, n, ext) => `${stem}${Number(n) - base}${ext}`);
  return [...parts.entries()].map(([name, bytes]): [string, string] => {
    const text = /\.(xml|rels)$/i.test(name)
      ? bytes.toString('utf8').replace(/(<dcterms:(created|modified)\b[^>]*>)[^<]*(<\/dcterms:\2>)/g, '$1T$3')
      : bytes.toString('base64');
    return [renumber(name), renumber(text)];
  }).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** sha256 over every normalised part, name and content, in name order. */
async function digest(kind: Kind, id: string): Promise<string> {
  const buf = await RENDER[kind](`${id} look`, OUTLINE, { ...OPTIONS, theme: id as DeckRenderOptions['theme'] });
  const hash = createHash('sha256');
  for (const [name, text] of normalise(await unpack(buf))) hash.update(name).update('\0').update(text).update('\0');
  return hash.digest('hex');
}

/** Every look in one format, keyed `<format>:<look id>`. */
async function digestsFor(kind: Kind): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const id of THEME_IDS) out[`${kind}:${id}`] = await digest(kind, id);
  return out;
}

/** The picker catalog (GET /themes in AI Office) for the ten looks. */
function catalogDigest(): string {
  return createHash('sha256').update(JSON.stringify(themeCatalog())).digest('hex');
}

describe('the ten built-in looks render unchanged', () => {
  if (WRITE) {
    it('writes the golden digests (OSHAL_WRITE_DECK_LOOK_DIGESTS=1)', async () => {
      const digests = { catalog: catalogDigest(), ...await digestsFor('pptx'), ...await digestsFor('docx'), ...await digestsFor('xlsx') };
      const fixture = {
        _source: 'Generated by tests/unit/deck-looks-unchanged.spec.ts with OSHAL_WRITE_DECK_LOOK_DIGESTS=1 from core main before the renderers accepted a brand look.',
        _shape: 'sha256 per format and built-in look over every OOXML part (embedded chart workbooks unpacked), with dcterms timestamps masked and pptxgenjs chart numbers renumbered from 1; plus the picker catalog JSON.',
        digests,
      };
      writeFileSync(FIXTURE, `${JSON.stringify(fixture, null, 2)}\n`);
      expect(Object.keys(digests)).toHaveLength(31);
    }, 120_000);
    return;
  }

  const golden = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { digests: Record<string, string> };

  it('keeps the fixture complete: the catalog plus ten looks in each of three formats', () => {
    expect(THEME_IDS).toHaveLength(10);
    expect(Object.keys(golden.digests).sort()).toEqual(
      ['catalog', ...(['pptx', 'docx', 'xlsx'] as const).flatMap((k) => THEME_IDS.map((id) => `${k}:${id}`))].sort(),
    );
  });

  it('serves the same picker catalog', () => {
    expect(catalogDigest()).toBe(golden.digests.catalog);
  });

  for (const kind of ['pptx', 'docx', 'xlsx'] as const) {
    it(`renders every look's .${kind} part-for-part as before`, async () => {
      const expected = Object.fromEntries(Object.entries(golden.digests).filter(([k]) => k.startsWith(`${kind}:`)));
      expect(await digestsFor(kind)).toEqual(expected);
    }, 120_000);
  }
});
