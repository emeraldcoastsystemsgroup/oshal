/**
 * Delayed Jarvis result acceptance test.
 *
 * This deliberately crosses the Express router, trusted-service identity boundary, durable task
 * store, summary path, real deterministic renderer/persistence service, Discussion history route,
 * and authenticated artifact route. Only the external bot/DB implementations are replaced with
 * deterministic in-memory adapters.
 */

import type { AddressInfo } from 'node:net';
import express, { type RequestHandler } from 'express';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const executeBot = vi.hoisted(() => vi.fn());

vi.mock('@/app/routes/inline-bot-execution', () => ({ executeBotOrInline: executeBot }));
vi.mock('@/app/routes/connector-token-broker', () => ({ resolveBotCreds: vi.fn().mockResolvedValue({}) }));
vi.mock('@/app/routes/free-tier-rotation', () => ({ resolveUserLlmConnection: vi.fn().mockResolvedValue(null) }));
vi.mock('@/features/user-model', () => ({
  withHavenContext: vi.fn(async (_pool: unknown, _sub: string, prompt: string) => prompt),
  learnFromExchange: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/shared/services/database', () => ({
  runRuntimeSchemaBootstrap: vi.fn().mockResolvedValue(undefined),
  buildOwnerRlsPolicyStatements: vi.fn().mockReturnValue([]),
}));

import { createJarvisRoutes } from '../../src/app/routes/jarvis-routes';
import { serviceSecretOr } from '../../src/shared/middleware/authz';

interface StoredTask {
  id: string;
  user_sub: string;
  session_id: string;
  title: string;
  status: string;
  result: string | null;
  error: string | null;
  kind: string;
  ticket_id: string | null;
  visual: Record<string, unknown> | null;
  delivered: boolean;
  created_at: string;
  finished_at: string | null;
  summarize_started_at: string | null;
}

interface StoredArtifact {
  artifact_id: string;
  mime_type: 'image/svg+xml';
  width: number;
  height: number;
  alt_text: string;
  content: Buffer;
  content_sha256: string;
  provenance: Record<string, unknown>;
  created_at: string;
  user_sub: string;
  source_surface: string;
  source_job_id: string;
}

interface StoredMessage {
  taskId: string;
  role: 'user' | 'assistant';
  type: 'task' | 'say';
  text: string;
  metadata?: Record<string, unknown>;
}

class DelayedLifecyclePool {
  readonly tasks = new Map<string, StoredTask>();
  readonly artifacts = new Map<string, StoredArtifact>();

  async query(sqlValue: string, values: unknown[] = []): Promise<{ rows: any[]; rowCount: number }> {
    const sql = String(sqlValue).replace(/\s+/g, ' ').trim();

    if (sql.startsWith('SELECT DISTINCT provider FROM oshal_connections')) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.startsWith('SELECT id, title, status, kind, result FROM jarvis_tasks')) {
      const rows = [...this.tasks.values()]
        .filter((task) => task.user_sub === values[0])
        .map(({ id, title, status, kind, result }) => ({ id, title, status, kind, result }));
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith('INSERT INTO jarvis_tasks')) {
      const [id, userSub, sessionId, title, status, kind, ticketId] = values.map((value) => value == null ? null : String(value));
      const previous = this.tasks.get(String(id));
      this.tasks.set(String(id), {
        id: String(id), user_sub: String(userSub), session_id: String(sessionId), title: String(title),
        status: String(status), result: null, error: null, kind: String(kind), ticket_id: ticketId,
        visual: null, files: null, delivered: previous?.delivered ?? false,
        created_at: previous?.created_at ?? '2026-07-10T15:00:00.000Z', finished_at: null,
        summarize_started_at: null,
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('SELECT id, title, status, result, error, kind, ticket_id, visual, files, delivered')) {
      const rows = [...this.tasks.values()].filter((task) => task.user_sub === values[0]);
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith('SELECT id, visual FROM jarvis_tasks WHERE user_sub = $1')) {
      // Match the production schema: jarvis_tasks.id is TEXT even when this bounded join happens
      // to contain UUID-shaped task ids. A UUID[] cast makes real Postgres reject text = uuid.
      if (!sql.includes('id = ANY($2::text[])')) {
        throw new Error('jarvis_tasks.id lookup must bind a text[] array');
      }
      const ids = new Set((values[1] as unknown[] || []).map(String));
      const rows = [...this.tasks.values()]
        .filter((task) => task.user_sub === values[0] && ids.has(task.id))
        .map((task) => ({ id: task.id, visual: task.visual }));
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith("UPDATE jarvis_tasks SET status = 'summarizing'")) {
      const task = this.tasks.get(String(values[0]));
      if (!task) return { rows: [], rowCount: 0 };
      task.status = 'summarizing';
      task.summarize_started_at = new Date().toISOString();
      return { rows: [{ id: task.id }], rowCount: 1 };
    }
    if (sql.startsWith('SELECT session_id FROM jarvis_tasks')) {
      const task = this.tasks.get(String(values[0]));
      const rows = task && task.user_sub === values[1] ? [{ session_id: task.session_id }] : [];
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith('UPDATE jarvis_tasks SET status = $2,')) {
      const task = this.tasks.get(String(values[0]));
      if (!task) return { rows: [], rowCount: 0 };
      task.status = String(values[1]);
      if (task.status === 'done') task.result = String(values[2]);
      else task.error = String(values[2]);
      task.visual = values[3] ? JSON.parse(String(values[3])) as Record<string, unknown> : null;
      // $5 is the captured-deliverables slot. Mirrored here (rather than ignored) so the fake pool
      // keeps modelling the real write: finishTask always sets it, and a null must overwrite a
      // previous run's files rather than leave them attached to a fresh result.
      task.files = values[4] ? JSON.parse(String(values[4])) as Record<string, unknown>[] : null;
      task.finished_at = new Date().toISOString();
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('UPDATE jarvis_tasks SET visual = $3::jsonb')) {
      const task = this.tasks.get(String(values[0]));
      if (!task || task.user_sub !== values[1] || task.visual || task.status !== 'done') {
        return { rows: [], rowCount: 0 };
      }
      task.visual = JSON.parse(String(values[2])) as Record<string, unknown>;
      return { rows: [{ id: task.id }], rowCount: 1 };
    }
    if (sql.startsWith('UPDATE jarvis_tasks SET delivered = TRUE')) {
      const task = this.tasks.get(String(values[0]));
      if (task && task.user_sub === values[1]) task.delivered = true;
      return { rows: [], rowCount: task ? 1 : 0 };
    }
    if (sql.startsWith('INSERT INTO visual_response_artifacts')) {
      const artifact: StoredArtifact = {
        artifact_id: String(values[0]), user_sub: String(values[1]), source_surface: String(values[2]),
        source_job_id: String(values[4]), mime_type: values[5] as 'image/svg+xml', width: Number(values[6]),
        height: Number(values[7]), alt_text: String(values[8]), content: values[9] as Buffer,
        content_sha256: String(values[10]), provenance: JSON.parse(String(values[11])) as Record<string, unknown>,
        created_at: '2026-07-10T15:05:00.000Z',
      };
      this.artifacts.set(artifact.artifact_id, artifact);
      return { rows: [{ artifact_id: artifact.artifact_id, created_at: artifact.created_at }], rowCount: 1 };
    }
    if (sql.includes('FROM visual_response_artifacts') && sql.includes('WHERE artifact_id = $1 AND user_sub = $2')) {
      const artifact = this.artifacts.get(String(values[0]));
      const rows = artifact && artifact.user_sub === values[1] ? [artifact] : [];
      return { rows, rowCount: rows.length };
    }
    if (sql.includes('FROM visual_response_artifacts') && sql.includes('source_job_id = $3')) {
      const artifact = [...this.artifacts.values()].find((item) => (
        item.user_sub === values[0] && item.source_surface === values[1] && item.source_job_id === values[2]
      ));
      return { rows: artifact ? [artifact] : [], rowCount: artifact ? 1 : 0 };
    }
    if (sql.includes('FROM swarm_applications') || sql.includes('FROM chat_tasks')) {
      return { rows: [], rowCount: 0 };
    }

    throw new Error(`Unhandled delayed-lifecycle SQL: ${sql}`);
  }
}

const SERVICE_SECRET = 'jarvis-delayed-lifecycle-secret';
const OWNER = 'auth0|delayed-owner';
const SESSION = 'jarvis-delayed-acceptance';

const DIRECT_VISUAL_SPECS = [
  {
    kind: 'weather', title: 'Direct weather', sourceRefs: ['nws:forecast:direct'],
    location: 'Chicago, IL', units: 'imperial', current: { temperature: 72, condition: 'Clear' },
  },
  {
    kind: 'priority-email', title: 'Direct email',
    sourceRefs: ['gmail:summary:direct', 'gmail:message:direct'],
    items: [{
      sourceRef: 'gmail:message:direct', sender: 'Ada <ada@example.com>', subject: 'Decision needed',
      unread: true, importance: 'important', reason: 'Marked important by Gmail',
    }],
  },
  {
    kind: 'table', title: 'Direct table', sourceRefs: [],
    columns: ['Option', 'Cost'], rows: [['Alpha', '$10']],
  },
  {
    kind: 'chart', title: 'Direct chart', sourceRefs: [], chartType: 'bar',
    categories: ['Alpha'], series: [{ name: 'Cost', values: [10], unit: '$' }],
  },
  {
    kind: 'summary', title: 'Direct summary', sourceRefs: [], bullets: ['Direct result'],
  },
  {
    kind: 'timeline', title: 'Direct timeline', sourceRefs: [],
    items: [
      { label: '08 Jul', title: 'Design approved', detail: 'The final design was approved.' },
      { label: '10 Jul', title: 'Pilot launched', detail: 'The pilot launched for ten users.' },
    ],
  },
  {
    kind: 'diagram', title: 'Direct diagram', sourceRefs: [], layout: 'flow',
    nodes: [
      { id: 'request', label: 'Request received' },
      { id: 'result', label: 'Result delivered' },
    ],
    edges: [{ from: 'request', to: 'result', label: 'produces' }],
  },
  {
    kind: 'gallery', title: 'Direct gallery',
    sourceRefs: ['walmart:catalog:direct', 'walmart:item:direct'],
    items: [{
      sourceRef: 'walmart:item:direct', title: 'Direct product', price: 10, currency: 'USD',
    }],
  },
] as const;

function headers(): Record<string, string> {
  return headersFor(OWNER);
}

function headersFor(ownerSub: string): Record<string, string> {
  return {
    'X-Service-Secret': SERVICE_SECRET,
    'x-oshal-user-sub': ownerSub,
  };
}

function createOwnerAwareTaskStore(initial: Array<{ taskId: string; ownerSub: string }> = []) {
  const tasks = new Map(initial.map((task) => [task.taskId, { ...task }]));
  return {
    tasks,
    store: {
      get: vi.fn(async (taskId: string) => tasks.get(taskId) ?? null),
      create: vi.fn(async (input: { taskId: string; ownerSub?: string }) => {
        const existing = tasks.get(input.taskId);
        if (existing) return existing;
        const created = { taskId: input.taskId, ownerSub: input.ownerSub || '' };
        tasks.set(input.taskId, created);
        return created;
      }),
      updateStatus: vi.fn().mockResolvedValue(undefined),
      incrementMessageCount: vi.fn().mockResolvedValue(undefined),
      incrementTurnCount: vi.fn().mockResolvedValue(undefined),
    },
  };
}

async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>, timeoutMs = 2_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for delayed Jarvis lifecycle state');
}

describe('Jarvis delayed worker visual lifecycle integration', () => {
  const originalSecret = process.env.SWARM_SERVICE_SECRET;

  beforeEach(() => {
    process.env.SWARM_SERVICE_SECRET = SERVICE_SECRET;
    executeBot.mockReset();
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.SWARM_SERVICE_SECRET;
    else process.env.SWARM_SERVICE_SECRET = originalSecret;
  });

  it('keeps the handoff acknowledgement text-only, then persists and reloads the completed visual in the original Discussion', async () => {
    const pool = new DelayedLifecyclePool();
    const messages: StoredMessage[] = [];
    const sessionTasks = createOwnerAwareTaskStore();
    const workTicket = {
      ticketId: 'ticket-weather-1', title: 'Prepare the trip weather brief', ticketType: 'task',
      status: 'approved', createdAt: '2026-07-10T15:00:00.000Z', updatedAt: '2026-07-10T15:00:00.000Z',
      metadata: { source: 'jarvis', sessionId: SESSION },
    };

    executeBot.mockImplementation(async (_ctx: unknown, _client: unknown, _agentId: string, input: { text: string }) => {
      if (input.text.includes('<untrusted-work-product>')) {
        return { response: [
          'The team completed the trip brief. Destin is expected to reach 86 degrees with a low rain risk.',
          '```oshal:visual',
          JSON.stringify({
            kind: 'summary', title: 'Trip weather brief',
            metrics: [{ label: 'High', value: '86°F' }, { label: 'Rain risk', value: 'Low' }],
            bullets: ['The completed brief is saved with this discussion.'],
            sourceRefs: [`ticket:${workTicket.ticketId}`],
          }),
          '```',
        ].join('\n') };
      }
      return { response: [
        "I’ve handed the trip-weather brief to the team and I’ll report back here.",
        '```oshal:visual',
        JSON.stringify({ kind: 'summary', title: 'Not finished', bullets: ['Work is queued.'], sourceRefs: [] }),
        '```',
        '```handoff',
        JSON.stringify({
          action: 'create', title: workTicket.title,
          description: 'Build a source-backed weather brief for the upcoming Destin trip.', complexity: 'complex',
        }),
        '```',
      ].join('\n') };
    });

    const ctx = {
      pool,
      orchestrator: { processMessage: vi.fn() },
      taskStore: sessionTasks.store,
      messageStore: {
        save: vi.fn(async (message: StoredMessage) => { messages.push(message); }),
        getByTask: vi.fn(async (taskId: string) => {
          if (taskId === workTicket.ticketId) {
            return [{
              role: 'assistant', type: 'say',
              text: 'Worker deliverable: the sourced Destin brief reports an 86 degree high and a low rain risk.',
            }];
          }
          return messages.filter((message) => message.taskId === taskId);
        }),
      },
      ticketService: {
        openChatTicket: vi.fn().mockResolvedValue({ ticketId: 'ticket-chat-1' }),
        createTicket: vi.fn().mockResolvedValue(workTicket),
        listTickets: vi.fn(async (filter: { ticketType?: string }) => filter.ticketType === 'chat' ? [] : [workTicket]),
        updateStatus: vi.fn().mockResolvedValue(undefined),
      },
    };

    const app = express();
    app.use(express.json());
    const deny: RequestHandler = (_req, res) => { res.status(401).json({ error: 'not_authenticated' }); };
    app.use('/api/jarvis', serviceSecretOr(deny), createJarvisRoutes(ctx as never, process.cwd()));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/jarvis`;

    try {
      const askResponse = await fetch(`${base}/ask`, {
        method: 'POST', headers: { ...headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Prepare a weather brief for our Destin trip.', sessionId: SESSION }),
      });
      expect(askResponse.status).toBe(202);
      const ask = await askResponse.json() as { jobId: string };

      const acknowledgement = await waitFor(async () => {
        const response = await fetch(`${base}/ask/result?jobId=${ask.jobId}`, { headers: headers() });
        const body = await response.json() as Record<string, unknown>;
        return body.status === 'done' ? body : undefined;
      });
      expect(acknowledgement).toMatchObject({
        status: 'done',
        answer: "I'll check the live weather data and report back here.",
      });
      expect(acknowledgement).not.toHaveProperty('visual');
      expect(pool.artifacts.size).toBe(0);
      expect(executeBot).not.toHaveBeenCalled();
      const dispatched = acknowledgement.dispatched as Array<{ workJobId: string; title: string }>;
      expect(dispatched).toHaveLength(1);
      const task = await waitFor(() => pool.tasks.get(dispatched[0].workJobId));
      expect(task).toMatchObject({ session_id: SESSION, status: 'queued', ticket_id: workTicket.ticketId });

      // The external worker/ticket system has now completed and stored its deliverable.
      workTicket.status = 'complete';
      workTicket.updatedAt = '2026-07-10T15:04:00.000Z';
      const firstTaskPoll = await fetch(`${base}/tasks`, { headers: headers() });
      const pendingSummary = await firstTaskPoll.json() as { tasks: Array<Record<string, unknown>> };
      expect(pendingSummary.tasks[0]).toMatchObject({
        id: task.id, status: 'summarizing', result: 'Reading the results…',
      });
      expect(pendingSummary.tasks[0]).not.toHaveProperty('visual');

      const completedTask = await waitFor(() => {
        const current = pool.tasks.get(task.id);
        return current?.status === 'done' && current.visual ? current : undefined;
      });
      expect(completedTask.result).toContain('The team completed the trip brief');
      expect(completedTask.visual).toMatchObject({ type: 'image', kind: 'summary', mimeType: 'image/svg+xml' });
      expect(executeBot).toHaveBeenCalledTimes(1);

      const finalTasksResponse = await fetch(`${base}/tasks`, { headers: headers() });
      const finalTasks = await finalTasksResponse.json() as { tasks: Array<Record<string, any>> };
      expect(finalTasks.tasks[0]).toMatchObject({ id: task.id, status: 'done', result: completedTask.result });
      expect(finalTasks.tasks[0].visual.url).toBe(`/api/jarvis/visuals/${finalTasks.tasks[0].visual.artifactId}`);

      const historyResponse = await fetch(`${base}/history?sessionId=${SESSION}`, { headers: headers() });
      const history = await historyResponse.json() as { turns: Array<Record<string, any>> };
      expect(history.turns.map((turn) => turn.text)).toEqual([
        'Prepare a weather brief for our Destin trip.',
        "I'll check the live weather data and report back here.",
        completedTask.result,
      ]);
      expect(history.turns[1]).not.toHaveProperty('visual');
      expect(history.turns[2].visual).toEqual(finalTasks.tasks[0].visual);

      const visualUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}${history.turns[2].visual.url}`;
      const anonymousVisualResponse = await fetch(visualUrl);
      expect(anonymousVisualResponse.status).toBe(401);
      const otherOwnerVisualResponse = await fetch(visualUrl, { headers: {
        'X-Service-Secret': SERVICE_SECRET, 'x-oshal-user-sub': 'auth0|different-owner',
      } });
      expect(otherOwnerVisualResponse.status).toBe(404);

      const visualResponse = await fetch(visualUrl, {
        headers: headers(),
      });
      expect(visualResponse.status).toBe(200);
      expect(visualResponse.headers.get('cache-control')).toBe('private, no-store');
      expect(visualResponse.headers.get('cross-origin-resource-policy')).toBe('same-origin');
      const svg = await visualResponse.text();
      expect(svg).toContain('Trip weather brief');
      expect(svg).toContain('86°F');
      expect(svg).toContain('Completed ticket result');

      // A page reload reads the same durable turn and immutable artifact URL; it does not regenerate.
      const reloadedResponse = await fetch(`${base}/history?sessionId=${SESSION}`, { headers: headers() });
      expect(await reloadedResponse.json()).toEqual(history);
      expect(pool.artifacts.size).toBe(1);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('materializes a live Walmart provider record as a byte-received product gallery', async () => {
    const pool = new DelayedLifecyclePool();
    const sessionId = 'jarvis-gallery-acceptance';
    const taskId = 'jarvis-gallery-task';
    const ticketId = 'ticket-gallery-1';
    const catalogRef = 'walmart:catalog:gallery-test';
    const itemRef = 'walmart:item:gallery-test';
    const imageUrl = 'https://i5.walmartimages.com/seo/fish-food.jpeg?odnWidth=573';
    const productUrl = 'https://www.walmart.com/ip/TetraMin-Tropical-Flakes/10849069';
    const title = 'Find two good fish food options';
    pool.tasks.set(taskId, {
      id: taskId, user_sub: OWNER, session_id: sessionId, title, status: 'done', result: null,
      error: null, kind: 'complex', ticket_id: ticketId, visual: null, delivered: false,
      created_at: '2026-07-12T14:00:00.000Z', finished_at: null, summarize_started_at: null,
    });
    const sessionTasks = createOwnerAwareTaskStore([{ taskId: sessionId, ownerSub: OWNER }]);
    const messages: StoredMessage[] = [];
    const providerRecord = {
      schemaVersion: 1,
      kind: 'walmart-catalog',
      provider: 'walmart',
      sourceRef: catalogRef,
      retrievedAt: '2026-07-12T14:01:00.000Z',
      query: 'fish food',
      items: [{
        sourceRef: itemRef,
        productId: '10849069',
        title: 'TetraMin Tropical Flakes',
        brand: 'Tetra',
        price: 7.97,
        currency: 'USD',
        imageUrl,
        productUrl,
      }],
    };
    const workerText = [
      'Live Walmart lookup complete. No cart or checkout action was taken.',
      '',
      '| Product | Price | Link |',
      '|---|---:|---|',
      `| TetraMin Tropical Flakes | $7.97 | [View at Walmart](${productUrl}) |`,
    ].join('\n');
    executeBot.mockRejectedValue(new Error('Walmart provider completion must not require a model summary'));
    const completedTicket = {
      ticketId, title, ticketType: 'task', status: 'complete',
      createdAt: '2026-07-12T14:00:00.000Z', updatedAt: '2026-07-12T14:01:00.000Z',
      metadata: { source: 'jarvis', sessionId },
    };
    const ctx = {
      pool,
      orchestrator: { processMessage: vi.fn() },
      taskStore: sessionTasks.store,
      messageStore: {
        save: vi.fn(async (message: StoredMessage) => { messages.push(message); }),
        getByTask: vi.fn(async (id: string) => id === ticketId ? [{
          role: 'assistant',
          type: 'say',
          text: workerText,
          metadata: {
            source: 'manifest-worker-bot-node',
            manifestWorkerResult: true,
            providerIntent: {
              schemaVersion: 1, kind: 'walmart-catalog', operation: 'product-search',
              query: 'fish food', limit: 2,
            },
            providerRecords: [providerRecord],
          },
        }] : messages.filter((message) => message.taskId === id)),
      },
      ticketService: {
        openChatTicket: vi.fn(), createTicket: vi.fn(),
        listTickets: vi.fn().mockResolvedValue([completedTicket]), updateStatus: vi.fn(),
      },
    };

    const app = express();
    app.use(express.json());
    const deny: RequestHandler = (_req, res) => { res.status(401).json({ error: 'not_authenticated' }); };
    app.use('/api/jarvis', serviceSecretOr(deny), createJarvisRoutes(ctx as never, process.cwd()));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const base = `${origin}/api/jarvis`;
    const jpeg = await sharp({
      create: { width: 640, height: 480, channels: 3, background: { r: 236, g: 188, b: 56 } },
    }).jpeg().toBuffer();
    const realFetch = globalThis.fetch;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.startsWith('https://i5.walmartimages.com/')) {
        return new Response(jpeg, {
          status: 200,
          headers: { 'content-type': 'image/jpeg', 'content-length': String(jpeg.byteLength) },
        });
      }
      return realFetch(input, init);
    });

    try {
      const tasksResponse = await fetch(`${base}/tasks`, { headers: headers() });
      expect(tasksResponse.status).toBe(200);
      const completed = await waitFor(() => {
        const task = pool.tasks.get(taskId);
        return task?.status === 'done' && task.visual ? task : undefined;
      }, 5_000);

      expect(completed.visual).toMatchObject({
        type: 'image', kind: 'gallery', mimeType: 'image/svg+xml',
      });
      expect(completed.result).toContain('| [TetraMin Tropical Flakes]');
      expect(completed.result).toContain(productUrl);
      expect(executeBot).not.toHaveBeenCalled();
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.objectContaining({ hostname: 'i5.walmartimages.com' }),
        expect.objectContaining({ redirect: 'manual', credentials: 'omit' }),
      );
      const artifact = pool.artifacts.get(String(completed.visual?.artifactId));
      expect(artifact?.provenance).toMatchObject({
        visualKind: 'gallery',
        imageReceipts: [expect.objectContaining({
          sourceRef: itemRef, mimeType: 'image/png', sourceBytes: jpeg.byteLength,
        })],
      });
      const svg = artifact?.content.toString('utf8') || '';
      expect(svg).toContain('TetraMin Tropical Flakes');
      expect(svg).toContain('$7.97');
      expect(svg).toContain('href="data:image/png;base64,');
      expect(svg).not.toContain(imageUrl);
      expect(svg).not.toContain(productUrl);
      expect(messages.at(-1)?.metadata?.visual).toEqual(completed.visual);
    } finally {
      fetchSpy.mockRestore();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('repairs an existing completed Ben and Jerry task table with exact ticket provenance', async () => {
    const pool = new DelayedLifecyclePool();
    const sessionId = 'jarvis-52a6c208-a506-4641-bfe9-efad71dde8fc';
    const taskId = '78cfd4c9-7414-4f67-b0e5-86c8dc21610f';
    const ticketId = '08ad8960-2920-4761-9cf4-6d126b1119b7';
    const title = "Order Ben & Jerry's ice cream + fish food";
    const result = [
      'The order task finished with a partial handoff:',
      '',
      '| Item | Status | Note |',
      '|---|---|---|',
      '| Ben & Jerry’s ice cream | Ready for you in Uber Eats | Store/item selection needs to be confirmed in your Uber Eats account. |',
      '| Fish food | Not added | Walmart wasn’t connected and returned demo data, so nothing unrelated was added to cart. |',
      '',
      'Uber Eats link: [Ben & Jerry’s ice cream search](https://www.ubereats.com/search?q=Ben+%26+Jerry%27s+ice+cream&utm_source=oshal)',
      '',
      `Full notes are here: [order-options.md](/app/workspace-shared/${ticketId}/deliverables/order-options.md)`,
    ].join('\n');
    pool.tasks.set(taskId, {
      id: taskId, user_sub: OWNER, session_id: sessionId, title, status: 'done', result,
      error: null, kind: 'complex', ticket_id: ticketId, visual: null, delivered: true,
      created_at: '2026-07-11T01:00:00.000Z', finished_at: '2026-07-11T01:05:00.000Z',
      summarize_started_at: '2026-07-11T01:04:00.000Z',
    });
    const sessionTasks = createOwnerAwareTaskStore([{ taskId: sessionId, ownerSub: OWNER }]);
    const messages: StoredMessage[] = [{
      taskId: sessionId, role: 'assistant', type: 'say', text: result,
      metadata: { sourceJarvisTaskId: taskId, sourceTicketId: ticketId },
    }];
    const completedTicket = {
      ticketId, title, ticketType: 'task', status: 'complete',
      createdAt: '2026-07-11T01:00:00.000Z', updatedAt: '2026-07-11T01:05:00.000Z',
      metadata: { source: 'jarvis', sessionId },
    };
    const ctx = {
      pool,
      orchestrator: { processMessage: vi.fn() },
      taskStore: sessionTasks.store,
      messageStore: {
        save: vi.fn(async (message: StoredMessage) => { messages.push(message); }),
        getByTask: vi.fn(async (id: string) => messages.filter((message) => message.taskId === id)),
      },
      ticketService: {
        openChatTicket: vi.fn(), createTicket: vi.fn(),
        listTickets: vi.fn().mockResolvedValue([completedTicket]), updateStatus: vi.fn(),
      },
    };

    const app = express();
    app.use(express.json());
    const deny: RequestHandler = (_req, res) => { res.status(401).json({ error: 'not_authenticated' }); };
    app.use('/api/jarvis', serviceSecretOr(deny), createJarvisRoutes(ctx as never, process.cwd()));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const base = `${origin}/api/jarvis`;

    try {
      const tasksResponse = await fetch(`${base}/tasks`, { headers: headers() });
      expect(tasksResponse.status).toBe(200);
      const taskPayload = await tasksResponse.json() as { tasks: Array<Record<string, any>> };
      expect(taskPayload.tasks[0]).toMatchObject({
        id: taskId, ticketId, status: 'done', result,
        visual: { type: 'image', kind: 'table', mimeType: 'image/svg+xml' },
      });
      expect(pool.tasks.get(taskId)?.visual).toEqual(taskPayload.tasks[0].visual);
      expect(pool.artifacts.size).toBe(1);

      const artifact = pool.artifacts.get(taskPayload.tasks[0].visual.artifactId);
      expect(artifact).toMatchObject({
        user_sub: OWNER,
        source_surface: 'jarvis-task',
        mime_type: 'image/svg+xml',
      });
      expect(artifact?.source_job_id).toMatch(new RegExp(`^${taskId}:[0-9a-f]{16}$`));
      expect(artifact?.provenance).toMatchObject({
        factLocked: true,
        sourceSessionId: sessionId,
        sources: expect.arrayContaining([
          { type: 'artifact', id: `ticket:${ticketId}`, label: 'Completed ticket result' },
          { type: 'artifact', id: `jarvis-task:${taskId}`, label: 'Jarvis work item' },
        ]),
      });

      const svgResponse = await fetch(`${origin}${taskPayload.tasks[0].visual.url}`, { headers: headers() });
      expect(svgResponse.status).toBe(200);
      const svg = await svgResponse.text();
      expect(svg).toContain('Order Ben &amp; Jerry');
      expect(svg).toContain('Ready for you in Uber Eats');
      expect(svg).toContain('Fish food');
      expect(svg).toContain('Completed ticket result');

      const historyResponse = await fetch(`${base}/history?sessionId=${sessionId}`, { headers: headers() });
      const history = await historyResponse.json() as { turns: Array<Record<string, any>> };
      expect(history.turns).toEqual([{
        role: 'jarvis', text: result, sourceJarvisTaskId: taskId, sourceTicketId: ticketId,
        visual: taskPayload.tasks[0].visual,
      }]);

      // A second poll reuses the repaired row and never mints a second artifact.
      const secondTasks = await fetch(`${base}/tasks`, { headers: headers() });
      expect((await secondTasks.json() as { tasks: Array<Record<string, any>> }).tasks[0].visual)
        .toEqual(taskPayload.tasks[0].visual);
      expect(pool.artifacts.size).toBe(1);
      expect(executeBot).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('suppresses every schema-valid direct visual kind at the real ask/history route boundary', async () => {
    const pool = new DelayedLifecyclePool();
    const messages: StoredMessage[] = [];
    const sessionTasks = createOwnerAwareTaskStore();
    const byKind = new Map(DIRECT_VISUAL_SPECS.map((spec) => [spec.kind, spec]));

    executeBot.mockImplementation(async (_ctx: unknown, _client: unknown, _agentId: string, input: { text: string }) => {
      const kind = [...byKind.keys()].find((candidate) => input.text.includes(`direct-${candidate}`));
      if (!kind) throw new Error(`No direct visual fixture matched prompt: ${input.text.slice(-100)}`);
      const spec = byKind.get(kind)!;
      const providerRecord = kind === 'weather' ? {
        schemaVersion: 1, kind: 'nws-weather', provider: 'nws', sourceRef: 'nws:forecast:direct',
        retrievedAt: '2026-07-10T15:00:00.000Z',
        record: {
          location: 'Chicago, IL', timestamp: '2026-07-10T15:00:00.000Z',
          current: { tempF: 72, tempC: 22, condition: 'Clear' }, periods: [],
        },
      } : kind === 'priority-email' ? {
        schemaVersion: 1, kind: 'gmail-summary', provider: 'gmail', sourceRef: 'gmail:summary:direct',
        retrievedAt: '2026-07-10T15:00:00.000Z', mailbox: 'test@example.com',
        messages: [{
          sourceRef: 'gmail:message:direct', id: 'direct', sender: 'Ada <ada@example.com>',
          subject: 'Decision needed', unread: true, important: true, starred: false,
        }],
      } : null;
      return { response: [
        `Direct ${kind} answer.`,
        '```oshal:visual', JSON.stringify(spec), '```',
        ...(providerRecord ? ['```oshal:provider-record', JSON.stringify(providerRecord), '```'] : []),
      ].join('\n') };
    });

    const ctx = {
      pool,
      orchestrator: { processMessage: vi.fn() },
      taskStore: sessionTasks.store,
      messageStore: {
        save: vi.fn(async (message: StoredMessage) => { messages.push(message); }),
        getByTask: vi.fn(async (taskId: string) => messages.filter((message) => message.taskId === taskId)),
      },
      ticketService: {
        openChatTicket: vi.fn().mockResolvedValue({ ticketId: 'ticket-direct-chat' }),
        createTicket: vi.fn(), listTickets: vi.fn().mockResolvedValue([]), updateStatus: vi.fn(),
      },
    };

    const app = express();
    app.use(express.json());
    const deny: RequestHandler = (_req, res) => { res.status(401).json({ error: 'not_authenticated' }); };
    app.use('/api/jarvis', serviceSecretOr(deny), createJarvisRoutes(ctx as never, process.cwd()));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/jarvis`;

    try {
      for (const spec of DIRECT_VISUAL_SPECS) {
        const sessionId = `jarvis-direct-${spec.kind}`;
        const response = await fetch(`${base}/ask`, {
          method: 'POST', headers: { ...headers(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: `direct-${spec.kind}`, sessionId }),
        });
        expect(response.status).toBe(202);
        const { jobId } = await response.json() as { jobId: string };
        const result = await waitFor(async () => {
          const poll = await fetch(`${base}/ask/result?jobId=${jobId}`, { headers: headers() });
          const body = await poll.json() as Record<string, unknown>;
          return body.status === 'done' ? body : undefined;
        });

        expect(result).toMatchObject({ status: 'done', answer: `Direct ${spec.kind} answer.` });
        expect(result).not.toHaveProperty('visual');
        expect(String(result.answer)).not.toContain('oshal:visual');
        expect(String(result.answer)).not.toContain('provider-record');

        const historyResponse = await fetch(`${base}/history?sessionId=${sessionId}`, { headers: headers() });
        const history = await historyResponse.json() as { turns: Array<Record<string, unknown>> };
        expect(history.turns.at(-1)).toEqual({ role: 'jarvis', text: `Direct ${spec.kind} answer.` });
      }

      expect(pool.artifacts.size).toBe(0);
      const assistantTurns = messages.filter((message) => message.role === 'assistant');
      expect(assistantTurns).toHaveLength(DIRECT_VISUAL_SPECS.length);
      expect(assistantTurns.every((message) => !message.metadata || !('visual' in message.metadata))).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('materializes an explicitly requested timeline once and replays its owner-scoped artifact from history', async () => {
    const pool = new DelayedLifecyclePool();
    const messages: StoredMessage[] = [];
    const sessionTasks = createOwnerAwareTaskStore();
    const sessionId = 'jarvis-explicit-timeline';
    const timeline = {
      kind: 'timeline',
      title: 'Launch timeline',
      asOf: '10 Jul 2026',
      caption: 'Two confirmed milestones.',
      sourceRefs: [],
      items: [
        { label: '08 Jul', title: 'Design approved', detail: 'The final design was approved.' },
        { label: '10 Jul', title: 'Pilot launched', detail: 'The pilot launched for ten users.' },
      ],
    } as const;
    const answer = [
      'Launch timeline. As of 10 Jul 2026. Two confirmed milestones.',
      '08 Jul. Design approved. The final design was approved.',
      '10 Jul. Pilot launched. The pilot launched for ten users.',
    ].join(' ');

    executeBot.mockImplementation(async (_ctx: unknown, _client: unknown, _agentId: string, input: { text: string }) => {
      if (!input.text.includes('explicit-launch-sequence')) {
        throw new Error(`No explicit timeline fixture matched prompt: ${input.text.slice(-100)}`);
      }
      return { response: [answer, '```oshal:visual', JSON.stringify(timeline), '```'].join('\n') };
    });

    const ctx = {
      pool,
      orchestrator: { processMessage: vi.fn() },
      taskStore: sessionTasks.store,
      messageStore: {
        save: vi.fn(async (message: StoredMessage) => { messages.push(message); }),
        getByTask: vi.fn(async (taskId: string) => messages.filter((message) => message.taskId === taskId)),
      },
      ticketService: {
        openChatTicket: vi.fn().mockResolvedValue({ ticketId: 'ticket-explicit-timeline' }),
        createTicket: vi.fn(), listTickets: vi.fn().mockResolvedValue([]), updateStatus: vi.fn(),
      },
    };

    const app = express();
    app.use(express.json());
    const deny: RequestHandler = (_req, res) => { res.status(401).json({ error: 'not_authenticated' }); };
    app.use('/api/jarvis', serviceSecretOr(deny), createJarvisRoutes(ctx as never, process.cwd()));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const base = `${origin}/api/jarvis`;

    try {
      const askResponse = await fetch(`${base}/ask`, {
        method: 'POST', headers: { ...headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Show this as a timeline: explicit-launch-sequence', sessionId }),
      });
      expect(askResponse.status).toBe(202);
      const { jobId } = await askResponse.json() as { jobId: string };

      const result = await waitFor(async () => {
        const poll = await fetch(`${base}/ask/result?jobId=${jobId}`, { headers: headers() });
        const body = await poll.json() as Record<string, any>;
        return body.status === 'done' ? body : undefined;
      });
      expect(result).toMatchObject({
        status: 'done',
        answer,
        visual: { type: 'image', kind: 'timeline', mimeType: 'image/svg+xml' },
      });
      expect(result.visual.url).toBe(`/api/jarvis/visuals/${result.visual.artifactId}`);
      expect(pool.artifacts.size).toBe(1);

      const artifact = pool.artifacts.get(result.visual.artifactId);
      expect(artifact).toMatchObject({
        artifact_id: result.visual.artifactId,
        user_sub: OWNER,
        source_surface: 'jarvis-direct',
        source_job_id: jobId,
        mime_type: 'image/svg+xml',
      });

      const historyResponse = await fetch(`${base}/history?sessionId=${sessionId}`, { headers: headers() });
      const history = await historyResponse.json() as { turns: Array<Record<string, any>> };
      expect(history.turns).toEqual([
        { role: 'user', text: 'Show this as a timeline: explicit-launch-sequence' },
        { role: 'jarvis', text: answer, visual: result.visual },
      ]);
      expect(messages.at(-1)?.metadata).toEqual({ visual: result.visual });

      const visualUrl = `${origin}${result.visual.url}`;
      const anonymousVisualResponse = await fetch(visualUrl);
      expect(anonymousVisualResponse.status).toBe(401);
      const otherOwnerVisualResponse = await fetch(visualUrl, { headers: headersFor('auth0|different-owner') });
      expect(otherOwnerVisualResponse.status).toBe(404);

      const visualResponse = await fetch(visualUrl, { headers: headers() });
      expect(visualResponse.status).toBe(200);
      expect(visualResponse.headers.get('cache-control')).toBe('private, no-store');
      expect(visualResponse.headers.get('cross-origin-resource-policy')).toBe('same-origin');
      const svg = await visualResponse.text();
      expect(svg).toContain('Launch timeline');
      expect(svg).toContain('Design approved');
      expect(svg).toContain('Pilot launched');
      expect(svg).toContain('Authoritative Jarvis answer');

      const reloadedResponse = await fetch(`${base}/history?sessionId=${sessionId}`, { headers: headers() });
      expect(await reloadedResponse.json()).toEqual(history);
      expect(pool.artifacts.size).toBe(1);
      expect(executeBot).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('does not disclose or append a guessed session across owners, while preserving owned and new sessions', async () => {
    const foreignOwner = 'auth0|foreign-owner';
    const intruder = 'auth0|intruder';
    const foreignSession = 'jarvis-foreign-session';
    const newSession = 'jarvis-intruder-new-session';
    const pool = new DelayedLifecyclePool();
    const sessionTasks = createOwnerAwareTaskStore([{ taskId: foreignSession, ownerSub: foreignOwner }]);
    const privateVisual = {
      artifactId: '11111111-1111-4111-8111-111111111111',
      type: 'image', kind: 'priority-email', mimeType: 'image/svg+xml',
      url: '/api/jarvis/visuals/11111111-1111-4111-8111-111111111111',
      alt: 'Private mailbox priority email result', width: 1280, height: 720,
    };
    const messages: StoredMessage[] = [{
      taskId: foreignSession, role: 'assistant', type: 'say', text: 'Private mailbox result.',
      metadata: { visual: privateVisual },
    }];
    const save = vi.fn(async (message: StoredMessage) => { messages.push(message); });
    const getByTask = vi.fn(async (taskId: string) => messages.filter((message) => message.taskId === taskId));
    executeBot.mockResolvedValue({ response: 'Safe owner-scoped response.' });

    const ctx = {
      pool,
      orchestrator: { processMessage: vi.fn() },
      taskStore: sessionTasks.store,
      messageStore: { save, getByTask },
      ticketService: {
        openChatTicket: vi.fn().mockResolvedValue({ ticketId: 'ticket-owner-isolation' }),
        createTicket: vi.fn(), listTickets: vi.fn().mockResolvedValue([]), updateStatus: vi.fn(),
      },
    };

    const app = express();
    app.use(express.json());
    const deny: RequestHandler = (_req, res) => { res.status(401).json({ error: 'not_authenticated' }); };
    app.use('/api/jarvis', serviceSecretOr(deny), createJarvisRoutes(ctx as never, process.cwd()));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/jarvis`;

    try {
      const ownerHistoryResponse = await fetch(`${base}/history?sessionId=${foreignSession}`, {
        headers: headersFor(foreignOwner),
      });
      expect(await ownerHistoryResponse.json()).toEqual({
        turns: [{ role: 'jarvis', text: 'Private mailbox result.', visual: privateVisual }],
      });
      const readsAfterOwner = getByTask.mock.calls.length;

      const guessedHistoryResponse = await fetch(`${base}/history?sessionId=${foreignSession}`, {
        headers: headersFor(intruder),
      });
      const guessedHistory = await guessedHistoryResponse.json();
      expect(guessedHistory).toEqual({ turns: [] });
      expect(getByTask).toHaveBeenCalledTimes(readsAfterOwner);
      expect(JSON.stringify(guessedHistory)).not.toContain('Private');
      expect(JSON.stringify(guessedHistory)).not.toContain(privateVisual.artifactId);

      const savesBeforeGuessedAppend = save.mock.calls.length;
      const guessedAppendResponse = await fetch(`${base}/ask`, {
        method: 'POST', headers: { ...headersFor(intruder), 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Append this to the guessed thread.', sessionId: foreignSession }),
      });
      expect(guessedAppendResponse.status).toBe(404);
      expect(await guessedAppendResponse.json()).toEqual({ error: 'session_not_found' });
      expect(save).toHaveBeenCalledTimes(savesBeforeGuessedAppend);
      expect(executeBot).not.toHaveBeenCalled();

      const newSessionResponse = await fetch(`${base}/ask`, {
        method: 'POST', headers: { ...headersFor(intruder), 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Start my own thread.', sessionId: newSession }),
      });
      expect(newSessionResponse.status).toBe(202);
      const { jobId } = await newSessionResponse.json() as { jobId: string };
      await waitFor(async () => {
        const result = await fetch(`${base}/ask/result?jobId=${jobId}`, { headers: headersFor(intruder) });
        const body = await result.json() as { status?: string };
        return body.status === 'done' ? body : undefined;
      });
      expect(sessionTasks.tasks.get(newSession)?.ownerSub).toBe(intruder);
      expect(messages.filter((message) => message.taskId === newSession).map((message) => message.text)).toEqual([
        'Start my own thread.', 'Safe owner-scoped response.',
      ]);

      const ownedAppendResponse = await fetch(`${base}/ask`, {
        method: 'POST', headers: { ...headersFor(foreignOwner), 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Continue my private thread.', sessionId: foreignSession }),
      });
      expect(ownedAppendResponse.status).toBe(202);
      const ownedAsk = await ownedAppendResponse.json() as { jobId: string };
      await waitFor(async () => {
        const result = await fetch(`${base}/ask/result?jobId=${ownedAsk.jobId}`, { headers: headersFor(foreignOwner) });
        const body = await result.json() as { status?: string };
        return body.status === 'done' ? body : undefined;
      });
      expect(messages.filter((message) => message.taskId === foreignSession).map((message) => message.text)).toContain(
        'Continue my private thread.',
      );

      const foreignCloseResponse = await fetch(`${base}/thread/close`, {
        method: 'POST', headers: { ...headersFor(intruder), 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: foreignSession }),
      });
      expect(await foreignCloseResponse.json()).toEqual({ ok: true, closed: false });
      expect(ctx.ticketService.updateStatus).not.toHaveBeenCalled();

      const ownerCloseResponse = await fetch(`${base}/thread/close`, {
        method: 'POST', headers: { ...headersFor(foreignOwner), 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: foreignSession }),
      });
      expect(await ownerCloseResponse.json()).toEqual({ ok: true, closed: true });
      expect(ctx.ticketService.updateStatus).toHaveBeenCalledWith('ticket-owner-isolation', 'complete');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
