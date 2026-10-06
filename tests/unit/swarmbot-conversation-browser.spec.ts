/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove explicit unavailable-thread recovery in an owned browser through actual recovery modules and recording loopback task/history transports.
 */
import express, { type Express } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { BROWSER_HOOK_TIMEOUT_MS, launchIsolatedBrowser } from '../fixtures/isolated-browser';
import { OWNER_PRINCIPAL_ISSUER_METADATA_KEY } from '@/shared/security/owner-principal-issuer';

const agentId = '8fe6d593-66a9-45d8-9bb4-cf162ba86ed8';
const owner = { sub: 'conversation-fixture-user', issuer: 'https://conversation.fixture.test' };
const draft = 'Keep this unsent circuit draft';
const oldHistory = 'PRIVATE OLD HISTORY RETAINED';
type FixtureTask = { taskId: string; agentId: string; ownerSub: string; metadata: Record<string, unknown> };
const world = { guest: false, failCreate: false, failFreshHistory: false, sequence: 0,
  requests: [] as Array<{ method: string; path: string; body: Record<string, unknown> }>,
  tasks: new Map<string, FixtureTask>(), history: new Map<string, string[]>() };
let server: Server, base: string;
let owned: Awaited<ReturnType<typeof launchIsolatedBrowser>>;
let context: BrowserContext, page: Page;
let errors: string[];

const adapter = String.raw`
import { bootstrapConversation, showConversationFailure, requestJson } from '/swarmbot/chat/swarmbot-conversation.js';
const query = new URLSearchParams(location.search);
const input = document.getElementById('messageInput');
input.value = query.get('draft') || '';
const app = {
  state: { agentId: query.get('agentId') || '', taskId: query.get('taskId') || '', guestMode: undefined,
    scope: { app: 'circuit-lab', tenantId: 'fixture-tenant' }, connected: false, typing: false },
  elements: { messageInput: input, sendBtn: document.getElementById('sendBtn'), statusBanner: document.getElementById('statusBanner') },
  setStatus(text, level) { this.elements.statusBanner.textContent = text; this.elements.statusBanner.dataset.level = level; },
  setTyping(value) { this.state.typing = value; },
  disconnectStream() { this.stream?.close(); this.stream = null; this.state.connected = false; },
  async resolveGuestMode() { const payload = await requestJson('/api/auth/user'); this.state.guestMode = payload.guestMode; return payload.guestMode; },
  async loadProfile() { await requestJson('/api/agents/' + encodeURIComponent(this.state.agentId) + '/profile'); },
  async ensureTask() {
    if (this.state.taskId) return;
    const task = await requestJson('/api/tasks', { method: 'POST', body: JSON.stringify({ title: '', processingMode: 'agentic',
      agentId: this.state.agentId, metadata: { source: 'swarmbot-chat' } }) });
    this.state.taskId = task.taskId;
  },
  async loadMessages() {
    const payload = await requestJson('/api/' + encodeURIComponent(this.state.taskId) + '/messages');
    document.getElementById('history').textContent = JSON.stringify(payload.messages);
  },
  connectStream() {
    this.disconnectStream(); this.stream = new EventSource('/api/stream/' + encodeURIComponent(this.state.taskId));
    this.stream.addEventListener('streaming-event', () => { this.state.connected = true; });
  },
  openInitialWorkspaceAction() {},
  renderGuestReadOnlyState() { input.disabled = true; this.setStatus('Guest session: this workspace is read-only.', 'info'); },
  renderAwaitingAgentSelectionState() { input.disabled = true; },
};
window.fixtureSnapshot = () => ({ ...app.state, draft: input.value, activeInput: document.activeElement === input });
window.fixtureFailure = () => showConversationFailure(app, new Error('Actual failed send boundary'));
document.getElementById('sendBtn').addEventListener('click', async () => {
  if (app.state.guestMode) return;
  try { await requestJson('/api/send-message', { method: 'POST', body: JSON.stringify({ taskId: app.state.taskId,
    agentId: app.state.agentId, text: 'A transport failure', source: 'swarmbot-chat' }) }); }
  catch (error) { showConversationFailure(app, error); }
});
await bootstrapConversation(app);
document.documentElement.dataset.bootstrapComplete = 'true';
`;

function configureRoutes(app: Express): void {
  app.use(express.json());
  app.use((req, _res, next) => { world.requests.push({ method: req.method, path: req.path,
    body: (req.body ?? {}) as Record<string, unknown> }); next(); });
  app.get('/fixture', (_req, res) => res.type('html').send('<!doctype html><html><body>'
    + '<div id="statusBanner">Booting...</div><textarea id="messageInput" disabled></textarea>'
    + '<div id="history"></div><button id="sendBtn" type="button" disabled>Send</button>'
    + '<script type="module" src="/fixture.js"></script></body></html>'));
  app.get('/fixture.js', (_req, res) => res.type('js').send(adapter));
  app.get('/swarmbot/chat/swarmbot-conversation.js', (_req, res) => res.sendFile(resolve('src/pages/swarmbot-chat/swarmbot-conversation.js')));
  app.get('/swarmbot/shared/ui-debug.js', (_req, res) => res.sendFile(resolve('src/pages/shared/ui-debug.js')));
  app.get('/api/auth/user', (_req, res) => res.json({ guestMode: world.guest }));
  app.get('/api/agents/:agentId/profile', (req, res) => res.json({ profile: { agentId: req.params.agentId } }));
  app.post('/api/tasks', (req, res) => {
    if (world.guest) { res.status(403).json({ error: 'guest_read_only' }); return; }
    if (world.failCreate) { res.status(503).json({ error: 'Task service unavailable' }); return; }
    const taskId = `fresh-${++world.sequence}`;
    const task: FixtureTask = { taskId, agentId: String(req.body.agentId), ownerSub: owner.sub,
      metadata: { ...req.body.metadata, [OWNER_PRINCIPAL_ISSUER_METADATA_KEY]: owner.issuer } };
    world.tasks.set(taskId, task); world.history.set(taskId, []); res.status(201).json(task);
  });
  app.get('/api/:taskId/messages', (req, res) => {
    if (req.params.taskId === 'old-untracked' || world.failFreshHistory) { res.status(404).json({ error: 'not found' }); return; }
    if (!world.tasks.has(req.params.taskId)) { res.status(404).json({ error: 'not found' }); return; }
    res.json({ messages: world.history.get(req.params.taskId) ?? [] });
  });
  app.post('/api/send-message', (_req, res) => res.status(404).json({ error: 'This thread is unavailable' }));
  app.get('/api/stream/:taskId', (req, res) => {
    if (!world.tasks.has(req.params.taskId)) { res.sendStatus(404); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write('event: streaming-event\ndata: {"type":"connection"}\n\n');
  });
}

beforeAll(async () => {
  const app = express(); configureRoutes(app);
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(done => server.once('listening', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  owned = await launchIsolatedBrowser();
}, BROWSER_HOOK_TIMEOUT_MS);
afterAll(async () => {
  try { await owned?.close(); }
  finally { if (server) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); } }
}, BROWSER_HOOK_TIMEOUT_MS);
beforeEach(async () => {
  world.guest = false; world.failCreate = false; world.failFreshHistory = false; world.sequence = 0;
  world.requests = []; world.tasks.clear(); world.history.clear();
  world.tasks.set('old-untracked', { taskId: 'old-untracked', agentId, ownerSub: owner.sub, metadata: {} });
  world.history.set('old-untracked', [oldHistory]); errors = [];
  context = await owned.browser.newContext();
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
});
afterEach(async () => { await context?.close(); expect(errors).toEqual([]); });

async function open(taskId = 'old-untracked', selectedAgent = agentId) {
  const query = new URLSearchParams({ taskId, agentId: selectedAgent, draft });
  expect((await page.goto(`${base}/fixture?${query}`))?.status()).toBe(200);
  await page.waitForFunction(() => document.documentElement.dataset.bootstrapComplete === 'true');
}

function createdTasks() { return world.requests.filter(request => request.method === 'POST' && request.path === '/api/tasks'); }

async function snapshot() {
  return page.evaluate(() => (window as unknown as { fixtureSnapshot: () => {
    agentId: string; taskId: string; guestMode: boolean; connected: boolean; draft: string; activeInput: boolean;
    scope: { app: string; tenantId: string };
  } }).fixtureSnapshot());
}

async function clickRecovery() {
  await page.getByRole('button', { name: 'Start new conversation', exact: true }).click();
}

it('renders actionable old404 recovery and creates a fresh owned thread only after an explicit click', async () => {
  await open();
  expect(await page.locator('#statusBanner').innerText()).toContain('This conversation is unavailable');
  expect(await page.locator('#messageInput').isDisabled()).toBe(true); expect(createdTasks()).toHaveLength(0);
  expect(await page.locator('#sendBtn').isDisabled()).toBe(true);
  await page.locator('#sendBtn').evaluate(button => (button as HTMLButtonElement).click());
  expect(world.requests.some(request => request.path === '/api/send-message')).toBe(false); expect(createdTasks()).toHaveLength(0);
  const oldTask = structuredClone(world.tasks.get('old-untracked'));
  await clickRecovery();
  await page.waitForFunction(() => !(document.getElementById('messageInput') as HTMLTextAreaElement).disabled);
  await page.waitForFunction(() => (window as unknown as { fixtureSnapshot: () => { connected: boolean } }).fixtureSnapshot().connected);
  expect(await snapshot()).toMatchObject({ agentId, taskId: 'fresh-1', draft, activeInput: true,
    scope: { app: 'circuit-lab', tenantId: 'fixture-tenant' } });
  expect(await page.locator('#sendBtn').isDisabled()).toBe(false);
  expect(createdTasks()).toHaveLength(1);
  expect(createdTasks()[0].body).toEqual({ title: '', processingMode: 'agentic', agentId, metadata: { source: 'swarmbot-chat' } });
  expect(world.tasks.get('fresh-1')).toMatchObject({ ownerSub: owner.sub, metadata: { [OWNER_PRINCIPAL_ISSUER_METADATA_KEY]: owner.issuer } });
  expect(world.requests.some(request => request.path === '/api/fresh-1/messages')).toBe(true);
  expect(world.tasks.get('old-untracked')).toEqual(oldTask); expect(world.history.get('old-untracked')).toEqual([oldHistory]);
  expect(world.requests.some(request => request.method === 'DELETE')).toBe(false);
  expect(await page.locator('#statusBanner').innerText()).toBe('New conversation ready.');
});

it('keeps failed fresh creation actionable and retries only when the user explicitly clicks again', async () => {
  await open(); world.failCreate = true; await clickRecovery();
  await page.waitForFunction(() => !!document.querySelector('[data-action="new-conversation"]:not(:disabled)'));
  expect(createdTasks()).toHaveLength(1); expect((await snapshot()).draft).toBe(draft);
  expect(await page.locator('#messageInput').isDisabled()).toBe(true);
  expect(await page.locator('#sendBtn').isDisabled()).toBe(true);
  await page.locator('#sendBtn').evaluate(button => (button as HTMLButtonElement).click());
  expect(world.requests.some(request => request.path === '/api/send-message')).toBe(false); expect(createdTasks()).toHaveLength(1);
  expect(world.history.get('old-untracked')).toEqual([oldHistory]);
  world.failCreate = false; await clickRecovery();
  await page.waitForFunction(() => !(document.getElementById('messageInput') as HTMLTextAreaElement).disabled);
  expect(createdTasks()).toHaveLength(2); expect(world.tasks.size).toBe(2);
  expect((await snapshot()).taskId).toBe('fresh-1');
});

it('retains both old and newly unavailable history when a created thread read fails', async () => {
  await open(); world.failFreshHistory = true; await clickRecovery();
  await page.waitForFunction(() => !!document.querySelector('[data-action="new-conversation"]:not(:disabled)'));
  expect(createdTasks()).toHaveLength(1); expect(world.tasks.has('fresh-1')).toBe(true);
  expect((await snapshot()).draft).toBe(draft); world.failFreshHistory = false;
  await clickRecovery();
  await page.waitForFunction(() => !(document.getElementById('messageInput') as HTMLTextAreaElement).disabled);
  expect((await snapshot()).taskId).toBe('fresh-2');
  expect(world.tasks.has('fresh-1')).toBe(true); expect(world.history.get('old-untracked')).toEqual([oldHistory]);
  expect(world.requests.some(request => request.method === 'DELETE')).toBe(false);
});

it('shows the same explicit recovery on a real send transport refusal while preserving the current draft', async () => {
  await open('');
  await page.waitForFunction(() => !(document.getElementById('messageInput') as HTMLTextAreaElement).disabled);
  expect(createdTasks()).toHaveLength(1);
  expect(await page.locator('#sendBtn').isDisabled()).toBe(false);
  await page.locator('#sendBtn').click();
  await page.waitForFunction(() => !!document.querySelector('[data-action="new-conversation"]'));
  expect(world.requests.filter(request => request.path === '/api/send-message')).toHaveLength(1);
  expect((await snapshot()).draft).toBe(draft); expect(await page.locator('#messageInput').isDisabled()).toBe(true);
  expect(await page.locator('#sendBtn').isDisabled()).toBe(true);
  await page.locator('#sendBtn').evaluate(button => (button as HTMLButtonElement).click());
  expect(world.requests.filter(request => request.path === '/api/send-message')).toHaveLength(1);
  await clickRecovery();
  await page.waitForFunction(() => !(document.getElementById('messageInput') as HTMLTextAreaElement).disabled);
  expect((await snapshot()).taskId).toBe('fresh-2'); expect(world.tasks.has('fresh-1')).toBe(true);
  expect(await page.locator('#sendBtn').isDisabled()).toBe(false);
});

it('keeps guests read-only without minting tasks or offering thread recovery', async () => {
  world.guest = true; await open();
  expect(await page.locator('#statusBanner').innerText()).toContain('Guest session');
  expect(await page.locator('#messageInput').isDisabled()).toBe(true); expect(createdTasks()).toHaveLength(0);
  expect(await page.locator('#sendBtn').isDisabled()).toBe(true);
  expect(world.requests.some(request => request.path.endsWith('/messages'))).toBe(false);
  await page.evaluate(() => (window as unknown as { fixtureFailure: () => void }).fixtureFailure());
  expect(await page.locator('[data-action="new-conversation"]').count()).toBe(0);
  expect(createdTasks()).toHaveLength(0);
});

it('waits for an actual bot selection without bootstrapping or offering a recovery action', async () => {
  await open('old-untracked', '');
  expect(await page.locator('#statusBanner').innerText()).toContain('Choose a swarm bot');
  expect(await page.locator('[data-action="new-conversation"]').count()).toBe(0);
  expect(createdTasks()).toHaveLength(0); expect(world.requests.some(request => request.path.startsWith('/api/'))).toBe(false);
});
