/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the first-run model-state banners: both variants (free-shared-model info + no-model warn) must carry a working dismiss that removes the banner and keeps it closed for the session, and at a 375px phone viewport the banner must wrap inside the viewport with a hit-testable close control — the shipped bug was a dismiss-less banner whose non-wrapping flex row filled the whole phone screen. Real cockpit JS + real stylesheets in a real engine; only the two JSON APIs the banner reads are mocked.
 */

import { test, expect, type Page } from '@playwright/test';

// The service worker must not answer for the mocked APIs — page.route only owns the
// network when SW interception is out of the picture.
test.use({ serviceWorkers: 'block' });

/** iPhone SE / 6-8 portrait — the viewport the banner previously swallowed whole. */
const PHONE = { width: 375, height: 667 };

/**
 * The cockpit document, addressed so the test reaches the page under test on a keyless
 * box: the G3 onboarding gate 302s the bare '/cockpit'+'/cockpit/' document paths to
 * /welcome whenever no provider selection exists (deliberately not waivable by
 * DISABLE_ONBOARDING_GATE), and this spec tests the banner, not the gate. The static
 * route serves the identical document; the banner code is client-side and driven
 * entirely by the two mocked APIs below.
 */
const COCKPIT_DOC = '/cockpit/index.html';

/** /api/providers/access shape for "active provider IS the pooled free model" (info banner). */
const FREE_MODEL_ACCESS = {
  hasActive: true,
  activeProvider: 'openrouter',
  freeModel: { provider: 'openrouter', model: 'free-pool' },
  providers: [{ id: 'openrouter', label: 'OpenRouter', active: true, configured: true }],
};

/** /api/providers/access shape for "nothing connected at all" (warn banner). */
const NO_MODEL_ACCESS = { hasActive: false, freeModel: null, providers: [] };

/**
 * @description Mock the two JSON endpoints first-run.js reads, so the REAL banner code renders
 * deterministically on a DB-less test server. A signed-in (non-guest) user is reported so the
 * model banners — not the guest strip — are the code path under test.
 * @param page - Playwright page.
 * @param access - The /api/providers/access payload to serve.
 */
async function mockBannerApis(page: Page, access: unknown): Promise<void> {
  await page.route('**/api/providers/access', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(access) }),
  );
  await page.route('**/api/auth/user', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ user: { sub: 'e2e-banner-user', is_guest: false }, guestMode: false }),
    }),
  );
}

test.describe('First-run model-state banner — dismissible, and phone-safe', () => {
  test('free-shared-model banner has a dismiss that removes it and holds for the session', async ({ page }) => {
    await mockBannerApis(page, FREE_MODEL_ACCESS);
    await page.goto(COCKPIT_DOC);

    const banner = page.locator('#oshalFirstRun .ofr-info');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('free shared model');
    // The reminder's CTAs must survive the dismiss affordance being added.
    await expect(banner.locator('a.ofr-btn')).toHaveCount(2);

    const close = banner.locator('.ofr-x');
    await expect(close).toBeVisible();
    await close.click();
    await expect(page.locator('#oshalFirstRun .ofr-info')).toHaveCount(0);

    // Same session (sessionStorage survives reload in the same tab): stays closed. The
    // getting-started strip rendering proves init completed rather than never running.
    await page.reload();
    await expect(page.locator('#oshalFirstRun .ofr-gs')).toBeVisible();
    await expect(page.locator('#oshalFirstRun .ofr-info')).toHaveCount(0);
  });

  test('no-model warn banner is dismissible too', async ({ page }) => {
    await mockBannerApis(page, NO_MODEL_ACCESS);
    await page.goto(COCKPIT_DOC);

    const banner = page.locator('#oshalFirstRun .ofr-warn');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('No AI model connected');
    await banner.locator('.ofr-x').click();
    await expect(page.locator('#oshalFirstRun .ofr-warn')).toHaveCount(0);
  });

  test('at 375px the banner wraps inside the viewport and the close control is hit-testable', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await mockBannerApis(page, FREE_MODEL_ACCESS);
    await page.goto(COCKPIT_DOC);

    const banner = page.locator('#oshalFirstRun .ofr-info');
    await expect(banner).toBeVisible();

    const probe = await page.evaluate(() => {
      const bar = document.querySelector('#oshalFirstRun .ofr-info') as HTMLElement;
      const close = bar.querySelector('.ofr-x') as HTMLElement;
      const barRect = bar.getBoundingClientRect();
      const closeRect = close.getBoundingClientRect();
      const cx = closeRect.left + closeRect.width / 2;
      const cy = closeRect.top + closeRect.height / 2;
      const hit = document.elementFromPoint(cx, cy);
      const doc = document.documentElement;
      return {
        barRight: Math.round(barRect.right),
        barHeight: Math.round(barRect.height),
        closeInViewport:
          closeRect.left >= 0 && closeRect.right <= window.innerWidth &&
          closeRect.top >= 0 && closeRect.bottom <= window.innerHeight,
        closeHit: Boolean(hit && (hit === close || close.contains(hit))),
        horizontalOverflowPx: Math.round(doc.scrollWidth - doc.clientWidth),
      };
    });

    // The shipped failure: a non-wrapping flex row — nowrap buttons overflowed the viewport
    // and the squeezed text column grew the bar toward the full screen height.
    expect(probe.horizontalOverflowPx).toBeLessThanOrEqual(1);
    expect(probe.barRight).toBeLessThanOrEqual(PHONE.width + 1);
    expect(probe.barHeight).toBeLessThan(PHONE.height / 2);
    expect(probe.closeInViewport).toBe(true);
    expect(probe.closeHit).toBe(true);

    await banner.locator('.ofr-x').click();
    await expect(page.locator('#oshalFirstRun .ofr-info')).toHaveCount(0);
  });
});
