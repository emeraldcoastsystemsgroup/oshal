/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Serve the briefing settings page assets through the real router from the tree copy every layout has, and keep every route page asset on a <cwd>/src/pages candidate because the server build excludes src/pages.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import express, { type RequestHandler } from 'express';
import type { AddressInfo } from 'node:net';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createJarvisBriefingRoutes } from '@/app/routes/jarvis-briefing-routes';

const actor = { sub: 'briefing-assets-user', issuer: 'https://fixture.test', isActive: true, isSwarmAdmin: false };
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
let server: ReturnType<express.Express['listen']>;
let origin: string;

beforeAll(async () => {
  const auth: RequestHandler = (req, res, next) => {
    if (req.header('x-test-session') !== 'fixture') { res.sendStatus(401); return; }
    next();
  };
  // Only the page assets are exercised; the preference service is never reached by these routes.
  const service = { catalog: async () => { throw new Error('catalog is not part of asset serving'); } };
  const app = express();
  app.use('/api/jarvis/briefings', createJarvisBriefingRoutes(service as never, auth, async () => actor));
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(done => server.once('listening', done));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/jarvis/briefings`;
});
afterAll(async () => {
  server?.closeAllConnections();
  if (server) await new Promise<void>(done => server.close(() => done()));
});

it.each([['client.js', 'client.js', 'javascript'], ['settings', 'index.html', 'text/html']])(
  'serves %s as the exact current src/pages/jarvis-briefings/%s bytes', async (route, file, mime) => {
    const response = await fetch(`${origin}/${route}`, { headers: { 'x-test-session': 'fixture' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain(mime);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const received = Buffer.from(await response.arrayBuffer());
    expect(received.length).toBeGreaterThan(0);
    expect(sha(received)).toBe(sha(await readFile(resolve('src/pages/jarvis-briefings', file))));
  },
);

it('keeps both page assets behind the authentication gate', async () => {
  for (const route of ['client.js', 'settings']) expect((await fetch(`${origin}/${route}`)).status).toBe(401);
});

it('keeps every route page asset on a <cwd>/src/pages candidate because the server build excludes src/pages', async () => {
  // dist/ carries no pages/ (tsconfig.server.json excludes them), so a route that reaches a page only
  // through __dirname works under ts-node and 404s in the baked image — the shape that made the
  // browser refuse /api/jarvis/briefings/client.js as application/json.
  expect(await readFile('tsconfig.server.json', 'utf8')).toMatch(/"src\/pages\/\*\*"/);
  const routesDir = resolve('src/app/routes');
  const offenders: string[] = [];
  for (const name of (await readdir(routesDir)).filter(entry => entry.endsWith('.ts') && !entry.endsWith('.spec.ts'))) {
    const source = await readFile(resolve(routesDir, name), 'utf8');
    const code = source.split('\n').filter(line => !/^\s*(\*|\/\/|\/\*)/.test(line));
    const viaDirname = code.some(line => line.includes('__dirname') && /pages\//.test(line));
    if (viaDirname && !/process\.cwd\(\),\s*['"]src\/pages/.test(source)) offenders.push(name);
  }
  expect(offenders).toEqual([]);
});
