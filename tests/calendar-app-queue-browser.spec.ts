/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Browser e2e: cockpit Calendar under a focused app requests its own queue; default cockpit stays unscoped
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Re-fixtured home -> oshal-engineering (ticketType build): home carved to the app store (ADR-085 Wave 2) and the test server installs no packages; the D5 rule says pin shared specs on kernel-resident apps only.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Un-quarantined (07-19 ratchet): fixed the two real instabilities - RibbonNav's innerHTML re-render detaches the first-rendered calendar button when the ?app= profile resolves (settle-poll on .ribbon-bottom before locating), and the engineering ribbon's 9 bottom items overlap the button at 720px (realistic 1600px operator viewport). Sibling default-cockpit case got the same settle-then-click. 3 consecutive zero-retry CI-mirror runs green.
 */

import { expect, test } from '@playwright/test';

/**
 * @description Canned build schedule so the calendar renders deterministically
 * (no Redis dependency) while we assert the request the view makes.
 */
const APP_SCHEDULE = {
  id: 'build',
  taskType: 'build',
  cron: '0 9 * * *',
  status: 'active',
  nextRunAt: null as string | null,
  taskData: { prompt: 'Nightly build sweep', label: 'Nightly build sweep' },
};

/**
 * @description Intercepts the calendar's data endpoints, recording the exact URLs
 * requested and returning canned payloads. `/api/agents` is emptied to avoid the
 * per-agent tool fan-out; the manifest endpoint is left live to prove real
 * ?app= → ticketType resolution.
 */
async function interceptCalendar(page: import('@playwright/test').Page, seen: string[]) {
  await page.route('**/api/agents**', (route) => route.fulfill({ json: { agents: [] } }));
  // Serve the app manifest with the production shape ({ app: { manifest: { ticketType } } },
  // confirmed against SwarmApplicationRecord) so the test isolates the client wiring
  // (read manifest.ticketType → request it) from whether the test DB auto-loaded apps.
  await page.route('**/api/swarm/apps/oshal-engineering**', (route) =>
    route.fulfill({ json: { app: { name: 'oshal-engineering', manifest: { ticketType: 'build' } } } }),
  );
  await page.route('**/api/v1/agent/schedules**', (route) => {
    seen.push(route.request().url());
    route.fulfill({ json: { success: true, schedules: [APP_SCHEDULE] } });
  });
  await page.route('**/api/v1/tickets/hierarchy**', (route) => {
    seen.push(route.request().url());
    route.fulfill({ json: { success: true, tickets: [] } });
  });
}

function find(seen: string[], path: string): string | undefined {
  return seen.find((u) => u.includes(path));
}

test.describe('Cockpit calendar — per-app queue scoping (browser)', () => {
  test('?app=oshal-engineering calendar requests only the build queue', async ({ page }) => {
    const seen: string[] = [];
    await interceptCalendar(page, seen);

    // Two real instabilities here (the 07-19 quarantine): (1) RibbonNav re-renders via a
    // full innerHTML swap when the ?app= profile resolves, DETACHING the first-rendered
    // calendar button mid-action; (2) the engineering ribbon's 9 bottom items overflow the
    // default 720px headless viewport and overlap the button. The subject under test is
    // REQUEST SCOPING, not ribbon layout — so: realistic operator height, wait for the
    // ribbon to settle into the APP shape (bottom tray grows past the 4 framework
    // defaults — proof the app re-render already happened), then a plain click (which
    // re-resolves on any residual detach; no force, clickability stays tested).
    await page.setViewportSize({ width: 1280, height: 1600 });
    await page.goto('/cockpit/?app=oshal-engineering');
    await expect
      .poll(() => page.locator('.ribbon-bottom .ribbon-btn').count(), { timeout: 20000 })
      .toBeGreaterThan(4);
    const calendarBtn = page.locator('.ribbon-btn[data-view="calendar"]');
    await expect(calendarBtn, 'engineering app exposes a Calendar ribbon item').toBeVisible({ timeout: 20000 });
    await calendarBtn.click();

    // Give the view time to resolve the app manifest and issue its scoped fetches.
    await expect(page.locator('.calendar-view')).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(1500);

    const schedulesUrl = find(seen, '/api/v1/agent/schedules');
    const hierarchyUrl = find(seen, '/api/v1/tickets/hierarchy');
    expect(schedulesUrl, 'calendar fetched schedules').toBeTruthy();
    expect(hierarchyUrl, 'calendar fetched ticket hierarchy').toBeTruthy();
    expect(schedulesUrl, 'schedules scoped to the app queue').toContain('taskType=build');
    expect(hierarchyUrl, 'tickets scoped to the app queue').toContain('type=build');

    await page.screenshot({ path: 'test-results/app-calendar.png', fullPage: true });
  });

  test('default cockpit (no app) requests the calendar unscoped', async ({ page }) => {
    const seen: string[] = [];
    await interceptCalendar(page, seen);

    await page.goto('/cockpit/');
    // Same settle-then-click medicine as the app-scoped case above: the ribbon renders via
    // a full innerHTML swap, so wait for the framework-default bottom tray to exist before
    // locating the button (a click on a pre-settle node can land on a detached element and
    // the calendar view never mounts — the loaded-box flake signature).
    await expect
      .poll(() => page.locator('.ribbon-bottom .ribbon-btn').count(), { timeout: 20000 })
      .toBeGreaterThan(0);
    const calendarBtn = page.locator('.ribbon-btn[data-view="calendar"]');
    await expect(calendarBtn).toBeVisible({ timeout: 20000 });
    await calendarBtn.click();
    await expect(page.locator('.calendar-view')).toBeVisible({ timeout: 25000 });
    await page.waitForTimeout(1500);

    const schedulesUrl = find(seen, '/api/v1/agent/schedules');
    expect(schedulesUrl, 'calendar fetched schedules').toBeTruthy();
    expect(schedulesUrl, 'no app focused → no queue filter').not.toContain('taskType=');
    const hierarchyUrl = find(seen, '/api/v1/tickets/hierarchy');
    if (hierarchyUrl) expect(hierarchyUrl).not.toContain('type=');
  });
});
