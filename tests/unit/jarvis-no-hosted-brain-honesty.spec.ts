/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for BACKLOG "Jarvis must fail honestly when the operator has no hosted brain" (root-caused 2026-08-09): with resolveUserLlmConnection resolving to nothing and the Jarvis bot's registry harness an unbrokered CLI, POST /api/jarvis/ask through the REAL router, runJarvisBot, executeBotOrInline and stampRemoteBrain settles as "Jarvis has no AI engine connected — add one under Settings → Connections → Bring Your Own LLM." with code NO_HOSTED_BRAIN, refused before any bot-node dispatch (the endpoint registry is warmed so the turn takes the production dedicated-node shape; a tripwire on the node transport records any dispatch); every other failure keeps its own message with no code; and the work-queue/briefing shelf read still answers in the same state. Only the ladder, persistence and the identity rail are doubled.
 */

import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const doubles = vi.hoisted(() => ({ turnFailure: null as Error | null }));

// The hosted-rung ladder is the ONE collaborator doubled on the decision path: "this caller has no
// endpoint anywhere" is the precondition, not the boundary under test. resolveUserBrain, the harness
// predicate, the registry, executeBotOrInline and stampRemoteBrain all run for real.
vi.mock('@/app/routes/free-tier-rotation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/app/routes/free-tier-rotation')>();
  return { ...actual, resolveUserLlmConnection: vi.fn(async () => undefined) };
});
vi.mock('@/app/routes/connector-token-broker', () => ({ resolveBotCreds: vi.fn().mockResolvedValue({}) }));
// Haven context is a prompt decoration outside the boundary; a case sets turnFailure to make the turn
// fail for an ordinary reason BEFORE any brain is consulted.
vi.mock('@/features/user-model', () => ({
  withHavenContext: vi.fn(async (_pool: unknown, _sub: string, prompt: string) => {
    if (doubles.turnFailure) throw doubles.turnFailure;
    return prompt;
  }),
  learnFromExchange: vi.fn().mockResolvedValue(undefined),
}));
// No store may open a pool: every in-memory store stays in memory, and no inherited DATABASE_URL is
// ever dialled. The rest of the barrel stays real (the stores' persistence activation reads it).
vi.mock('@/shared/services/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/shared/services/database')>()),
  createOptionalPostgresPool: () => null,
  ensureConversationStoreSchema: async () => {},
  runRuntimeSchemaBootstrap: vi.fn().mockResolvedValue(undefined),
}));

import { resolveUserLlmConnection } from '../../src/app/routes/free-tier-rotation';
import { agentRequiresHostedBrain } from '../../src/app/routes/inline-bot-execution';
import { JARVIS_AGENT_ID } from '../../src/app/routes/jarvis-orchestrator';
import { purgeJarvisAskJobsForOwner } from '../../src/app/routes/jarvis-routes';
import { getActiveRegistry } from '../../src/app/extensions/swarm/swarm-bot-registry';
import { BotNodeClient, createRegistryEndpointResolver } from '../../src/features/agent-management';
import { warmBotEndpointRegistry } from '../../src/features/agent-management/services/bot-node-client';
import { createNoBrainJarvisRouter, noBrainShelfRow, NO_BRAIN_SUB } from '../fixtures/jarvis-no-brain';

const NO_ENGINE = 'Jarvis has no AI engine connected — add one under Settings → Connections → Bring Your Own LLM.';
const SESSION = 'no-brain-session';
const SHELF_ROW = noBrainShelfRow();

// Tripwire on the node transport. Jarvis dispatches to its dedicated node on a live box; a turn with no
// admissible brain must be refused BEFORE that hop. If it ever is not, this records the dispatch and
// fails it here instead of letting a spec reach whatever answers the registry's host port.
const nodeDispatch = vi.spyOn(BotNodeClient.prototype, 'execute')
  .mockRejectedValue(new Error('tripwire: a Jarvis turn reached the bot-node transport'));

let server: Server;
let base: string;

// The endpoint resolver's synchronous require cannot load the .ts registry under the spec runner and
// reports "no endpoint" until warmed, which would silently route Jarvis down the inline branch. Warm
// it so the turn takes the production shape: a dedicated-node dispatch through stampRemoteBrain.
beforeAll(async () => { await warmBotEndpointRegistry(); });

beforeEach(async () => {
  doubles.turnFailure = null;
  const app = express();
  app.use(express.json());
  app.use('/api/jarvis', createNoBrainJarvisRouter([SHELF_ROW]));
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((done) => server.once('listening', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/jarvis`;
});

afterEach(async () => {
  purgeJarvisAskJobsForOwner(NO_BRAIN_SUB);
  vi.clearAllMocks();
  server.closeAllConnections();
  await new Promise<void>((done, fail) => server.close((error) => (error ? fail(error) : done())));
});

/** POST /ask, then poll the job to its settled result — exactly what the surface does. */
async function ask(message: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${base}/ask`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, sessionId: SESSION }),
  });
  expect(response.status).toBe(202);
  const { jobId } = await response.json() as { jobId: string };
  // Bounded by wall time rather than a poll count, so a slow shared box cannot run out of polls
  // before the job settles; an unsettled job returns 'pending' and fails the case's assertion.
  const deadline = Date.now() + 30_000;
  let result: Record<string, unknown> = {};
  while (result.status !== 'error' && result.status !== 'done' && Date.now() < deadline) {
    if (result.status) await new Promise((done) => setTimeout(done, 10));
    result = await (await fetch(`${base}/ask/result?jobId=${jobId}`)).json() as Record<string, unknown>;
  }
  return result;
}

describe('/ask with no admissible brain — the operator is told what is wrong and where to fix it', () => {
  it('precondition: the shipped registry runs Jarvis on a dedicated node whose harness the controller refuses unattended', () => {
    // Asserted, not assumed: if Jarvis ever moves to a hosted harness or inline, this guard must say so
    // loudly instead of passing on a path that no longer exists.
    expect(agentRequiresHostedBrain(JARVIS_AGENT_ID, getActiveRegistry())).toBe(true);
    expect(new BotNodeClient(createRegistryEndpointResolver()).hasEndpoint(JARVIS_AGENT_ID)).toBe(true);
  });

  it('settles as the no-engine sentence with code NO_HOSTED_BRAIN, after the ladder was really walked', async () => {
    const result = await ask('Tighten my resume summary');

    expect(result).toMatchObject({ status: 'error', code: 'NO_HOSTED_BRAIN', error: NO_ENGINE });
    expect(vi.mocked(resolveUserLlmConnection)).toHaveBeenCalledWith(expect.anything(), NO_BRAIN_SUB);
    expect(nodeDispatch).not.toHaveBeenCalled();
    // What the operator could not act on before: harness jargon, and a heading that does not exist.
    expect(String(result.error)).not.toMatch(/unattended|SEC-05|harness/i);
    expect(String(result.error)).not.toContain('AI Providers');
  }, 60_000);

  it('keeps every other failure as its own message, with no code', async () => {
    doubles.turnFailure = new Error('The request could not be prepared.');
    const result = await ask('Tighten my resume summary');
    expect(result).toMatchObject({ status: 'error', error: 'The request could not be prepared.' });
    expect(result.code).toBeUndefined();
  }, 60_000);

  it('never claims a missing engine for a failure that only mentions one in prose', async () => {
    // Message-shape matching would be a lie generator: a model or a provider can write that sentence.
    doubles.turnFailure = new Error('No AI engine is connected for this account');
    const result = await ask('Tighten my resume summary');
    expect(result.status).toBe('error');
    expect(result.code).toBeUndefined();
    expect(result.error).toBe('No AI engine is connected for this account');
  }, 60_000);

  it('still lists the work-queue/briefing shelf in that same state — it needs no live model', async () => {
    await ask('Tighten my resume summary');

    const response = await fetch(`${base}/tasks`);
    expect(response.status).toBe(200);
    const { tasks } = await response.json() as { tasks: Array<Record<string, unknown>> };
    expect(tasks).toEqual([expect.objectContaining({ id: SHELF_ROW.id, title: 'Your morning briefing', status: 'done' })]);
  }, 60_000);
});
