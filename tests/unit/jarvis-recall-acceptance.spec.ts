/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - the Jarvis cross-conversation recall acceptance case's own logic: fixture shape (the codeword lives only in thread A and the question trips none of Jarvis's deterministic intercepts), verdicts (codeword + owner-stamped recall pins = pass; missing/wrong codeword, no recall pin, foreign frame = fail; no capture = degraded), exact cleanup (any residue is red, ids never occupied), the signed-in Test Lab adapter's refusals and port wiring, and the live-proof runner's by-name PAT forwarding. The real store/RLS boundary is jarvis-recall-acceptance-postgres.spec.ts.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The fake server now answers like the fixed route: the answer is written into the asked thread and read back through /api/jarvis/history. New cases: a late answer that lands after the job reported "still working" passes; one that never reaches thread B within the delivery budget fails even though the job answered with the codeword; one written into thread A fails; and the route's old timeout sentence with no delivery fails after the budget.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { detectPersonModelIntent } from '@/features/person-model';
import { detectProviderBoundHandoff } from '@/app/routes/jarvis-provider-intent-detect';
import { detectScheduleIntent } from '@/app/routes/jarvis-schedule-intent';
import { detectBuildRequest } from '@/app/routes/jarvis-build-handoff';
import { runJarvisCrossThreadRecall } from '@/app/routes/test-lab-jarvis-recall';
import { OWNER_PRINCIPAL_ISSUER_METADATA_KEY } from '@/shared/security/owner-principal-issuer';
import type { ScenarioRunContext } from '@/app/routes/test-lab-scenarios';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createTokenChaseRoutes } from '@/app/routes/token-chase-routes';
import type { AppContext } from '@/app/composition/app-context';

const requireCjs = createRequire(import.meta.url);
const acceptance = requireCjs('../../scripts/lib/jarvis-recall-acceptance.js');
const runner = requireCjs('../../scripts/operations/live-proof-runner.js');

const OWNER = 'fixture|recall-owner';
const OTHER = 'fixture|someone-else';
const scratch: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface WorldOptions {
  answer?: (codeword: string | null) => string;
  /** Polls of /ask/result that report "still working" before the answer lands. */
  lateAfterPolls?: number;
  /** Where the answer is written: thread B (default), thread A, or nowhere at all. */
  landIn?: 'B' | 'A' | 'nowhere';
  pins?: Array<{ tool: string; success: boolean }>;
  noCapture?: boolean;
  frameOwner?: string;
  keepTaskOnDelete?: string;
  askStatus?: number;
  occupied?: boolean;
  codewordInFrame?: boolean;
}

/** The fake server's state: its stores, the chat tickets it opened and the calls it saw. */
interface WorldState {
  root: string;
  options: WorldOptions;
  tasks: Map<string, { ownerSub: string; messages: Array<{ role: string; text: string }> }>;
  polls: number;
  landed: boolean;
  tickets: Map<string, string>;
  calls: string[];
}

/** The codeword the seeded thread A holds, as a recalling Jarvis would read it. */
function codewordOfA(state: WorldState): string | null {
  for (const [id, task] of state.tasks) if (id.startsWith('testlab-recall-a-')) {
    return acceptance.extractCodewords(task.messages.map((m) => m.text).join(' '))[0] ?? null;
  }
  return null;
}

/** Write the capture the bot's Token Chase lane would leave for thread B. */
function writeCapture(state: WorldState, threadB: string): void {
  const dir = path.join(state.root, threadB, '.tokenchase');
  mkdirSync(dir, { recursive: true });
  const pins = state.options.pins ?? [{ tool: 'conversation_query', success: true }, { tool: 'conversation-fetch', success: true }];
  const owner = state.options.frameOwner ?? OWNER;
  writeFileSync(path.join(dir, 'frame-0001.json'), JSON.stringify({ userSub: owner, pins: [] }));
  writeFileSync(path.join(dir, 'frame-0002.json'), JSON.stringify({ userSub: owner, pins,
    response: { content: state.options.codewordInFrame ? `It is ${codewordOfA(state)}` : 'working' } }));
  writeFileSync(path.join(dir, 'final.json'), JSON.stringify({ userSub: owner, pins: [] }));
}

/** Write the answer where this world's route writes it: thread B, thread A, or nowhere. Once. */
function landAnswer(state: WorldState, answer: string): void {
  if (state.landed || state.options.landIn === 'nowhere') return;
  state.landed = true;
  const prefix = state.options.landIn === 'A' ? 'testlab-recall-a-' : 'testlab-recall-b-';
  for (const [id, task] of state.tasks) if (id.startsWith(prefix)) task.messages.push({ role: 'assistant', text: answer });
}

/** GET /api/token-chase/runs/:id and /frames/:seq, in the real routes' response shapes. */
function captureRoute(state: WorldState, route: string) {
  const parts = route.split('/');
  const dir = path.join(state.root, decodeURIComponent(parts[4]), '.tokenchase');
  const files = existsSync(dir) ? ['frame-0001.json', 'frame-0002.json'].filter((f) => existsSync(path.join(dir, f))) : [];
  if (parts.length === 5) return { status: 200, json: { frames: files.map((_, i) => ({ seq: i + 1 })) } };
  const frame = JSON.parse(readFileSync(path.join(dir, files[Number(parts[6]) - 1]), 'utf8'));
  return { status: 200, json: { frame: { seq: Number(parts[6]), ownerSub: frame.userSub, pins: frame.pins, responseContent: frame.response?.content ?? null } } };
}

/** The routes the case calls, answering as the running server would. */
function routes(state: WorldState) {
  const { options, tasks, tickets } = state;
  return vi.fn(async (method: string, route: string, body?: Record<string, string>) => {
    state.calls.push(`${method} ${route.split('?')[0]}`);
    if (method === 'POST' && route === '/api/jarvis/ask') {
      if (options.askStatus) return { status: options.askStatus, json: { error: 'session_not_found' } };
      tasks.set(body!.sessionId, { ownerSub: OWNER, messages: [{ role: 'user', text: body!.message }] });
      tickets.set('ticket-b', body!.sessionId);
      if (!options.noCapture) writeCapture(state, body!.sessionId);
      return { status: 202, json: { jobId: 'job-1', sessionId: body!.sessionId, chatTicketId: 'ticket-b' } };
    }
    if (route.startsWith('/api/jarvis/ask/result')) {
      if (++state.polls <= (options.lateAfterPolls ?? 0)) return { status: 200, json: { status: 'pending', progress: 'Still working on it' } };
      const cw = codewordOfA(state);
      const answer = options.answer ? options.answer(cw) : `The codeword was **${cw}**.`;
      landAnswer(state, answer);
      return { status: 200, json: { status: 'done', answer } };
    }
    if (route.startsWith('/api/jarvis/history?sessionId=')) {
      const task = tasks.get(decodeURIComponent(route.slice('/api/jarvis/history?sessionId='.length)));
      return { status: 200, json: { turns: (task?.messages ?? []).map((m) => ({ role: m.role === 'user' ? 'user' : 'jarvis', text: m.text })) } };
    }
    if (route.startsWith('/api/token-chase/runs/')) return captureRoute(state, route);
    if (route === '/api/jarvis/thread/close' || route === '/api/jarvis/ask/dismiss') return { status: 200, json: { ok: true } };
    if (method === 'DELETE' && route.startsWith('/api/tickets/')) { tickets.delete(decodeURIComponent(route.slice(13))); return { status: 200, json: {} }; }
    if (method === 'DELETE' && route.startsWith('/api/tasks/')) {
      const id = decodeURIComponent(route.slice(11));
      if (!id.startsWith(options.keepTaskOnDelete ?? '\u0000')) tasks.delete(id);
      return { status: 204, json: {} };
    }
    throw new Error(`unexpected ${method} ${route}`);
  });
}

/** An in-memory stand-in for the running server: stores, routes and the bot's capture directory. */
function world(options: WorldOptions = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'recall-ws-'));
  scratch.push(root);
  const state: WorldState = { root, options, tasks: new Map(), tickets: new Map(), calls: [], polls: 0, landed: false };
  const { tasks, tickets } = state;
  let clock = 0;
  const ports = {
    ownerSub: OWNER,
    api: routes(state),
    taskStore: { create: vi.fn(async (input: { taskId: string; ownerSub: string; agentId?: string; metadata: Record<string, unknown> }) => {
      tasks.set(input.taskId, { ownerSub: input.ownerSub, messages: [] });
      return { ownerSub: input.ownerSub, metadata: input.metadata };
    }) },
    messageStore: { save: vi.fn(async (message: { taskId: string; role: string; text: string }) => {
      tasks.get(message.taskId)!.messages.push({ role: message.role, text: message.text });
      return message;
    }) },
    query: vi.fn(async (_sql: string, params: [string, string[]]) => {
      const [owner, ids] = params;
      const mine = ids.filter((id) => tasks.get(id)?.ownerSub === owner || (options.occupied && id.startsWith('testlab-recall-a-')));
      return { rows: [{ chat_tasks: mine.length, chat_messages: mine.reduce((n, id) => n + (tasks.get(id)?.messages.length ?? 0), 0),
        chat_tickets: [...tickets.values()].filter((id) => ids.includes(id)).length, work_items: 0 }] };
    }),
    withOwner: <T>(fn: () => Promise<T>) => fn(),
    workspaceRoot: root,
    sleep: async () => undefined,
    now: () => { clock += 1_000; return clock; },
  };
  return { ports, tasks, tickets, calls: state.calls, root };
}

describe('recall fixture', () => {
  it('keeps the codeword inside thread A only and mints fixture-tagged ids', () => {
    const fixture = acceptance.createRecallFixture();
    expect(acceptance.FIXTURE_ID_RE.test(fixture.threadA)).toBe(true);
    expect(acceptance.FIXTURE_ID_RE.test(fixture.threadB)).toBe(true);
    expect(fixture.threadA.startsWith('testlab-recall-a-') && fixture.threadB.startsWith('testlab-recall-b-')).toBe(true);
    expect(fixture.codeword).toMatch(/^TESTLAB-RECALL-[0-9A-F]{8}$/);
    expect(fixture.title).not.toContain(fixture.codeword);
    expect(fixture.question).not.toContain(fixture.codeword);
    expect(fixture.question).toContain(fixture.title);
    expect(fixture.messages.every((m: { text: string }) => m.text.includes(fixture.codeword))).toBe(true);
    expect(acceptance.createRecallFixture().codeword).not.toBe(fixture.codeword);
  });

  it('asks a question none of Jarvis\'s deterministic intercepts claim, so it reaches the model turn', () => {
    const { question } = acceptance.createRecallFixture();
    expect(detectPersonModelIntent(question)).toBeNull();
    expect(detectProviderBoundHandoff(question)).toBeUndefined();
    expect(detectScheduleIntent(question, { now: new Date('2026-09-27T12:00:00Z'), timezone: 'UTC' })).toBeNull();
    expect(detectBuildRequest(question)).toBeNull();
  });
});

describe('evidence summary', () => {
  it('counts only successful recall pins, accepts both spellings and flags foreign frames', () => {
    const summary = acceptance.summarizeToolEvidence([
      { ownerSub: OWNER, pins: [{ tool: 'conversation-query', success: true }, { tool: 'bash', success: true }] },
      { ownerSub: OWNER, pins: [{ tool: 'conversation_fetch', success: false }], responseContent: 'TESTLAB-RECALL-0A0B0C0D' },
      { ownerSub: OTHER, pins: [{ tool: 'conversation_fetch', success: true }] },
    ], OWNER, 'TESTLAB-RECALL-0A0B0C0D');
    expect(summary).toEqual({ frames: 3, query: 1, fetch: 1, failedRecall: 1, foreignFrames: 1, codewordInFrames: true });
  });

  it('extracts codewords case-insensitively through markdown', () => {
    expect(acceptance.extractCodewords('it was **testlab-recall-0a0b0c0d**!')).toEqual(['TESTLAB-RECALL-0A0B0C0D']);
  });
});

describe('runJarvisRecallAcceptance', () => {
  it('passes on the codeword plus owner-stamped recall pins, then removes every fixture and the ask workspace', async () => {
    const w = world();
    const result = await acceptance.runJarvisRecallAcceptance(w.ports);
    expect(result.state, result.detail).toBe('pass');
    expect(result.detail).toContain('conversation_query x1, conversation_fetch x1');
    expect(result.evidence).toMatchObject({ query: 1, fetch: 1, foreignFrames: 0, botFinish: 'final', cleanupErrors: [] });
    expect(w.tasks.size).toBe(0);
    expect(w.tickets.size).toBe(0);
    expect(existsSync(path.join(w.root, result.evidence.threadB))).toBe(false);
    expect(w.calls).toEqual(expect.arrayContaining(['POST /api/jarvis/thread/close', 'DELETE /api/tickets/ticket-b', 'POST /api/jarvis/ask/dismiss']));
  });

  it('fails when the codeword never reaches thread B within the budget, and says the bot wrote it', async () => {
    const w = world({ answer: () => 'I could not get an answer just now — my model provider did not respond in time.', codewordInFrame: true });
    const result = await acceptance.runJarvisRecallAcceptance(w.ports, { deliveryBudgetMs: 30_000 });
    expect(result.state).toBe('fail');
    expect(result.detail).toContain('did not deliver the other thread\'s codeword into thread B within 30s');
    expect(result.detail).toContain('DID write the codeword');
    expect(result.evidence).toMatchObject({ deliveredSeconds: null, askStatus: 'done' });
    expect(w.tasks.size).toBe(0);
  });

  it('passes on a late answer that lands in thread B after the job reported it was still working', async () => {
    const w = world({ lateAfterPolls: 3 });
    const result = await acceptance.runJarvisRecallAcceptance(w.ports);
    expect(result.state, result.detail).toBe('pass');
    expect(result.detail).toContain('after the route reported the turn was still working');
    expect(result.evidence).toMatchObject({ stillWorkingSeen: true, strayInThreadA: 0 });
    expect(result.evidence.deliveredSeconds).toBeGreaterThan(0);
  });

  it('fails when the job answered with the codeword but it was never written into thread B', async () => {
    const w = world({ landIn: 'nowhere' });
    const result = await acceptance.runJarvisRecallAcceptance(w.ports, { deliveryBudgetMs: 30_000 });
    expect(result.state).toBe('fail');
    expect(result.detail).toContain('The ask result carried the codeword, but it was never written into thread B.');
  });

  it('fails when the answer lands in the other thread instead of thread B', async () => {
    const w = world({ landIn: 'A' });
    const result = await acceptance.runJarvisRecallAcceptance(w.ports, { deliveryBudgetMs: 30_000 });
    expect(result.state).toBe('fail');
    expect(result.detail).toContain('did not deliver the other thread\'s codeword into thread B');
    expect(w.tasks.size).toBe(0);
  });

  it('fails when the answer reaches thread B AND is also written into thread A', async () => {
    const w = world();
    const real = w.ports.api;
    w.ports.api = vi.fn(async (method: string, route: string, body?: Record<string, string>) => {
      const reply = await real(method, route, body);
      if (route.startsWith('/api/jarvis/ask/result')) {
        for (const [id, task] of w.tasks) if (id.startsWith('testlab-recall-a-') && task.messages.length === 2) task.messages.push({ role: 'assistant', text: 'stray' });
      }
      return reply;
    }) as typeof real;
    const result = await acceptance.runJarvisRecallAcceptance(w.ports);
    expect(result.state).toBe('fail');
    expect(result.detail).toContain('thread A gained 1 message(s)');
    expect(result.evidence).toMatchObject({ strayInThreadA: 1 });
  });

  it('keeps polling through a transient "expired" (a session read that lost its database connection) until the job settles', async () => {
    const w = world();
    const real = w.ports.api;
    let polls = 0;
    w.ports.api = vi.fn(async (method: string, route: string, body?: Record<string, string>) => {
      if (route.startsWith('/api/jarvis/ask/result') && polls++ < 2) return polls === 1 ? { status: 200, json: { status: 'expired' } } : { status: 503, json: {} };
      return real(method, route, body);
    }) as typeof real;
    const result = await acceptance.runJarvisRecallAcceptance(w.ports);
    expect(result.state, result.detail).toBe('pass');
    expect(polls).toBe(3);
  });

  it('fails on a wrong codeword and names it', async () => {
    const w = world({ answer: () => 'It was TESTLAB-RECALL-FFFFFFFF.' });
    const result = await acceptance.runJarvisRecallAcceptance(w.ports);
    expect(result.state).toBe('fail');
    expect(result.detail).toContain('Thread B names TESTLAB-RECALL-FFFFFFFF instead');
  });

  it('fails when the capture shows no successful recall tool call', async () => {
    const w = world({ pins: [{ tool: 'conversation_query', success: false }] });
    const result = await acceptance.runJarvisRecallAcceptance(w.ports);
    expect(result.state).toBe('fail');
    expect(result.detail).toContain('no successful recall tool call');
  });

  it('is degraded, not green, when the deployment captured nothing', async () => {
    const w = world({ noCapture: true });
    const result = await acceptance.runJarvisRecallAcceptance(w.ports, { settleBudgetMs: 3_000 });
    expect(result.state).toBe('degraded');
    expect(result.detail).toContain('cannot be proven');
  });

  it('refuses to delete a workspace holding another owner\'s frame, and that is red', async () => {
    const w = world({ frameOwner: OTHER });
    const result = await acceptance.runJarvisRecallAcceptance(w.ports);
    expect(result.state).toBe('fail');
    expect(result.detail).toContain('CLEANUP INCOMPLETE');
    expect(existsSync(path.join(w.root, result.evidence.threadB))).toBe(true);
  });

  it('turns a green run red when a fixture row survives cleanup', async () => {
    const w = world({ keepTaskOnDelete: 'testlab-recall-a-' });
    const result = await acceptance.runJarvisRecallAcceptance(w.ports);
    expect(result.state).toBe('fail');
    expect(result.detail).toMatch(/CLEANUP INCOMPLETE: residue remains .*chatTasks=1/);
  });

  it('writes nothing when the generated ids are already occupied', async () => {
    const w = world({ occupied: true });
    const result = await acceptance.runJarvisRecallAcceptance(w.ports);
    expect(result.state).toBe('fail');
    expect(result.detail).toContain('already occupied');
    expect(w.ports.taskStore.create).not.toHaveBeenCalled();
    expect(w.calls).toEqual([]);
  });

  it('still removes thread A when the new thread is refused', async () => {
    const w = world({ askStatus: 404 });
    const result = await acceptance.runJarvisRecallAcceptance(w.ports);
    expect(result.state).toBe('fail');
    expect(result.detail).toContain('refused the new thread: HTTP 404');
    expect(w.tasks.size).toBe(0);
  });
});

describe('capture evidence through the REAL Token Chase routes', () => {
  /** Serve the real router the way server.ts mounts it, as one signed-in caller. */
  async function withRoutes<T>(caller: string, fn: (api: (method: string, route: string) => Promise<{ status: number; json: Record<string, unknown> }>) => Promise<T>): Promise<T> {
    const app = express();
    app.use((req, _res, next) => { (req as unknown as { oidc: unknown }).oidc = { isAuthenticated: () => true, user: { sub: caller } }; next(); });
    app.use('/api/token-chase', createTokenChaseRoutes(process.cwd(), { pool: { query: async () => ({ rows: [] }) } } as unknown as AppContext));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      return await fn(async (method, route) => {
        const response = await fetch(`${base}${route}`, { method });
        return { status: response.status, json: await response.json().catch(() => ({})) as Record<string, unknown> };
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it('reads each frame pins and recorded owner out of the route { frame } envelope, and nothing for another caller', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'recall-tc-'));
    scratch.push(root);
    vi.stubEnv('SHARED_WORKSPACE_ROOT', root);
    const threadB = acceptance.createRecallFixture().threadB;
    const dir = path.join(root, threadB, '.tokenchase');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'frame-0001.json'), JSON.stringify({ seq: 1, userSub: OWNER, phase: 'closed', pins: [] }));
    writeFileSync(path.join(dir, 'frame-0002.json'), JSON.stringify({ seq: 2, userSub: OWNER, phase: 'closed',
      pins: [{ tool: 'conversation_query', success: true }], response: { content: 'TESTLAB-RECALL-0A0B0C0D' } }));
    const mine = await withRoutes<Array<{ seq: number }>>(OWNER, (api) => acceptance.readCapturedFrames({ api }, threadB));
    expect(mine.map((f: { seq: number }) => f.seq)).toEqual([1, 2]);
    expect(acceptance.summarizeToolEvidence(mine, OWNER, 'TESTLAB-RECALL-0A0B0C0D'))
      .toMatchObject({ frames: 2, query: 1, fetch: 0, foreignFrames: 0, codewordInFrames: true });
    expect(await withRoutes(OTHER, (api) => acceptance.readCapturedFrames({ api }, threadB))).toEqual([]);
  });
});

describe('Test Lab adapter', () => {
  function runtime(overrides: Partial<ScenarioRunContext> = {}): ScenarioRunContext {
    const w = world();
    return { ctx: { pool: { query: w.ports.query }, taskStore: w.ports.taskStore, messageStore: w.ports.messageStore } as never,
      ownerSub: OWNER, issuer: 'https://issuer.fixture.test', apiBaseUrl: 'http://127.0.0.1:5999', ...overrides };
  }

  it('writes nothing without a session cookie or a verified issuer', async () => {
    const noCookie = runtime();
    expect((await runJarvisCrossThreadRecall('', noCookie)).state).toBe('degraded');
    const noIssuer = runtime({ issuer: null });
    expect((await runJarvisCrossThreadRecall('sid=fixture', noIssuer)).state).toBe('degraded');
    expect((noCookie.ctx.taskStore.create as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect((noIssuer.ctx.taskStore.create as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('drives the case over loopback with the caller cookie and stamps the thread like a Jarvis thread', async () => {
    const w = world();
    vi.stubEnv('OSHAL_WORKSPACE_ROOT', w.root);
    const cookies: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      cookies.push(String((init.headers as Record<string, string>).cookie));
      const target = new URL(url);
      const reply = await w.ports.api(String(init.method), target.pathname + target.search, init.body ? JSON.parse(String(init.body)) : undefined);
      return new Response(reply.status === 204 ? null : JSON.stringify(reply.json), { status: reply.status, headers: { 'content-type': 'application/json' } });
    }));
    const lab = { ctx: { pool: { query: w.ports.query }, taskStore: w.ports.taskStore, messageStore: w.ports.messageStore } as never,
      ownerSub: OWNER, issuer: 'https://issuer.fixture.test', apiBaseUrl: 'http://127.0.0.1:5999' };
    const result = await runJarvisCrossThreadRecall('sid=fixture', lab, { pollMs: 1, settleBudgetMs: 2_000 });
    expect(result.state, result.detail).toBe('pass');
    expect(new Set(cookies)).toEqual(new Set(['sid=fixture']));
    const created = w.ports.taskStore.create.mock.calls[0][0];
    expect(created.agentId).toBe('a0000000-0000-0000-0000-000000000050');
    expect(created.metadata).toMatchObject({ origin: 'jarvis-chat', [OWNER_PRINCIPAL_ISSUER_METADATA_KEY]: 'https://issuer.fixture.test' });
    expect(w.tasks.size).toBe(0);
  });
});

describe('live-proof runner', () => {
  it('reads the operator PAT by name from the environment first, then a quoted CRLF .env', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'recall-env-'));
    scratch.push(dir);
    const envFile = path.join(dir, '.env');
    writeFileSync(envFile, 'OTHER=1\r\nOSHAL_VERIFY_OPERATOR_PAT="oshal_pat_fixture_from_file"\r\n');
    expect(runner.readOperatorPat({}, envFile)).toBe('oshal_pat_fixture_from_file');
    expect(runner.readOperatorPat({ OSHAL_VERIFY_OPERATOR_PAT: 'oshal_pat_fixture_env' }, envFile)).toBe('oshal_pat_fixture_env');
    expect(runner.readOperatorPat({}, path.join(dir, 'missing.env'))).toBe('');
  });

  it('forwards the PAT by NAME only and always removes the staging directory', () => {
    const argvs: string[][] = [];
    const envs: Array<NodeJS.ProcessEnv> = [];
    const exec = (args: string[], env: NodeJS.ProcessEnv) => {
      argvs.push(args); envs.push(env);
      if (args.includes('node')) return { status: 1, stdout: 'RESULT {"caseId":"x","state":"fail","detail":"d"}\n', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    const out = runner.stageAndRun({ container: 'api', files: [{ src: '/tmp/a.js', rel: 'operations/a.js' }], entry: 'operations/a.js',
      env: { LOG_LEVEL: 'silent' }, pat: 'oshal_pat_secret_value', timeoutMs: 1_000 }, exec);
    expect(out.status).toBe(1);
    expect(runner.parseResult(out.stdout)).toMatchObject({ state: 'fail' });
    expect(argvs.flat().join(' ')).not.toContain('oshal_pat_secret_value');
    const run = argvs.find((args) => args.includes('node'))!;
    expect(run[run.indexOf('-e', run.indexOf('/app')) + 1]).toBe('OSHAL_VERIFY_OPERATOR_PAT');
    expect(envs.every((env) => env.OSHAL_VERIFY_OPERATOR_PAT === 'oshal_pat_secret_value')).toBe(true);
    expect(argvs[argvs.length - 1].slice(0, 4)).toEqual(['exec', 'api', 'rm', '-rf']);
  });

  it('still removes the staging directory when staging fails', () => {
    const argvs: string[][] = [];
    const exec = (args: string[]) => { argvs.push(args); return { status: args[0] === 'cp' ? 1 : 0, stdout: '', stderr: 'no such container' }; };
    const out = runner.stageAndRun({ container: 'api', files: [{ src: '/tmp/a.js', rel: 'operations/a.js' }], entry: 'operations/a.js',
      env: {}, pat: 'oshal_pat_x', timeoutMs: 1_000 }, exec);
    expect(out.status).toBe(2);
    expect(argvs.some((args) => args.includes('node'))).toBe(false);
    expect(argvs[argvs.length - 1].slice(2, 4)).toEqual(['rm', '-rf']);
  });
});
