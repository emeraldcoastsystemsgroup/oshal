/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Route guard for POST /api/vision/read-doc (extractor mocked — no parser/network calls): auth-gated 401, malformed dataUrl 400, extractor success → 200 { ok:true, text }, extractor failure → HONEST 200 { ok:false, reason } (the "couldn't read" contract the Jarvis surface renders — a 500 or a silent 200 {} here would let the attachment vanish).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import type { Server } from 'node:http';

// Controllable fake extractor so the route contract is tested without pdf-parse/yauzl.
const fake = vi.hoisted(() => ({
  result: { ok: true, format: 'pdf', text: 'extracted text', truncated: false } as unknown,
  calls: [] as Array<{ name?: string; bytes: number }>,
}));
vi.mock('@/shared/logger', () => ({ createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
vi.mock('@/features/doc-extract', () => ({
  extractDocText: async (input: { name?: string; buffer: Buffer }) => {
    fake.calls.push({ name: input.name, bytes: input.buffer.length });
    return fake.result;
  },
}));
vi.mock('@/features/vision-describe', () => ({
  VisionDescribeService: class { isAvailable() { return false; } async describe() { throw new Error('unused'); } },
}));

import { createVisionRoutes } from '@/app/routes/vision-routes';

function testIdentity() {
  return (req: Request, _res: Response, next: NextFunction) => {
    const sub = req.headers['x-test-sub'];
    if (sub) (req as unknown as { oidc: { user: { sub: string } } }).oidc = { user: { sub: String(sub) } };
    next();
  };
}

const servers: Server[] = [];
afterEach(async () => {
  fake.result = { ok: true, format: 'pdf', text: 'extracted text', truncated: false };
  fake.calls.length = 0;
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

async function readDoc(base: string, body: unknown, authed = true): Promise<globalThis.Response> {
  return fetch(`${base}/api/vision/read-doc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(authed ? { 'x-test-sub': 'auth0|owner-a' } : {}) },
    body: JSON.stringify(body),
  });
}

const PDF_DATAURL = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4 tiny').toString('base64');

describe('POST /api/vision/read-doc', () => {
  it('is auth-gated — an anonymous caller gets 401 and the extractor never runs', async () => {
    const base = await start();
    const res = await readDoc(base, { name: 'a.pdf', dataUrl: PDF_DATAURL }, false);
    expect(res.status).toBe(401);
    expect(fake.calls.length).toBe(0);
  });

  it('rejects a malformed dataUrl with 400 before extraction', async () => {
    const base = await start();
    expect((await readDoc(base, { name: 'a.pdf' })).status).toBe(400);
    expect((await readDoc(base, { name: 'a.pdf', dataUrl: 'not-a-data-url' })).status).toBe(400);
    expect(fake.calls.length).toBe(0);
  });

  it('returns extracted text on success — the decoded bytes reach the extractor', async () => {
    const base = await start();
    const res = await readDoc(base, { name: 'q3.pdf', dataUrl: PDF_DATAURL });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, name: 'q3.pdf', format: 'pdf', text: 'extracted text' });
    expect(fake.calls).toEqual([{ name: 'q3.pdf', bytes: Buffer.from('%PDF-1.4 tiny').length }]);
  });

  it('extraction failure is an HONEST 200 { ok:false, reason } — named, never silent, never a 500', async () => {
    fake.result = { ok: false, format: 'docx', reason: 'no word/document.xml inside — not a Word .docx file' };
    const base = await start();
    const res = await readDoc(base, { name: 'broken.docx', dataUrl: PDF_DATAURL });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.name).toBe('broken.docx');
    expect(body.reason).toMatch(/not a Word/);
  });
});
