/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove the shared audience-view kit in headless Chromium over the real /shared/ui mounts: a page keeps its full UI without a request, ignores an audience it does not provide, renders the family and company grammars from one model with text-only nodes, hides the full UI, keeps one escape that navigates the top window out of a frame, and turns a failed read into a retryable notice instead of a blank frame.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Date-only strings format as the reader's calendar day (Sep 15 stays Sep 15; a date-only today is 'today')
 * 3 | maintainer@emeraldcoastsystemsgroup.com | No header/h1/h2/h3 inside the kit root (heading roles instead) so host-page tag rules cannot restyle a view
 * 4 | maintainer@emeraldcoastsystemsgroup.com | AppView.day under America/Chicago: a UTC-midnight DATE value ('YYYY-MM-DDT00:00:00(.000)Z') and a plain 'YYYY-MM-DD' print as their own day, while AppView.date of the same instant shows the day before (the precondition)
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { startExperienceBrowserFixture } from '../fixtures/experience-browser';

vi.mock('@/shared/logger', () => ({ createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
vi.setConfig({ testTimeout: 90000, hookTimeout: 60000 });

let browser: Browser, context: BrowserContext, page: Page;
let fixture: Awaited<ReturnType<typeof startExperienceBrowserFixture>>;
const errors: string[] = [];

beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
afterAll(async () => { await browser?.close(); });
beforeEach(async () => {
  fixture = await startExperienceBrowserFixture();
  context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  await context.route('**/*', route => new URL(route.request().url()).origin === fixture.origin ? route.continue() : route.abort());
  page = await context.newPage();
  page.setDefaultTimeout(20000);
  errors.length = 0;
  page.on('pageerror', e => errors.push(String(e && (e as Error).message || e)));
});
afterEach(async () => { await context?.close(); await fixture?.close(); });

/** @description Open the synthetic application page with a query string and wait for the kit to decide. */
async function open(query: string) {
  await page.goto(`${fixture.origin}/fixture/app-view${query}`);
  await page.waitForFunction(() => typeof (window as unknown as { AppView?: unknown }).AppView === 'object');
}
const bodyText = () => page.evaluate(() => document.body.innerText);
const visible = (selector: string) => page.evaluate(sel => { const el = document.querySelector(sel) as HTMLElement | null; return !!el && getComputedStyle(el).display !== 'none'; }, selector);

describe('shared audience-view kit', () => {
  it('runs the full page when no audience is requested and when the requested one is not provided', async () => {
    await open('');
    await page.waitForFunction(() => (window as unknown as { __full: boolean }).__full === true);
    expect(await page.locator('#av-root').count()).toBe(0);
    expect(await page.evaluate(() => document.documentElement.getAttribute('data-audience'))).toBeNull();
    expect(await page.evaluate(() => (window as unknown as { AppView: { active(): string | null } }).AppView.active())).toBeNull();
    expect(await visible('#full-ui')).toBe(true);

    await open('?audience=classroom');
    await page.waitForFunction(() => (window as unknown as { __full: boolean }).__full === true);
    expect(await page.locator('#av-root').count()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { AppView: { audience(): string | null } }).AppView.audience())).toBe('classroom');

    await open('?audience=marketing');
    await page.waitForFunction(() => (window as unknown as { __full: boolean }).__full === true);
    expect(await page.evaluate(() => (window as unknown as { AppView: { audience(): string | null } }).AppView.audience())).toBeNull();
    expect(errors).toEqual([]);
  });

  it('renders the family grammar from one model, hides the full UI and never parses model text as HTML', async () => {
    const hostile = '<img src=x onerror="window.__xss=1">Synthetic home';
    await open(`?audience=family&doc=${encodeURIComponent('Synthetic family')}&title=${encodeURIComponent(hostile)}`);
    await page.waitForSelector('#av-root .av-title');
    expect(await page.evaluate(() => document.documentElement.getAttribute('data-audience'))).toBe('family');
    expect(await page.locator('#av-root').getAttribute('data-audience')).toBe('family');
    expect(await page.title()).toBe('Synthetic family');
    expect(await page.evaluate(() => (window as unknown as { __full: boolean }).__full)).toBe(false);
    expect(await visible('#full-ui')).toBe(false);
    expect(await page.locator('.av-title').textContent()).toBe(hostile);
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
    expect(await page.locator('.av-title img').count()).toBe(0);
    expect(await page.locator('#av-root header, #av-root h1, #av-root h2, #av-root h3').count()).toBe(0);
    expect(await page.locator('.av-title').getAttribute('role')).toBe('heading');

    expect(await page.locator('.av-stat').count()).toBe(3);
    expect(await page.locator('.av-stat.tone-warn .av-stat-value').textContent()).toBe('2');
    expect(await page.locator('.av-kind-tiles .av-tile').count()).toBe(2);
    await page.locator('.av-tile', { hasText: 'Synthetic kitchen' }).click();
    expect(await page.evaluate(() => (window as unknown as { __opened: string }).__opened)).toBe('Synthetic kitchen');
    await page.locator('.av-btn.is-primary', { hasText: 'Run a scene' }).click();
    expect(await page.evaluate(() => (window as unknown as { __acted: string }).__acted)).toBe('scene');
    expect(await page.locator('[data-section="events"] .av-item .av-badge.tone-info').textContent()).toBe('family');
    expect(await page.locator('[data-section="empty"] .av-empty').textContent()).toBe('Nothing planned.');
    expect(await page.locator('[data-section="bills"] td.is-right').textContent()).toBe('$120.00');
    expect(await page.locator('.av-bar-fill').evaluate(el => (el as HTMLElement).style.width)).toBe('40%');
    expect(await page.locator('.av-time-title').textContent()).toBe('Synthetic event');
    expect(await page.locator('[data-section="custom"] .av-custom').textContent()).toBe('Synthetic custom part');
    expect(await page.locator('.av-escape-link').getAttribute('href')).toBe('/cockpit/?app=synthetic');
    expect(errors).toEqual([]);
  });

  it('renders the company grammar and refreshes in place', async () => {
    await open('?audience=company');
    await page.waitForSelector('#av-root .av-table');
    expect(await page.locator('#av-root').getAttribute('data-audience')).toBe('company');
    expect(await page.locator('[data-section="ledger"] tbody tr').count()).toBe(2);
    expect(await bodyText()).toContain('Synthetic payroll');
    expect(await page.evaluate(() => (window as unknown as { __fetches: number[] }).__fetches)).toEqual([200]);
    await page.evaluate(() => (window as unknown as { __ctx: { refresh(): Promise<unknown> } }).__ctx.refresh());
    await page.waitForFunction(() => (window as unknown as { __fetches: number[] }).__fetches.length === 2);
    expect(await page.locator('[data-section="ledger"] tbody tr').count()).toBe(2);
    expect(errors).toEqual([]);
  });

  it('turns a failed read into a retryable notice with the escape kept, never a blank frame', async () => {
    fixture.state.status['appview'] = 503;
    await open('?audience=family');
    await page.waitForSelector('#av-root.is-error');
    expect(await page.locator('.av-title').textContent()).toBe('This view could not load');
    expect(await page.locator('.av-lede').textContent()).toContain('HTTP 503');
    expect(await page.locator('.av-escape-link').getAttribute('href')).toBe('/cockpit/?app=synthetic');
    fixture.state.status['appview'] = 200;
    await page.locator('.av-btn.is-primary', { hasText: 'Try again' }).click();
    await page.waitForSelector('#av-root:not(.is-error) .av-kind-tiles');
    expect(await page.locator('.av-title').textContent()).toBe('Your synthetic home');
    expect(errors).toEqual([]);
  });

  it('formats money, counts, ratios and dates for the reader', async () => {
    await open('');
    const out = await page.evaluate(() => {
      const AV = (window as unknown as { AppView: Record<string, (...a: unknown[]) => string> }).AppView;
      return [AV.money(1234.5), AV.money(12), AV.money(null), AV.num(12400), AV.num(2500000), AV.num(42), AV.pct(0.256), AV.pct(80, true),
        AV.when(new Date(Date.now() + 3 * 864e5).toISOString()), AV.when(new Date(Date.now() - 2 * 36e5).toISOString()), AV.when(null), AV.date('nonsense'),
        // Date-only strings are the reader's calendar day in every zone (UTC-midnight parsing showed Sep 14 for Sep 15 west of Greenwich).
        AV.date(new Date().getFullYear() + '-09-15'), AV.date('2025-01-02'), AV.when(localDay(0)), AV.when(localDay(1)), AV.when(localDay(-3))];
      function localDay(offsetDays: number) { const d = new Date(); d.setDate(d.getDate() + offsetDays); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
    });
    expect(out).toEqual(['$1,235', '$12.00', '—', '12.4k', '2.5M', '42', '26%', '80%', 'in 3 days', '2 h ago', '—', '—', 'Sep 15', 'Jan 2, 2025', 'today', 'tomorrow', '3 days ago']);
  });

  it('AppView.day prints a UTC-midnight DATE value as its own day for a reader in a US zone', async () => {
    await context.close();
    context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce', timezoneId: 'America/Chicago', locale: 'en-US' });
    await context.route('**/*', route => new URL(route.request().url()).origin === fixture.origin ? route.continue() : route.abort());
    page = await context.newPage();
    await open('');
    const year = new Date().getFullYear();
    const out = await page.evaluate(y => {
      const AV = (window as unknown as { AppView: Record<string, (v: unknown) => string> }).AppView;
      // The instant form first: in this zone `date()` of UTC midnight is the evening before, the defect `day()` exists for.
      return [AV.date(y + '-09-15T00:00:00.000Z'), AV.day(y + '-09-15T00:00:00.000Z'), AV.day(y + '-09-15T00:00:00Z'), AV.day(y + '-09-15'),
        AV.day('2025-01-02T00:00:00.000Z'), AV.day(y + '-09-15T05:00:00.000Z'), AV.day(null), AV.day('nonsense')];
    }, year);
    expect(out).toEqual(['Sep 14', 'Sep 15', 'Sep 15', 'Sep 15', 'Jan 2, 2025', 'Sep 15', '—', '—']);
  });

  it('escapes from a frame by navigating the top window to the full application', async () => {
    await page.goto(`${fixture.origin}/fixture/app-view/host`);
    const frame = page.frameLocator('#host-frame');
    await frame.locator('.av-escape-link').waitFor();
    expect(await frame.locator('#av-root').getAttribute('data-audience')).toBe('family');
    await Promise.all([page.waitForURL(/\/cockpit\/\?app=synthetic$/), frame.locator('.av-escape-link').click()]);
    expect(await bodyText()).toContain('Cockpit synthetic');
  });
});
