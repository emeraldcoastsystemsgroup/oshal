/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The internal-host SSRF probe follows PLAYWRIGHT_PORT via the shared apiOrigin() helper instead of a hardcoded localhost:35457 — any localhost port is equally "an internal host the renderer must refuse" (byte-identical under the default env)
 */

import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import * as http from 'http';
import type { AddressInfo } from 'net';
import {
  renderPptx, parseSlideContent, autoSelectLayout, applyDeckRhythm,
  resolveTheme, themeCatalog, layoutCatalog, LAYOUT_ORDER, LAYOUTS, THEME_IDS, isThemeId, isLayoutId,
  resolveImage, sniffImageMime, fetchCapped,
} from '../../src/features/presentation-generation';
// The SSRF address logic is the platform guard's, reused rather than duplicated in the feature.
import { isPrivateIp } from '../../src/shared/security/ssrf-guard';
import type { DeckThemeId, SlideLayoutId } from '../../src/shared/types';
import { apiOrigin } from '../helpers';

/** Fonts that ship with Microsoft Office on BOTH Windows and macOS. Anything outside this set
 *  substitutes on the user's desktop and reflows every line the renderer laid out. */
const OFFICE_SAFE = new Set([
  'Calibri', 'Cambria', 'Candara', 'Century Gothic', 'Consolas', 'Constantia', 'Corbel',
  'Garamond', 'Georgia', 'Trebuchet MS', 'Arial', 'Courier New',
]);

/** Unzip a rendered deck into its OOXML parts. */
async function parts(buf: Buffer): Promise<Record<string, string>> {
  const zip = await JSZip.loadAsync(buf);
  const out: Record<string, string> = {};
  for (const name of Object.keys(zip.files)) {
    if (name.endsWith('.xml') || name.endsWith('.rels')) out[name] = await zip.files[name].async('string');
  }
  return out;
}

/** A deck exercising every content shape the parser understands. */
const KITCHEN_SINK = [
  { title: 'Where we are', content: 'shipped the runtime\nsigned three design partners' },
  { title: 'The numbers', content: '94% :: uptime last quarter\n$1.2M :: pipeline created\n3.4x :: faster than baseline' },
  { title: 'Revenue by quarter', content: 'Q1: 120\nQ2: 180\nQ3: 240\nQ4: 310' },
  { title: 'Revenue mix', content: 'Enterprise: 55\nMid-market: 30\nSelf-serve: 15' },
  { title: 'Build vs buy', content: '## Build\nfull control\nour IP\n## Buy\nlive next week\nvendor lock-in' },
  { title: 'By segment', content: '| Segment | Revenue | Growth |\n| --- | --- | --- |\n| Enterprise | 4.1M | 22% |\n| Mid-market | 1.8M | 41% |' },
  { title: 'What they said', content: '> It cut our close time from days to minutes.\n— Jane Roe, CFO' },
  { title: 'Roadmap', content: 'Q1 2026 :: Private preview\nQ2 2026 :: General availability\nQ3 2026 :: Scale' },
  { title: 'How it works', content: 'Discover :: gather inputs\nDecide :: pick an approach\nDeliver :: ship it' },
  { title: 'Thank you', content: 'the operator@example.com' },
];

describe('deck themes', () => {
  it('ships exactly ten themes', () => {
    expect(THEME_IDS).toHaveLength(10);
    expect(themeCatalog()).toHaveLength(10);
  });

  it('only uses fonts that ship with Office on Windows AND macOS', () => {
    // A webfont here would silently substitute when the user opens the .pptx on their desktop,
    // which reflows every line the renderer measured. This is the whole "download and edit it"
    // promise, so it is asserted rather than trusted.
    for (const id of THEME_IDS) {
      const f = resolveTheme(id).fonts;
      for (const face of [f.heading, f.body, f.mono]) {
        expect(OFFICE_SAFE, `${id} uses non-Office font ${face}`).toContain(face);
      }
    }
  });

  it('gives every theme readable body text on its own canvas and deep surfaces', () => {
    // Cheap luminance-delta check: catches a palette edit that puts dark ink on a dark canvas.
    const lum = (hex: string) => {
      const ch = [0, 2, 4].map((i) => {
        const s = parseInt(hex.slice(i, i + 2), 16) / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
    };
    const contrast = (a: string, b: string) => {
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    for (const id of THEME_IDS) {
      const c = resolveTheme(id).colors;
      expect(contrast(c.ink, c.canvas), `${id} ink on canvas`).toBeGreaterThan(4.5);
      expect(contrast(c.inkSoft, c.canvas), `${id} soft ink on canvas`).toBeGreaterThan(3);
      expect(contrast(c.deepInk, c.deep), `${id} ink on deep`).toBeGreaterThan(4.5);
      expect(contrast(c.deepInkSoft, c.deep), `${id} soft ink on deep`).toBeGreaterThan(3);
    }
  });

  it('falls back to the default theme rather than throwing on a bad name', () => {
    expect(resolveTheme('nope').id).toBe('midnight');
    expect(resolveTheme(undefined).id).toBe('midnight');
    expect(isThemeId('executive')).toBe(true);
    expect(isThemeId('nope')).toBe(false);
  });
});

describe('slide content parser', () => {
  it('keeps a plain body as plain bullets (the pre-existing behaviour)', () => {
    const d = parseSlideContent('one\ntwo\nthree');
    expect(d.bullets).toEqual(['one', 'two', 'three']);
    expect(d.groups).toHaveLength(0);
    expect(d.table).toBeNull();
  });

  it('parses groups, tables, quotes, pairs, series and directives', () => {
    expect(parseSlideContent('## A\na1\n## B\nb1').groups).toEqual([
      { heading: 'A', items: ['a1'] }, { heading: 'B', items: ['b1'] },
    ]);
    expect(parseSlideContent('| H1 | H2 |\n| --- | --- |\n| a | b |').table)
      .toEqual({ head: ['H1', 'H2'], rows: [['a', 'b']] });
    expect(parseSlideContent('> quoted\n— Jane').quote).toEqual({ text: 'quoted', attribution: 'Jane' });
    expect(parseSlideContent('94% :: uptime').pairs).toEqual([{ label: '94%', value: 'uptime' }]);
    expect(parseSlideContent('Q3: 240').series).toEqual([{ label: 'Q3', value: 240, display: '240' }]);
    expect(parseSlideContent('#layout: kpi-grid').directives.layout).toBe('kpi-grid');
  });

  it('parses authored metric formats, and does not mistake prose for data', () => {
    expect(parseSlideContent('Revenue: $1.2M').series[0].value).toBe(1_200_000);
    expect(parseSlideContent('Uptime: 94%').series[0].value).toBe(94);
    // A colon in a sentence must stay a bullet — otherwise ordinary prose silently becomes a chart.
    expect(parseSlideContent('Note: this is important').bullets).toEqual(['Note: this is important']);
    expect(parseSlideContent('Note: this is important').series).toHaveLength(0);
  });

  it('treats lines inside a group as that group’s copy, not deck-level data', () => {
    const d = parseSlideContent('## Build\nSpeed: 2s\nfull control');
    expect(d.groups[0].items).toEqual(['Speed: 2s', 'full control']);
    expect(d.series).toHaveLength(0);
  });
});

describe('layout auto-selection', () => {
  const pick = (title: string, content: string, i = 1, total = 5): SlideLayoutId =>
    autoSelectLayout(title, parseSlideContent(content), { index: i, total });

  it('reads the layout out of the content’s shape', () => {
    expect(pick('X', 'a\nb\nc')).toBe('bullets');
    expect(pick('X', '| a | b |\n| c | d |')).toBe('table');
    expect(pick('X', '> q\n— j')).toBe('quote');
    expect(pick('X', '94% :: uptime')).toBe('big-number');
    expect(pick('X', '94% :: up\n$1M :: pipeline\n3x :: faster')).toBe('kpi-grid');
    expect(pick('X', 'Q1 2026 :: a\nQ2 2026 :: b\nQ3 2026 :: c')).toBe('timeline');
    expect(pick('X', 'Discover :: a\nDecide :: b\nDeliver :: c')).toBe('process');
    expect(pick('X', '## A\na\n## B\nb\n## C\nc\n## D\nd')).toBe('quadrant');
    expect(pick('Build vs buy', '## Build\na\n## Buy\nb')).toBe('comparison');
    expect(pick('Two things', '## A\na\n## B\nb')).toBe('two-column');
    expect(pick('Agenda', 'one\ntwo\nthree')).toBe('agenda');
    expect(pick('Thank you', 'bye', 5, 5)).toBe('closing');
  });

  it('picks the chart that fits the data', () => {
    expect(pick('Revenue by quarter', 'Q1: 1\nQ2: 2\nQ3: 3')).toBe('line-chart');
    expect(pick('Revenue mix', 'A: 55\nB: 30\nC: 15')).toBe('pie-chart');
    expect(pick('Headcount by team', 'Eng: 40\nSales: 12')).toBe('bar-chart');
  });

  it('honours an explicit #layout over the inferred one', () => {
    expect(pick('X', '#layout: statement\na\nb\nc')).toBe('statement');
  });

  it('ignores an unknown #layout instead of blanking the slide', () => {
    expect(pick('X', '#layout: nonsense\na\nb')).toBe('bullets');
    expect(isLayoutId('nonsense')).toBe(false);
  });

  it('breaks up long bullet runs but leaves short ones alone', () => {
    const many = Array.from({ length: 6 }, () => parseSlideContent('a\nb\nc\nd\ne'));
    const run = applyDeckRhythm(Array(6).fill('bullets') as SlideLayoutId[], many);
    expect(run.filter((l) => l === 'bullets').length).toBeLessThan(6);
    expect(run[0]).toBe('bullets'); // the run's opener sets the pattern — never re-cut

    const few = Array.from({ length: 3 }, () => parseSlideContent('a\nb\nc\nd'));
    expect(applyDeckRhythm(Array(3).fill('bullets') as SlideLayoutId[], few)).toEqual(['bullets', 'bullets', 'bullets']);
  });

  it('does not re-cut a slide too thin to split', () => {
    const thin = Array.from({ length: 5 }, () => parseSlideContent('only one'));
    expect(applyDeckRhythm(Array(5).fill('bullets') as SlideLayoutId[], thin).every((l) => l === 'bullets')).toBe(true);
  });
});

describe('layout registry', () => {
  it('registers exactly twenty layouts, each with a master and a renderer', () => {
    expect(LAYOUT_ORDER).toHaveLength(20);
    expect(new Set(LAYOUT_ORDER).size).toBe(20);
    expect(layoutCatalog()).toHaveLength(20);
    for (const id of LAYOUT_ORDER) {
      expect(LAYOUTS[id].master, `${id} master`).toMatch(/^OSHAL_/);
      expect(typeof LAYOUTS[id].render).toBe('function');
      expect(LAYOUTS[id].needs.length).toBeGreaterThan(0);
    }
  });
});

describe('image safety', () => {
  // A slide's `#image:` is author-supplied, and pptxgenjs would fetch it from the api container
  // itself at write time. That makes an image reference an SSRF vector and a corruption vector,
  // so both are closed before a layout ever sees it.
  const PNG = 'data:image/png;base64,' + Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52,
  ]).toString('base64');

  it('blocks loopback, private, CGNAT and cloud-metadata addresses (via the shared guard)', () => {
    for (const ip of ['127.0.0.1', '10.0.0.5', '172.16.4.2', '192.168.1.1', '169.254.169.254',
      '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '::ffff:10.0.0.1']) {
      expect(isPrivateIp(ip), `${ip} must be blocked`).toBe(true);
    }
  });

  it('allows ordinary public addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700::1111']) {
      expect(isPrivateIp(ip), `${ip} must be allowed`).toBe(false);
    }
  });

  it('identifies images by magic bytes, not by a claimed type', () => {
    expect(sniffImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]))).toBe('image/png');
    expect(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8]))).toBe('image/jpeg');
    // The exact failure the renderer hits in the wild: a 404 page served as a .jpg.
    expect(sniffImageMime(Buffer.from('<!doctype html><html>404 not found</html>'))).toBeNull();
  });

  it('accepts a real data URI and refuses a lying one', async () => {
    await expect(resolveImage(PNG)).resolves.toContain('data:image/png;base64,');
    await expect(resolveImage('data:image/png;base64,' + Buffer.from('not an image').toString('base64'))).resolves.toBeNull();
    await expect(resolveImage('javascript:alert(1)')).resolves.toBeNull();
    await expect(resolveImage('file:///etc/passwd')).resolves.toBeNull();
    await expect(resolveImage('')).resolves.toBeNull();
  });

  it('refuses to fetch an internal host on an author’s behalf', async () => {
    await expect(resolveImage('http://169.254.169.254/latest/meta-data/')).resolves.toBeNull();
    await expect(resolveImage(`${apiOrigin()}/api/health`)).resolves.toBeNull();
    await expect(resolveImage('http://[::1]:80/x.png')).resolves.toBeNull();
    await expect(resolveImage('http://127.0.0.1:9/x.png')).resolves.toBeNull();
  });

  it('refuses a URL whose host resolves to a private address, even dressed as a real name', async () => {
    // localtest.me resolves to 127.0.0.1 in public DNS — the classic way to smuggle a loopback
    // target past a name-only allowlist. It must come back null whether it was blocked because
    // the resolved address is private (the guard working) or because a hermetic runner has no
    // DNS to resolve it at all — both are the security-correct outcome for the deck.
    await expect(resolveImage('http://localtest.me/x.png')).resolves.toBeNull();
  });

  it('aborts an oversized body mid-stream instead of buffering it (the memory DoS)', async () => {
    // The hole the first cut had: arrayBuffer() read the whole stream before the size check, so a
    // host answering with no Content-Length and a huge body exhausted the api container's memory.
    // fetchCapped must destroy the request the moment the byte cap is crossed. Driven directly
    // (bypassing resolveImage's IP guard) against a loopback flood — an IP-literal host skips the
    // connect-time lookup, so this exercises the cap and nothing else.
    let sent = 0;
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'image/png' }); // NO content-length → unbounded framing
      const chunk = Buffer.alloc(1024 * 1024, 0x41);
      const pump = () => {
        if (sent > 64 * 1024 * 1024) { res.end(); return; }
        sent += chunk.length;
        if (res.write(chunk)) setImmediate(pump); else res.once('drain', pump);
      };
      pump();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const out = await fetchCapped(`http://127.0.0.1:${port}/big.png`);
      expect(out).toBeNull();
      // The whole point: it stopped near the 8MB cap, nowhere near the 64MB the server would send.
      expect(sent).toBeLessThan(24 * 1024 * 1024);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('embeds a real image fetched over http, and sniffs it by content', async () => {
    // The happy path, proving the fetch path actually delivers a usable image end to end.
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(64, 7), // enough bytes to clear the 12-byte sniff floor
    ]);
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(png.length) });
      res.end(png);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const out = await fetchCapped(`http://127.0.0.1:${port}/ok.png`);
      expect(out?.mime).toBe('image/png');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('embeds a valid image, and renders the slide without one when it is refused', async () => {
    const ok = await renderPptx('T', [{ title: 'Shot', content: `#image: ${PNG}` }]);
    const zip = await JSZip.loadAsync(ok);
    expect(Object.keys(zip.files).some((n) => n.startsWith('ppt/media/') && !zip.files[n].dir)).toBe(true);

    // Refused image → the layout falls back to type, and the deck still renders.
    const blocked = await renderPptx('T', [{ title: 'Shot', content: '#image: http://169.254.169.254/x.png' }]);
    const zip2 = await JSZip.loadAsync(blocked);
    expect(Object.keys(zip2.files).some((n) => n.startsWith('ppt/media/') && !zip2.files[n].dir)).toBe(false);
    expect(blocked.length).toBeGreaterThan(5_000);
  });
});

describe('rendered .pptx', () => {
  it('is a valid OOXML package with the six theme masters', async () => {
    const buf = await renderPptx('Q3 Review', KITCHEN_SINK, { theme: 'executive' });
    const p = await parts(buf);
    expect(buf.subarray(0, 2).toString()).toBe('PK'); // a .pptx is a zip
    expect(p['ppt/presentation.xml']).toBeDefined();
    expect(Object.keys(p).filter((k) => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(k)).length).toBeGreaterThanOrEqual(6);
    const layouts = Object.keys(p).filter((k) => k.startsWith('ppt/slideLayouts/slideLayout'))
      .map((k) => /name="([^"]+)"/.exec(p[k])?.[1]).filter(Boolean);
    for (const m of ['OSHAL_COVER', 'OSHAL_SECTION', 'OSHAL_CONTENT', 'OSHAL_CANVAS', 'OSHAL_FEATURE', 'OSHAL_CLOSING']) {
      expect(layouts, `master ${m}`).toContain(m);
    }
  });

  it('uses PowerPoint’s real 16:9 size, not pptxgenjs’s 13.3in LAYOUT_WIDE', async () => {
    const p = await parts(await renderPptx('T', KITCHEN_SINK));
    // 13.333in x 7.5in in EMU (914400 per inch).
    expect(p['ppt/presentation.xml']).toContain('cx="12192000"');
    expect(p['ppt/presentation.xml']).toContain('cy="6858000"');
  });

  it('binds titles to real title placeholders so Outline view works', async () => {
    const p = await parts(await renderPptx('T', [{ title: 'A real title', content: 'a\nb' }]));
    const slide = p['ppt/slides/slide2.xml'];
    expect(slide).toContain('type="title"');
    expect(slide).toContain('A real title');
  });

  it('emits slide numbers as fields that renumber on reorder — not static text', async () => {
    const p = await parts(await renderPptx('T', KITCHEN_SINK));
    expect(p['ppt/slides/slide2.xml']).toContain('type="slidenum"');
  });

  it('omits the number field entirely when slideNumbers is off', async () => {
    const p = await parts(await renderPptx('T', KITCHEN_SINK, { slideNumbers: false }));
    const slides = Object.keys(p).filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k));
    expect(slides.some((k) => p[k].includes('type="slidenum"'))).toBe(false);
  });

  it('renders charts natively with an embedded workbook, not as pictures', async () => {
    // Double-click-to-edit-the-data is the difference between a deck and a picture of a deck.
    const zip = await JSZip.loadAsync(await renderPptx('T', KITCHEN_SINK));
    const names = Object.keys(zip.files);
    expect(names.some((n) => /^ppt\/charts\/chart\d+\.xml$/.test(n))).toBe(true);
    expect(names.some((n) => /^ppt\/embeddings\/.*\.xlsx$/.test(n))).toBe(true);
    // Note `!zip.files[n].dir`: pptxgenjs always creates an empty `ppt/media/` FOLDER entry,
    // so the check has to be for image FILES, not for the directory's existence.
    expect(names.some((n) => n.startsWith('ppt/media/') && !zip.files[n].dir)).toBe(false);
  });

  it('renders tables as native <a:tbl>, so cells stay editable', async () => {
    const p = await parts(await renderPptx('T', [{ title: 'T', content: '| A | B |\n| --- | --- |\n| 1 | 2 |' }]));
    expect(p['ppt/slides/slide2.xml']).toContain('<a:tbl>');
  });

  it('carries speaker notes through', async () => {
    const p = await parts(await renderPptx('T', [{ title: 'A', content: 'x', notes: 'say this out loud' }]));
    expect(Object.keys(p).some((k) => k.startsWith('ppt/notesSlides/') && p[k].includes('say this out loud'))).toBe(true);
  });

  it('composes a cover plus one slide per section', async () => {
    const p = await parts(await renderPptx('Deck', KITCHEN_SINK));
    const slides = Object.keys(p).filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k));
    expect(slides).toHaveLength(KITCHEN_SINK.length + 1);
  });

  it('renders every theme without throwing', async () => {
    for (const id of THEME_IDS) {
      const buf = await renderPptx(`${id} deck`, KITCHEN_SINK, { theme: id as DeckThemeId, byline: 'oshal maintainers' });
      expect(buf.length, `${id} produced an empty file`).toBeGreaterThan(10_000);
    }
  });

  it('renders every layout, in every theme, against content it was not designed for', async () => {
    // The degradation guarantee: a layout forced onto the wrong content must still produce a
    // slide rather than an empty frame or a throw. This is the case a user hits by typing
    // `#layout:` on a whim, and it is why every layout has an `anyLines`-style fallback.
    const hostile = [
      { title: 'Only a title', content: '' },
      { title: 'One line', content: 'just this' },
    ];
    for (const id of THEME_IDS) {
      for (const layout of LAYOUT_ORDER) {
        const buf = await renderPptx('Edge', hostile.map((h) => ({ ...h, layout })), { theme: id as DeckThemeId });
        expect(buf.length, `${id}/${layout} produced an empty file`).toBeGreaterThan(5_000);
      }
    }
  }, 120_000);

  it('survives hostile input without throwing', async () => {
    await expect(renderPptx('', [])).resolves.toBeInstanceOf(Buffer);
    await expect(renderPptx('T', [{ title: '', content: '' }])).resolves.toBeInstanceOf(Buffer);
    await expect(renderPptx('T', [{ title: 'x'.repeat(5000), content: 'y'.repeat(20000) }])).resolves.toBeInstanceOf(Buffer);
    await expect(renderPptx('T', [{ title: 'Angle < & > brackets "quoted"', content: '<script>alert(1)</script>' }]))
      .resolves.toBeInstanceOf(Buffer);
  });

  it('escapes XML metacharacters rather than corrupting the package', async () => {
    const p = await parts(await renderPptx('T', [{ title: 'A & B <tag>', content: 'x' }]));
    expect(p['ppt/slides/slide2.xml']).toContain('A &amp; B &lt;tag&gt;');
  });
});
