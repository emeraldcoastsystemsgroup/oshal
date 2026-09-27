/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | JVV-003: one queue-backed delayed-lifecycle proof with NO injected terminal worker state. Real: a Jarvis /ask hand-off files an approved ticket in TicketService; one QueueManagerService poll cycle routes it (chooseDispatchPath -> manifest-worker) through the orchestration code of buildTaskCallOutResolver; BotNodeClient executes it over loopback HTTP; dispatchManifestWorkerTicket writes the completion and marks the ticket complete; only then does Jarvis's /tasks poll read that deliverable, summarize it once, persist one immutable visual and return it to the original Discussion. Doubles: the resolver's routing decision (agentRouter.route fixed to the one worker, strategy 'bid'), its mesh bid transport, agentProfileRepository, resolveOnlineAgentIds and isAgentAccessibleTo; the worker (a canned node:http POST /api/swarm-execute handler, not bot-node-server); the message store (an in-memory vi.fn array, so the completion is dispatcher-written but not durable); InMemoryTicketStore/InMemoryTaskStore and the in-memory DelayedLifecyclePool SQL rows with the database pool/bootstrap/RLS helpers mocked; the swarm runtime, chat orchestrator and resolveAgentIdByName stubs; vi.mocked executeBotOrInline (Jarvis's hosted brain), connector-token-broker, free-tier-rotation and user-model; and a header auth middleware plus a stub applicationAuthorization in place of OIDC.
 */

import type { AddressInfo } from 'node:net';
import * as http from 'node:http';
import express, { type RequestHandler } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const executeBot = vi.hoisted(() => vi.fn());

vi.mock('@/app/routes/inline-bot-execution', () => ({ executeBotOrInline: executeBot }));
vi.mock('@/app/routes/connector-token-broker', () => ({ resolveBotCreds: vi.fn().mockResolvedValue({}) }));
vi.mock('@/app/routes/free-tier-rotation', () => ({ resolveUserLlmConnection: vi.fn().mockResolvedValue(null) }));
vi.mock('@/features/user-model', () => ({
  withHavenContext: vi.fn(async (_pool: unknown, _sub: string, prompt: string) => prompt),
  learnFromExchange: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/shared/services/database', async (importOriginal) => ({
  ...await importOriginal<object>(),
  createOptionalPostgresPool: () => null,
  runRuntimeSchemaBootstrap: vi.fn().mockResolvedValue(undefined),
  buildOwnerRlsPolicyStatements: vi.fn().mockReturnValue([]),
}));

import { createJarvisRoutes } from '../../src/app/routes/jarvis-routes';
import { serviceSecretOr } from '../../src/shared/middleware/authz';
import { runWithRequestIdentity } from '../../src/shared/services/database/request-identity';
import { BotNodeClient } from '../../src/features/agent-management/services/bot-node-client';
import { InMemoryTicketStore } from '../../src/features/ticketing/services/in-memory-ticket-store';
import { TicketService } from '../../src/features/ticketing/services/ticket-service';
import { QueueManagerService } from '../../src/features/swarm-orchestration/services/queue-manager-service';
import { buildTaskCallOutResolver } from '../../src/features/swarm-orchestration/services/task-call-out';
import { InMemoryTaskStore } from '../../src/entities/task';
import { DelayedLifecyclePool, waitFor, type StoredMessage } from '../helpers/jarvis-delayed-lifecycle-harness';

const SERVICE_SECRET = 'jarvis-queue-lifecycle-secret';
const OWNER = 'auth0|queue-owner';
const ISSUER = 'https://issuer.oshal.example.com/';
const SESSION = 'jarvis-queue-acceptance';
const WORKER = 'c0de0000-0000-4000-8000-0000000003a1';
const WORKER_NAME = 'research-analyst';
const DELIVERABLE = 'Onboarding checklist review: 12 of 14 steps are complete; badge and laptop requests are still open.';

/** The signed-in owner on every request: OIDC-shaped user with issuer, plus the request identity. */
const ownerAuth: RequestHandler = (req, res, next) => {
  if (req.header('x-test-authenticated-sub') !== OWNER) { res.status(401).json({ error: 'not_authenticated' }); return; }
  (req as unknown as { oidc: unknown }).oidc = { isAuthenticated: () => true, user: { sub: OWNER, iss: ISSUER } };
  runWithRequestIdentity({ sub: OWNER, principalIssuer: ISSUER, isOperator: false } as never, next);
};

/** A canned loopback worker answering a bot-node's POST /api/swarm-execute (not bot-node-server); records every execution. */
async function startWorkerNode(): Promise<{ url: string; calls: Array<Record<string, unknown>>; close: () => Promise<void> }> {
  const calls: Array<Record<string, unknown>> = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => { body += chunk; });
    req.on('end', () => {
      if (req.method !== 'POST' || req.url !== '/api/swarm-execute') { res.writeHead(404).end(); return; }
      calls.push(JSON.parse(body) as Record<string, unknown>);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true, response: DELIVERABLE, cost: 0, model: 'fixture-model', provider: 'fixture', durationMs: 5,
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 0 },
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    calls,
    close: () => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close((err) => (err ? reject(err) : resolve())); }),
  };
}

/** The ADR-083 resolver's real orchestration code; its routing decision, bid transport and candidate inputs are fixed doubles. */
function callOutResolver() {
  return buildTaskCallOutResolver({
    agentRouter: { route: vi.fn().mockResolvedValue({ winner: { agentId: WORKER, score: 1, reason: 'bid' }, ranked: [], strategy: 'bid' }) } as never,
    meshBidBroadcaster: {
      broadcastBidRequest: vi.fn().mockResolvedValue({ claims: [], lead: null }),
      toBids: vi.fn().mockReturnValue([{ agentId: WORKER, confidence: 0.82, estimatedCost: 0, estimatedLatencyMs: 10 }]),
    } as never,
    agentProfileRepository: { listAgents: vi.fn().mockResolvedValue([{
      agentId: WORKER, name: WORKER_NAME, status: 'active', baseCapabilities: ['research'], routingKeywords: ['checklist'], selectorDescriptor: '',
    }]) } as never,
    resolveOnlineAgentIds: async () => [WORKER],
    isAgentAccessibleTo: (agentId) => agentId === WORKER,
  });
}

/** Jarvis's hosted brain (outside the proven chain): a hand-off first, then the summary of the READ deliverable. */
function jarvisBrain(ticketTitle: string, ticketId: () => string) {
  executeBot.mockImplementation(async (_ctx: unknown, _client: unknown, _agentId: string, input: { text: string }) => {
    if (input.text.includes('<untrusted-work-product>')) {
      expect(input.text).toContain(DELIVERABLE); // the summary is written from the worker's real completion
      return { response: [
        'The onboarding review is finished: 12 of 14 steps are complete.',
        '```oshal:visual',
        JSON.stringify({ kind: 'summary', title: 'Onboarding review', metrics: [{ label: 'Complete', value: '12 of 14' }],
          bullets: ['Badge and laptop requests are still open.'], sourceRefs: [`ticket:${ticketId()}`] }),
        '```',
      ].join('\n') };
    }
    return { response: [
      "I've handed the onboarding review to the team and I'll report back here.",
      '```handoff',
      JSON.stringify({ action: 'create', title: ticketTitle, description: 'Review the onboarding checklist and report what is still open.', complexity: 'simple' }),
      '```',
    ].join('\n') };
  });
}

describe('JVV-003 queue-backed delayed Jarvis lifecycle', () => {
  const originalSecret = process.env.SWARM_SERVICE_SECRET;
  beforeEach(() => { process.env.SWARM_SERVICE_SECRET = SERVICE_SECRET; executeBot.mockReset(); });
  afterEach(() => {
    if (originalSecret === undefined) delete process.env.SWARM_SERVICE_SECRET;
    else process.env.SWARM_SERVICE_SECRET = originalSecret;
  });

  it('hand-off -> queue call-out -> loopback worker -> dispatcher-written completion -> one summary + one artifact in the original Discussion', async () => {
    const pool = new DelayedLifecyclePool();
    const messages: StoredMessage[] = [];
    // The real task store: it keeps the owner issuer the session/ticket ownership checks read back.
    const taskStore = new InMemoryTaskStore();
    const ticketService = new TicketService(new InMemoryTicketStore());
    const messageStore = {
      save: vi.fn(async (message: StoredMessage) => { messages.push(message); return message; }),
      getByTask: vi.fn(async (taskId: string) => messages.filter((message) => message.taskId === taskId)),
    };
    const worker = await startWorkerNode();
    const botNodeClient = new BotNodeClient((agentId) => (agentId === WORKER ? worker.url : null), 10_000, { env: {} });
    const queue = new QueueManagerService(ticketService, {
      async getRuntimeReadiness() { return { ready: true }; },
      async processTickets() { throw new Error('a task ticket must never enter the build swarm'); },
    } as never, {
      resolveAgentIdByName: async () => undefined,
      botNodeClient,
      taskStore,
      messageStore,
      resolveTaskWorker: callOutResolver(),
    } as never);
    const ticketTitle = 'Review the onboarding checklist';
    let filedTicketId = '';
    jarvisBrain(ticketTitle, () => filedTicketId);

    const ctx = {
      pool, orchestrator: { processMessage: vi.fn() }, taskStore, messageStore, ticketService,
      applicationAuthorization: { resolveActor: async () => ({ sub: OWNER, issuer: ISSUER, isActive: true, isSwarmAdmin: false }) },
    };
    const app = express();
    app.use(express.json());
    app.use('/api/jarvis', serviceSecretOr(ownerAuth), createJarvisRoutes(ctx as never, process.cwd()));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/jarvis`;
    const headers = { 'X-Test-Authenticated-Sub': OWNER };

    try {
      const ask = await (await fetch(`${base}/ask`, {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Please review our onboarding checklist and tell me what is open.', sessionId: SESSION }),
      })).json() as { jobId: string };
      const acknowledgement = await waitFor(async () => {
        const body = await (await fetch(`${base}/ask/result?jobId=${ask.jobId}`, { headers })).json() as Record<string, unknown>;
        return body.status === 'done' ? body : undefined;
      });
      expect(acknowledgement).not.toHaveProperty('visual');
      const [handedOff] = acknowledgement.dispatched as Array<{ workJobId: string }>;
      const [ticket] = await ticketService.listTickets({ ownerSub: OWNER });
      expect(ticket).toMatchObject({ title: ticketTitle, ticketType: 'task', status: 'approved' });
      filedTicketId = ticket.ticketId;
      expect(worker.calls).toHaveLength(0);
      expect(pool.artifacts.size).toBe(0);

      // One REAL queue poll: nothing below writes the ticket's terminal state except the dispatcher.
      await (queue as unknown as { pollCycle(): Promise<void> }).pollCycle();
      await waitFor(async () => ((await ticketService.getTicket(ticket.ticketId))?.status === 'complete' ? true : undefined), 5_000);
      expect(worker.calls).toHaveLength(1);
      expect(worker.calls[0]).toMatchObject({ agentId: WORKER, taskId: ticket.ticketId, userSub: OWNER });
      const completion = messages.find((message) => message.taskId === ticket.ticketId);
      expect(completion).toMatchObject({ role: 'assistant', text: DELIVERABLE, metadata: expect.objectContaining({
        source: 'manifest-worker-bot-node', manifestWorkerResult: true }) });

      // Jarvis's own poll reads the dispatcher-written completion, summarizes ONCE and persists ONE artifact.
      await fetch(`${base}/tasks`, { headers });
      const done = await waitFor(() => {
        const row = pool.tasks.get(handedOff.workJobId);
        return row?.status === 'done' && row.visual ? row : undefined;
      }, 5_000);
      expect(done.result).toContain('12 of 14 steps are complete');
      await fetch(`${base}/tasks`, { headers });
      expect(executeBot.mock.calls.filter(([, , , input]) => String((input as { text: string }).text).includes('<untrusted-work-product>'))).toHaveLength(1);
      expect(pool.artifacts.size).toBe(1);
      // Keyed to the handed-off work job (plus its content digest), owned by the asker.
      expect([...pool.artifacts.values()][0]).toMatchObject({ user_sub: OWNER, source_job_id: expect.stringMatching(new RegExp(`^${handedOff.workJobId}(:|$)`)) });

      const history = await (await fetch(`${base}/history?sessionId=${SESSION}`, { headers })).json() as { turns: Array<Record<string, any>> };
      expect(history.turns.map((turn) => turn.text).at(-1)).toBe(done.result);
      expect(history.turns.at(-1)?.visual).toEqual(done.visual);
      expect(history.turns.slice(0, -1).some((turn) => turn.visual)).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await worker.close();
    }
  });
});
