/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Regression guard for the Jarvis build hand-off. Before it, "build me X" was decided by an agentic bot turn raced against a 75 s timeout: the agent ignored the hand-off rule and ground the build inline (8.6 min, 1.87M tokens, measured 2026-06-20) while the route that lost the race filed the same ask with the swarm - two builds of one request, acknowledged after 75 seconds. These cases drive the REAL route: a build directive must reach 'done' without the model being called at all (there is no losing turn to abandon), must open exactly one ticket however many times the same ask arrives, and must leave every non-build message on the model path it had. The declined corpus is the one from jarvis-decision-timeout-filing.spec.ts - the real rows that were wrongly filed on the operator's box - so a generous detector cannot pass here.
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
// PARTIAL mock: a factory that LISTS the barrel's exports goes red the moment the barrel grows one
// the spec never asked about.
vi.mock('@/shared/services/database', async (importOriginal) => ({
  ...await importOriginal<object>(),
  runRuntimeSchemaBootstrap: vi.fn().mockResolvedValue(undefined),
  buildOwnerRlsPolicyStatements: vi.fn().mockReturnValue([]),
}));

import { createJarvisRoutes, purgeJarvisAskJobsForOwner } from '@/app/routes/jarvis-routes';
import { BUILD_HANDOFF_ACK, detectBuildRequest, resetBuildHandoffClaims } from '@/app/routes/jarvis-build-handoff';
import { createMemoryOnlyTaskStore } from '../helpers/jarvis-session-task-store';

const OWNER = 'auth0|jarvis-build-handoff-owner';

/** Test-only user-auth rail mirroring the req.oidc shape OIDC and PAT middleware produce. */
const testUserAuth: RequestHandler = (req, res, next) => {
  const sub = req.header('x-test-authenticated-sub');
  if (!sub) { res.status(401).json({ error: 'not_authenticated' }); return; }
  (req as unknown as { oidc: unknown }).oidc = { isAuthenticated: () => true, user: { sub } };
  next();
};

/** One finished /ask turn as the surface sees it, plus what the route did to get there. */
interface AskOutcome {
  status: number;
  result: Record<string, unknown>;
  /** Wall-clock milliseconds from POST /ask to the polled 'done'. */
  elapsedMs: number;
}

/** The doubles the route needs: the model, the ticket service, and the persistence pool. */
function buildContext(): {
  ctx: Record<string, unknown>;
  createTicket: ReturnType<typeof vi.fn>;
} {
  const createTicket = vi.fn(async () => ({ ticketId: `ticket-${createTicket.mock.calls.length}` }));
  const ctx = {
    pool: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) },
    orchestrator: { processMessage: vi.fn() },
    taskStore: createMemoryOnlyTaskStore(),
    messageStore: { save: vi.fn(), getByTask: vi.fn().mockResolvedValue([]) },
    ticketService: {
      listTickets: vi.fn().mockResolvedValue([]),
      openChatTicket: vi.fn().mockResolvedValue({ ticketId: 'build-handoff-chat' }),
      createTicket,
      updateStatus: vi.fn(),
    },
  };
  return { ctx, createTicket };
}

/**
 * @description Mount the real Jarvis router and drive one or more asks through it, polling
 * /ask/result to completion the way the cockpit does. Only the model, the ticket service and the
 * persistence pool are doubles; the route and every deterministic guard in it are the shipped code.
 * @param messages - The messages to send, in order, on one conversation.
 * @returns One outcome per message, and the ticket-service spy.
 */
async function askAll(messages: string[]): Promise<{
  outcomes: AskOutcome[];
  createTicket: ReturnType<typeof vi.fn>;
}> {
  const { ctx, createTicket } = buildContext();
  const app = express();
  app.use(express.json());
  app.use('/api/jarvis', testUserAuth, createJarvisRoutes(ctx as never, process.cwd()));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const outcomes: AskOutcome[] = [];
  try {
    const port = (server.address() as AddressInfo).port;
    for (const message of messages) {
      const startedAt = Date.now();
      const posted = await fetch(`http://127.0.0.1:${port}/api/jarvis/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-test-authenticated-sub': OWNER },
        body: JSON.stringify({ message, sessionId: 'build-handoff-thread' }),
      });
      const body = await posted.json() as { jobId?: string };
      const result = body.jobId ? await pollResult(port, body.jobId) : {};
      outcomes.push({ status: posted.status, result, elapsedMs: Date.now() - startedAt });
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  return { outcomes, createTicket };
}

/** Poll /ask/result until the turn leaves 'pending', exactly as the cockpit does. */
async function pollResult(port: number, jobId: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await fetch(
      `http://127.0.0.1:${port}/api/jarvis/ask/result?jobId=${encodeURIComponent(jobId)}`,
      { headers: { 'x-test-authenticated-sub': OWNER } },
    );
    const body = await response.json() as Record<string, unknown>;
    if (body.status !== 'pending') return body;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('the ask never left pending');
}

/** Real build requests, including the two verbatim rows the operator's queue recorded. */
const BUILD_DIRECTIVES = [
  'Build me a bot that watches my inbox',
  'build a dashboard for my spending',
  'Build the AttritionAnalyzer with Shared Types and Unit Tests',
  'Build the ReportGenerator, CLI Entry Point, and Integration tests',
  'can you build me an app for tracking invoices',
  'please implement the fallback chain in the cockpit',
  'create an app that files my receipts',
  'write a script that renames my screenshots',
  "I'd like you to build a page showing the fleet",
];

/**
 * Messages that must keep the model turn. The first block is the corpus of rows that really were
 * auto-filed on the operator's box; the rest are work requests whose verb is not a build verb, and
 * questions ABOUT building.
 */
const MUST_NOT_FILE = [
  'Hi',
  'hello',
  'thanks',
  'what is 9 times 9',
  'what screen am i on',
  'How much money did we make in the stock market today?',
  'why is engineering fireing like all the time',
  'how do I build a bot?',
  'what did the build bot do yesterday?',
  'did the build succeed?',
  'show me my builds',
  'build it',
  'make me a sandwich',
  'write me a poem about the ocean',
  'please fix the escalation mirror',
  'Can you add google drive to our files application. We just added the connector',
  'the trading dashboard has been blank since this morning',
];

describe('detectBuildRequest recognises an imperative build and nothing else', () => {
  for (const message of BUILD_DIRECTIVES) {
    it(`recognises: ${JSON.stringify(message.slice(0, 52))}`, () => {
      expect(detectBuildRequest(message), 'a build directive must not need a model turn').not.toBeNull();
    });
  }

  for (const message of MUST_NOT_FILE) {
    it(`declines: ${JSON.stringify(message.slice(0, 52))}`, () => {
      expect(
        detectBuildRequest(message),
        'anything but an imperative build keeps the path it had — a generous detector is how "Hi" became a build ticket',
      ).toBeNull();
    });
  }

  it('an empty or whitespace message is never a build', () => {
    for (const value of ['', '   ', '\n', '?']) expect(detectBuildRequest(value)).toBeNull();
  });

  it('the kill switch returns the turn to the model path', () => {
    const saved = process.env.JARVIS_FAST_BUILD_HANDOFF;
    process.env.JARVIS_FAST_BUILD_HANDOFF = 'false';
    try {
      expect(detectBuildRequest('Build me a bot that watches my inbox')).toBeNull();
    } finally {
      if (saved === undefined) delete process.env.JARVIS_FAST_BUILD_HANDOFF;
      else process.env.JARVIS_FAST_BUILD_HANDOFF = saved;
    }
  });
});

describe('POST /api/jarvis/ask hands a build to the swarm without a model turn', () => {
  beforeEach(() => {
    resetBuildHandoffClaims();
    executeBot.mockReset();
    executeBot.mockResolvedValue({ response: 'A model answer nobody should have asked for.' });
  });

  afterEach(() => {
    purgeJarvisAskJobsForOwner(OWNER);
    resetBuildHandoffClaims();
  });

  it('acknowledges a build immediately, files it once, and never starts a turn to abandon', async () => {
    const { outcomes, createTicket } = await askAll(['Build me a bot that watches my inbox']);

    const [outcome] = outcomes;
    expect(outcome.status).toBe(202);
    expect(outcome.result.status).toBe('done');
    expect(outcome.result.answer).toBe(BUILD_HANDOFF_ACK);
    // The whole point: no provider round trip exists, so nothing is left grinding server-side.
    expect(executeBot, 'a model turn started here is the abandoned duplicate the fix removes').not.toHaveBeenCalled();
    // One ask, one execution — the swarm's.
    expect(createTicket).toHaveBeenCalledTimes(1);
    expect(createTicket.mock.calls[0]?.[0]).toMatchObject({
      title: 'Build me a bot that watches my inbox',
      status: 'approved',
      ownerSub: OWNER,
      metadata: expect.objectContaining({ source: 'jarvis', complexity: 'complex', autoFiled: true }),
    });
    // The surface is told what was started, so the work is visible rather than implied.
    expect(outcome.result.dispatched).toEqual([
      { workJobId: expect.any(String), title: 'Build me a bot that watches my inbox' },
    ]);
    // The done-when budget is 20 seconds. With no provider hop this is a database round trip.
    expect(outcome.elapsedMs, `acknowledged in ${outcome.elapsedMs}ms`).toBeLessThan(20_000);
  });

  it('the same ask sent twice still files exactly one build', async () => {
    const ask = 'build a dashboard for my spending';

    const { outcomes, createTicket } = await askAll([ask, ask]);

    expect(outcomes.map((o) => o.result.status)).toEqual(['done', 'done']);
    expect(outcomes.map((o) => o.result.answer)).toEqual([BUILD_HANDOFF_ACK, BUILD_HANDOFF_ACK]);
    expect(
      createTicket,
      'a resend must reuse the claim; two tickets here is the double build the entry is about',
    ).toHaveBeenCalledTimes(1);
    // Both turns name the SAME work item, so the surface cannot show two builds either.
    const dispatched = outcomes.map((o) => (o.result.dispatched as Array<{ workJobId: string }>)[0]?.workJobId);
    expect(dispatched[0]).toBe(dispatched[1]);
    expect(executeBot).not.toHaveBeenCalled();
  });

  it('a question still reaches the model and files nothing', async () => {
    const { outcomes, createTicket } = await askAll(['what screen am i on']);

    expect(outcomes[0]?.result.status).toBe('done');
    expect(executeBot, 'only a build directive may skip the model').toHaveBeenCalled();
    expect(createTicket, 'a question must never open a build ticket').not.toHaveBeenCalled();
    expect(outcomes[0]?.result.answer).not.toBe(BUILD_HANDOFF_ACK);
  });
});
