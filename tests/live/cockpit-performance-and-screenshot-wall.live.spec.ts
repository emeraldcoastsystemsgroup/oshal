/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR        | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Live authenticated proof for cockpit p95,
 *                     |               | reload/no-spinner, and module screenshot wall.
 */

/**
 * @description
 * Read-only live proof for competitive Speed and Audit/Proof gates. Attaches to
 * The operator's already-signed-in Chrome via CDP, opens top cockpit modules,
 * captures timings/screenshots, then reloads and re-opens each module to catch
 * dead spinner regressions.
 */
import { test, expect } from './fixtures';
import {
  COCKPIT_READY,
  openCockpit,
  openTool,
  hasSurfaceError,
  hasTool,
} from './helpers';

type ModuleTarget = {
  id: string;
  label: string;
};

type ModuleTiming = ModuleTarget & {
  firstOpenMs: number;
  reloadOpenMs: number;
  visibleLoadersAfterReload: string[];
};

const MODULES: ModuleTarget[] = [
  { id: 'tickets', label: 'Tickets' },
  { id: 'operations', label: 'Operations' },
  { id: 'connectors', label: 'Connectors' },
  { id: 'calendar', label: 'Calendar' },
  { id: 'chat', label: 'Swarm Messages' },
  { id: 'settings', label: 'Settings' },
];

const CONTENT_CAN_CONTAIN_ERRORS = new Set(['tickets', 'chat']);

test('cockpit captures p95 timings, reload proof, and module screenshots', async ({ page }, testInfo) => {
  test.setTimeout(360_000);

  const timings: ModuleTiming[] = [];
  const cockpitStart = Date.now();
  await openCockpit(page);
  const cockpitLoadMs = Date.now() - cockpitStart;

  const selected: ModuleTarget[] = [];
  for (const module of MODULES) {
    if (await hasTool(page, module.id)) selected.push(module);
  }
  expect(selected.length, 'expected at least the pinned platform modules plus core cockpit tools').toBeGreaterThanOrEqual(5);

  for (const module of selected) {
    const firstStart = Date.now();
    await openTool(page, module.id);
    await waitForModuleSettle(page);
    const firstOpenMs = Date.now() - firstStart;
    if (!CONTENT_CAN_CONTAIN_ERRORS.has(module.id)) {
      expect(await hasSurfaceError(page), `${module.label} should not render a visible surface-load error`).toBeFalsy();
    }

    await testInfo.attach(`module-screenshot-${module.id}`, {
      body: await page.screenshot({ fullPage: false }),
      contentType: 'image/png',
    });

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator(COCKPIT_READY).first(), 'cockpit should render after reload').toBeVisible({ timeout: 90_000 });

    const reloadStart = Date.now();
    await openTool(page, module.id);
    await waitForModuleSettle(page);
    const reloadOpenMs = Date.now() - reloadStart;
    const visibleLoadersAfterReload = await visibleLoaderSummaries(page);

    expect.soft(
      visibleLoadersAfterReload,
      `${module.label} should not leave a visible dead loading state after reload`,
    ).toEqual([]);

    timings.push({
      ...module,
      firstOpenMs,
      reloadOpenMs,
      visibleLoadersAfterReload,
    });
  }

  const allOpenTimes = timings.flatMap((t) => [t.firstOpenMs, t.reloadOpenMs]);
  const moduleP95Ms = percentile(allOpenTimes, 95);
  const report = {
    generatedAt: new Date().toISOString(),
    cockpitLoadMs,
    moduleP95Ms,
    moduleCount: timings.length,
    modules: timings,
  };

  // eslint-disable-next-line no-console
  console.log(`[performance-baseline] ${JSON.stringify(report)}`);

  await testInfo.attach('performance-baseline.json', {
    body: JSON.stringify(report, null, 2),
    contentType: 'application/json',
  });

  expect(moduleP95Ms, 'top cockpit module p95 should stay under the live-test budget').toBeLessThan(30_000);
});

async function waitForModuleSettle(page: { waitForTimeout: (ms: number) => Promise<void>; locator: (selector: string) => { first: () => { waitFor: (options: { state: 'hidden'; timeout: number }) => Promise<void> } } }) {
  await page.waitForTimeout(800);
  await page
    .locator('.loading-skeleton:visible, .spinner:visible, .spin:visible, [aria-busy="true"]:visible')
    .first()
    .waitFor({ state: 'hidden', timeout: 10_000 })
    .catch(() => {});
  await page.waitForTimeout(300);
}

async function visibleLoaderSummaries(page: { locator: (selector: string) => { evaluateAll: (fn: (els: Element[]) => string[]) => Promise<string[]> } }) {
  return page
    .locator('.loading-skeleton:visible, .spinner:visible, .spin:visible, [aria-busy="true"]:visible')
    .evaluateAll((els) =>
      els
        .map((el) => (el.textContent || el.getAttribute('aria-label') || el.className || '').toString().replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .slice(0, 5),
    );
}

function percentile(values: number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((percentileValue / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))];
}
