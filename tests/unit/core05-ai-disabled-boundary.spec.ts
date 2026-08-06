/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Real HTTP coverage for the shared 503 ai_disabled contract across chat, Jarvis, and manifest-declared package AI routes.
 */

import express, { type Express } from 'express';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createMessageRoutes } from '../../src/app/routes/message-routes';
import { createJarvisRoutes } from '../../src/app/routes/jarvis-routes';
import { ManifestRouteMounterImpl } from '../../src/app/composition/manifest-route-mounter';
import type { AppContext } from '../../src/app/composition/app-context';

const originalNoAi = process.env.OSHAL_NO_AI;
const originalDynamicRoutes = process.env.APP_PACKAGE_DYNAMIC_ROUTES;
const openAuth = (_req: express.Request, _res: express.Response, next: express.NextFunction) => next();

/** Listen on a real ephemeral loopback port. */
async function listen(app: Express): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

/** Close a loopback server without leaving a Vitest worker handle behind. */
async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

afterEach(() => {
  if (originalNoAi === undefined) delete process.env.OSHAL_NO_AI;
  else process.env.OSHAL_NO_AI = originalNoAi;
  if (originalDynamicRoutes === undefined) delete process.env.APP_PACKAGE_DYNAMIC_ROUTES;
  else process.env.APP_PACKAGE_DYNAMIC_ROUTES = originalDynamicRoutes;
});

describe('CORE-05 no-AI route boundary', () => {
  it.each([
    ['/api/send-message', { taskId: 'chat-1', text: 'hello' }],
    ['/api/tasks/chat-1/messages', { text: 'hello' }],
  ])('returns the canonical state before either chat orchestrator path runs: %s', async (route, body) => {
    process.env.OSHAL_NO_AI = 'true';
    const app = express();
    app.use(express.json());
    app.use('/api', createMessageRoutes({} as AppContext));
    const runtime = await listen(app);
    try {
      const response = await fetch(runtime.baseUrl + route, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        error: 'ai_disabled',
        code: 'ai_disabled',
        message: 'AI features are disabled on this deployment. Connect a model or remove OSHAL_NO_AI=true.',
      });
    } finally {
      await close(runtime.server);
    }
  });

  it('returns ai_disabled before Jarvis creates a task or detached inference job', async () => {
    process.env.OSHAL_NO_AI = 'true';
    const pool = { query: async () => ({ rows: [], rowCount: 0 }) };
    const app = express();
    app.use(express.json());
    app.use('/api/jarvis', createJarvisRoutes({ pool } as unknown as AppContext, process.cwd()));
    const runtime = await listen(app);
    try {
      const response = await fetch(`${runtime.baseUrl}/api/jarvis/ask`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'hello' }),
      });
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({ error: 'ai_disabled', code: 'ai_disabled' });
    } finally {
      await close(runtime.server);
    }
  });

  it('blocks only manifest routes that explicitly declare requiresAi', async () => {
    process.env.OSHAL_NO_AI = 'true';
    process.env.APP_PACKAGE_DYNAMIC_ROUTES = '1';
    const packageDir = mkdtempSync(join(tmpdir(), 'oshal-core05-route-'));
    writeFileSync(join(packageDir, 'route.js'), `
exports.createRoutes = function () {
  return function (req, res, next) {
    if (req.url === '/_smoke') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ result: { type: 'real-package-code' } }));
      return;
    }
    next();
  };
};
`, 'utf8');
    const app = express();
    const mounter = new ManifestRouteMounterImpl(app, openAuth, {} as AppContext);
    await mounter.mount('ai-package', packageDir, [{
      module: 'route.js', factory: 'createRoutes', mountPath: '/api/ai-package', auth: 'public', requiresAi: true,
    }]);
    await mounter.mount('deterministic-package', packageDir, [{
      module: 'route.js', factory: 'createRoutes', mountPath: '/api/deterministic', auth: 'public', requiresAi: false,
    }]);
    app.use((_req, res) => res.status(404).end());
    const runtime = await listen(app);
    try {
      const blocked = await fetch(`${runtime.baseUrl}/api/ai-package/_smoke`);
      expect(blocked.status).toBe(503);
      await expect(blocked.json()).resolves.toMatchObject({ error: 'ai_disabled' });

      const available = await fetch(`${runtime.baseUrl}/api/deterministic/_smoke`);
      expect(available.status).toBe(200);
      await expect(available.json()).resolves.toMatchObject({ result: { type: 'real-package-code' } });
    } finally {
      await close(runtime.server);
      rmSync(packageDir, { recursive: true, force: true });
    }
  });
});
