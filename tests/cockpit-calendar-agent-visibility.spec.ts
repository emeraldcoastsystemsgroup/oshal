/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added targeted calendar visibility regression coverage for work-item-backed assignee projection and calendar bot filter rendering
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Un-quarantine (ENV empty-DB): both cases now self-seed an assigned ticket (assignedAgentId=code-developer, a registered swarm agent) instead of relying on ambient data a fresh ephemeral CI DB does not have. The bot-filter case navigates via the framework ribbon + __cockpit.switchView (bare /cockpit/ lands on the heavy Jarvis surface) and asserts the seeded assignee — which is a registered agent, so it always appears in the calendar bot filter — no longer skipping. No product changes.
 */

import { expect, test } from '@playwright/test';

const COCKPIT_URL = '/cockpit/?profile=oshal-framework';
// A registered swarm agent (see swarm-bot-registry.ts). The calendar bot filter is
// populated from the agent registry, and each option label embeds the agent name, so a
// ticket assigned to this id both projects an assignee into the hierarchy AND is
// guaranteed to appear in #calBotFilter.
const ASSIGNEE_AGENT_ID = 'code-developer';

/** @description Flattens nested cockpit ticket hierarchy rows into a single array for assertions. */
function flattenTickets(tickets: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return tickets.reduce<Array<Record<string, unknown>>>((allTickets, ticket) => {
    const children = Array.isArray(ticket.children) ? flattenTickets(ticket.children as Array<Record<string, unknown>>) : [];
    return [...allTickets, ticket, ...children];
  }, []);
}

/**
 * @description Seeds a root ticket assigned to a registered swarm agent so calendar
 * assignee projection has deterministic live data (a fresh ephemeral CI DB has none).
 * @param request - Playwright API request context.
 * @returns The created ticketId.
 */
async function seedAssignedTicket(
  request: import('@playwright/test').APIRequestContext,
): Promise<string> {
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const resp = await request.post('/api/tickets', {
    data: {
      title: `Calendar Assignee Seed ${suffix}`,
      description: 'Seeds an assigned ticket for calendar assignee-projection coverage.',
      assignedAgentId: ASSIGNEE_AGENT_ID,
    },
  });
  expect(resp.ok()).toBeTruthy();
  const body = await resp.json();
  expect(body.ticketId).toBeTruthy();
  return String(body.ticketId);
}

/**
 * @description Opens the cockpit calendar view reliably. Uses the lightweight framework
 * ribbon (bare /cockpit/ lands on the heavy Jarvis surface whose load churn blocks
 * interaction) and switches view via __cockpit.switchView with retries, using #calBotFilter
 * as the "view mounted" signal. Mirrors the sanctioned openCockpitConnectors pattern.
 * @param page - Playwright page to drive.
 */
async function openCockpitCalendar(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(COCKPIT_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => Boolean((window as unknown as { __cockpit?: { switchView?: unknown } }).__cockpit?.switchView),
    null,
    { timeout: 40000 },
  );
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await page
      .evaluate(() => (window as unknown as { __cockpit?: { switchView?: (v: string) => unknown } }).__cockpit?.switchView?.('calendar'))
      .catch(() => {});
    if (await page.locator('#calBotFilter').isVisible().catch(() => false)) break;
    await page.waitForTimeout(600);
  }
  // Last resort for older cockpit builds without __cockpit.switchView.
  await page.locator('.ribbon-btn[data-view="calendar"]').click({ timeout: 5000 }).catch(() => {});
  await expect(page.locator('#calBotFilter')).toBeVisible({ timeout: 15000 });
  await page.waitForLoadState('load').catch(() => {});
}

test.describe('Cockpit calendar agent visibility', () => {
  test('ticket hierarchy exposes at least one assignee for calendar bot filtering', async ({ request }) => {
    await seedAssignedTicket(request);

    const response = await request.get('/api/v1/tickets/hierarchy');
    expect(response.ok()).toBeTruthy();

    const body = await response.json();
    const hierarchyTickets = Array.isArray(body.tickets)
      ? body.tickets
      : (Array.isArray(body.data) ? body.data : []);
    const flattenedTickets = flattenTickets(hierarchyTickets);
    const assignedTickets = flattenedTickets.filter((ticket) => {
      const assignee = typeof ticket.assignee === 'string' ? ticket.assignee.trim() : '';
      return assignee.length > 0;
    });

    expect(assignedTickets.length).toBeGreaterThan(0);
  });

  test('calendar bot filter renders with live assignee-backed options', async ({ page, request }) => {
    test.setTimeout(120000);
    const seededId = await seedAssignedTicket(request);

    const response = await request.get('/api/v1/tickets/hierarchy');
    expect(response.ok()).toBeTruthy();

    const body = await response.json();
    const hierarchyTickets = Array.isArray(body.tickets)
      ? body.tickets
      : (Array.isArray(body.data) ? body.data : []);
    const flattenedTickets = flattenTickets(hierarchyTickets);
    // The seeded ticket must project its assignee into the hierarchy payload.
    const seededTicket = flattenedTickets.find(
      (ticket) => ticket.id === seededId || ticket.ticketId === seededId,
    );
    expect(seededTicket).toBeTruthy();
    const assignee = typeof seededTicket?.assignee === 'string' ? seededTicket.assignee.trim() : '';
    expect(assignee.length).toBeGreaterThan(0);

    await openCockpitCalendar(page);

    const botFilterText = await page.locator('#calBotFilter').textContent();
    expect(botFilterText || '').toContain(assignee);
  });
});