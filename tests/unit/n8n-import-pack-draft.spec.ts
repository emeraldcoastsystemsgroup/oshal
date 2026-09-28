/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Private Packs review draft over the real router and a headless browser: authentication before buffering, 512 KiB and multipart limits, slug and collision refusals, redacted files on disk, no source export retained, and the deploy route refusing an n8n-analysis draft.
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { Server } from 'node:http';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-n8n-draft-'));
const priorRoot = process.env.OSHAL_WORKSPACE_ROOT;
process.env.OSHAL_WORKSPACE_ROOT = root;
const ownerSub = 'auth0|n8n-draft-owner';
let currentSub: string | undefined = ownerSub;

function packDir(name: string): string {
  const key = crypto.createHash('sha256').update(ownerSub).digest('hex').slice(0, 32);
  return path.join(root, 'packs', key, name);
}

function sourceJson(): string {
  return JSON.stringify({
    name: 'private-source-name', active: true,
    nodes: [
      { name: 'private-start-name', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, parameters: {} },
      { id: 'private-source-id', name: 'private-code-name', type: 'n8n-nodes-base.code', typeVersion: 2,
        parameters: { jsCode: 'const secret = "sensitive-token-value"; return [];' },
        credentials: { api: { id: 'private-credential-id', name: 'private-account-name' } } },
    ],
    connections: { 'private-start-name': { main: [[{ node: 'private-code-name', type: 'main', index: 1 }]] } },
    pinData: { 'private-code-name': [{ json: { key: 'private-pinned-value' } }] },
  });
}

function form(name: string, source: string | Buffer): FormData {
  const data = new FormData();
  data.set('name', name);
  data.set('file', new Blob([source], { type: 'application/json' }), 'workflow.json');
  return data;
}

describe('n8n → private Packs review draft', () => {
  let server: Server;
  let base = '';
  let browser: Browser;
  let loads = 0;

  beforeAll(async () => {
    const { createSwarmPackRoutes } = await import('../../src/app/routes/swarm-pack-routes');
    const app = express();
    // Production mounts a 100kb JSON parser before this router. Multipart must pass it untouched.
    app.use(express.json({ limit: '100kb' }));
    app.use((req: Request, _res: Response, next: NextFunction) => {
      if (currentSub) (req as Request & { oidc?: { user: { sub: string } } }).oidc = { user: { sub: currentSub } };
      next();
    });
    app.use('/api/swarm/packs', createSwarmPackRoutes({ loadApp: async () => { loads++; } }));
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });

  afterAll(async () => {
    if (browser) await browser.close();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
    if (priorRoot === undefined) delete process.env.OSHAL_WORKSPACE_ROOT;
    else process.env.OSHAL_WORKSPACE_ROOT = priorRoot;
  });

  it('saves a redacted graph with local IDs and exact ports, with no deploy path', async () => {
    const response = await fetch(`${base}/api/swarm/packs/import/n8n`, { method: 'POST', body: form('private-review', sourceJson()) });
    expect(response.status).toBe(201);
    const receipt = await response.json() as Record<string, unknown>;
    expect(receipt).toMatchObject({ mode: 'n8n-analysis', analysisOnly: true, executable: false,
      publishable: false, nodeCount: 2, connectionCount: 1, unsupportedCount: 1 });
    const dir = packDir('private-review');
    expect(fs.readdirSync(dir).sort()).toEqual(['README.md', 'analysis.json', 'pack.json', 'workflow.json']);
    const serialized = fs.readdirSync(dir).map((file) => fs.readFileSync(path.join(dir, file), 'utf8')).join('\n');
    for (const sensitive of ['private-source-name', 'private-start-name', 'private-code-name',
      'private-source-id', 'private-credential-id', 'private-account-name', 'sensitive-token-value',
      'private-pinned-value', 'jsCode']) expect(serialized).not.toContain(sensitive);
    const workflow = JSON.parse(fs.readFileSync(path.join(dir, 'workflow.json'), 'utf8'));
    expect(workflow.flags).toMatchObject({ sourceActive: true, hasCredentialReferences: true,
      hasPinnedData: true, hasMissingNodeIds: true, hasPortIndexes: true });
    expect(workflow.nodes[0].id).toMatch(/^[0-9a-f-]{36}$/);
    expect(workflow.nodes[0].id).not.toBe(workflow.nodes[1].id);
    expect(workflow.edges[0]).toMatchObject({ from: workflow.nodes[0].id, to: workflow.nodes[1].id,
      sourceChannel: 'main', sourceOutput: 0, targetChannel: 'main', targetInput: 1 });
    expect(workflow.nativeCandidates).toMatchObject([{ sourceOrdinal: 1, status: 'proposal_only',
      requiredBinding: 'manual_ticket_intake_binding_required', node: { type: 'start', config: { triggerMode: 'manual' } } }]);
    expect(workflow.nativeCandidates[0].node.id).not.toBe(workflow.nodes[0].id);
    const before = loads;
    const deploy = await fetch(`${base}/api/swarm/packs/private-review/deploy`, { method: 'POST' });
    expect(deploy.status).toBe(400);
    expect(loads).toBe(before);
    expect(fs.existsSync(path.join(root, 'deployed-apps', 'private-review.yaml'))).toBe(false);
    expect((await fetch(`${base}/api/swarm/packs/private-review/workflow`)).status).toBe(200);
  });

  it('refuses collisions, malformed/unsafe/oversize input without saving raw source', async () => {
    const collision = await fetch(`${base}/api/swarm/packs/import/n8n`, { method:'POST', body: form('private-review', sourceJson()) });
    expect(collision.status).toBe(409);
    const malformed = await fetch(`${base}/api/swarm/packs/import/n8n`, { method:'POST', body: form('malformed-review', '{no') });
    expect(malformed.status).toBe(400);
    expect(fs.existsSync(packDir('malformed-review'))).toBe(false);
    const unsafe = await fetch(`${base}/api/swarm/packs/import/n8n`, { method:'POST', body: form('unsafe-review',
      '{"nodes":[],"connections":{},"__proto__":{}}') });
    expect(unsafe.status).toBe(400);
    expect(fs.existsSync(packDir('unsafe-review'))).toBe(false);
    const big = await fetch(`${base}/api/swarm/packs/import/n8n`, { method:'POST', body: form('oversize-review', Buffer.alloc(512 * 1024 + 1, 65)) });
    expect(big.status).toBe(413);
    expect(fs.existsSync(packDir('oversize-review'))).toBe(false);
    const badName = await fetch(`${base}/api/swarm/packs/import/n8n`, { method:'POST', body: form('..', sourceJson()) });
    expect(badName.status).toBe(400);
  });

  it('requires a real owner before upload and isolates private packs by owner', async () => {
    currentSub = undefined;
    const anonymous = await fetch(`${base}/api/swarm/packs/import/n8n`, { method:'POST', body: form('anonymous-review', sourceJson()) });
    expect(anonymous.status).toBe(401);
    currentSub = 'auth0|different-owner';
    const list = await fetch(`${base}/api/swarm/packs`);
    expect(await list.json()).toEqual({ packs: [] });
    expect((await fetch(`${base}/api/swarm/packs/private-review`)).status).toBe(404);
    expect((await fetch(`${base}/api/swarm/packs/private-review/workflow`)).status).toBe(404);
    currentSub = ownerSub;
  });

  it('shows a keyboard-accessible upload and review flow with no deploy control or private source text', async () => {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(`${base}/api/swarm/packs/studio`);
    await page.getByLabel('Draft slug').fill('browser-review');
    await page.getByLabel('n8n JSON export').setInputFiles({ name: 'workflow.json', mimeType: 'application/json', buffer: Buffer.from(sourceJson()) });
    await page.getByRole('button', { name: 'Analyze and save draft' }).click();
    await expect.poll(async () => page.locator('#n8n-import-status').innerText()).toContain('Saved private analysis draft');
    const card = page.locator('.pack').filter({ has: page.locator('.nm', { hasText: 'browser-review' }) });
    await card.getByRole('button', { name: 'View flow' }).click();
    await expect.poll(async () => card.locator('.flow').innerText()).toContain('main[1]');
    expect(await card.getByRole('button', { name: /Deploy to swarm/ }).count()).toBe(0);
    const text = await page.locator('body').innerText();
    expect(text).toContain('imported_code_not_allowed');
    expect(text).toContain('Source workflow was active; no local trigger was activated.');
    for (const sensitive of ['private-source-name', 'private-code-name', 'sensitive-token-value', 'private-pinned-value']) {
      expect(text).not.toContain(sensitive);
    }
    await page.close();
  });
});
