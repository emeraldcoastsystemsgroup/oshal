/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Render actual Users, Access, application administration and AI Lab pages across saved and live parent themes without business authority or writes.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { ALL_CORE_SURFACES, startCoreSurfaceThemeFixture } from '../fixtures/core-surface-theme';
import { APPEARANCE_SCENARIOS } from '@/app/routes/test-lab-appearance-scenarios';

let fixture: Awaited<ReturnType<typeof startCoreSurfaceThemeFixture>>;
let browser: Browser, context: BrowserContext, page: Page;
let external: string[];
const COLORS = { midnight: 'rgb(238, 238, 245)', daylight: 'rgb(26, 26, 46)', workspace: 'rgb(37, 43, 60)' } as const;

beforeAll(async () => { fixture = await startCoreSurfaceThemeFixture(); browser = await chromium.launch({ headless: true }); }, 30000);
beforeEach(async () => {
  context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
  external = []; fixture.mutations.length = 0;
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin === fixture.origin) return route.continue();
    external.push(route.request().url()); return route.abort();
  });
  page = await context.newPage();
});
afterEach(async () => { await context.close(); expect(fixture.mutations).toEqual([]); expect(external).toEqual([]); });
afterAll(async () => { await browser.close(); await fixture.close(); });

/** Optional images contain only actual core chrome with explicitly synthetic refused data reads. */
async function screenshot(name: string, theme: string) {
  const directory = process.env.CORE_SURFACE_THEME_EVIDENCE_DIR;
  if (!directory || !['Applications', 'Access', 'AI Test Lab', 'queue-dashboard', 'run-trace', 'rag-center'].includes(name)) return;
  mkdirSync(directory, { recursive: true });
  await page.screenshot({ path: resolve(directory, name.toLowerCase().replaceAll(' ', '-') + '-' + theme + '.png'), fullPage: false });
}

/** Contrast uses rendered backdrop pixels, including gradients, transparency and blur. */
function luminance(values: number[]): number {
  const linear = values.slice(0, 3).map(value => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

it.each(['midnight', 'daylight', 'workspace'] as const)('keeps the actual RAG hero heading and description readable in %s', async theme => {
  await context.addInitScript(value => localStorage.setItem('cockpit-theme', value), theme);
  await page.goto(fixture.origin + '/rag-center');
  const hero = (await page.locator('.hero').boundingBox())!;
  for (const selector of ['.hero h1', '.hero-copy']) {
    const label = page.locator(selector), box = (await label.boundingBox())!;
    const ink = await label.evaluate(node => getComputedStyle(node).color.match(/[\d.]+/g)!.map(Number));
    // Sample clear hero padding at the same height as the text, away from its glyphs and rounded border.
    const pixel = await page.screenshot({ clip: { x: hero.x + 12, y: box.y + box.height / 2, width: 1, height: 1 } });
    const background = Array.from(await sharp(pixel).removeAlpha().raw().toBuffer());
    const light = [luminance(ink), luminance(background)].sort((a, b) => a - b);
    expect((light[1] + 0.05) / (light[0] + 0.05)).toBeGreaterThanOrEqual(4.5);
  }
});

for (const surface of ALL_CORE_SURFACES) {
  it.each(['midnight', 'daylight', 'workspace'] as const)(`${surface.name} renders readable actual HTML in %s`, async theme => {
    await context.addInitScript(value => localStorage.setItem('cockpit-theme', value), theme);
    await page.goto(fixture.origin + surface.path);
    await expect.poll(() => page.locator('html').getAttribute('data-theme')).toBe(theme);
    await expect.poll(() => page.locator('body').evaluate(node => getComputedStyle(node).color)).toBe(COLORS[theme]);
    expect(await page.locator(surface.name === 'workflow-studio' ? '.brand-name' : 'h1').first().isVisible()).toBe(true);
    const palette = await page.locator('html').evaluate(node => {
      const css = getComputedStyle(node);
      return { background: css.getPropertyValue('--bg-primary').trim(), ink: css.getPropertyValue('--text-primary').trim() };
    });
    expect(palette.background).not.toBe(''); expect(palette.ink).not.toBe('');
    expect(await page.locator('html').evaluate(node => getComputedStyle(node).colorScheme)).toBe(theme === 'midnight' ? 'dark' : 'light');
    await screenshot(surface.name, theme);
  }, 15000);

  it(`${surface.name} follows parent theme changes without reloading its document or changing the saved palette`, async () => {
    await context.addInitScript(() => localStorage.setItem('cockpit-theme', 'daylight'));
    await page.goto(fixture.origin + '/fixture/parent?surface=' + encodeURIComponent(surface.path));
    const frame = page.frameLocator('iframe');
    await expect.poll(() => frame.locator('html').getAttribute('data-theme')).toBe('workspace');
    await frame.locator('html').evaluate(node => { node.setAttribute('data-test-document', 'preserved'); });
    if (surface.name === 'run-trace') await frame.locator('#tid').fill('Synthetic unsent ticket query');
    await page.locator('#parentDraft').fill('Synthetic unsaved text');
    await page.evaluate(() => { document.documentElement.dataset.theme = 'midnight'; });
    await expect.poll(() => frame.locator('body').evaluate(node => getComputedStyle(node).color)).toBe(COLORS.midnight);
    await page.evaluate(() => { document.documentElement.dataset.theme = 'workspace'; });
    await expect.poll(() => frame.locator('body').evaluate(node => getComputedStyle(node).color)).toBe(COLORS.workspace);
    expect(await frame.locator('html').getAttribute('data-test-document')).toBe('preserved');
    expect(await page.locator('#parentDraft').inputValue()).toBe('Synthetic unsaved text');
    if (surface.name === 'run-trace') expect(await frame.locator('#tid').inputValue()).toBe('Synthetic unsent ticket query');
    expect(await page.evaluate(() => localStorage.getItem('cockpit-theme'))).toBe('daylight');
  }, 15000);
}

it('updates an already-open standalone Users page when another portal document changes the saved choice', async () => {
  await context.addInitScript(() => localStorage.setItem('cockpit-theme', 'midnight'));
  await page.goto(fixture.origin + '/users');
  const portal = await context.newPage(); await portal.goto(fixture.origin + '/fixture/parent?surface=%2Faccess');
  await portal.evaluate(() => localStorage.setItem('cockpit-theme', 'workspace'));
  await expect.poll(() => page.locator('html').getAttribute('data-theme')).toBe('workspace');
  await expect.poll(() => page.locator('body').evaluate(node => getComputedStyle(node).color)).toBe(COLORS.workspace);
});

it('keeps invalid and unavailable saved preferences readable without persisting a replacement', async () => {
  await context.addInitScript(() => localStorage.setItem('cockpit-theme', 'missing-theme'));
  await page.goto(fixture.origin + '/access');
  await expect.poll(() => page.locator('html').getAttribute('data-theme')).toBe('midnight');
  expect(await page.evaluate(() => localStorage.getItem('cockpit-theme'))).toBe('missing-theme');
  await context.addInitScript(() => { Storage.prototype.getItem = () => { throw Error('synthetic storage unavailable'); }; });
  await page.goto(fixture.origin + '/api/test-lab/app');
  await expect.poll(() => page.locator('body').evaluate(node => getComputedStyle(node).color)).toBe(COLORS.midnight);
});

it('registers core surface rendering as browser coverage without claiming the readiness card executes it', () => {
  expect(APPEARANCE_SCENARIOS.find(scenario => scenario.id === 'cockpit-appearance')?.regressionTests)
    .toContainEqual({ level: 'browser', path: 'tests/unit/core-surface-theme-browser.spec.ts' });
});
