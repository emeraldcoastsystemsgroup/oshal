/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Route tests for POST /api/vision/describe over a real in-process express server (VisionDescribeService mocked): anonymous → 401 (auth-gated, CLAUDE.md), empty images → 400, no OpenRouter credential → 503, happy path → 200 description, and a service client-error message → 400.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import type { Server } from 'node:http';

// Controllable fake vision service so the route is tested without a real OpenRouter call.
const svc = vi.hoisted(() => ({ available: true, throwClientError: false }));
vi.mock('@/shared/logger', () => ({ createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
vi.mock('@/features/vision-describe', () => ({
  VisionDescribeService: class {
    isAvailable() { return svc.available; }
    async describe(req: { images: unknown[] }) {
      if (svc.throwClientError) throw new Error('each image must be a base64 image data URL');
      return { description: 'a red bicycle', model: 'google/gemini-2.5-flash', cost: 0.001, imageCount: req.images.length };
    }
  },
}));

import { createVisionRoutes } from '@/app/routes/vision-routes';

/** Minimal identity middleware: an x-test-sub header stands in for an OIDC session. */
function testIdentity() {
  return (req: Request, _res: Response, next: NextFunction) => {
    const sub = req.headers['x-test-sub'];
    if (sub) (req as unknown as { oidc: { user: { sub: string } } }).oidc = { user: { sub: String(sub) } };
    next();
  };
}

const servers: Server[] = [];
afterEach(async () => {
  svc.available = true; svc.throwClientError = false;
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

async function start(): Promise<string> {
  const app = express();
  app.use(express.json({ limit: '12mb' }));
  app.use(testIdentity());
  app.use('/api/vision', createVisionRoutes({ pool: null } as never));
  const server = app.listen(0);
  servers.push(server);
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('test server did not bind');
  return `http://127.0.0.1:${addr.port}`;
}

async function describe_(base: string, body: unknown, authed = true): Promise<globalThis.Response> {
  return fetch(`${base}/api/vision/describe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(authed ? { 'x-test-sub': 'auth0|owner-a' } : {}) },
    body: JSON.stringify(body),
  });
}

describe('POST /api/vision/describe', () => {
  const IMG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAAA=';

  it('is auth-gated — an anonymous caller gets 401', async () => {
    const base = await start();
    const res = await describe_(base, { images: [{ dataUrl: IMG }] }, false);
    expect(res.status).toBe(401);
  });

  it('rejects a request with no images (400)', async () => {
    const base = await start();
    const res = await describe_(base, { images: [] });
    expect(res.status).toBe(400);
  });

  it('returns 503 when image understanding is not configured', async () => {
    svc.available = false;
    const base = await start();
    const res = await describe_(base, { images: [{ dataUrl: IMG }] });
    expect(res.status).toBe(503);
    expect((await res.json() as { error: string }).error).toBe('vision_unavailable');
  });

  it('describes an image and returns 200 with the description', async () => {
    const base = await start();
    const res = await describe_(base, { images: [{ dataUrl: IMG }], question: 'what is this?', sessionId: 'jarvis-abc' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ description: 'a red bicycle', imageCount: 1 });
  });

  it('maps a service client-error message to 400', async () => {
    svc.throwClientError = true;
    const base = await start();
    const res = await describe_(base, { images: [{ dataUrl: 'not-a-data-url' }] });
    expect(res.status).toBe(400);
  });
});
