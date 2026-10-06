/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-174 Amendment B guards (step B5-6), driven in headless Chromium against the real /swarm-admin/knowledge page served through the real surface registration, with the RAG, agents and directory APIs mocked in the real reply shapes: the posture strip and every document with its scope named (every bot, one bot by name, one person by directory label) and an untagged document marked as not removable one by one; the text, scope and collection filters; pasting text posts an ingest and a second click during the write posts nothing more; uploading posts the multipart upload and names the files not read and the files cut short, and a 422's reasons are shown; removing asks with the document's title (hedged for an untagged document), sends the DELETE, says whether its chunks went or stay, and a cancelled dialog posts nothing; deleting a collection asks for its name typed and a wrong or cancelled answer posts nothing; a health or collection read that fails is said to have failed; a failed reload clears every section and a filter touch brings nothing back; a 403 shows the operator-role banner. Each fails if its fix returns.
 */

import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express, { type Request, type RequestHandler } from 'express';
import multer from 'multer';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { requireAdminConsoleAccess } from '@/features/governance/rbac/policy';
import { registerUiSurfaceRoutes } from '@/app/routes/ui-surface-routes';
import { resolveUiSurfacePages, sendHtmlResponse } from '@/app/server-ui-assets';
import { clearPrivilegedIdentities, setPrivilegedIdentities } from '@/shared/middleware/privileged-identities';

const OPERATOR = { sub: 'idp-operator', email: 'operator@example.test', iss: 'https://login.example.test/tenant' };
const PERSON_SUB = 'idp-person-7b1';
const PERSON_LABEL = 'Pat Example (google; active)';
const SHARED_ID = '11111111-1111-4111-8111-111111111111';
const BOT_ID = '22222222-2222-4222-8222-222222222222';
const PRIVATE_ID = '33333333-3333-4333-8333-333333333333';
const LEGACY_ID = '44444444-4444-4444-8444-444444444444';

type Doc = { knowledgeId: string; title: string; collection: string; source: string; format: string | null; scope: string; agentId: string | null; ownerSub: string | null; chunkCount: number; documentCount: number; createdAt: string; legacy?: boolean };

const store = {
  docs: [] as Doc[],
  collections: [] as string[],
  health: 'connected' as 'connected' | 'unreachable' | 'down',
  collectionsDown: false,
  api: 'normal' as 'normal' | '403' | '500',
  ingestDelayMs: 0,
  uploadAnswer: 'ok' as 'ok' | '422',
  posted: [] as Array<{ path: string; body: Record<string, unknown> }>,
  deleted: [] as string[],
  reset() {
    this.docs = [
      { knowledgeId: SHARED_ID, title: 'Office hours', collection: 'default', source: 'ingest-api', format: 'text', scope: 'swarm', agentId: null, ownerSub: null, chunkCount: 4, documentCount: 1, createdAt: '2026-10-06T10:00:00.000Z' },
      { knowledgeId: BOT_ID, title: 'Trading rules', collection: 'agent-knowledge-trading-bot', source: 'rag-upload', format: 'file-upload', scope: 'bot', agentId: 'trading-bot', ownerSub: null, chunkCount: 9, documentCount: 1, createdAt: '2026-10-05T10:00:00.000Z' },
      { knowledgeId: PRIVATE_ID, title: 'My notes', collection: 'my-knowledge', source: 'ingest-api', format: 'markdown', scope: 'private', agentId: null, ownerSub: PERSON_SUB, chunkCount: 2, documentCount: 1, createdAt: '2026-10-04T10:00:00.000Z' },
      { knowledgeId: LEGACY_ID, title: 'Old handbook', collection: 'default', source: 'ingest-api', format: 'text', scope: 'swarm', agentId: null, ownerSub: null, chunkCount: 7, documentCount: 1, createdAt: '2026-09-01T10:00:00.000Z', legacy: true },
    ];
    this.collections = ['default', 'agent-knowledge-trading-bot', 'my-knowledge'];
    this.health = 'connected'; this.collectionsDown = false; this.api = 'normal'; this.ingestDelayMs = 0; this.uploadAnswer = 'ok'; this.posted = []; this.deleted = [];
  },
};

const requiresAuth: RequestHandler = (req, res, next) => {
  if ((req as Request & { oidc?: { isAuthenticated?: () => boolean } }).oidc?.isAuthenticated?.()) next(); else res.redirect(302, '/login');
};

function buildServer(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { Object.assign(req, { oidc: { isAuthenticated: () => true, user: OPERATOR } }); next(); });
  app.get('/login', (_q, r) => r.type('html').send('<html><body>Sign in</body></html>'));
  app.get('/api/rag/knowledge', (_q, r) => {
    if (store.api === '403') { r.status(403).json({ error: 'operator_required' }); return; }
    if (store.api === '500') { r.status(500).json({ error: 'RAG knowledge listing failed' }); return; }
    r.json({ documents: store.docs.map(({ legacy, ...doc }) => ({ ...doc, chunksTagged: !legacy })), count: store.docs.length, isOperator: true });
  });
  app.get('/api/rag/collections', (_q, r) => { if (store.collectionsDown) { r.status(500).json({ error: 'RAG collections listing failed' }); return; } r.json({ collections: store.collections }); });
  app.get('/api/rag/health', (_q, r) => { if (store.health === 'down') { r.status(500).json({ error: 'boom' }); return; } r.json({ chromadb: store.health }); });
  app.get('/api/agents', (_q, r) => r.json({ agents: [{ agentId: 'trading-bot', name: 'Trading Bot' }, { agent_id: 'general-bot', name: 'General Bot' }] }));
  app.get('/api/user-directory', (_q, r) => r.json({ users: [{ sub: PERSON_SUB, issuer: 'x', label: PERSON_LABEL, email: 'pat@example.test', source: 'verified-sign-in', signIn: 'active', lastSeenAt: null }] }));
  app.post('/api/rag/ingest', (q, r) => {
    const body = q.body as Record<string, unknown>;
    store.posted.push({ path: '/api/rag/ingest', body });
    const id = `55555555-5555-4555-8555-${String(store.posted.length).padStart(12, '0')}`;
    const reply = () => {
      store.docs.unshift({ knowledgeId: id, title: String(body.title || 'pasted'), collection: String(body.collection), source: 'ingest-api', format: String(body.format), scope: 'swarm', agentId: null, ownerSub: null, chunkCount: 5, documentCount: 1, createdAt: '2026-10-06T12:00:00.000Z' });
      r.json({ success: true, knowledgeId: id, collection: body.collection, documentCount: 1, chunkCount: 5 });
    };
    if (store.ingestDelayMs) setTimeout(reply, store.ingestDelayMs); else reply();
  });
  const upload = multer({ storage: multer.memoryStorage() });
  app.post('/api/rag/upload', upload.array('files', 20), (q, r) => {
    const files = (q.files as Express.Multer.File[]) ?? [];
    store.posted.push({ path: '/api/rag/upload', body: { collection: q.body.collection, names: files.map((f) => f.originalname) } });
    if (store.uploadAnswer === '422') { r.status(422).json({ error: 'No file could be read as text', rejected: files.map((f) => ({ name: f.originalname, format: 'unknown', reason: 'binary' })) }); return; }
    const accepted = files.filter((f) => !f.originalname.endsWith('.exe')).map((f) => ({ name: f.originalname, format: 'text', characters: f.size }));
    const rejected = files.filter((f) => f.originalname.endsWith('.exe')).map((f) => ({ name: f.originalname, format: 'unknown', reason: 'binary' }));
    const truncated = files.filter((f) => f.originalname.startsWith('huge')).map((f) => f.originalname);
    store.docs.unshift({ knowledgeId: '66666666-6666-4666-8666-666666666666', title: accepted.map((a) => a.name).join(', '), collection: String(q.body.collection), source: 'rag-upload', format: 'file-upload', scope: 'swarm', agentId: null, ownerSub: null, chunkCount: 3, documentCount: accepted.length, createdAt: '2026-10-06T12:30:00.000Z' });
    r.json({ success: true, knowledgeId: '66666666-6666-4666-8666-666666666666', count: accepted.length, chunks: 3, collection: q.body.collection, accepted, rejected, truncated });
  });
  app.delete('/api/rag/knowledge/:id', (q, r) => {
    store.deleted.push(`knowledge:${q.params.id}`);
    const at = store.docs.findIndex((d) => d.knowledgeId === q.params.id);
    if (at < 0) { r.status(404).json({ error: 'knowledge_not_found' }); return; }
    const [doc] = store.docs.splice(at, 1);
    r.json({ success: true, removed: true, knowledgeId: doc.knowledgeId, collection: doc.collection, scope: doc.scope, chunksTagged: !doc.legacy, chunksRemoved: doc.legacy ? null : doc.chunkCount, ...(doc.legacy ? { note: 'stored before ids' } : {}) });
  });
  app.delete('/api/rag/collections/:name', (q, r) => {
    store.deleted.push(`collection:${q.params.name}`);
    store.collections = store.collections.filter((c) => c !== q.params.name);
    r.json({ deleted: q.params.name });
  });
  const src = path.resolve(process.cwd(), 'src');
  app.use('/shared/ui/css', express.static(path.join(src, 'shared/ui/css')));
  app.use('/shared/ui/js', express.static(path.join(src, 'shared/ui/js')));
  app.use('/fonts', express.static(path.join(process.cwd(), 'node_modules/@vscode/codicons/dist')));
  registerUiSurfaceRoutes({ app, requiresAuth, serveHtml: sendHtmlResponse, pages: resolveUiSurfacePages([requireAdminConsoleAccess()]) });
  return app;
}

let browser: Browser;
let context: BrowserContext;
let server: Server;
let base = '';

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  server = buildServer().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000);
afterAll(async () => { await browser?.close(); await new Promise<void>((resolve) => server.close(() => resolve())); }, 30_000);
beforeEach(async () => {
  setPrivilegedIdentities([{ sub: OPERATOR.sub, email: OPERATOR.email, role: 'admin' }]);
  store.reset();
  context = await browser.newContext({ viewport: { width: 1200, height: 1500 } });
  await context.route('**/*', (route) => (new URL(route.request().url()).origin === base ? route.continue() : route.abort()));
}, 60_000);
afterEach(async () => { await context?.close(); clearPrivilegedIdentities(); }, 30_000);

/** Opens the page; dialogs are answered by `answer` (accept with its text for prompts, dismiss when null). */
async function open(answer: ((message: string) => string | null) | null = () => ''): Promise<Page> {
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  if (answer) page.on('dialog', (dialog) => { const a = answer(dialog.message()); void (a === null ? dialog.dismiss() : dialog.accept(a)); });
  await page.goto(`${base}/swarm-admin/knowledge`, { waitUntil: 'networkidle' });
  await expect.poll(() => page.locator('#docs tr[data-id]').count()).toBe(store.docs.length);
  return page;
}
const row = (page: Page, id: string) => page.locator(`#docs tr[data-id="${id}"]`);
const banner = (page: Page) => page.locator('#statusBanner').textContent();
const shown = async (page: Page) => page.locator('#docs tr[data-id]').evaluateAll((rows) => rows.map((r) => (r as HTMLElement).dataset.id));

describe('the shared-knowledge page in Chromium', () => {
  it('shows the posture and every document with its scope named, and marks an untagged document as not removable one by one', async () => {
    const page = await open();
    const posture = await page.locator('#posture').textContent();
    expect(posture).toContain('Vector store connected.');
    expect(posture).toContain('4document(s)');
    expect(posture).toContain('2in the shared corpus');
    expect(posture).toContain('3collection(s)');
    expect(await row(page, SHARED_ID).locator('td').nth(1).textContent()).toBe('Shared corpusevery bot');
    expect(await row(page, BOT_ID).locator('td').nth(1).textContent()).toBe('One botTrading Bot');
    expect(await row(page, PRIVATE_ID).locator('td').nth(1).textContent()).toBe(`Private${PERSON_LABEL}`);
    expect(await row(page, BOT_ID).locator('td').nth(3).textContent()).toBe('9');
    expect(await row(page, LEGACY_ID).locator('td').nth(3).textContent()).toBe('7stored before ids: not removable one by one');
    expect(await row(page, LEGACY_ID).locator('td').nth(3).getAttribute('data-untagged')).toBe('true');
    expect(await row(page, BOT_ID).locator('td').nth(4).textContent()).toBe('rag-upload · file-upload');
    expect(await page.locator('#collections li[data-collection]').count()).toBe(3);
    expect(await page.locator('#collections li[data-collection="default"] span').textContent()).toBe('default · 2 document record(s)');
    expect(await banner(page)).toBe('4 document(s), 2 in the shared corpus.');
  });

  it('filters by text, scope and collection', async () => {
    const page = await open();
    await page.fill('#search', 'trading');
    await expect.poll(() => shown(page)).toEqual([BOT_ID]);
    await page.fill('#search', '');
    await page.selectOption('#scopeFilter', 'swarm');
    await expect.poll(() => shown(page)).toEqual([SHARED_ID, LEGACY_ID]);
    await page.selectOption('#collectionFilter', 'my-knowledge');
    await expect.poll(() => page.locator('#docs td.empty').textContent()).toContain('No document matches');
    expect(await page.locator('#count').textContent()).toBe('0 of 4 document(s) shown.');
  });

  it('adds pasted text once even when clicked twice, and uploads files naming the ones not read and the ones cut short; a 422 shows its reasons', async () => {
    const page = await open();
    store.ingestDelayMs = 700;
    await page.fill('#pasteTitle', 'Parking');
    await page.fill('#pasteCollection', 'default');
    await page.selectOption('#pasteFormat', 'markdown');
    await page.fill('#pasteContent', '# Parking\nUse lot B.');
    await page.click('#pasteForm button[type="submit"]');
    await page.click('#pasteForm button[type="submit"]', { force: true });
    await expect.poll(() => banner(page)).toBe('Added to the shared corpus: 5 chunk(s) in "default".');
    expect(store.posted).toEqual([{ path: '/api/rag/ingest', body: { format: 'markdown', content: '# Parking\nUse lot B.', collection: 'default', title: 'Parking' } }]);
    expect(await page.locator('#docs tr[data-id]').count()).toBe(5);
    expect(await page.inputValue('#pasteContent')).toBe('');

    await page.fill('#uploadCollection', 'handbooks');
    await page.setInputFiles('#uploadFiles', [
      { name: 'rules.txt', mimeType: 'text/plain', buffer: Buffer.from('Rule one') },
      { name: 'huge-manual.txt', mimeType: 'text/plain', buffer: Buffer.from('x'.repeat(1000)) },
      { name: 'tool.exe', mimeType: 'application/octet-stream', buffer: Buffer.from([0, 1, 2]) },
    ]);
    await page.click('#uploadForm button[type="submit"]');
    await expect.poll(() => banner(page)).toBe('Uploaded 2 file(s) into "handbooks": 3 chunk(s). Cut short (too long to store whole): huge-manual.txt.');
    expect(await page.locator('#statusBanner').getAttribute('data-tone')).toBe('warning');
    expect(store.posted[1]).toEqual({ path: '/api/rag/upload', body: { collection: 'handbooks', names: ['rules.txt', 'huge-manual.txt', 'tool.exe'] } });
    expect(await page.locator('#uploadMessage').textContent()).toBe('Not read: tool.exe (binary). Cut short (too long to store whole): huge-manual.txt.');
    expect(await page.locator('#docs tr[data-id]').count()).toBe(6);

    store.uploadAnswer = '422';
    await page.setInputFiles('#uploadFiles', [{ name: 'photo.exe', mimeType: 'application/octet-stream', buffer: Buffer.from([0]) }]);
    await page.click('#uploadForm button[type="submit"]');
    await expect.poll(() => page.locator('#uploadMessage').textContent()).toBe('No file could be read as text Not read: photo.exe (binary).');
  });

  it('removes a document after asking with its title and says whether its chunks went or stay; a cancelled dialog posts nothing', async () => {
    const dialogs: string[] = [];
    let answer: string | null = '';
    const page = await open((message) => { dialogs.push(message); return answer; });
    answer = null;
    await row(page, BOT_ID).getByRole('button', { name: 'Remove' }).click();
    await expect.poll(() => dialogs.length).toBe(1);
    expect(dialogs[0]).toContain('Remove "Trading rules" from the bot Trading Bot?');
    await expect.poll(() => row(page, BOT_ID).getByRole('button', { name: 'Remove' }).isEnabled()).toBe(true);
    expect(store.deleted).toEqual([]);
    expect(await page.locator('#docs tr[data-id]').count()).toBe(4);

    answer = '';
    await row(page, BOT_ID).getByRole('button', { name: 'Remove' }).click();
    await expect.poll(() => banner(page)).toBe('"Trading rules" removed: 9 chunk(s) removed.');
    expect(await page.locator('#statusBanner').getAttribute('data-tone')).toBe('success');
    expect(store.deleted).toEqual([`knowledge:${BOT_ID}`]);
    expect(await page.locator('#docs tr[data-id]').count()).toBe(3);

    await row(page, LEGACY_ID).getByRole('button', { name: 'Remove' }).click();
    await expect.poll(() => banner(page)).toBe('"Old handbook" removed: its record removed; its chunks stay in "default" until that collection is deleted.');
    expect(dialogs.at(-1)).toContain('its chunks STAY in "default"');
    expect(await page.locator('#statusBanner').getAttribute('data-tone')).toBe('warning');
  });

  it('deletes a collection only after its name is typed; a wrong or cancelled answer posts nothing', async () => {
    const dialogs: string[] = [];
    let answer: string | null = null;
    const page = await open((message) => { dialogs.push(message); return answer; });
    const del = page.locator('#collections li[data-collection="my-knowledge"]').getByRole('button', { name: 'Delete the collection' });
    await del.click();
    await expect.poll(() => dialogs.length).toBe(1);
    expect(dialogs[0]).toContain('Type the collection\'s name to confirm');
    await expect.poll(() => del.isEnabled()).toBe(true);
    expect(store.deleted).toEqual([]);
    answer = 'wrong-name';
    await del.click();
    await expect.poll(() => banner(page)).toBe('Not deleted: the name typed did not match "my-knowledge".');
    expect(store.deleted).toEqual([]);
    answer = 'my-knowledge';
    await del.click();
    await expect.poll(() => banner(page)).toBe('Collection "my-knowledge" deleted: its chunks are gone; 1 document record(s) still list it and can be removed one by one.');
    expect(store.deleted).toEqual(['collection:my-knowledge']);
    expect(await page.locator('#collections li[data-collection]').count()).toBe(2);
  });

  it('says plainly when the store is unreachable, says when a read failed instead of rendering it as empty, and clears everything on a failed reload', async () => {
    store.health = 'unreachable';
    const page = await open();
    expect(await page.locator('#posture li').first().textContent()).toContain('unreachable');
    expect(await page.locator('#posture li').first().getAttribute('data-state')).toBe('off');

    store.health = 'down'; store.collectionsDown = true;
    await page.click('#reload');
    await expect.poll(() => page.locator('#posture li').first().textContent()).toContain('health could not be read');
    expect(await page.locator('#posture li').first().getAttribute('data-state')).toBe('unknown');
    expect(await page.locator('#posture').textContent()).toContain('collection list could not be read');
    expect(await page.locator('#collections li.empty').textContent()).toBe('The collection list could not be read.');
    expect(await page.locator('#collections button').count()).toBe(0);
    expect(await page.locator('#docs tr[data-id]').count()).toBe(4);

    store.api = '500';
    await page.click('#reload');
    await expect.poll(() => banner(page)).toBe('RAG knowledge listing failed');
    expect(await page.locator('#docs tr[data-id]').count()).toBe(0);
    expect(await page.locator('#posture li').count()).toBe(0);
    expect(await page.locator('#collections button').count()).toBe(0);
    await page.fill('#search', 'office');
    await expect.poll(() => page.locator('#docs td.empty').textContent()).toBe('The knowledge could not be read.');
    expect(await page.locator('#count').textContent()).toBe('');

    store.api = '403';
    const other = await context.newPage();
    await other.goto(`${base}/swarm-admin/knowledge`, { waitUntil: 'networkidle' });
    await expect.poll(() => other.locator('#statusBanner').textContent()).toContain('operator role');
    expect(await other.locator('#docs td.empty').textContent()).toContain('could not be read');
  });
});
