/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | The static BUG-12 gate proves a surface CONSUMES theme tokens; it cannot see a role mapped onto a plausible-but-wrong token, because such a mapping is still a `var()`, nor a dark-authored `rgba()` left behind outside a `:root` block. This walk renders the converted surfaces in a real Chromium in one light theme and one dark theme and measures the RESULT: every run of text is compared against the pixel actually painted behind it, so gradients, translucency and blur composite exactly as an operator sees them, and every declared border must paint a pixel that differs from the fill on at least one side. `.auth-ok` shipped with `background` and `color` both `var(--status-success)` — a static check reads two correct tokens, an operator reads an empty green lozenge.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { startCoreSurfaceThemeFixture } from '../fixtures/core-surface-theme';
import { APPEARANCE_SCENARIOS } from '@/app/routes/test-lab-appearance-scenarios';

/** One light theme and one dark theme: the two extremes a mis-mapped role fails in. */
const THEMES = ['daylight', 'midnight'] as const;

/** A state the surface's own script produces, plus the source substring that proves it still does. */
interface SurfaceState { selector: string; className?: string; html?: string; enable?: boolean; provenance: string }

/**
 * The converted surfaces this walk covers. `source` is the file whose script produces the states;
 * `minBorders` is the number of bordered panels the anonymous view is known to paint — /applications
 * paints none, because every bordered block on it is an operator panel served `display: none`.
 */
const WALK: { name: string; path: string; source: string; minBorders: number; states: SurfaceState[] }[] = [
  {
    name: 'swarm-control', path: '/swarm-control', source: 'src/pages/swarm-control/swarm-control.js', minBorders: 3,
    states: [
      { selector: '#botAuthStatus', className: 'auth-badge auth-ok', provenance: "'auth-badge auth-ok'" },
      { selector: '#propagateStatus', className: 'propagate-status status-ok', html: '<span id="propagateMessage">Synthetic propagation result</span>', provenance: "'propagate-status status-ok'" },
      { selector: '#chatInput', enable: true, provenance: 'chatInput.disabled' },
      { selector: '#sendBtn', enable: true, provenance: 'sendBtn.disabled' },
      {
        selector: '#chatMessages', provenance: '<div class="msg-sender">',
        html: '<div class="chat-msg user"><div class="msg-sender">Operator</div><div class="msg-body">Synthetic walk message</div></div>'
              + '<div class="chat-msg bot"><div class="msg-sender">Bot</div><div class="msg-body">Synthetic walk reply</div></div>',
      },
    ],
  },
  {
    name: 'swarm-control (auth missing)', path: '/swarm-control', source: 'src/pages/swarm-control/swarm-control.js', minBorders: 3,
    states: [
      { selector: '#botAuthStatus', className: 'auth-badge auth-none', provenance: "'auth-badge auth-none'" },
      { selector: '#propagateStatus', className: 'propagate-status status-partial', html: '<span id="propagateMessage">Synthetic partial result</span>', provenance: "'propagate-status status-partial'" },
    ],
  },
  { name: 'task-explorer', path: '/task-explorer', source: 'src/pages/task-explorer/task-explorer.js', minBorders: 15, states: [] },
  { name: 'workflow-studio', path: '/workflow-studio', source: 'src/pages/workflow-studio/workflow-studio.js', minBorders: 5, states: [] },
  { name: 'applications', path: '/applications', source: 'src/pages/applications/index.html', minBorders: 0, states: [] },
];

/** WCAG 2.1: 3:1 for large text (>=24px, or >=18.66px at weight >=700), 4.5:1 for everything else. */
const LARGE_TEXT_RATIO = 3;
const BODY_TEXT_RATIO = 4.5;
const VIEWPORT = { width: 1280, height: 1400 };

interface TextRun { label: string; color: string; fontSize: number; weight: number; x: number; y: number }
interface BorderEdge { label: string; x: number; outside: number; rows: number[]; inside: number }

let fixture: Awaited<ReturnType<typeof startCoreSurfaceThemeFixture>>;
let browser: Browser;

beforeAll(async () => {
  fixture = await startCoreSurfaceThemeFixture();
  browser = await chromium.launch({ headless: true });
}, 60000);
afterAll(async () => { await browser?.close(); await fixture?.close(); });

/** Relative luminance of an sRGB triple, per WCAG 2.1. */
function luminance(rgb: number[]): number {
  const linear = rgb.slice(0, 3).map((value) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

/** Contrast ratio between two opaque sRGB triples. */
function contrast(first: number[], second: number[]): number {
  const [low, high] = [luminance(first), luminance(second)].sort((a, b) => a - b);
  return (high + 0.05) / (low + 0.05);
}

/**
 * Composite a possibly translucent computed colour over the pixel measured behind it.
 * Chromium serialises a `color-mix()` result as `color(srgb r g b / a)` with 0-1 components —
 * read as 0-255 that reports near-black, which silently passes every light backdrop.
 */
function overBackdrop(color: string, backdrop: number[]): number[] {
  const parts = (color.match(/[\d.]+/g) ?? []).map(Number);
  const scale = color.trimStart().startsWith('color(srgb') ? 255 : 1;
  const alpha = parts.length > 3 ? parts[3] : 1;
  return [0, 1, 2].map((index) => parts[index] * scale * alpha + backdrop[index] * (1 - alpha));
}

/** Read one RGB pixel out of a raw RGB buffer. */
function pixel(buffer: Buffer, width: number, x: number, y: number): number[] {
  const offset = (Math.round(y) * width + Math.round(x)) * 3;
  return [buffer[offset], buffer[offset + 1], buffer[offset + 2]];
}

/**
 * Put the surface into the states its own script produces, after proving that script still
 * produces them — a walk that measures a state the surface stopped shipping proves nothing.
 */
async function applyStates(page: Page, surface: (typeof WALK)[number]): Promise<void> {
  const source = readFileSync(resolve(surface.source), 'utf8');
  for (const state of surface.states) {
    expect(source, `${surface.source} no longer contains ${state.provenance}; this walk is measuring a state the surface does not ship`)
      .toContain(state.provenance);
    await page.locator(state.selector).evaluate((node, applied: SurfaceState) => {
      if (applied.className) node.className = applied.className;
      if (applied.html) node.innerHTML = applied.html;
      if (applied.enable) node.removeAttribute('disabled');
      (node as HTMLElement).style.removeProperty('display');
    }, state);
  }
  await page.evaluate(() => document.fonts.ready);
}

/** Every non-blank run of text in the viewport, with the ink colour Chromium resolved for it. */
async function textRuns(page: Page): Promise<TextRun[]> {
  return page.evaluate(() => {
    const runs: TextRun[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const element = node.parentElement;
      if (!node.nodeValue?.trim() || !element) continue;
      // WCAG 1.4.3 exempts inactive components; a dimmed disabled control is the intended affordance.
      if (element.closest('[disabled]') || Number(getComputedStyle(element).opacity) < 0.95) continue;
      const style = getComputedStyle(element);
      if (style.visibility === 'hidden' || style.webkitTextFillColor === 'rgba(0, 0, 0, 0)') continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const rect = range.getBoundingClientRect();
      if (rect.width < 6 || rect.height < 6) continue;
      if (rect.top < 1 || rect.left < 1 || rect.bottom > innerHeight - 1 || rect.right > innerWidth - 1) continue;
      const names = String(element.className || '').trim().split(/\s+/).filter(Boolean).join('.');
      runs.push({
        label: `${element.tagName.toLowerCase()}${names ? '.' + names : ''} "${node.nodeValue.trim().slice(0, 32)}"`,
        color: style.color, fontSize: parseFloat(style.fontSize), weight: Number(style.fontWeight) || 400,
        x: rect.left + rect.width / 2, y: rect.top + rect.height / 2,
      });
    }
    return runs;
  }) as Promise<TextRun[]>;
}

/** Sample points across every declared top border: just outside it, on it, and just inside it. */
async function borderEdges(page: Page): Promise<BorderEdge[]> {
  return page.evaluate(() => {
    const edges: BorderEdge[] = [];
    for (const element of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
      const style = getComputedStyle(element);
      if (style.visibility === 'hidden' || Number(style.opacity) < 0.95) continue;
      if (element.closest('[disabled]')) continue;
      const width = Math.round(parseFloat(style.borderTopWidth));
      if (!width || style.borderTopStyle === 'none' || style.borderTopStyle === 'hidden') continue;
      const rect = element.getBoundingClientRect();
      if (rect.width < 40 || rect.height < 12) continue;
      if (rect.top < 3 || rect.top + width + 3 > innerHeight || rect.left < 0 || rect.right > innerWidth) continue;
      const names = String(element.className || '').trim().split(/\s+/).filter(Boolean).join('.');
      // A 1px border on a fractional offset lands on one of two device rows; try every row it can occupy.
      const rows: number[] = [];
      for (let row = Math.floor(rect.top); row <= Math.ceil(rect.top + width) - 1; row += 1) rows.push(row);
      edges.push({
        label: `${element.tagName.toLowerCase()}${names ? '.' + names : ''}`,
        x: rect.left + rect.width / 2, outside: rect.top - 2, rows, inside: rect.top + width + 2,
      });
    }
    return edges;
  }) as Promise<BorderEdge[]>;
}

/** Repaint with glyph fill removed so every sampled pixel is backdrop, never a letter. */
async function backdropPixels(page: Page): Promise<Buffer> {
  await page.addStyleTag({ content: '*, *::before, *::after { -webkit-text-fill-color: transparent !important; text-shadow: none !important; }' });
  const shot = await page.screenshot({ clip: { x: 0, y: 0, ...VIEWPORT } });
  return sharp(shot).removeAlpha().raw().toBuffer();
}

/** Optional evidence images for the human half of the walk. */
async function evidence(page: Page, name: string, theme: string): Promise<void> {
  const directory = process.env.SURFACE_THEME_WALK_DIR;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  await page.screenshot({ path: resolve(directory, `${name.replace(/[^a-z0-9]+/gi, '-')}-${theme}.png`) });
}

/** Open one surface under one theme, in its shipped states, with every external request refused. */
async function openSurface(surface: (typeof WALK)[number], theme: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: VIEWPORT, serviceWorkers: 'block' });
  await context.route('**/*', (route) => (new URL(route.request().url()).origin === fixture.origin ? route.continue() : route.abort()));
  await context.addInitScript((value) => localStorage.setItem('cockpit-theme', value), theme);
  const page = await context.newPage();
  await page.goto(fixture.origin + surface.path, { waitUntil: 'load' });
  await expect.poll(() => page.locator('html').getAttribute('data-theme')).toBe(theme);
  await applyStates(page, surface);
  return { context, page };
}

for (const surface of WALK) {
  for (const theme of THEMES) {
    it(`${surface.name} keeps every run of text readable in ${theme}`, async () => {
      const { context, page } = await openSurface(surface, theme);
      try {
        await evidence(page, surface.name, theme);
        const runs = await textRuns(page);
        expect(runs.length, 'the surface rendered no measurable text').toBeGreaterThan(5);
        const backdrop = await backdropPixels(page);
        const failures: string[] = [];
        for (const run of runs) {
          const behind = pixel(backdrop, VIEWPORT.width, run.x, run.y);
          const ratio = contrast(overBackdrop(run.color, behind), behind);
          const large = run.fontSize >= 24 || (run.fontSize >= 18.66 && run.weight >= 700);
          const floor = large ? LARGE_TEXT_RATIO : BODY_TEXT_RATIO;
          if (ratio < floor) failures.push(`${ratio.toFixed(2)}:1 (needs ${floor}:1) ${run.label} ink ${run.color} on rgb(${behind.join(',')})`);
        }
        expect(failures, `${surface.name} in ${theme}: text the operator cannot read.\n${failures.join('\n')}`).toEqual([]);
      } finally { await context.close(); }
    }, 60000);

    it(`${surface.name} paints every declared border in ${theme}`, async () => {
      const { context, page } = await openSurface(surface, theme);
      try {
        const edges = await borderEdges(page);
        expect(edges.length, 'fewer bordered panels rendered than this surface is known to paint').toBeGreaterThanOrEqual(surface.minBorders);
        const backdrop = await backdropPixels(page);
        const invisible = edges.filter((edge) => {
          const sample = (y: number) => pixel(backdrop, VIEWPORT.width, edge.x, y).join(',');
          const [outside, inside] = [sample(edge.outside), sample(edge.inside)];
          return edge.rows.every((row) => sample(row) === outside && sample(row) === inside);
        });
        expect(invisible.map((edge) => edge.label), `${surface.name} in ${theme}: a declared border paints the same pixel as the fill on both sides, so it does not exist on screen`).toEqual([]);
      } finally { await context.close(); }
    }, 60000);
  }
}

it('registers the contrast walk as appearance browser coverage without claiming the readiness card runs it', () => {
  expect(APPEARANCE_SCENARIOS.find((scenario) => scenario.id === 'cockpit-appearance')?.regressionTests)
    .toContainEqual({ level: 'browser', path: 'tests/unit/surface-theme-contrast-browser.spec.ts' });
});
