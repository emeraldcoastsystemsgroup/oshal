/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Real 375px-viewport scroll guard for the cockpit app shell. The only existing coverage for the flexbox scroll trap was tests/unit/cockpit-ticket-view-scroll.spec.ts, which REGEXES the stylesheet — it proves the declarations are written, never that Chromium lays them out that way, so a trap introduced by an ancestor rule (the actual failure mode: an intermediate flex item with a content-based automatic minimum size) passes it silently. These assertions measure real layout in a real engine: for each surface the designated scroll child must be the element that scrolls, its bottom edge must stay inside the viewport (content below the fold with no scroller is content a phone user can never reach), the app shell must not scroll the document, and nothing may widen the page horizontally. Covers the ticket detail (.td-body), the calendar grid and the settings pane — the audit list from the backlog item.
 */

import { test, expect, type Page } from '@playwright/test';

/** iPhone SE / 6-8 portrait — the narrowest mainstream phone the cockpit has to survive. */
const PHONE = { width: 375, height: 667 };

const TICKET_ID = 'tkt-mobile-375';

/** One ticket row for the hierarchy list. */
const TICKET = {
  id: TICKET_ID,
  ticketId: TICKET_ID,
  sequenceId: 'M375',
  name: 'Mobile scroll regression fixture',
  title: 'Mobile scroll regression fixture',
  description: 'Fixture ticket used to measure the ticket-detail scroll structure at 375px.',
  state: 'In Progress',
  status: 'in_progress',
  cost: 0,
  createdAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
  children: [],
};

/**
 * A timeline long enough that the detail body MUST overflow a 667px-tall phone, so
 * "does the right element scroll?" is a question with a real answer rather than a
 * vacuous pass on content that happens to fit.
 */
const TIMELINE = Array.from({ length: 60 }, (_, i) => ({
  id: `evt-${i}`,
  type: 'message',
  actor: 'swarm',
  author: 'swarm',
  text: `Timeline entry ${i} — deliberately long filler so the detail body overflows a phone viewport and the scroll container has to be real.`,
  message: `Timeline entry ${i}`,
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
  timestamp: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
}));

/**
 * @description Install the ticket API mocks the cockpit ticket view drives its render from, so
 * the surface renders deterministic, deliberately-overflowing content on a DB-less test server.
 * The REAL cockpit JS and the REAL stylesheets do the layout — only the data is fixed.
 * @param page - Playwright page.
 */
async function mockTicketApis(page: Page): Promise<void> {
  // Registered first: the SSE stream must not be swallowed by the /activity glob below.
  await page.route('**/api/v1/tickets/*/activity/stream*', (route) =>
    route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' }),
  );
  await page.route('**/api/v1/tickets/hierarchy**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: [TICKET], total: 1 }) }),
  );
  await page.route('**/api/v1/tickets/*/activity', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: { ticket: TICKET, timeline: TIMELINE, cost: {} } }),
    }),
  );
}

/** Layout facts read straight out of the live engine for one surface. */
interface ScrollProbe {
  found: boolean;
  overflowY: string;
  scrollerScrolls: boolean;
  scrolledTo: number;
  bottomOverflowPx: number;
  rootOverflowPx: number;
  documentScrollsPx: number;
  horizontalOverflowPx: number;
}

/**
 * @description Measure whether `scrollSel` is genuinely the scrolling element of `rootSel` at the
 * current viewport. `bottomOverflowPx > 0` is the failure that matters on a phone: the scroll box
 * itself extends past the fold, so its lower content is clipped by an ancestor and unreachable.
 * @param page - Playwright page.
 * @param rootSel - Selector for the surface root (the height-bounded container).
 * @param scrollSel - Selector for the element that is supposed to scroll.
 * @returns The measured layout facts.
 */
async function probeScroll(page: Page, rootSel: string, scrollSel: string): Promise<ScrollProbe> {
  return page.evaluate(
    ([rootSelector, scrollSelector]) => {
      const root = document.querySelector(rootSelector) as HTMLElement | null;
      const scroller = document.querySelector(scrollSelector) as HTMLElement | null;
      const empty: ScrollProbe = {
        found: false, overflowY: '', scrollerScrolls: false, scrolledTo: 0,
        bottomOverflowPx: 0, rootOverflowPx: 0, documentScrollsPx: 0, horizontalOverflowPx: 0,
      };
      if (!root || !scroller) return empty;
      scroller.scrollTop = 0;
      const canScroll = scroller.scrollHeight > scroller.clientHeight + 1;
      scroller.scrollTop = 1_000_000;
      const scrolledTo = scroller.scrollTop;
      scroller.scrollTop = 0;
      const doc = document.documentElement;
      return {
        found: true,
        overflowY: getComputedStyle(scroller).overflowY,
        scrollerScrolls: canScroll,
        scrolledTo,
        bottomOverflowPx: Math.round(scroller.getBoundingClientRect().bottom - window.innerHeight),
        rootOverflowPx: Math.round(root.scrollHeight - root.clientHeight),
        documentScrollsPx: Math.round(doc.scrollHeight - doc.clientHeight),
        horizontalOverflowPx: Math.round(doc.scrollWidth - doc.clientWidth),
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    },
    [rootSel, scrollSel] as [string, string],
  ) as Promise<ScrollProbe>;
}

/**
 * @description Switch the cockpit to a view through the SAME entry point the ribbon button uses,
 * then wait for the surface root. Clicking through the phone drawer would test the drawer, which
 * tests/cockpit-mobile-drawer.spec.ts already owns.
 * @param page - Playwright page.
 * @param viewId - Ribbon view id.
 * @param rootSelector - Selector that proves the surface rendered.
 */
async function openView(page: Page, viewId: string, rootSelector: string): Promise<void> {
  await page.waitForFunction(() => Boolean((window as unknown as { __cockpit?: unknown }).__cockpit), null, { timeout: 30000 });
  await page.evaluate(
    (id) => (window as unknown as { __cockpit: { switchView: (v: string) => Promise<void> } }).__cockpit.switchView(id),
    viewId,
  );
  await page.waitForSelector(rootSelector, { state: 'attached', timeout: 30000 });
}

test.describe('Cockpit at 375px — the designated scroll child is the element that scrolls', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(PHONE);
  });

  test('ticket detail: .td-body scrolls, the pane does not, and nothing falls below the fold', async ({ page }) => {
    await mockTicketApis(page);
    await page.goto(`/cockpit/?ticket=${TICKET_ID}`);
    await page.waitForSelector('.td-body', { state: 'attached', timeout: 30000 });
    // The mocked timeline is 60 entries: if the body is not overflowing, the fixture (not the
    // layout) is broken and every assertion below would be vacuous.
    await page.waitForFunction(
      () => {
        const b = document.querySelector('.td-body') as HTMLElement | null;
        return Boolean(b && b.scrollHeight > b.clientHeight + 1);
      },
      null,
      { timeout: 30000 },
    );

    const probe = await probeScroll(page, '.ticket-detail-pane', '.td-body');
    expect(probe.found, '.ticket-detail-pane + .td-body must both render').toBe(true);
    // 1. The body is a real scroll box and actually moves when scrolled.
    expect(['auto', 'scroll']).toContain(probe.overflowY);
    expect(probe.scrollerScrolls).toBe(true);
    expect(probe.scrolledTo).toBeGreaterThan(0);
    // 2. THE trap: the scroll box itself must not extend past the fold. When an ancestor flex item
    //    keeps its content-based minimum height, .td-body grows to its content, its bottom lands
    //    hundreds of px below the viewport, and the overflow:hidden pane clips the rest away.
    expect(probe.bottomOverflowPx).toBeLessThanOrEqual(1);
    // 3. The pane delegates scrolling instead of becoming one giant scroll block.
    expect(probe.rootOverflowPx).toBeLessThanOrEqual(1);
    // 4. The app shell is fixed-height: the document must not scroll, in either axis.
    expect(probe.documentScrollsPx).toBeLessThanOrEqual(1);
    expect(probe.horizontalOverflowPx).toBeLessThanOrEqual(1);
  });

  test('ticket detail: the pinned header stays put while the body scrolls', async ({ page }) => {
    await mockTicketApis(page);
    await page.goto(`/cockpit/?ticket=${TICKET_ID}`);
    await page.waitForSelector('.td-header', { state: 'attached', timeout: 30000 });
    const moved = await page.evaluate(() => {
      const header = document.querySelector('.td-header') as HTMLElement;
      const body = document.querySelector('.td-body') as HTMLElement;
      const before = header.getBoundingClientRect().top;
      body.scrollTop = 1_000_000;
      const after = header.getBoundingClientRect().top;
      return { delta: Math.round(after - before), scrolled: body.scrollTop, headerVisible: header.getBoundingClientRect().top >= -1 };
    });
    expect(moved.scrolled, 'fixture must actually scroll for this assertion to mean anything').toBeGreaterThan(0);
    expect(moved.delta).toBe(0);
    expect(moved.headerVisible).toBe(true);
  });

  test('calendar: .cal-grid-container is the scroll child and stays inside the viewport', async ({ page }) => {
    await mockTicketApis(page);
    await page.goto('/cockpit/');
    await openView(page, 'calendar', '.calendar-view');
    const probe = await probeScroll(page, '.calendar-view', '.cal-grid-container');
    expect(probe.found, '.calendar-view + .cal-grid-container must both render').toBe(true);
    expect(['auto', 'scroll']).toContain(probe.overflowY);
    expect(probe.bottomOverflowPx).toBeLessThanOrEqual(1);
    expect(probe.rootOverflowPx).toBeLessThanOrEqual(1);
    expect(probe.documentScrollsPx).toBeLessThanOrEqual(1);
    expect(probe.horizontalOverflowPx).toBeLessThanOrEqual(1);
    // A month grid on a 375px phone is taller than 667px: if it does not overflow, the calendar
    // is rendering nothing and this whole test would be vacuous.
    expect(probe.scrollerScrolls).toBe(true);
    expect(probe.scrolledTo).toBeGreaterThan(0);
  });

  test('settings: .settings-content is the scroll child and stays inside the viewport', async ({ page }) => {
    await mockTicketApis(page);
    await page.goto('/cockpit/');
    await openView(page, 'settings', '.settings-view');
    const probe = await probeScroll(page, '.settings-view', '.settings-content');
    expect(probe.found, '.settings-view + .settings-content must both render').toBe(true);
    expect(['auto', 'scroll']).toContain(probe.overflowY);
    expect(probe.bottomOverflowPx).toBeLessThanOrEqual(1);
    expect(probe.rootOverflowPx).toBeLessThanOrEqual(1);
    expect(probe.documentScrollsPx).toBeLessThanOrEqual(1);
    expect(probe.horizontalOverflowPx).toBeLessThanOrEqual(1);
    expect(probe.scrollerScrolls).toBe(true);
    expect(probe.scrolledTo).toBeGreaterThan(0);
  });
});
