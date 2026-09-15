/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the no-brain honesty fix (root-caused 2026-08-09): with the user-brain ladder resolved to nothing and the Jarvis bot's registry harness an unbrokered CLI, the /ask turn must answer with "Jarvis has no AI engine connected" and the code the surface speaks — never the SEC-05 refusal text and never a bare apology. Drives the REAL router, the REAL executeBotOrInline chokepoint and the REAL swarm registry (only the ladder, persistence and the identity rail are doubled), proves the briefing shelf still lists its rows in that same state, and evaluates the shipped askFailureLines out of jarvis.html so the spoken line cannot rot.
 */

import express, { type RequestHandler } from 'express';
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The ladder is the ONE collaborator doubled on the server path: "the caller has no endpoint
// anywhere" is this guard's PRECONDITION, not the boundary under test. The registry, the harness
// predicate, executeBotOrInline and the router are all real.
vi.mock('@/app/routes/free-tier-rotation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/app/routes/free-tier-rotation')>();
  return { ...actual, resolveUserLlmConnection: vi.fn(async () => undefined) };
});
vi.mock('@/app/routes/byo-llm-routes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/app/routes/byo-llm-routes')>();
  return { ...actual, getUserLlmConnection: vi.fn(async () => undefined) };
});
vi.mock('@/app/routes/connector-token-broker', () => ({ resolveBotCreds: vi.fn().mockResolvedValue({}) }));
vi.mock('@/features/user-model', () => ({
  withHavenContext: vi.fn(async (_pool: unknown, _sub: string, prompt: string) => prompt),
  learnFromExchange: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/shared/services/database', () => ({
  createOptionalPostgresPool: () => null,
  ensureConversationStoreSchema: async () => {},
  runRuntimeSchemaBootstrap: vi.fn().mockResolvedValue(undefined),
  buildOwnerRlsPolicyStatements: vi.fn().mockReturnValue([]),
}));

import { InMemoryMessageStore } from '../../src/entities/message';
import { InMemoryTaskStore } from '../../src/entities/task';
import {
  JARVIS_NO_BRAIN_CODE,
  JARVIS_NO_BRAIN_MESSAGE,
  describeJarvisAskFailure,
} from '../../src/app/routes/jarvis-no-brain-notice';
import { createJarvisRoutes, purgeJarvisAskJobsForOwner } from '../../src/app/routes/jarvis-routes';

const OWNER = 'auth0|no-brain-operator';
const SESSION = 'no-brain-session';
/** The exact text assertAuditedAutonomousHarness raises — the jargon the operator used to get. */
const SEC_05_REFUSAL = 'unattended execution is disabled';

/** One finished shelf row, the kind the morning briefing leaves behind. Needs no live model. */
const SHELF_ROW = {
  id: '5f6c2b40-0000-4000-8000-0000000000aa',
  user_sub: OWNER,
  session_id: null,
  briefing_source_id: null,
  principal_issuer: null,
  title: 'Your morning briefing',
  status: 'done',
  result: 'Three things worth your attention this morning.',
  error: null,
  kind: 'simple',
  ticket_id: null,
  visual: null,
  files: null,
  delivered: false,
  created_at: new Date('2026-09-14T11:00:00Z'),
  finished_at: new Date('2026-09-14T11:00:04Z'),
};

let server: Server;
let base: string;

beforeEach(async () => {
  const ctx = {
    // Every statement answers empty EXCEPT the shelf read, which returns one finished row: the
    // point of the shelf case is that it still carries content while the ask path refuses.
    pool: {
      query: vi.fn(async (text: string) => (
        /FROM jarvis_tasks WHERE user_sub = \$1 ORDER BY created_at/.test(String(text))
          ? { rows: [SHELF_ROW], rowCount: 1 }
          : { rows: [], rowCount: 0 }
      )),
    },
    taskStore: new InMemoryTaskStore(),
    messageStore: new InMemoryMessageStore(),
    ticketService: {
      listTickets: vi.fn().mockResolvedValue([]),
      openChatTicket: vi.fn().mockResolvedValue({ ticketId: 'no-brain-chat' }),
      createTicket: vi.fn(),
      updateStatus: vi.fn(),
    },
  };
  const auth: RequestHandler = (request, _response, next) => {
    (request as unknown as { oidc: unknown }).oidc = { isAuthenticated: () => true, user: { sub: OWNER } };
    next();
  };
  const app = express();
  app.use(express.json());
  app.use('/api/jarvis', auth, createJarvisRoutes(ctx as never, process.cwd()));
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((done) => server.once('listening', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/jarvis`;
});

afterEach(async () => {
  purgeJarvisAskJobsForOwner(OWNER);
  vi.clearAllMocks();
  if (!server) return;
  server.closeAllConnections();
  await new Promise<void>((done, fail) => server.close((error) => (error ? fail(error) : done())));
});

/** POST /ask, then poll the job to its settled result — exactly what the surface does. */
async function ask(message: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${base}/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, sessionId: SESSION }),
  });
  expect(response.status).toBe(202);
  const { jobId } = await response.json() as { jobId: string };
  let result: Record<string, unknown> = {};
  for (let attempt = 0; attempt < 400; attempt++) {
    result = await (await fetch(`${base}/ask/result?jobId=${jobId}`)).json() as Record<string, unknown>;
    if (result.status !== 'pending') break;
    await new Promise((done) => setTimeout(done, 10));
  }
  return result;
}

describe('/ask with no admissible brain — the operator is told what is wrong and where to fix it', () => {
  it('answers with the no-engine sentence and its code, not the SEC-05 refusal', async () => {
    const result = await ask('Tighten my resume summary');

    expect(result.status).toBe('error');
    expect(result.code).toBe(JARVIS_NO_BRAIN_CODE);
    expect(String(result.error)).toBe(JARVIS_NO_BRAIN_MESSAGE);
    // The two things the operator could not act on before: harness jargon, and no destination.
    expect(String(result.error)).not.toContain(SEC_05_REFUSAL);
    expect(String(result.error)).toContain('Bring Your Own LLM');
  }, 60_000);

  it('still lists the briefing shelf in that same state — it needs no live model', async () => {
    await ask('Tighten my resume summary');

    const response = await fetch(`${base}/tasks`);
    expect(response.status).toBe(200);
    const { tasks } = await response.json() as { tasks: Array<{ id: string; title: string; status: string }> };
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ id: SHELF_ROW.id, title: 'Your morning briefing', status: 'done' });
  }, 60_000);
});

describe('describeJarvisAskFailure — one known state is rewritten, nothing else is', () => {
  it('maps a NO_HOSTED_BRAIN refusal to the actionable sentence plus its code', () => {
    const refusal = Object.assign(new Error('No AI engine is connected for this account'), { code: 'NO_HOSTED_BRAIN' });
    expect(describeJarvisAskFailure(refusal)).toEqual({ message: JARVIS_NO_BRAIN_MESSAGE, code: JARVIS_NO_BRAIN_CODE });
  });

  it('leaves every other failure with its own message and no code', () => {
    expect(describeJarvisAskFailure(new Error('the requested ticket does not exist')))
      .toEqual({ message: 'the requested ticket does not exist' });
    const walled = Object.assign(new Error('endpoint returned HTTP 429: quota exceeded'), { code: 'BYO_HOSTED_HTTP_ERROR' });
    expect(describeJarvisAskFailure(walled)).toEqual({ message: 'endpoint returned HTTP 429: quota exceeded' });
  });

  it('never claims a missing engine for a refusal that only mentions one in prose', () => {
    // Message-shape matching would be a lie generator: a model can write that sentence itself.
    expect(describeJarvisAskFailure(new Error('No AI engine is connected for this account')).code).toBeUndefined();
  });
});

type AskFailureLines = (result: unknown) => { text: string; speech: string };

/**
 * Pull the shipped `askFailureLines` out of jarvis.html and evaluate it. Testing the real source
 * rather than a copy is the point — a copy keeps passing after the page changes.
 */
function loadAskFailureLines(): AskFailureLines {
  const html = readFileSync(resolve(__dirname, '../../src/api/jarvis.html'), 'utf8');
  const match = html.match(/function askFailureLines\(result\)\{[\s\S]*?\n\}/);
  if (!match) throw new Error('askFailureLines not found in jarvis.html — the surface changed, update this guard');
  const sandbox: Record<string, unknown> = {};
  runInNewContext(`${match[0]}\nthis.fn = askFailureLines;`, sandbox);
  return sandbox.fn as AskFailureLines;
}

describe('jarvis.html — the spoken line says what is wrong, not only the written one', () => {
  const askFailureLines = loadAskFailureLines();

  it('speaks the no-engine state instead of apologising', () => {
    const lines = askFailureLines({ status: 'error', error: JARVIS_NO_BRAIN_MESSAGE, code: JARVIS_NO_BRAIN_CODE });
    expect(lines.text).toBe(JARVIS_NO_BRAIN_MESSAGE);
    expect(lines.speech).toContain('no AI engine connected');
    expect(lines.speech).toContain('Bring Your Own LLM');
    expect(lines.speech).not.toContain("didn't work");
  });

  it('keeps the arrows out of the spoken line — a speech engine reads them as noise', () => {
    const lines = askFailureLines({ error: JARVIS_NO_BRAIN_MESSAGE, code: JARVIS_NO_BRAIN_CODE });
    expect(lines.speech).not.toContain('→');
  });

  it('leaves an ordinary failure exactly as it was — message shown, apology spoken', () => {
    const lines = askFailureLines({ status: 'error', error: 'That ticket no longer exists.' });
    expect(lines.text).toBe('That ticket no longer exists.');
    expect(lines.speech).toBe("Sorry, that didn't work.");
  });

  it('falls back to the old wording when a failure carried no message at all', () => {
    expect(askFailureLines({ status: 'error' })).toEqual({ text: "That didn't work.", speech: "Sorry, that didn't work." });
  });
});
