/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Foreign-agent END-TO-END proof for the A2A gateway (BACKLOG Plan F done-when). INBOUND (against the isolated ts-node server, A2A_GATEWAY_ENABLED=true, noop, MOCK_OIDC operator): an operator mints a per-agent credential over the API, the well-known card is fetched and asserted curated (spec version, slug skill ids, no internal agent UUIDs), then AS THE FOREIGN AGENT a real JSON-RPC message/send files a REAL ticket owned by 'a2a:<id>' (verified straight from Postgres) and tasks/get returns a valid spec TaskState. OUTBOUND (against the REAL standalone tools/a2a-sample-agent spawned as a child process — node directly, killed in afterAll): OSHAL's A2AHarnessAdapter does a real message/send -> tasks/get round trip, the deterministic computed artifact comes back, and the recordCost/chat_tasks attribution path is invoked with the sample agent's REAL usage numbers. No HTTP mocks anywhere in the outbound path — the independence of the sample agent is the proof.
 */

import { test, expect, request as pwRequest } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import crypto from 'node:crypto';
import { Pool } from 'pg';
import {
  A2AHarnessAdapter,
  type A2ACostEvent,
} from '@/features/llm-provider/services/a2a-harness-adapter';

const GATEWAY_ENABLED = String(process.env.A2A_GATEWAY_ENABLED ?? '').toLowerCase() === 'true';
const DB_URL = process.env.DATABASE_URL ?? '';

/** Builds a JSON-RPC 2.0 request body. */
function rpc(method: string, params: unknown, id: number = 1): Record<string, unknown> {
  return { jsonrpc: '2.0', id, method, params };
}

// ── INBOUND: external agent → OSHAL gateway → real ticket ───────────────────────
// Requires the isolated server booted with A2A_GATEWAY_ENABLED=true and a reachable
// DATABASE_URL. Without them the proof cannot run honestly — skip loudly, never fake it.
test.describe('A2A inbound gateway — foreign agent files a real ticket', () => {
  test.skip(!GATEWAY_ENABLED || !DB_URL,
    'inbound proof needs A2A_GATEWAY_ENABLED=true and DATABASE_URL on the isolated server');

  test('mint → card → message/send (ticket owned by a2a:<id>) → tasks/get', async ({ baseURL }) => {
    const api = await pwRequest.newContext({ baseURL });
    const pool = new Pool({ connectionString: DB_URL });
    try {
      // (1) Operator mints a per-agent credential over the API. MOCK_OIDC authenticates
      // every request as the operator (OSHAL_OPERATOR_EMAILS=alex@demo.local).
      const mintRes = await api.post('/api/a2a/agents', { data: { name: 'proof-partner-agent' } });
      expect(mintRes.status(), await mintRes.text()).toBe(201);
      const minted = (await mintRes.json()) as { success: boolean; agent: { id: string; token: string; scopes: string[] } };
      expect(minted.success).toBe(true);
      const agentId = minted.agent.id;
      const token = minted.agent.token;
      expect(token.startsWith('oshal_a2a_')).toBe(true);
      expect(minted.agent.scopes).toEqual(['message:send', 'tasks:read', 'tasks:cancel']);

      // (2) Fetch the well-known card (public by spec). Assert curated + no internal leak.
      const cardRes = await api.get('/.well-known/agent-card.json');
      expect(cardRes.status()).toBe(200);
      const card = (await cardRes.json()) as { protocolVersion: string; url: string; skills: Array<{ id: string; name: string }> };
      expect(card.protocolVersion).toBe('0.3.0');
      expect(card.url.endsWith('/api/a2a')).toBe(true);
      expect(Array.isArray(card.skills)).toBe(true);
      const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
      for (const skill of card.skills) {
        expect(skill.id, `skill id must be a name-slug, not a UUID: ${skill.id}`).not.toMatch(uuid);
        expect(skill.id).toMatch(/^[a-z0-9-]+$/);
        expect(skill.name.toLowerCase()).not.toMatch(/trading|developer|packer|judge|queue|operator|vault/);
      }
      expect(JSON.stringify(card)).not.toContain(agentId);

      // (3) AS THE FOREIGN AGENT — real JSON-RPC message/send over per-agent Bearer.
      const marker = `zebra${Date.now()}`;
      const taskText = `Summarize the k8s runbook drift and mention ${marker}.`;
      const sendRes = await api.post('/api/a2a', {
        headers: { Authorization: `Bearer ${token}` },
        data: rpc('message/send', { message: { role: 'user', parts: [{ kind: 'text', text: taskText }], messageId: crypto.randomUUID() } }),
      });
      expect(sendRes.status()).toBe(200);
      const sendBody = (await sendRes.json()) as { result?: { id: string; kind: string; status: { state: string } }; error?: unknown };
      expect(sendBody.error, JSON.stringify(sendBody.error)).toBeUndefined();
      const ticketId = sendBody.result!.id;
      expect(sendBody.result!.kind).toBe('task');
      expect(sendBody.result!.status.state).toBe('submitted');

      // (4) Verify the REAL ticket landed on the rails, owned by the synthetic sub — read
      // straight from Postgres so this is proof of persistence, not just an RPC round-trip.
      const row = await pool.query(
        'SELECT owner_sub, ticket_type, status, description FROM tickets WHERE ticket_id = $1',
        [ticketId],
      );
      expect(row.rowCount).toBe(1);
      expect(row.rows[0].owner_sub).toBe(`a2a:${agentId}`);
      expect(row.rows[0].ticket_type).toBe('task');
      expect(row.rows[0].status).toBe('approved');
      expect(String(row.rows[0].description)).toContain('[A2A INBOUND TASK]');
      expect(String(row.rows[0].description)).toContain(marker);

      // (5) tasks/get returns a VALID spec TaskState for the owned task.
      const getRes = await api.post('/api/a2a', {
        headers: { Authorization: `Bearer ${token}` },
        data: rpc('tasks/get', { id: ticketId }, 2),
      });
      expect(getRes.status()).toBe(200);
      const getBody = (await getRes.json()) as { result?: { id: string; status: { state: string } } };
      expect(getBody.result!.id).toBe(ticketId);
      const validStates = ['submitted', 'working', 'input-required', 'completed', 'canceled', 'failed', 'rejected', 'auth-required', 'unknown'];
      expect(validStates).toContain(getBody.result!.status.state);

      // Foreign-ticket isolation: a bogus id is indistinguishable from missing (no oracle).
      const foreign = await api.post('/api/a2a', {
        headers: { Authorization: `Bearer ${token}` },
        data: rpc('tasks/get', { id: crypto.randomUUID() }, 3),
      });
      expect(((await foreign.json()) as { error: { code: number } }).error.code).toBe(-32001);

      // eslint-disable-next-line no-console
      console.log(JSON.stringify({
        proof: 'inbound',
        agentId,
        ticketId,
        ownerSub: row.rows[0].owner_sub,
        sendState: sendBody.result!.status.state,
        getState: getBody.result!.status.state,
        cardSkillCount: card.skills.length,
      }));
    } finally {
      await pool.end();
      await api.dispose();
    }
  });
});

// ── OUTBOUND: OSHAL harness → REAL standalone foreign agent + attribution ────────
test.describe('A2A outbound harness — real round trip to the standalone sample agent', () => {
  let agent: ChildProcess | undefined;
  const port = 41300 + Math.floor(Math.random() * 500);
  const endpointUrl = `http://127.0.0.1:${port}/a2a`;

  test.beforeAll(async () => {
    const serverPath = path.resolve(process.cwd(), 'tools/a2a-sample-agent/server.js');
    // Spawn node DIRECTLY (never npx) so killing this PID actually stops the server —
    // an npx wrapper would orphan the real node grandchild (TaskStop landmine).
    agent = spawn(process.execPath, [serverPath, '--port', String(port)], { stdio: 'ignore' });
    // Wait until the sample agent's card is reachable.
    const deadline = Date.now() + 10_000;
    for (;;) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/.well-known/agent-card.json`);
        if (res.ok) break;
      } catch { /* not up yet */ }
      if (Date.now() > deadline) throw new Error('sample agent did not become ready');
      await new Promise((r) => setTimeout(r, 100));
    }
  });

  test.afterAll(async () => {
    if (agent && !agent.killed) agent.kill();
  });

  test('execute → computed artifact returns AND recordCost gets the REAL remote usage', async () => {
    const costEvents: A2ACostEvent[] = [];
    const adapter = new A2AHarnessAdapter({
      endpointUrl,
      botKey: 'a2a-sample-agent',
      authToken: 'proof-bearer',
      remoteAgentLabel: 'sample',
      timeoutMs: 8_000,
      pollIntervalMs: 25,
      recordCost: async (event) => { costEvents.push(event); },
    });

    // Health probe hits the real card endpoint.
    expect(await adapter.healthCheck()).toBe(true);

    const marker = `flamingo${Date.now()}`;
    const result = await adapter.run({
      prompt: `Analyze this task and include the token ${marker}. {"beta":2,"alpha":1}`,
      taskId: 'proof-task-1',
      agentId: 'a2a-sample-agent',
    });

    // The deliverable is the sample agent's REAL computed analysis (not a mirror).
    expect(result.model).toBe('a2a/sample');
    expect(result.stopReason).toBe('end_turn');
    const analysis = JSON.parse(result.text) as {
      wordCount: number; uniqueWordCount: number; sha256: string;
      sortedUniqueWords: string[]; jsonTopLevelKeysSorted: string[] | null;
    };
    expect(analysis.wordCount).toBeGreaterThan(0);
    expect(analysis.sha256).toMatch(/^[0-9a-f]{64}$/);
    // Real work: our marker travelled to the agent and was really tokenized + sorted.
    expect(analysis.sortedUniqueWords).toContain(marker.toLowerCase());
    // Real structure work: the embedded JSON's keys came back SORTED, not as sent.
    expect(analysis.jsonTopLevelKeysSorted).toEqual(['alpha', 'beta']);

    // Attribution: recordCost invoked with the sample agent's OWN usage numbers, and those
    // numbers are internally consistent with the computed work (input=wordCount,
    // output=uniqueWordCount, cost=(sum)*0.000002) — real end-to-end, never fabricated.
    expect(costEvents).toHaveLength(1);
    const event = costEvents[0];
    expect(event.providerId).toBe('a2a');
    expect(event.agentId).toBe('a2a-sample-agent');
    expect(event.taskId).toBe('proof-task-1');
    expect(event.costUnknown).toBe(false);
    expect(event.requestCount).toBe(1);
    expect(event.inputTokens).toBe(analysis.wordCount);
    expect(event.outputTokens).toBe(analysis.uniqueWordCount);
    expect(event.totalCost).toBeCloseTo((analysis.wordCount + analysis.uniqueWordCount) * 0.000002, 6);
    expect(result.usage).toEqual({ inputTokens: analysis.wordCount, outputTokens: analysis.uniqueWordCount });

    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      proof: 'outbound',
      artifactText: result.text,
      recordCost: {
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        totalCost: event.totalCost,
        remoteEndpointHost: event.remoteEndpointHost,
      },
    }));
  });
});
