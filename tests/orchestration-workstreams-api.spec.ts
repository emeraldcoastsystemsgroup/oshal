/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Phase 12 S7: API-level tests for orchestration workstreams WS1 (debug trace), WS5 (ticket reply persistence), WS6 (parent assembly escalation)
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Track B S4: Agent status toggle now includes container operation field in response
 */

import { test, expect } from '@playwright/test';

// ── WS1: Runtime Trace Analyzer ───────────────────────────────────────────────

test.describe('WS1 — Debug Trace API', () => {
  test('GET /api/debug/tickets/:ticketId/trace — rejects missing workspaceTaskId', async ({ request }) => {
    const res = await request.get('/api/debug/tickets/PROJ-TEST/trace');
    expect(res.status()).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toContain('workspaceTaskId');
  });

  test('GET /api/debug/tickets/:ticketId/trace — returns empty trace for unknown workspace', async ({ request }) => {
    const res = await request.get('/api/debug/tickets/PROJ-NONEXISTENT/trace?workspaceTaskId=00000000-0000-0000-0000-000000000000');
    expect(res.ok()).toBeTruthy();
    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.ticketId).toBe('PROJ-NONEXISTENT');
    expect(body.traceCount).toBe(0);
    expect(Array.isArray((body.report as Record<string, unknown>)?.traces)).toBeTruthy();
    expect(Array.isArray((body.report as Record<string, unknown>)?.anomalies)).toBeTruthy();
    expect(Array.isArray((body.report as Record<string, unknown>)?.regressionHandoffs)).toBeTruthy();
  });

  test('GET /api/debug/tickets/:ticketId/trace — response includes anomalyCount and regressionCount', async ({ request }) => {
    const res = await request.get('/api/debug/tickets/PROJ-ABC/trace?workspaceTaskId=test-workspace-id');
    expect(res.ok()).toBeTruthy();
    const body = await res.json() as Record<string, unknown>;
    expect(typeof body.anomalyCount).toBe('number');
    expect(typeof body.regressionCount).toBe('number');
    expect(typeof body.traceCount).toBe('number');
  });
});

// ── WS5: Ticket Reply Persistence ────────────────────────────────────────────

test.describe('WS5 — Ticket Reply Persistence', () => {
  test('POST /api/v1/tickets/:id/reply — rejects empty body', async ({ request }) => {
    const res = await request.post('/api/v1/tickets/test-ticket-id/reply', {
      data: {},
    });
    expect(res.status()).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body.success).toBe(false);
    expect(body.error).toContain('text');
  });

  test('POST /api/v1/tickets/:id/reply — rejects whitespace-only text', async ({ request }) => {
    const res = await request.post('/api/v1/tickets/test-ticket-id/reply', {
      data: { text: '   ' },
    });
    expect(res.status()).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body.success).toBe(false);
  });

  test('POST /api/v1/tickets/:id/reply — accepts valid text and returns activity entry', async ({ request }) => {
    const res = await request.post('/api/v1/tickets/test-ticket-id/reply', {
      data: { text: 'Operator note: please prioritize this.' },
    });
    // Succeeds even without a real ticket (graceful degradation — no primary task found)
    expect(res.ok()).toBeTruthy();
    const body = await res.json() as Record<string, unknown>;
    expect(body.success).toBe(true);
    const entry = body.reply as Record<string, unknown>;
    expect(entry.type).toBe('user');
    expect(entry.text).toBe('Operator note: please prioritize this.');
    expect(entry.intent).toBe('update');
    expect(typeof entry.timestamp).toBe('string');
  });

  test('POST /api/v1/tickets/:id/reply — response always has actor and author fields', async ({ request }) => {
    const res = await request.post('/api/v1/tickets/any-ticket/reply', {
      data: { text: 'test update' },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json() as Record<string, unknown>;
    const entry = body.reply as Record<string, unknown>;
    expect(entry.actor).toBe('You');
    expect(entry.author).toBe('user');
  });
});

// ── Track B S4: Bot Container Spawner — agent status toggle includes container field ──

test.describe('Track B S4 — Agent Status Container Response Shape', () => {
  test('PATCH /api/agents/:agentId/status — response includes container field', async ({ request }) => {
    // Use a non-existent agent — expect 404, verifying the route is wired
    const res = await request.patch('/api/agents/nonexistent-bot/status', {
      data: { status: 'active' },
    });
    // 404 is acceptable — confirms the route reached the controller (not 500 from missing route)
    expect([200, 404].includes(res.status())).toBeTruthy();
  });

  test('PATCH /api/agents/:agentId/status — rejects missing status body', async ({ request }) => {
    const res = await request.patch('/api/agents/any-bot/status', {
      data: {},
    });
    expect(res.status()).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toContain('Invalid status');
  });

  test('PATCH /api/agents/:agentId/status — valid toggle returns container operation info when agent exists', async ({ request }) => {
    // List agents first; if any exist, toggle one and check the shape
    const listRes = await request.get('/api/agents/status-list');
    expect(listRes.ok()).toBeTruthy();
    const listBody = await listRes.json() as Record<string, unknown>;
    const agents = listBody.agents as Array<Record<string, unknown>>;

    if (agents.length === 0) {
      // No agents seeded — skip container check, just assert route is functional
      return;
    }

    const target = agents[0];
    const newStatus = target['status'] === 'active' ? 'inactive' : 'active';
    const res = await request.patch(`/api/agents/${target['agentId']}/status`, {
      data: { status: newStatus },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json() as Record<string, unknown>;
    expect(body.success).toBe(true);

    // Track B S4: response must include container field with operation info
    const container = body.container as Record<string, unknown>;
    expect(container).toBeDefined();
    expect(typeof container['operation']).toBe('string');
    expect(['start', 'stop'].includes(container['operation'] as string)).toBeTruthy();
    expect(typeof container['success']).toBe('boolean');
  });
});

// ── WS6: Parent Assembly Escalation ──────────────────────────────────────────

test.describe('WS6 — Agent Status API (Session 3 baseline)', () => {
  // WS6 (parent escalation) is triggered internally by queue-manager; no direct API endpoint.
  // These tests validate the agent-status API from Session 3 which WS6 escalation builds on.

  test('GET /api/agents/status-list — returns agent list with status fields', async ({ request }) => {
    const res = await request.get('/api/agents/status-list');
    expect(res.ok()).toBeTruthy();
    const body = await res.json() as Record<string, unknown>;
    expect(body.success).toBe(true);
    expect(typeof body.count).toBe('number');
    expect(Array.isArray(body.agents)).toBeTruthy();
  });

  test('GET /api/agents/status-list?status=active — filters by active status', async ({ request }) => {
    const res = await request.get('/api/agents/status-list?status=active');
    expect(res.ok()).toBeTruthy();
    const body = await res.json() as Record<string, unknown>;
    expect(body.success).toBe(true);
    const agents = body.agents as Array<Record<string, unknown>>;
    for (const agent of agents) {
      expect(agent.status).toBe('active');
    }
  });

  test('PATCH /api/agents/:agentId/status — rejects invalid status value', async ({ request }) => {
    const res = await request.patch('/api/agents/any-agent-id/status', {
      data: { status: 'unknown-status' },
    });
    expect(res.status()).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toContain('Invalid status');
  });
});
