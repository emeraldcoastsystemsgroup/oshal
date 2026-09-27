/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove the shared audience-view kit in headless Chromium over the real /shared/ui mounts: a page keeps its full UI without a request, ignores an audience it does not provide, renders the family and company grammars from one model with text-only nodes, hides the full UI, keeps one escape that navigates the top window out of a frame, and turns a failed read into a retryable notice instead of a blank frame.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Date-only strings format as the reader's calendar day (Sep 15 stays Sep 15; a date-only today is 'today')
 * 3 | maintainer@emeraldcoastsystemsgroup.com | No header/h1/h2/h3 inside the kit root (heading roles instead) so host-page tag rules cannot restyle a view
 * 4 | maintainer@emeraldcoastsystemsgroup.com | AppView.day under America/Chicago: a UTC-midnight DATE value ('YYYY-MM-DDT00:00:00(.000)Z') and a plain 'YYYY-MM-DD' print as their own day, while AppView.date of the same instant shows the day before (the precondition)
 * 5 | maintainer@emeraldcoastsystemsgroup.com | The classroom grammar: a classroom request paints a data-audience="classroom" root whose tiles, buttons, list rows and escape are at least 48px tall (also at phone width, one tile per row, no horizontal overflow); an item carrying target '_blank' opens a new page with no opener from a click or Enter while the frame and the top window stay where they are, and an item without one is still handled on the page. The "requested but not provided" case now narrows the synthetic page's builders with ?provides=.
 * 6 | maintainer@emeraldcoastsystemsgroup.com | AppView.when within a minute either side of now reads 'just now' (now, a Date equal to now, 1 s and 45 s ahead or behind), a time 90 s or 30 min ahead still reads 'soon', and 20 min ago still reads 'just now': a just-saved record read "Written soon.".
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

    // The synthetic page provides all three audiences unless ?provides= narrows it; here it offers no classroom view.
    await open('?audience=classroom&provides=family,company');
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

  it('renders the classroom grammar: data-audience classroom, touch targets of at least 48px, colour from the skin tokens', async () => {
    await open('?audience=classroom');
    await page.waitForSelector('#av-root .av-kind-tiles');
    expect(await page.evaluate(() => document.documentElement.getAttribute('data-audience'))).toBe('classroom');
    expect(await page.locator('#av-root').getAttribute('data-audience')).toBe('classroom');
    expect(await visible('#full-ui')).toBe(false);
    const box = await page.evaluate(() => {
      const css = (sel: string) => getComputedStyle(document.querySelector(sel) as HTMLElement);
      const height = (sel: string) => (document.querySelector(sel) as HTMLElement).getBoundingClientRect().height;
      // The accent the skin's tokens resolve to inside the view, read through a probe painted with the same variable.
      const probe = document.createElement('div'); probe.style.background = 'var(--av-accent)'; document.getElementById('av-root')!.appendChild(probe);
      const accent = getComputedStyle(probe).backgroundColor; probe.remove();
      return { tileMin: parseFloat(css('.av-tile').minHeight), tile: height('.av-tile'), tileRadius: parseFloat(css('.av-tile').borderTopLeftRadius),
        btnMin: parseFloat(css('.av-btn').minHeight), btn: height('.av-btn'), item: height('.av-item'), escape: height('.av-escape-link'),
        titleSize: parseFloat(css('.av-title').fontSize), accent, primary: css('.av-btn.is-primary').backgroundColor, kicker: css('.av-kicker').color };
    });
    expect(box.tileMin).toBeGreaterThanOrEqual(48); expect(box.tile).toBeGreaterThanOrEqual(48); expect(box.tileRadius).toBeGreaterThanOrEqual(16);
    expect(box.btnMin).toBeGreaterThanOrEqual(48); expect(box.btn).toBeGreaterThanOrEqual(48);
    expect(box.item).toBeGreaterThanOrEqual(48); expect(box.escape).toBeGreaterThanOrEqual(48);
    expect(box.titleSize).toBeGreaterThanOrEqual(28);
    expect(box.primary).toBe(box.accent); expect(box.kicker).toBe(box.accent);
    await page.locator('.av-btn.is-primary', { hasText: 'Start making' }).click();
    expect(await page.evaluate(() => (window as unknown as { __acted: string }).__acted)).toBe('make');
    // At phone width the classroom keeps its 48px targets and lays tiles out one per row.
    await page.setViewportSize({ width: 390, height: 844 });
    const narrow = await page.evaluate(() => {
      const tiles = Array.from(document.querySelectorAll('.av-kind-tiles .av-tile')).map(t => (t as HTMLElement).getBoundingClientRect());
      return { sameColumn: tiles.every(r => Math.abs(r.left - tiles[0].left) < 1), btn: (document.querySelector('.av-btn') as HTMLElement).getBoundingClientRect().height, overflow: document.documentElement.scrollWidth - window.innerWidth };
    });
    expect(narrow.sameColumn).toBe(true); expect(narrow.btn).toBeGreaterThanOrEqual(48); expect(narrow.overflow).toBeLessThanOrEqual(0);
    expect(errors).toEqual([]);
  });

  it('opens an item carrying target _blank in a new tab without an opener, and the frame does not navigate', async () => {
    await page.goto(`${fixture.origin}/fixture/app-view/host?audience=classroom`);
    const frame = page.frameLocator('#host-frame');
    await frame.locator('.av-kind-tiles .av-tile').first().waitFor();
    const framed = page.frames().find(f => f.url().includes('/fixture/app-view?audience=classroom'));
    expect(framed).toBeTruthy();
    const [tab] = await Promise.all([context.waitForEvent('page'), frame.locator('.av-tile', { hasText: 'Synthetic starter' }).click()]);
    await tab.waitForLoadState();
    expect(new URL(tab.url()).pathname).toBe('/fixture/surface/opened-tab');
    expect(await tab.evaluate(() => window.opener)).toBeNull();
    expect(framed!.url()).toContain('/fixture/app-view?audience=classroom');
    expect(new URL(page.url()).pathname).toBe('/fixture/app-view/host');
    expect(await frame.locator('#av-root').getAttribute('data-audience')).toBe('classroom');
    // A list item follows the same rule from the keyboard; an item without a target is still handled on the page.
    const [guide] = await Promise.all([context.waitForEvent('page'), frame.locator('.av-item', { hasText: 'Synthetic guide' }).press('Enter')]);
    await guide.waitForLoadState();
    expect(new URL(guide.url()).pathname).toBe('/fixture/surface/opened-guide');
    expect(framed!.url()).toContain('/fixture/app-view?audience=classroom');
    await frame.locator('.av-tile', { hasText: 'Synthetic kept here' }).click();
    expect(await framed!.evaluate(() => (window as unknown as { __opened: string }).__opened)).toBe('kept');
    expect(context.pages()).toHaveLength(3);
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

  it('AppView.when reads a timestamp within a minute either side of now as "just now", and later this hour as "soon"', async () => {
    await open('');
    const out = await page.evaluate(() => {
      const AV = (window as unknown as { AppView: { when(v: unknown): string } }).AppView;
      const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
      // A record saved this instant, or stamped a moment ahead of the reader's clock, is 'just now' (it read "Written soon.").
      return [AV.when(new Date()), AV.when(at(0)), AV.when(at(1000)), AV.when(at(45_000)), AV.when(at(-1000)), AV.when(at(-45_000)),
        AV.when(at(90_000)), AV.when(at(30 * 60_000)), AV.when(at(-20 * 60_000))];
    });
    expect(out).toEqual(['just now', 'just now', 'just now', 'just now', 'just now', 'just now', 'soon', 'soon', 'just now']);
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
