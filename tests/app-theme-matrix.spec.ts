/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR        | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added dark/light surface theme validation
 *                     |               | for shared CSS MIME, cockpit theme sync,
 *                     |               | overflow, and readable core surfaces.
 */

import { test, expect, type Page, type FrameLocator } from '@playwright/test';

const THEMES = ['midnight', 'daylight'] as const;

const COCKPIT_VIEWS = [
  { id: 'connectors', ready: '#connectorSearch', label: 'Connectors' },
  { id: 'tool-token-chase', ready: 'iframe[src*="/api/token-chase/ui"]', label: 'Optimizer' },
  { id: 'tool-workflow-studio', ready: 'iframe[src*="/workflow-studio/"]', label: 'Workflow Studio' },
] as const;

const DIRECT_SURFACES = [
  { label: 'AI Test Lab', url: '/api/test-lab/app', ready: 'h1' },
  { label: 'Eval Wall', url: '/api/eval-wall/app', ready: '#tiles' },
] as const;

test.describe('dark/light stylesheet and surface theme matrix', () => {
  test.setTimeout(180_000);

  test('shared CSS assets load with stylesheet MIME type', async ({ request }) => {
    for (const asset of ['surface-glass.css', 'design-system.css']) {
      const response = await request.get(`/shared/ui/css/${asset}`, { maxRedirects: 0 });
      expect(response.status(), `${asset} must not redirect to auth`).toBe(200);
      expect(response.headers()['content-type'], `${asset} must load as CSS`).toMatch(/text\/css/i);
    }
  });

  for (const theme of THEMES) {
    test(`cockpit core surfaces render cleanly in ${theme}`, async ({ page }, testInfo) => {
      const badResponses: string[] = [];
      page.on('response', (response) => {
        const url = response.url();
        if (/surface-glass\.css|design-system\.css|themes\/.*\.css/i.test(url)) {
          const status = response.status();
          const contentType = response.headers()['content-type'] || '';
          if (status === 304) return;
          if (status >= 400 || (status >= 200 && status < 300 && !/text\/css/i.test(contentType))) {
            badResponses.push(`${status} ${contentType} ${url}`);
          }
        }
      });

      await setCockpitTheme(page, theme);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme, { timeout: 30_000 });
      await expectThemeVarsReadable(page);

      for (const view of COCKPIT_VIEWS) {
        await openCockpitView(page, view.id, view.ready);
        await expect(page.locator(view.ready).first(), `${view.label} ready in ${theme}`).toBeVisible({ timeout: 45_000 });
        await expectNoHorizontalOverflow(page, `cockpit ${view.label} ${theme}`);

        if (view.id.startsWith('tool-')) {
          await expectFrameReadable(page.frameLocator(view.ready), `${view.label} iframe ${theme}`);
        }

        await page.screenshot({
          path: testInfo.outputPath(`cockpit-${theme}-${view.id}.png`),
          fullPage: false,
        });
      }

      expect(badResponses, `stylesheet responses must be CSS in ${theme}`).toEqual([]);
    });

    test(`direct app surfaces avoid blank/overflow failures in ${theme}`, async ({ page }, testInfo) => {
      await page.addInitScript((themeName) => {
        localStorage.setItem('cockpit-theme', themeName);
      }, theme);

      for (const surface of DIRECT_SURFACES) {
        await page.goto(surface.url, { waitUntil: 'domcontentloaded' });
        await expect(page.locator(surface.ready).first(), `${surface.label} ready in ${theme}`).toBeVisible({ timeout: 30_000 });
        await expect(page.locator('body')).not.toContainText(/Cannot GET|Internal Server Error|Not authenticated/i);
        await expectNoHorizontalOverflow(page, `${surface.label} ${theme}`);
        await expectBodyHasReadableText(page, `${surface.label} ${theme}`);
        await page.screenshot({
          path: testInfo.outputPath(`direct-${theme}-${safeName(surface.label)}.png`),
          fullPage: false,
        });
      }
    });
  }
});

async function setCockpitTheme(page: Page, theme: string): Promise<void> {
  await page.addInitScript((themeName) => {
    localStorage.setItem('cockpit-theme', themeName);
  }, theme);
  await page.goto(`/cockpit/?profile=oshal-framework&theme-matrix=${theme}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean((window as any).__cockpit?.switchView), null, { timeout: 45_000 });
  await page.waitForFunction((themeName) => document.documentElement.getAttribute('data-theme') === themeName, theme, {
    timeout: 45_000,
  });
}

async function openCockpitView(page: Page, viewId: string, readySelector: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await page.evaluate((id) => {
      const button = document.querySelector(`[data-view="${id}"]`) as HTMLElement | null;
      const app = (window as any).__cockpit;
      if (button) button.click();
      else if (app?.ribbon?.setActive) app.ribbon.setActive(id);
      else app?.switchView?.(id);
    }, viewId).catch(() => {});

    const visible = await page.locator(readySelector).first()
      .waitFor({ state: 'visible', timeout: 8_000 })
      .then(() => true)
      .catch(() => false);
    if (visible) return;

    await page.evaluate((id) => (window as any).__cockpit?.switchView?.(id), viewId).catch(() => {});
    const switched = await page.locator(readySelector).first()
      .waitFor({ state: 'visible', timeout: 8_000 })
      .then(() => true)
      .catch(() => false);
    if (switched) return;

    await page.waitForTimeout(500);
  }

  await expect(page.locator(readySelector).first(), `${viewId} ready`).toBeVisible({ timeout: 10_000 });
}

async function expectThemeVarsReadable(page: Page): Promise<void> {
  const contrast = await page.evaluate(() => {
    const styles = getComputedStyle(document.documentElement);
    return contrastRatio(styles.getPropertyValue('--text-primary'), styles.getPropertyValue('--bg-primary'));

    function contrastRatio(foreground: string, background: string): number {
      const fg = rgb(foreground);
      const bg = rgb(background);
      if (!fg || !bg) return 0;
      const l1 = luminance(fg);
      const l2 = luminance(bg);
      const lighter = Math.max(l1, l2);
      const darker = Math.min(l1, l2);
      return (lighter + 0.05) / (darker + 0.05);
    }

    function rgb(value: string): [number, number, number] | null {
      const trimmed = value.trim();
      const hex = trimmed.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
      if (hex) {
        const raw = hex[1].length === 3
          ? hex[1].split('').map((part) => part + part).join('')
          : hex[1];
        return [
          Number.parseInt(raw.slice(0, 2), 16),
          Number.parseInt(raw.slice(2, 4), 16),
          Number.parseInt(raw.slice(4, 6), 16),
        ];
      }
      const fn = trimmed.match(/rgba?\(([^)]+)\)/i);
      if (!fn) return null;
      const parts = fn[1].split(',').slice(0, 3).map((part) => Number.parseFloat(part.trim()));
      return parts.length === 3 && parts.every(Number.isFinite) ? parts as [number, number, number] : null;
    }

    function luminance([r, g, b]: [number, number, number]): number {
      const srgb = [r, g, b].map((part) => {
        const value = part / 255;
        return value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * srgb[0] + 0.7152 * srgb[1] + 0.0722 * srgb[2];
    }
  });
  expect(contrast, `theme text/background contrast ${contrast}`).toBeGreaterThanOrEqual(4.5);
}

async function expectNoHorizontalOverflow(page: Page, label: string): Promise<void> {
  const overflow = await page.evaluate(() => {
    const root = document.scrollingElement || document.documentElement;
    return Math.max(0, root.scrollWidth - root.clientWidth);
  });
  expect(overflow, `${label} has horizontal overflow`).toBeLessThanOrEqual(24);
}

async function expectBodyHasReadableText(page: Page, label: string): Promise<void> {
  const stats = await page.evaluate(() => ({
    textLength: (document.body.innerText || '').trim().length,
    visibleElements: Array.from(document.body.querySelectorAll('*')).filter((el) => {
      const rect = (el as HTMLElement).getBoundingClientRect();
      const styles = getComputedStyle(el);
      return rect.width > 1 && rect.height > 1 && styles.visibility !== 'hidden' && styles.display !== 'none';
    }).length,
  }));
  expect(stats.textLength, `${label} visible text`).toBeGreaterThan(40);
  expect(stats.visibleElements, `${label} visible elements`).toBeGreaterThan(8);
}

async function expectFrameReadable(frame: FrameLocator, label: string): Promise<void> {
  const body = frame.locator('body');
  await expect(body, `${label} body`).toBeVisible({ timeout: 30_000 });
  const text = await body.innerText({ timeout: 10_000 });
  expect(text.trim().length, `${label} visible text`).toBeGreaterThan(30);
}

function safeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
