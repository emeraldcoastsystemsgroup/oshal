/**
 * CHANGE LOG
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Chromium exercises the shared dispatcher against real handle/registry routes. Authentication and a confirmation-gated destination are explicit fixtures.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { chromium, type Browser } from 'playwright';
import type { AppContext } from '@/app/composition/app-context';
import { createArtifactExchangeRoutes } from '@/app/routes/artifact-exchange-routes';
import { mintArtifactHandle, registerAppArtifactActions, unregisterAppArtifactActions } from '@/shared/artifact-exchange';

let browser: Browser, server: Server, base: string, ref: string, foreign: string;
const posts: unknown[] = [];
beforeAll(async () => {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => {
    Object.assign(req, { oidc: { user: { sub: 'alice' }, isAuthenticated: () => true } }); next();
  });
  app.use('/api/artifacts', createArtifactExchangeRoutes({} as AppContext, async () => new Map([['dispatch-proof', 'Dispatch proof'], ['jarvis-proof', 'Test files']])));
  app.use('/shared', express.static(resolve('src/shared')));
  app.use('/cockpit/css/themes', express.static(resolve('src/pages/cockpit/css/themes')));
  app.use('/api/jarvis/assets', express.static(resolve('src/api')));
  app.get('/api/jarvis/', (_req, res) => res.sendFile(resolve('src/api/jarvis.html')));
  app.get('/api/jarvis-proof/files', (_req, res) => res.json({ items: [{ name: 'Selected image.png', type: 'image/png', source: '/api/example/image' }] }));
  app.get('/api/example/image', (_req, res) => res.type('image/png').send(Buffer.from('image')));
  registerAppArtifactActions('jarvis-proof', { provides: [{ types: ['image/*'], list: '/api/jarvis-proof/files' }], accepts: [{ id: 'open', label: 'Open test file', types: ['image/*'], mode: 'open' }] });
  app.get('/', (_req, res) => res.send('<script src="/api/artifacts/send-to.js"></script>'));
  app.get('/cockpit/', (_req, res) => res.send('Destination'));
  app.post('/api/dispatch-proof/confirm', (req, res) => {
    posts.push(req.body); res.status(428).json({ error: 'Confirmation required' });
  });
  registerAppArtifactActions('dispatch-proof', { accepts: [
    { id: 'open', label: 'Open', types: ['image/*'], mode: 'open' },
    { id: 'confirm', label: 'Confirm', types: ['image/*'], mode: 'post', endpoint: '/api/dispatch-proof/confirm' },
  ] });
  ref = mintArtifactHandle({ ownerSub: 'alice', sourcePath: '/api/example/image', type: 'image/png' }).ref;
  foreign = mintArtifactHandle({ ownerSub: 'bob', sourcePath: '/api/example/image', type: 'image/png' }).ref;
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch({ headless: true });
}, 30000);
afterAll(async () => {
  await browser?.close();
  server?.closeAllConnections();
  await new Promise<void>(resolve => server?.close(() => resolve()));
  unregisterAppArtifactActions('dispatch-proof');
  unregisterAppArtifactActions('jarvis-proof');
}, 30000);

describe('live browser artifact handoff', () => {
  it('reuses the owner handle for navigation and ignores supplied destination URLs', async () => {
    const page = await browser.newPage(); await page.goto(base);
    await page.evaluate(({ ref }) => {
      return (window as any).oshalDispatchArtifact({ ref, app: 'dispatch-proof', id: 'open', endpoint: 'https://example.invalid/' });
    }, { ref });
    await page.waitForURL('**/cockpit/?**');
    expect(new URL(page.url()).searchParams.get('artifact')).toBe(ref);
    expect(new URL(page.url()).searchParams.get('app')).toBe('dispatch-proof');
    await page.close();
  });
  it('opens email compose without sending and never retries a 428 with confirmation', async () => {
    const page = await browser.newPage(); await page.goto(base);
    await page.evaluate(({ ref }) => (window as any).oshalDispatchArtifact({ ref, app: 'kernel-email', id: 'compose' }), { ref });
    expect(await page.locator('iframe').getAttribute('src')).toBe('/api/artifacts/email-compose?artifact=' + ref);
    const error = await page.evaluate(async ({ ref }) => {
      try { await (window as any).oshalDispatchArtifact({ ref, app: 'dispatch-proof', id: 'confirm', confirm: true }); }
      catch (error) { return (error as Error).message; }
    }, { ref });
    expect(error).toBe('Confirmation required'); expect(posts).toEqual([{ ref }]);
    await page.close();
  });
  it('refuses foreign handles and deactivated destinations before any write', async () => {
    const page = await browser.newPage(); await page.goto(base);
    const reject = (selected: string) => page.evaluate(async ({ ref }) => {
      try { await (window as any).oshalDispatchArtifact({ ref, app: 'dispatch-proof', id: 'confirm' }); }
      catch (error) { return (error as Error).message; }
    }, { ref: selected });
    expect(await reject(foreign)).toBe('artifact handle not found');
    unregisterAppArtifactActions('dispatch-proof');
    expect(await reject(ref)).toMatch(/no longer available/);
    expect(posts).toHaveLength(1); await page.close();
  });

  it('ships the picker selection through the actual Jarvis form and does not replay it on reload', async () => {
    const page = await browser.newPage();
    await page.route('https://**', route => route.abort());
    page.setDefaultTimeout(6000);
    const pageErrors: string[] = []; page.on('pageerror', error => pageErrors.push(error.message));
    const asks: Array<{ artifact?: { ref: string }; message: string }> = [];
    let resultReads = 0;
    await page.route('**/api/jarvis/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/jarvis/' || path.startsWith('/api/jarvis/assets/')) return route.continue();
      if (path === '/api/jarvis/ask') {
        asks.push(route.request().postDataJSON());
        return route.fulfill({ json: { jobId: 'browser-handoff' } });
      }
      if (path === '/api/jarvis/ask/result') {
        resultReads++;
        return route.fulfill({ json: { status: 'done', answer: 'Opening your image.', artifactAction: { ref: asks[0].artifact?.ref, app: 'jarvis-proof', id: 'open' } } });
      }
      return route.fulfill({ json: { tasks: [], sessions: [], threads: [], items: [], agents: [] } });
    });
    await page.goto(base + '/api/jarvis/');
    await page.locator('#chooseArtifact').click();
    expect(pageErrors).toEqual([]);
    expect(await page.locator('dialog').count()).toBe(1);
    await page.getByRole('button', { name: 'Test files', exact: true }).click();
    await page.getByRole('button', { name: 'Selected image.png', exact: true }).click();
    await page.locator('#selectedArtifactName', { hasText: 'Selected image.png' }).waitFor({ state: 'visible' });
    expect(await page.locator('#selectedArtifactName').textContent()).toBe('Selected image.png');
    await page.locator('#typein').fill('Open this in the test app');
    await page.locator('#typer button').click();
    await page.waitForURL('**/cockpit/?**');
    expect(asks).toHaveLength(1);
    expect(asks[0].artifact?.ref).toMatch(/^art_/);
    expect(new URL(page.url()).searchParams.get('artifact')).toBe(asks[0].artifact?.ref);
    await page.goto(base + '/api/jarvis/');
    await page.reload();
    expect(await page.locator('#selectedArtifact').isHidden()).toBe(true);
    expect(asks).toHaveLength(1); expect(resultReads).toBe(1);
    await page.close();
  }, 30000);

  it('rejects a delayed Jarvis action after the user removes the selected file', async () => {
    const page = await browser.newPage();
    await page.route('https://**', route => route.abort());
    let selectedRef = '';
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/api/jarvis/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/jarvis/' || path.startsWith('/api/jarvis/assets/')) return route.continue();
      if (path === '/api/jarvis/ask') {
        selectedRef = route.request().postDataJSON().artifact.ref;
        return route.fulfill({ json: { jobId: 'delayed-handoff' } });
      }
      if (path === '/api/jarvis/ask/result') {
        await pending;
        return route.fulfill({ json: { status: 'done', answer: 'Opening it.', artifactAction: { ref: selectedRef, app: 'jarvis-proof', id: 'open' } } });
      }
      return route.fulfill({ json: { tasks: [], sessions: [], threads: [], items: [], agents: [] } });
    });
    await page.goto(base + '/api/jarvis/');
    await page.locator('#chooseArtifact').click();
    await page.getByRole('button', { name: 'Test files', exact: true }).click();
    await page.getByRole('button', { name: 'Selected image.png', exact: true }).click();
    await page.locator('#typein').fill('Open this in the test app');
    const asked = page.waitForRequest('**/api/jarvis/ask');
    await page.locator('#typer button').click(); await asked;
    await page.locator('#clearArtifact').click(); release();
    await page.locator('#convo .err').filter({ hasText: 'selected file changed' }).waitFor({ state: 'attached' });
    expect(new URL(page.url()).pathname).toBe('/api/jarvis/');
    await page.close();
  }, 30000);
});
