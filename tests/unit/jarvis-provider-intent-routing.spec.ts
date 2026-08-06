/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Exercise Jarvis provider-intent routing through an authenticated user principal so polling follows the SEC-01 rule that legacy fleet credentials cannot read owner-scoped results.
 */

import type { AddressInfo } from 'node:net';
import express, { type RequestHandler } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const executeBot = vi.hoisted(() => vi.fn());

vi.mock('@/app/routes/inline-bot-execution', () => ({ executeBotOrInline: executeBot }));
vi.mock('@/app/routes/connector-token-broker', () => ({ resolveBotCreds: vi.fn().mockResolvedValue({}) }));
vi.mock('@/app/routes/free-tier-rotation', () => ({
  resolveUserLlmConnection: vi.fn().mockResolvedValue(null),
  reportResolvedLlmFailure: vi.fn().mockResolvedValue(false),
}));
vi.mock('@/features/user-model', () => ({
  withHavenContext: vi.fn(async (_pool: unknown, _sub: string, prompt: string) => prompt),
  learnFromExchange: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/shared/services/database', () => ({
  runRuntimeSchemaBootstrap: vi.fn().mockResolvedValue(undefined),
  buildOwnerRlsPolicyStatements: vi.fn().mockReturnValue([]),
}));

import {
  createJarvisRoutes,
  detectProviderBoundHandoff,
  purgeJarvisAskJobsForOwner,
  resolveWeatherLocationFollowUp,
} from '../../src/app/routes/jarvis-routes';
import { serviceSecretOr } from '../../src/shared/middleware/authz';

const SERVICE_SECRET = 'jarvis-provider-intent-secret';
const OWNER = 'auth0|jarvis-provider-intent-owner';
const OTHER_OWNER = 'auth0|jarvis-provider-intent-other-owner';

function authHeaders(owner = OWNER): Record<string, string> {
  return { 'X-Test-Authenticated-Sub': owner };
}

/** Test-only user-auth rail mirroring the req.oidc shape produced by OIDC and PAT middleware. */
const testUserAuth: RequestHandler = (req, res, next) => {
  const sub = req.header('x-test-authenticated-sub');
  if (!sub) { res.status(401).json({ error: 'not_authenticated' }); return; }
  (req as unknown as { oidc: unknown }).oidc = {
    isAuthenticated: () => true,
    user: { sub },
  };
  next();
};

async function waitForResult(base: string, jobId: string, owner = OWNER): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${base}/ask/result?jobId=${encodeURIComponent(jobId)}`, { headers: authHeaders(owner) });
    const result = await response.json() as Record<string, unknown>;
    if (result.status !== 'pending') return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for Jarvis provider-intent result');
}

describe('deterministic Jarvis provider-bound intent guard', () => {
  it.each([
    ['What is the weather today in Destin, Florida?', 'weather'],
    ['Show me the current conditions near Chicago.', 'weather'],
    ['Will it rain tomorrow?', 'weather'],
    ['Summarize my inbox.', 'priority-email'],
    ['Show me my important emails.', 'priority-email'],
    ["What's important in my inbox?", 'priority-email'],
    ['Which of my emails are important?', 'priority-email'],
    ['Catch me up on the priority mail in my inbox today.', 'priority-email'],
    ['Find fish food at Walmart.', 'walmart-catalog'],
    ['Search Walmart for fish food.', 'walmart-catalog'],
    ['Show me 3 fish food options from Walmart.', 'walmart-catalog'],
  ] as const)('routes %s to the %s provider worker', (message, kind) => {
    const intent = detectProviderBoundHandoff(message);

    expect(intent).toMatchObject({ kind, handoff: { action: 'create', complexity: 'simple', platform: false } });
    expect(intent?.handoff.description).toContain(message);
    expect(intent?.handoff.description).toContain('Do not answer from model memory');
  });

  it('extracts only the bounded provider operation into a server-authored intent', () => {
    expect(detectProviderBoundHandoff('What is the weather today in Destin, Florida?')).toMatchObject({
      handoff: { providerIntent: {
        schemaVersion: 1, kind: 'weather', operation: 'current-forecast', location: 'Destin, Florida',
      } },
    });
    expect(detectProviderBoundHandoff('Show me my important emails.')).toMatchObject({
      handoff: { providerIntent: {
        schemaVersion: 1, kind: 'priority-email', operation: 'priority-summary',
      } },
    });
    expect(detectProviderBoundHandoff(
      'Use the Shopping concierge to perform a read-only live Walmart search for fish food. '
      + 'Return exactly 2 real items with current prices, Walmart product links, and product images. '
      + 'Do not add anything to a cart, do not checkout, do not order, and do not take any write action.',
    )).toMatchObject({
      handoff: { providerIntent: {
        schemaVersion: 1, kind: 'walmart-catalog', operation: 'product-search', query: 'fish food', limit: 2,
      } },
    });
    expect(detectProviderBoundHandoff('Show me 9 fish food options from Walmart.')).toMatchObject({
      handoff: { providerIntent: { query: 'fish food', limit: 6 } },
    });
  });

  it('turns a conversational city follow-up into the bounded weather operation', () => {
    expect(resolveWeatherLocationFollowUp(
      'the weather today where I live.',
      'Destin, Florida. And if you could remember that, please.',
    )).toMatchObject({
      kind: 'weather',
      handoff: { providerIntent: {
        schemaVersion: 1, kind: 'weather', operation: 'current-forecast', location: 'Destin, Florida',
      } },
    });
    expect(resolveWeatherLocationFollowUp('the weather today where I live.', 'Alright.')).toBeUndefined();
    expect(resolveWeatherLocationFollowUp('the weather today where I live.', 'Show me my important emails.')).toBeUndefined();
    expect(resolveWeatherLocationFollowUp('the weather today where I live.', 'Create a reminder for tomorrow.')).toBeUndefined();
    expect(resolveWeatherLocationFollowUp('the weather today where I live.', 'What is on my calendar?')).toBeUndefined();
  });

  it.each([
    'Call Mom',
    'Open Settings',
    'Book Dinner',
    'Play Music',
    'Turn Off Lights',
    'Add Milk',
    'please call mom',
    'please open settings',
    'please check my tasks',
    'Check My Tasks',
    'Cook Dinner',
    'Drive Home',
    'Mute Music',
    'Pause Music',
    'Resume Music',
    'Lock Door',
    'Unlock Door',
    'Dim Lights',
    'Raise Volume',
    'Lower Volume',
    'Navigate Home',
    'Search Web',
    'Run Backup',
    'Execute Script',
    'Fix Bug',
    'Take Screenshot',
    'Upload File',
    'Download Report',
    'Pay Bill',
    'Go Home',
    'Help Me',
    'Remember Milk',
  ])('does not reinterpret a command-shaped follow-up as a weather location: %s', (reply) => {
    expect(resolveWeatherLocationFollowUp('the weather today where I live.', reply)).toBeUndefined();
  });

  it.each([
    ['Show Low, Arizona', 'Show Low, Arizona'],
    ['Tell City, Indiana', 'Tell City, Indiana'],
    ['new york', 'new york'],
    ['Destin, Florida', 'Destin, Florida'],
  ])('accepts a bounded place follow-up regardless of transcript casing: %s', (reply, location) => {
    expect(resolveWeatherLocationFollowUp('the weather today where I live.', reply)).toMatchObject({
      kind: 'weather',
      handoff: { providerIntent: {
        schemaVersion: 1, kind: 'weather', operation: 'current-forecast', location,
      } },
    });
  });

  it.each([
    'Hello Jarvis',
    'What causes weather systems to form?',
    'How is the weather API designed?',
    'Summarize this attached email.',
    'Draft an important email to Alice.',
    'Build a weather app for our cockpit.',
    'Implement an inbox-summary widget in Jarvis.',
    'Show me TypeScript code for a weather API.',
    'Order fish food from Walmart.',
    'Find fish food at Walmart and add it to my cart.',
    "Compare fish food at Walmart and Target.",
    'Build a Walmart shopping integration.',
    "Order Ben & Jerry's ice cream + fish food.",
  ])('leaves non-provider or implementation request model-owned: %s', (message) => {
    expect(detectProviderBoundHandoff(message)).toBeUndefined();
  });
});

describe('Jarvis /ask provider-bound routing', () => {
  const originalSecret = process.env.SWARM_SERVICE_SECRET;

  beforeEach(() => {
    process.env.SWARM_SERVICE_SECRET = SERVICE_SECRET;
    executeBot.mockReset();
  });

  afterEach(() => {
    purgeJarvisAskJobsForOwner(OWNER);
    purgeJarvisAskJobsForOwner(OTHER_OWNER);
    if (originalSecret === undefined) delete process.env.SWARM_SERVICE_SECRET;
    else process.env.SWARM_SERVICE_SECRET = originalSecret;
  });

  it('dispatches weather and priority inbox reads without a model turn or direct visual, while direct asks still call Jarvis', async () => {
    const messages: Array<Record<string, unknown>> = [];
    const jarvisTaskInserts: unknown[][] = [];
    const visualArtifactInserts: unknown[][] = [];
    const pool = {
      query: vi.fn(async (sqlValue: string, values: unknown[] = []) => {
        const sql = String(sqlValue).replace(/\s+/g, ' ').trim();
        if (sql.startsWith('INSERT INTO jarvis_tasks')) jarvisTaskInserts.push(values);
        if (sql.startsWith('INSERT INTO visual_response_artifacts')) visualArtifactInserts.push(values);
        return { rows: [], rowCount: sql.startsWith('INSERT') ? 1 : 0 };
      }),
    };
    const createTicket = vi.fn(async (input: Record<string, unknown>) => ({
      ...input,
      ticketId: `work-ticket-${createTicket.mock.calls.length}`,
      status: 'approved',
      createdAt: '2026-07-10T18:00:00.000Z',
      updatedAt: '2026-07-10T18:00:00.000Z',
    }));
    const ctx = {
      pool,
      orchestrator: { processMessage: vi.fn() },
      taskStore: {
        get: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue(undefined),
        updateStatus: vi.fn().mockResolvedValue(undefined), incrementMessageCount: vi.fn().mockResolvedValue(undefined),
        incrementTurnCount: vi.fn().mockResolvedValue(undefined),
      },
      messageStore: {
        save: vi.fn(async (message: Record<string, unknown>) => { messages.push(message); }),
        getByTask: vi.fn().mockResolvedValue([]),
      },
      ticketService: {
        listTickets: vi.fn().mockResolvedValue([]),
        openChatTicket: vi.fn(async () => ({ ticketId: `chat-ticket-${Math.random()}` })),
        createTicket,
        updateStatus: vi.fn().mockResolvedValue(undefined),
      },
    };

    executeBot.mockImplementation(async (_ctx: unknown, _client: unknown, _agentId: string, input: { text: string }) => ({
      response: input.text.includes('Build a weather app')
        ? 'I can help design that weather app.'
        : 'Hello. What can I help with?',
    }));

    const app = express();
    app.use(express.json());
    app.use('/api/jarvis', serviceSecretOr(testUserAuth), createJarvisRoutes(ctx as never, process.cwd()));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/jarvis`;

    const ask = async (message: string, sessionId: string, owner = OWNER) => {
      const response = await fetch(`${base}/ask`, {
        method: 'POST',
        headers: { ...authHeaders(owner), 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, sessionId }),
      });
      expect(response.status).toBe(202);
      const { jobId } = await response.json() as { jobId: string };
      return waitForResult(base, jobId, owner);
    };

    try {
      const clarification = await ask('the weather today where I live.', 'provider-follow-up-session');
      const resolvedWeather = await ask(
        'Destin, Florida. And if you could remember that, please.',
        'provider-follow-up-session',
      );
      const weather = await ask('What is the weather today in Destin, Florida?', 'provider-weather-session');
      const email = await ask('Show me my important emails.', 'provider-email-session');
      const walmart = await ask('Show me exactly 2 fish food options from Walmart.', 'provider-walmart-session');
      await ask('the weather today where I live.', 'provider-unrelated-session');
      const unrelatedEmail = await ask('Show me my important emails.', 'provider-unrelated-session');
      const clearedLocation = await ask('Destin, Florida', 'provider-unrelated-session');
      await ask('the weather today where I live.', 'provider-cross-owner-session');
      const otherOwnerLocation = await ask('Destin, Florida', 'provider-cross-owner-session', OTHER_OWNER);
      const ownerResolvedLocation = await ask('Destin, Florida', 'provider-cross-owner-session');
      const greeting = await ask('Hello Jarvis', 'provider-greeting-session');
      const build = await ask('Build a weather app for our cockpit.', 'provider-build-session');

      expect(clarification).toMatchObject({
        status: 'done', answer: 'What city or ZIP code should I use for the live weather check?',
        dispatched: [],
      });
      expect(resolvedWeather).toMatchObject({
        status: 'done', answer: "I'll check the live weather data and report back here.",
        dispatched: [expect.objectContaining({ title: expect.stringContaining('Live weather:') })],
      });
      expect(weather).toMatchObject({
        status: 'done', answer: "I'll check the live weather data and report back here.",
        dispatched: [expect.objectContaining({ title: expect.stringContaining('Live weather:') })],
      });
      expect(email).toMatchObject({
        status: 'done', answer: "I'll check your priority inbox and report back here.",
        dispatched: [expect.objectContaining({ title: expect.stringContaining('Priority inbox:') })],
      });
      expect(walmart).toMatchObject({
        status: 'done', answer: "I'll check the live Walmart catalog and report back here.",
        dispatched: [expect.objectContaining({ title: 'Live Walmart: fish food' })],
      });
      expect(unrelatedEmail).toMatchObject({
        status: 'done', answer: "I'll check your priority inbox and report back here.",
        dispatched: [expect.objectContaining({ title: expect.stringContaining('Priority inbox:') })],
      });
      expect(clearedLocation).toMatchObject({ status: 'done', answer: 'Hello. What can I help with?' });
      expect(otherOwnerLocation).toMatchObject({ status: 'done', answer: 'Hello. What can I help with?' });
      expect(ownerResolvedLocation).toMatchObject({
        status: 'done', answer: "I'll check the live weather data and report back here.",
        dispatched: [expect.objectContaining({ title: expect.stringContaining('Live weather:') })],
      });
      expect(weather).not.toHaveProperty('visual');
      expect(email).not.toHaveProperty('visual');
      expect(walmart).not.toHaveProperty('visual');
      expect(greeting).toMatchObject({ status: 'done', answer: 'Hello. What can I help with?' });
      expect(build).toMatchObject({ status: 'done', answer: 'I can help design that weather app.' });

      expect(executeBot).toHaveBeenCalledTimes(4);
      const modelInputs = executeBot.mock.calls.map((call) => String(call[3]?.text || ''));
      expect(modelInputs.some((text) => text.includes('Hello Jarvis'))).toBe(true);
      expect(modelInputs.some((text) => text.includes('Build a weather app'))).toBe(true);
      expect(modelInputs.some((text) => text.includes('weather today in Destin'))).toBe(false);
      expect(modelInputs.some((text) => text.includes('important emails'))).toBe(false);
      expect(modelInputs.some((text) => text.includes('fish food options from Walmart'))).toBe(false);

      expect(createTicket).toHaveBeenCalledTimes(6);
      expect(createTicket).toHaveBeenNthCalledWith(1, expect.objectContaining({
        ticketType: 'task', ownerSub: OWNER,
        title: expect.stringContaining('Live weather:'),
        description: expect.stringContaining('Destin, Florida'),
        metadata: expect.objectContaining({ source: 'jarvis', complexity: 'simple' }),
      }));
      expect(createTicket).toHaveBeenNthCalledWith(2, expect.objectContaining({
        ticketType: 'task', ownerSub: OWNER,
        title: expect.stringContaining('Live weather:'),
        description: expect.stringContaining('authorized live weather provider'),
        metadata: expect.objectContaining({ source: 'jarvis', complexity: 'simple' }),
      }));
      expect(createTicket).toHaveBeenNthCalledWith(3, expect.objectContaining({
        ticketType: 'task', ownerSub: OWNER,
        title: expect.stringContaining('Priority inbox:'),
        description: expect.stringContaining('authorized mailbox provider'),
        metadata: expect.objectContaining({ source: 'jarvis', complexity: 'simple' }),
      }));
      expect(createTicket).toHaveBeenNthCalledWith(4, expect.objectContaining({
        ticketType: 'task', ownerSub: OWNER,
        title: 'Live Walmart: fish food',
        description: expect.stringContaining('strictly read-only'),
        metadata: expect.objectContaining({ providerIntent: expect.objectContaining({ kind: 'walmart-catalog' }) }),
      }));
      expect(createTicket).toHaveBeenNthCalledWith(5, expect.objectContaining({
        ticketType: 'task', ownerSub: OWNER,
        title: expect.stringContaining('Priority inbox:'),
        metadata: expect.objectContaining({ providerIntent: expect.objectContaining({ kind: 'priority-email' }) }),
      }));
      expect(createTicket).toHaveBeenNthCalledWith(6, expect.objectContaining({
        ticketType: 'task', ownerSub: OWNER,
        title: expect.stringContaining('Live weather:'),
        metadata: expect.objectContaining({ providerIntent: expect.objectContaining({ location: 'Destin, Florida' }) }),
      }));
      expect(createTicket.mock.calls[0]?.[0]).toMatchObject({ metadata: { providerIntent: {
        schemaVersion: 1, kind: 'weather', operation: 'current-forecast', location: 'Destin, Florida',
      } } });
      expect(createTicket.mock.calls[1]?.[0]).toMatchObject({ metadata: { providerIntent: {
        schemaVersion: 1, kind: 'weather', operation: 'current-forecast', location: 'Destin, Florida',
      } } });
      expect(createTicket.mock.calls[2]?.[0]).toMatchObject({ metadata: { providerIntent: {
        schemaVersion: 1, kind: 'priority-email', operation: 'priority-summary',
      } } });
      expect(createTicket.mock.calls[3]?.[0]).toMatchObject({ metadata: { providerIntent: {
        schemaVersion: 1, kind: 'walmart-catalog', operation: 'product-search', query: 'fish food', limit: 2,
      } } });
      await vi.waitFor(() => expect(jarvisTaskInserts).toHaveLength(6));
      expect(visualArtifactInserts).toHaveLength(0);

      const providerAcknowledgements = messages.filter((message) => (
        message.role === 'assistant'
        && (String(message.text).includes('live weather data')
          || String(message.text).includes('priority inbox')
          || String(message.text).includes('live Walmart catalog'))
      ));
      expect(providerAcknowledgements).toHaveLength(6);
      expect(providerAcknowledgements.every((message) => (
        JSON.stringify(message.metadata || {}) === '{}'
      ))).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
