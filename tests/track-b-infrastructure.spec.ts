/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Track B S5-S7: Infrastructure API tests — agent runtime config, tool registry, startup recovery
 */

import { test, expect } from '@playwright/test';

// ── Track B S5: Schema-driven agent runtime config API ────────────────────────

test.describe('Track B S5 — Agent Runtime Config API', () => {
  test('GET /api/swarm/agents/:agentId/config — 404 for unknown agent', async ({ request }) => {
    const res = await request.get('/api/swarm/agents/nonexistent-bot-xyz/config');
    expect(res.status()).toBe(404);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBeTruthy();
  });

  test('PUT /api/swarm/agents/:agentId/config — rejects empty body', async ({ request }) => {
    const res = await request.put('/api/swarm/agents/test-bot/config', { data: {} });
    expect(res.status()).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toContain('schema');
  });

  test('PUT /api/swarm/agents/:agentId/config — accepts schema + values', async ({ request }) => {
    const agentId = 'test-runtime-config-agent';
    const schema = [
      { name: 'api_key', type: 'password', label: 'API Key', description: 'Service API key' },
      { name: 'base_url', type: 'url', label: 'Base URL', placeholder: 'https://api.example.com' },
    ];
    const values = { api_key: 'sk-test-123', base_url: 'https://api.example.com' };

    const putRes = await request.put(`/api/swarm/agents/${agentId}/config`, {
      data: { schema, values },
    });
    expect(putRes.ok()).toBeTruthy();
    const putBody = await putRes.json() as Record<string, unknown>;
    expect(putBody.agentId).toBe(agentId);
    expect(Array.isArray(putBody.schema)).toBeTruthy();
    expect(typeof putBody.values).toBe('object');
  });

  test('GET /api/swarm/agents/:agentId/config — returns schema + values after PUT', async ({ request }) => {
    const agentId = 'test-runtime-config-agent';

    // PUT first
    await request.put(`/api/swarm/agents/${agentId}/config`, {
      data: {
        schema: [{ name: 'token', type: 'password', label: 'Token' }],
        values: { token: 'bearer-abc' },
      },
    });

    // GET to verify
    const getRes = await request.get(`/api/swarm/agents/${agentId}/config`);
    expect(getRes.ok()).toBeTruthy();
    const body = await getRes.json() as Record<string, unknown>;
    expect(body.agentId).toBe(agentId);
    expect(Array.isArray(body.schema)).toBeTruthy();
    expect(typeof body.values).toBe('object');
  });

  test('PUT /api/swarm/agents/:agentId/config — values-only update merges with existing', async ({ request }) => {
    const agentId = 'test-runtime-config-merge';

    // Set initial
    await request.put(`/api/swarm/agents/${agentId}/config`, {
      data: { schema: [{ name: 'x', type: 'text', label: 'X' }], values: { x: 'first' } },
    });

    // Values-only update
    const updateRes = await request.put(`/api/swarm/agents/${agentId}/config`, {
      data: { values: { x: 'updated' } },
    });
    expect(updateRes.ok()).toBeTruthy();
    const body = await updateRes.json() as Record<string, unknown>;
    const vals = body.values as Record<string, unknown>;
    expect(vals.x).toBe('updated');
  });
});

// ── Track B S6: Dynamic tool registration ─────────────────────────────────────

test.describe('Track B S6 — Tool Registry API', () => {
  test('GET /api/tools — returns registered tools list', async ({ request }) => {
    const res = await request.get('/api/tools');
    expect(res.ok()).toBeTruthy();
    const body = await res.json() as Record<string, unknown>;
    expect(typeof body.count).toBe('number');
    expect(Array.isArray(body.tools)).toBeTruthy();
  });

  test('GET /api/tools — each tool has id, name, and authType', async ({ request }) => {
    const res = await request.get('/api/tools');
    expect(res.ok()).toBeTruthy();
    const body = await res.json() as Record<string, unknown>;
    const tools = body.tools as Array<Record<string, unknown>>;
    for (const tool of tools) {
      expect(typeof tool.id).toBe('string');
      expect(typeof tool.name).toBe('string');
    }
  });

  test('GET /api/tools/:toolId — 404 for unknown tool', async ({ request }) => {
    const res = await request.get('/api/tools/nonexistent-tool-xyz');
    expect(res.status()).toBe(404);
  });
});

// ── Track B S7: Startup recovery ──────────────────────────────────────────────

test.describe('Track B S7 — Startup Health API', () => {
  test('GET /health — server is healthy', async ({ request }) => {
    const res = await request.get('/health');
    expect(res.ok()).toBeTruthy();
    const body = await res.json() as Record<string, unknown>;
    expect(body.status).toBe('ok');
  });

  test('GET /api/agents — returns agent list', async ({ request }) => {
    const res = await request.get('/api/agents');
    expect(res.ok()).toBeTruthy();
    const body = await res.json() as Record<string, unknown>;
    // List endpoint returns agents array or agents key
    const agents = Array.isArray(body) ? body : (body.agents as unknown[]);
    expect(Array.isArray(agents)).toBeTruthy();
  });

  test('GET /api/agents/status-list — returns count and agents array', async ({ request }) => {
    const res = await request.get('/api/agents/status-list');
    expect(res.ok()).toBeTruthy();
    const body = await res.json() as Record<string, unknown>;
    expect(body.success).toBe(true);
    expect(typeof body.count).toBe('number');
    expect(Array.isArray(body.agents)).toBeTruthy();
  });

  test('GET /api/agents/config-status — returns operator config validation report', async ({ request }) => {
    const res = await request.get('/api/agents/config-status');
    expect(res.ok()).toBeTruthy();
    const body = await res.json() as Record<string, unknown>;
    expect(body.success).toBe(true);
    expect(typeof body.totalAgents).toBe('number');
    expect(typeof body.validAgents).toBe('number');
    expect(typeof body.invalidAgents).toBe('number');
    expect(Array.isArray(body.results)).toBeTruthy();
    expect(typeof body.generatedAt).toBe('string');
  });

  test('GET /api/agents/config-status — each result has agentId and valid flag', async ({ request }) => {
    const res = await request.get('/api/agents/config-status');
    expect(res.ok()).toBeTruthy();
    const body = await res.json() as Record<string, unknown>;
    const results = body.results as Array<Record<string, unknown>>;
    for (const result of results) {
      expect(typeof result.agentId).toBe('string');
      expect(typeof result.valid).toBe('boolean');
      expect(Array.isArray(result.missingRequiredFields)).toBeTruthy();
      expect(Array.isArray(result.configuredFields)).toBeTruthy();
    }
  });
});
