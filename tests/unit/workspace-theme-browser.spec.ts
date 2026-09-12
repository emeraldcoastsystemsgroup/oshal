/**
 * =============================================================================
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove selectable Workspace styling through real Cockpit components, persisted choices, shared iframes and transient package themes in Chromium.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Verify the existing chooser through relocated header controls with keyboard and pointer dismissal.
 * =============================================================================
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { readFileSync } from 'node:fs';
import { startWorkspaceThemeFixture } from '../fixtures/workspace-theme';
import { SCENARIOS } from '@/app/routes/test-lab-scenarios';

declare global {
  interface Window {
    workspaceThemeFixture: { theme: {
      apply(theme: string): string; applyTransient(theme: string, cssUrl?: string): string;
      setApplicationTheme(theme?: string, cssUrl?: string): string;
    }; showHome(): Promise<void>; showSettings(): void; showSurface(): void };
  }
}
let fixture: Awaited<ReturnType<typeof startWorkspaceThemeFixture>>;
let browser: Browser, context: BrowserContext, page: Page;
let errors: string[];

/** @description Wait for actual component boot; optional existing saved choice is seeded before any script runs. */
async function open(saved?: string) {
  if (saved) await context.addInitScript(value => localStorage.setItem('cockpit-theme', value), saved);
  await page.goto(fixture.origin + '/cockpit/');
  await page.waitForSelector('html[data-fixture-ready=true]');
  await page.locator('.apps-home-card').first().waitFor();
}

/** @description Read a computed shared token after stylesheets have loaded. */
async function token(name: string) {
  return page.evaluate(key => getComputedStyle(document.documentElement).getPropertyValue(key).trim(), name);
}

/** @description Exercise the actual sidebar options disclosure before the existing cycle control. */
async function cycleTheme() {
  await page.locator('#cockpitHeaderOptions > summary').click();
  await page.locator('#themeToggle').click();
}

/** @description WCAG contrast between the actual opaque hex theme tokens, without synthetic pixel assertions. */
function contrast(foreground: string, background: string) {
  const luminance = (hex: string) => {
    const channels = hex.startsWith('#') ? [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16))
      : (hex.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
    const rgb = channels.map(value => value / 255)
      .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  };
  const a = luminance(foreground), b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

beforeAll(async () => { fixture = await startWorkspaceThemeFixture(); browser = await chromium.launch({ headless: true }); });
afterAll(async () => { await browser?.close(); await fixture?.close(); });
beforeEach(async () => {
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  await context.route('**/*', route => new URL(route.request().url()).origin === fixture.origin ? route.continue() : route.abort());
  page = await context.newPage(); errors = [];
  page.on('pageerror', error => errors.push(error.message));
});
afterEach(async () => { await context?.close(); });

it('selects through the real Settings picker, persists and stays in the existing theme cycle', async () => {
  await open(); expect(await page.locator('html').getAttribute('data-theme')).toBe('workspace');
  await cycleTheme(); expect(await page.locator('html').getAttribute('data-theme')).toBe('midnight');
  await page.locator('.ribbon-btn[data-view=settings]').click();
  const choice = page.locator('#settingsThemePicker [data-theme=workspace]');
  await choice.click(); expect(await choice.innerText()).toContain('Workspace');
  expect(await page.locator('html').getAttribute('data-theme')).toBe('workspace');
  expect(await page.evaluate(() => localStorage.getItem('cockpit-theme'))).toBe('workspace');
  await expect.poll(() => token('--bg-primary')).toBe('#f5f6f9');
  await cycleTheme();
  expect(await choice.getAttribute('aria-pressed')).toBe('false');
  expect(await page.locator('#settingsThemePicker [data-theme=midnight]').getAttribute('aria-pressed')).toBe('true');
  expect(await page.locator('#settingsThemePicker button.active').count()).toBe(1);
  await choice.click();
  await page.reload(); await page.waitForSelector('html[data-fixture-ready=true]');
  expect(await page.locator('html').getAttribute('data-theme')).toBe('workspace');
  await cycleTheme(); expect(await page.locator('html').getAttribute('data-theme')).toBe('midnight');
  await page.evaluate(() => window.workspaceThemeFixture.theme.apply('amber'));
  await cycleTheme(); expect(await page.locator('html').getAttribute('data-theme')).toBe('workspace');
  expect(errors).toEqual([]);
}, 30000);

it('honors the saved theme before the actual Cockpit component boot completes', async () => {
  let release!: () => void;
  const held = new Promise<void>(done => { release = done; });
  await context.addInitScript(() => localStorage.setItem('cockpit-theme', 'ocean'));
  await page.route('**/fixture/bootstrap.js', async route => { await held; await route.continue(); });
  try {
    await page.goto(fixture.origin + '/cockpit/', { waitUntil: 'commit' });
    await expect.poll(() => page.locator('html').getAttribute('data-theme')).toBe('ocean');
    expect(await page.locator('html').getAttribute('data-fixture-ready')).toBeNull();
    release(); await page.waitForSelector('html[data-fixture-ready=true]');
    expect(await page.locator('html').getAttribute('data-theme')).toBe('ocean'); expect(errors).toEqual([]);
  } finally { release(); }
}, 30000);

it('retains existing saved choices while allowing a transient Workspace skin', async () => {
  await open('ocean'); expect(await page.locator('html').getAttribute('data-theme')).toBe('ocean');
  await page.evaluate(() => window.workspaceThemeFixture.theme.applyTransient('workspace'));
  expect(await page.locator('html').getAttribute('data-theme')).toBe('workspace');
  expect(await page.evaluate(() => localStorage.getItem('cockpit-theme'))).toBe('ocean');
  await page.reload(); await page.waitForSelector('html[data-fixture-ready=true]');
  expect(await page.locator('html').getAttribute('data-theme')).toBe('ocean'); expect(errors).toEqual([]);
}, 30000);

it('uses Workspace in a fresh standalone surface but retains the existing invalid-choice fallback', async () => {
  await page.goto(fixture.origin + '/cockpit/tools/budgets.html');
  await expect.poll(() => page.locator('html').getAttribute('data-theme')).toBe('workspace');
  await page.evaluate(() => localStorage.setItem('cockpit-theme', 'unknown-fixture-theme'));
  await page.reload(); await expect.poll(() => page.locator('html').getAttribute('data-theme')).toBe('midnight');
  await page.goto(fixture.origin + '/cockpit/'); await page.waitForSelector('html[data-fixture-ready=true]');
  expect(await page.locator('html').getAttribute('data-theme')).toBe('midnight');
  expect(await page.evaluate(() => localStorage.getItem('cockpit-theme'))).toBe('midnight'); expect(errors).toEqual([]);
}, 30000);

it('keeps current parent and packaged themes authoritative in the real shared surface without overwriting Workspace', async () => {
  await open(); await page.evaluate(() => { window.workspaceThemeFixture.theme.apply('workspace'); window.workspaceThemeFixture.showSurface(); });
  const shared = page.frameLocator('#shared-surface');
  await expect.poll(() => shared.locator('html').getAttribute('data-theme')).toBe('workspace');
  await expect.poll(() => shared.locator('body').evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(245, 246, 249)');
  await page.evaluate(() => window.workspaceThemeFixture.theme.applyTransient('forest'));
  await expect.poll(() => shared.locator('html').getAttribute('data-theme')).toBe('forest');
  await page.evaluate(() => window.workspaceThemeFixture.theme.applyTransient('fixture-studio', '/fixture/packaged.css'));
  await expect.poll(() => shared.locator('html').getAttribute('data-theme')).toBe('fixture-studio');
  await expect.poll(() => shared.locator('body').evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(233, 244, 235)');
  expect(await page.evaluate(() => localStorage.getItem('cockpit-theme'))).toBe('workspace');
  await page.evaluate(() => window.workspaceThemeFixture.theme.apply('workspace'));
  await expect.poll(() => shared.locator('html').getAttribute('data-theme')).toBe('workspace');
  await expect.poll(() => shared.locator('body').evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(245, 246, 249)');
  await page.goto(fixture.origin + '/cockpit/tools/budgets.html');
  await expect.poll(() => page.locator('html').getAttribute('data-theme')).toBe('workspace'); expect(errors).toEqual([]);
}, 30000);

it('keeps a newer Workspace choice when an older package stylesheet finishes loading late', async () => {
  let release!: () => void;
  const held = new Promise<void>(done => { release = done; });
  await page.route('**/fixture/packaged.css', async route => { await held; await route.continue(); });
  try {
    await open(); await page.evaluate(() => window.workspaceThemeFixture.showSurface());
    const shared = page.frameLocator('#shared-surface');
    await expect.poll(() => shared.locator('html').getAttribute('data-theme')).toBe('workspace');
    await page.evaluate(() => window.workspaceThemeFixture.theme.applyTransient('fixture-studio', '/fixture/packaged.css'));
    await shared.locator('#app-package-theme-css').waitFor({ state: 'attached' });
    await page.evaluate(() => window.workspaceThemeFixture.theme.apply('workspace'));
    await expect.poll(() => shared.locator('html').getAttribute('data-theme')).toBe('workspace');
    release();
    await expect.poll(() => shared.locator('#app-package-theme-css').evaluate(element => Boolean((element as HTMLLinkElement).sheet))).toBe(true);
    expect(await shared.locator('html').getAttribute('data-theme')).toBe('workspace');
    expect(await page.evaluate(() => localStorage.getItem('cockpit-theme'))).toBe('workspace');
  } finally { release(); }
}, 30000);

it('renders readable paper cards on the existing Home DOM at desktop and phone widths with visible keyboard focus', async () => {
  await open(); await page.evaluate(() => window.workspaceThemeFixture.theme.apply('workspace'));
  await expect.poll(() => token('--bg-card')).toBe('#ffffff');
  for (const foreground of ['--text-primary', '--text-secondary', '--text-muted']) {
    for (const background of ['--bg-card', '--bg-primary', '--bg-tertiary']) {
      expect(contrast(await token(foreground), await token(background))).toBeGreaterThanOrEqual(4.5);
    }
  }
  expect(contrast('#ffffff', await token('--accent-primary'))).toBeGreaterThanOrEqual(4.5);
  expect(await page.locator('.header-bar').evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(255, 255, 255)');
  expect(await page.locator('.apps-home-card').count()).toBe(3);
  expect(await page.locator('.apps-home-head').innerText()).toContain('Your world, at a glance.');
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle)).toBe('solid');
  for (const width of [1024, 768, 390]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  }
  expect(errors).toEqual([]);
}, 30000);

it('keeps every real Settings theme label readable with a distinct selected state and candidate color swatches', async () => {
  await open(); await page.locator('.ribbon-btn[data-view=settings]').click();
  const choices = page.locator('#settingsThemePicker button'); expect(await choices.count()).toBe(12);
  const colors = await choices.evaluateAll(buttons => buttons.map(button => {
    const style = getComputedStyle(button);
    return { text: style.color, background: style.backgroundColor, swatch: getComputedStyle(button, '::before').backgroundColor };
  }));
  for (const color of colors) expect(contrast(color.text, color.background)).toBeGreaterThanOrEqual(4.5);
  expect(new Set(colors.map(color => color.swatch)).size).toBeGreaterThan(5);
  const selected = page.locator('#settingsThemePicker [data-theme=workspace]');
  expect(await selected.getAttribute('aria-pressed')).toBe('true');
  expect(await selected.evaluate(element => getComputedStyle(element).borderTopColor)).toBe('rgb(83, 91, 200)');
  await page.locator('#settingsThemePicker [data-theme=midnight]').click();
  expect(await selected.getAttribute('aria-pressed')).toBe('false');
  await selected.click(); expect(await selected.getAttribute('aria-pressed')).toBe('true'); expect(errors).toEqual([]);
}, 30000);

it('precaches the default Workspace palette and prepaint bootstrap on the first real service-worker installation', async () => {
  await context.close();
  context = await browser.newContext({ viewport: { width: 1024, height: 768 }, serviceWorkers: 'allow' });
  await context.route('**/*', route => new URL(route.request().url()).origin === fixture.origin ? route.continue() : route.abort());
  page = await context.newPage();
  await open();
  await page.evaluate(async () => {
    await navigator.serviceWorker.register('/cockpit/service-worker.js', { scope: '/cockpit/' });
    await navigator.serviceWorker.ready;
  });
  const cached = await page.evaluate(async () => ({
    theme: Boolean(await caches.match('/cockpit/css/themes/workspace.css')),
    bootstrap: Boolean(await caches.match('/shared/ui/js/surface-theme.js')),
  }));
  expect(cached).toEqual({ theme: true, bootstrap: true });
  await context.setOffline(true);
  const assets = await page.evaluate(async () => {
    const theme = await caches.match('/cockpit/css/themes/workspace.css');
    const bootstrap = await caches.match('/shared/ui/js/surface-theme.js');
    return { theme: await theme?.text(), bootstrap: await bootstrap?.text() };
  });
  expect(assets.theme).toContain('[data-theme="workspace"]');
  expect(assets.bootstrap).toContain("defaultTheme ? resolve(defaultTheme) : 'workspace'");
}, 30000);

it('loads the real guarded CSS route and registers its browser proof without claiming it executes during a Lab asset check', async () => {
  const response = await context.request.get(fixture.origin + '/cockpit/css/themes/workspace.css');
  expect(response.status()).toBe(200); expect(response.headers()['content-type']).toContain('text/css');
  expect(response.headers()['cache-control']).toContain('no-store');
  expect(await response.text()).toBe(readFileSync('src/pages/cockpit/css/themes/workspace.css', 'utf8'));
  const scenario = SCENARIOS.find(item => item.id === 'cockpit-appearance');
  expect(scenario?.regressionTests).toContainEqual({ level: 'browser', path: 'tests/unit/workspace-theme-browser.spec.ts' });
  expect(scenario?.description).toContain('does not execute the browser suite');
});

it('keeps the chosen portal palette across application defaults and only enables app colors on request', async () => {
  await page.goto(fixture.origin + '/cockpit/?app=fixture-studio');
  await page.waitForSelector('html[data-fixture-ready=true]');
  expect(await page.locator('html').getAttribute('data-theme')).toBe('workspace');
  await page.evaluate(() => window.workspaceThemeFixture.showSettings());
  await page.locator('#settingsApplicationColors').check();
  await expect.poll(() => page.locator('html').getAttribute('data-theme')).toBe('fixture-studio');
  expect(await page.evaluate(() => localStorage.getItem('cockpit-theme'))).toBe('workspace');
  await page.reload(); await page.waitForSelector('html[data-fixture-ready=true]');
  expect(await page.locator('html').getAttribute('data-theme')).toBe('fixture-studio');
  await page.evaluate(() => window.workspaceThemeFixture.showSettings());
  await page.locator('#settingsThemePicker [data-theme=midnight]').click();
  expect(await page.locator('#settingsApplicationColors').isChecked()).toBe(false);
  await page.reload(); await page.waitForSelector('html[data-fixture-ready=true]');
  expect(await page.locator('html').getAttribute('data-theme')).toBe('midnight');
  await page.evaluate(() => window.workspaceThemeFixture.theme.setApplicationTheme('daylight'));
  expect(await page.locator('html').getAttribute('data-theme')).toBe('midnight');
  expect(errors).toEqual([]);
}, 30000);

it('keeps secondary header actions tucked away and makes the real Settings chooser reachable', async () => {
  await open('workspace');
  expect(await page.locator('#themeToggle').isVisible()).toBe(false);
  expect(await page.locator('#zenModeBtn').isVisible()).toBe(false);
  expect(await page.locator('#profileBtn').isVisible()).toBe(true);
  await page.locator('#cockpitHeaderOptions > summary').click();
  await page.locator('#portalSettingsBtn').click();
  expect(await page.locator('#settingsThemePicker').isVisible()).toBe(true);
  expect(await page.locator('#cockpitHeaderOptions').getAttribute('open')).toBeNull();
  expect(await page.locator('#cockpitHomeLink').getAttribute('href')).toBe('/cockpit/');
  expect(errors).toEqual([]);
});

it('returns keyboard focus to the options trigger after switching theme', async () => {
  await open('midnight');
  const trigger = page.locator('#cockpitHeaderOptions > summary');
  await trigger.focus(); await page.keyboard.press('Enter');
  await page.locator('#themeToggle').focus(); await page.keyboard.press('Enter');
  expect(await page.locator('html').getAttribute('data-theme')).not.toBe('midnight');
  expect(await page.locator('#cockpitHeaderOptions').getAttribute('open')).toBeNull();
  expect(await trigger.evaluate(element => element === document.activeElement)).toBe(true);
  expect(errors).toEqual([]);
});

it('dismisses the options disclosure using Escape and outside pointer without activating a tool', async () => {
  await open('midnight');
  const trigger = page.locator('#cockpitHeaderOptions > summary');
  await trigger.focus(); await page.keyboard.press('Enter');
  expect(await page.locator('#themeToggle').isVisible()).toBe(true);
  await page.keyboard.press('Escape');
  expect(await page.locator('#themeToggle').isVisible()).toBe(false);
  expect(await trigger.evaluate(element => element === document.activeElement)).toBe(true);
  await trigger.click(); await page.locator('#mainContent').click({ position: { x: 5, y: 5 } });
  expect(await page.locator('#themeToggle').isVisible()).toBe(false);
  expect(await page.locator('html').getAttribute('data-theme')).toBe('midnight');
  expect(errors).toEqual([]);
});

it('follows the real chooser across open portal tabs without replacing an embedded document or its draft', async () => {
  await open();
  const other = await context.newPage();
  await other.goto(fixture.origin + '/cockpit/?app=fixture-studio');
  await other.waitForSelector('html[data-fixture-ready=true]');
  await other.evaluate(() => window.workspaceThemeFixture.showSurface());
  const frame = other.frameLocator('#shared-surface');
  await frame.locator('body').waitFor();
  await frame.locator('body').evaluate(body => {
    const input = document.createElement('input'); input.id = 'appearance-draft';
    input.value = 'Keep this unsaved note'; body.append(input);
  });
  const documentBefore = await frame.locator('html').elementHandle();
  await page.bringToFront(); await page.locator('.ribbon-btn[data-view=settings]').click();
  await page.locator('#settingsThemePicker [data-theme=daylight]').click();
  await expect.poll(() => other.locator('html').getAttribute('data-theme')).toBe('daylight');
  await expect.poll(() => frame.locator('html').getAttribute('data-theme')).toBe('daylight');
  expect(await frame.locator('#appearance-draft').inputValue()).toBe('Keep this unsaved note');
  expect(await documentBefore?.evaluate(element => element === document.documentElement)).toBe(true);
  await page.locator('#settingsThemePicker [data-theme=workspace]').click();
  await expect.poll(() => frame.locator('body').evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(245, 246, 249)');
  expect(await frame.locator('#appearance-draft').inputValue()).toBe('Keep this unsaved note');
  await other.close(); expect(errors).toEqual([]);
}, 30000);

it('offers readable primary-control ink and correct native control schemes in every portal palette', async () => {
  await open();
  const themes = ['midnight','daylight','ocean','sakura','forest','gray','black','light-blue','aurora','graphite','amber','workspace'];
  for (const theme of themes) {
    await page.evaluate(value => window.workspaceThemeFixture.theme.apply(value), theme);
    expect(contrast(await token('--text-on-accent'), await token('--accent-primary')), theme).toBeGreaterThanOrEqual(4.5);
    const scheme = await page.locator('html').evaluate(element => getComputedStyle(element).colorScheme);
    expect(scheme, theme).toBe(['daylight','light-blue','workspace'].includes(theme) ? 'light' : 'dark');
  }
  expect(errors).toEqual([]);
}, 30000);

it('keeps the actual theme picker usable when browser preference writes are blocked', async () => {
  await context.addInitScript(() => {
    Storage.prototype.setItem = () => { throw new DOMException('Storage blocked', 'SecurityError'); };
  });
  await open(); await page.locator('.ribbon-btn[data-view=settings]').click();
  await page.locator('#settingsThemePicker [data-theme=midnight]').click();
  expect(await page.locator('html').getAttribute('data-theme')).toBe('midnight');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  expect(await page.locator('html').getAttribute('data-theme')).toBe('midnight');
  await page.evaluate(() => window.workspaceThemeFixture.theme.setApplicationTheme('forest'));
  await page.locator('#settingsApplicationColors').check();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  expect(await page.locator('html').getAttribute('data-theme')).toBe('forest');
  await page.locator('#settingsThemePicker [data-theme=workspace]').click();
  await expect.poll(() => token('--bg-primary')).toBe('#f5f6f9');
  expect(errors).toEqual([]);
}, 30000);
