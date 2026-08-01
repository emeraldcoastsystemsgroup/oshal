/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard: the portrait-phone ribbon drawer is ONE scrolling column. The drawer used to keep the desktop's pinned home/bottom trays, so the pinned platform tray starved the scrollable app tray down to ~one visible row on the default deployment ("you can barely see one app"). Asserts real hit-tested visibility, not clipped bounding boxes.
 */

import { test, expect, type Page } from '@playwright/test';

const COCKPIT_URL = '/cockpit/';

// iPhone SE / 8-class portrait viewport — short enough that the old pinned
// bottom tray (base essentials + appended platform pins) consumed the whole
// drawer height on its own.
const PHONE = { width: 390, height: 667 };

/** Open the mobile drawer and wait for the ribbon to finish rendering. */
async function openDrawer(page: Page) {
  await page.goto(COCKPIT_URL);
  // Ribbon renders async after the guest/operator/profile fetches; on the
  // isolated (DB-less) test server those ride out connection timeouts first,
  // so give the render the long leash rather than a fixed sleep.
  await page.waitForSelector('.ribbon-scroll .ribbon-btn', { state: 'attached', timeout: 25000 });
  await page.locator('#mobileMenuBtn').click();
  await expect(page.locator('.ribbon-nav')).toHaveClass(/mobile-open/);
  // Let the 220ms slide-in transition settle so hit-testing sees final geometry.
  await page.waitForTimeout(350);
}

/**
 * Count app-tray buttons that are ACTUALLY visible: on-screen AND the topmost
 * element at their own center. A clipped button inside an overflowed tray still
 * reports an on-screen bounding box, so a rect-only check would pass against
 * the broken layout — elementFromPoint is what proves a row isn't painted over
 * by (or hidden under) the pinned trays.
 */
async function countVisibleAppRows(page: Page): Promise<number> {
  return page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('.ribbon-scroll .ribbon-btn'));
    let visible = 0;
    for (const b of btns) {
      const r = b.getBoundingClientRect();
      if (r.top < 0 || r.bottom > window.innerHeight || r.height === 0) continue;
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (hit && (hit === b || b.contains(hit))) visible += 1;
    }
    return visible;
  });
}

test.describe('Cockpit — portrait-phone ribbon drawer', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(PHONE);
  });

  test('opening the drawer shows several app rows, not a starved sliver', async ({ page }) => {
    await openDrawer(page);
    // Old layout: pinned bottom tray (13+ rows × 46px) left the app tray ≤2
    // visible rows on this viewport (1 with the default deployment profile,
    // 2 with the built-in fallback). One scrolling column shows ≥4 either way.
    const visible = await countVisibleAppRows(page);
    expect(visible).toBeGreaterThanOrEqual(4);
  });

  test('the whole drawer scrolls as one column and the bottom tray stays reachable', async ({ page }) => {
    await openDrawer(page);
    // The nav itself must be the scroll container on a phone…
    const navScrolls = await page.evaluate(() => {
      const nav = document.querySelector('.ribbon-nav') as HTMLElement;
      return getComputedStyle(nav).overflowY === 'auto' && nav.scrollHeight > nav.clientHeight;
    });
    expect(navScrolls).toBe(true);
    // …and scrolling it to the end must land the bottom-tray essentials
    // (Settings) actually on screen and hit-testable, so unpinning the tray
    // never makes the essentials unreachable.
    const settingsVisible = await page.evaluate(() => {
      const nav = document.querySelector('.ribbon-nav') as HTMLElement;
      nav.scrollTop = nav.scrollHeight;
      const btn = document.querySelector('.ribbon-bottom .ribbon-btn[data-view="settings"]');
      if (!btn) return 'missing';
      const r = btn.getBoundingClientRect();
      if (r.top < 0 || r.bottom > window.innerHeight || r.height === 0) return 'offscreen';
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return hit && (hit === btn || btn.contains(hit)) ? 'visible' : 'covered';
    });
    expect(settingsVisible).toBe('visible');
  });

  test('picking an app from the drawer closes it', async ({ page }) => {
    await openDrawer(page);
    await page.locator('.ribbon-scroll .ribbon-btn').first().click();
    await expect(page.locator('.ribbon-nav')).not.toHaveClass(/mobile-open/);
  });
});
