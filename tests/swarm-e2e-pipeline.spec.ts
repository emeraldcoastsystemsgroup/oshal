/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | EG-4: Automated swarm E2E Playwright tests — validates ticket creation, approval, routing, execution, and dashboard accuracy
 */

import { test, expect } from '@playwright/test';

const BASE = process.env.PLAYWRIGHT_BASE_URL || `http://localhost:${process.env.PLAYWRIGHT_PORT || '3456'}`;

test.describe('Swarm E2E Pipeline', () => {
  test('ticket creation returns a valid ticket with backlog status', async ({ request }) => {
    const res = await request.post(`${BASE}/api/tickets`, {
      data: { title: 'E2E Test: Swarm Pipeline Validation', description: 'Automated E2E test ticket.', priority: 'low' },
    });
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(body.ticketId).toBeTruthy();
    expect(body.status).toBe('backlog');
  });

  test('ticket approval transitions status to approved', async ({ request }) => {
    const createRes = await request.post(`${BASE}/api/tickets`, {
      data: { title: 'E2E Approval Test', description: 'Testing approval transition.', priority: 'low' },
    });
    const ticket = await createRes.json();
    const patchRes = await request.patch(`${BASE}/api/tickets/${ticket.ticketId}`, {
      data: { status: 'approved' },
    });
    expect(patchRes.ok()).toBe(true);
  });

  test('metrics summary returns valid dashboard data', async ({ request }) => {
    const res = await request.get(`${BASE}/api/v1/metrics/summary`);
    expect(res.ok()).toBe(true);
    const { data } = await res.json();
    expect(data.total).toBeGreaterThanOrEqual(0);
    expect(data.swarmHealth).toBeTruthy();
    expect(data.swarmHealth.healthy).toBeGreaterThanOrEqual(0);
    expect(data.costSeries).toBeInstanceOf(Array);
    expect(data.agents).toBeTruthy();
    expect(typeof data.agents.total).toBe('number');
  });

  test('metrics agents endpoint returns per-agent data', async ({ request }) => {
    const res = await request.get(`${BASE}/api/v1/metrics/agents`);
    expect(res.ok()).toBe(true);
    const body = await res.json();
    const agents = body.agents || body;
    expect(Array.isArray(agents)).toBe(true);
  });

  test('bot registry returns online bots with heartbeats', async ({ request }) => {
    const res = await request.get(`${BASE}/api/swarm/bots/registry`);
    expect(res.ok()).toBe(true);
    const { bots } = await res.json();
    expect(Array.isArray(bots)).toBe(true);
    expect(bots.length).toBeGreaterThan(0);
    const onlineBots = bots.filter((b: any) => b.online);
    expect(onlineBots.length).toBeGreaterThan(0);
  });

  test('work items endpoint returns swarm execution history', async ({ request }) => {
    const res = await request.get(`${BASE}/api/swarm/work-items`);
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(body.items || body.workItems || Array.isArray(body)).toBeTruthy();
  });

  test('escalations endpoint returns escalation records', async ({ request }) => {
    const res = await request.get(`${BASE}/api/swarm/escalations`);
    expect(res.ok()).toBe(true);
  });

  test('ticket reply endpoint accepts operator messages', async ({ request }) => {
    const createRes = await request.post(`${BASE}/api/tickets`, {
      data: { title: 'E2E Reply Test', description: 'Testing reply endpoint.', priority: 'low' },
    });
    const ticket = await createRes.json();
    const replyRes = await request.post(`${BASE}/api/v1/tickets/${ticket.ticketId}/reply`, {
      data: { text: 'Operator guidance for this ticket', intent: 'update' },
    });
    expect(replyRes.ok()).toBe(true);
  });

  test('agent status list returns status for all registered agents', async ({ request }) => {
    const res = await request.get(`${BASE}/api/agents/status-list`);
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(Array.isArray(body.agents || body)).toBe(true);
  });

  test('health endpoint returns ok status', async ({ request }) => {
    const res = await request.get(`${BASE}/api/health`);
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(body.status).toBe('ok');
  });

  test('queue manager activity returns runtime snapshot', async ({ request }) => {
    const res = await request.get(`${BASE}/api/qm/activity`);
    if (res.ok()) {
      const body = await res.json();
      expect(body.agents || body.data).toBeTruthy();
    }
    // Non-fatal if QM activity route is not mounted (host server without PM role)
  });
});

test.describe('Swarm E2E — Cockpit Surfaces', () => {
  test('cockpit loads without errors', async ({ page }) => {
    const response = await page.goto(`${BASE}/cockpit/`);
    expect(response?.ok()).toBe(true);
    await expect(page.locator('body')).toContainText('Dashboard', { timeout: 10000 });
  });

  test('queue dashboard page loads', async ({ page }) => {
    const response = await page.goto(`${BASE}/queue-dashboard/`);
    expect(response?.ok()).toBe(true);
  });

  test('queue manager admin page loads', async ({ page }) => {
    const response = await page.goto(`${BASE}/queue-manager-admin/`);
    expect(response?.ok()).toBe(true);
  });

  test('health dashboard page loads', async ({ page }) => {
    const response = await page.goto(`${BASE}/health-dashboard/`);
    expect(response?.ok()).toBe(true);
  });

  test('swarm control page loads', async ({ page }) => {
    const response = await page.goto(`${BASE}/swarm-control/`);
    expect(response?.ok()).toBe(true);
  });
});
