/**
 * CHANGE LOG
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Exercise the real Jarvis router's compact assets over HTTP, with an explicit fixture auth gate and no business operations.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createJarvisRoutes, ensureJarvisSchema } from '@/app/routes/jarvis-routes';

const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
let server: ReturnType<express.Express['listen']>;
let origin: string;

beforeAll(async () => {
  const pool = { query, connect: async () => ({ query, release() {} }) };
  // Finish the real router's process bootstrap before measuring request operations.
  await ensureJarvisSchema(pool as never);
  query.mockClear();
  const app = express();
  app.use('/api/jarvis', (req, res, next) => {
    if (req.header('x-test-session') !== 'fixture') { res.sendStatus(401); return; }
    next();
  }, createJarvisRoutes({ pool } as never, resolve('src/api')));
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(done => server.once('listening', done));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server?.closeAllConnections();
  if (server) await new Promise<void>(done => server.close(() => done()));
});

it.each([['jarvis-dashboard.css', 'text/css'], ['jarvis-dashboard.js', 'application/javascript']])(
  'serves exact current %s bytes with private cache and MIME headers', async (file, mime) => {
    const response = await fetch(`${origin}/api/jarvis/assets/${file}`, { headers: { 'x-test-session': 'fixture' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain(mime);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('cache-control')).toContain('private');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    const received = Buffer.from(await response.arrayBuffer()), expected = await readFile(resolve('src/api', file));
    expect(received.length).toBeGreaterThan(0);
    expect(createHash('sha256').update(received).digest('hex')).toBe(createHash('sha256').update(expected).digest('hex'));
    expect(query).not.toHaveBeenCalled();
  },
);

it('does not make newly allowlisted files bypass the parent authentication gate', async () => {
  for (const file of ['jarvis-dashboard.css', 'jarvis-dashboard.js']) {
    expect((await fetch(`${origin}/api/jarvis/assets/${file}`)).status).toBe(401);
  }
  expect(query).not.toHaveBeenCalled();
});

it.each(['package.json', '..%2f..%2fpackage.json', 'jarvis-dashboard.js.map'])('refuses unlisted asset %s', async file => {
  const response = await fetch(`${origin}/api/jarvis/assets/${file}`, { headers: { 'x-test-session': 'fixture' } });
  expect(response.status).toBe(404);
  expect(query).not.toHaveBeenCalled();
});
