/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-139 Amendment D guard, crossed over a REAL HTTP server mounting the REAL router: nothing here is doubled except the sign-in, because the boundary this fix claims to protect IS multer + the route ordering + the handle store together. Proves (a) authorization runs BEFORE multer buffers - an oversize body from an anonymous caller answers 401, not 413, which is only true if the auth middleware is ahead of the parser; (b) a carried artifact round-trips byte-for-byte through the ordinary redeem, so a locator handle and a bytes handle are indistinguishable downstream; (c) a built-in destination (extract-text) consumes a carried handle with NO code of its own, which is the claim that lets every existing destination inherit this; (d) the owner binding holds - a second sub reading the same ref gets the same 404 as a stranger; (e) the size cap answers 413 at the parser.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AppContext } from '@/app/composition/app-context';

vi.mock('@/shared/logger', () => ({ createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

const OWNER = 'auth0|inline-owner';
const OTHER = 'auth0|inline-stranger';
/** Small enough that the oversize case is cheap; the route reads this at import, so it is set first. */
const CAP = 65_536;

let server: Server;
let base = '';
/** The sub the next request signs in as - the ONLY doubled thing in this spec. */
let actingSub: string | null = OWNER;

beforeAll(async () => {
  process.env.ARTIFACT_INLINE_MAX_BYTES = String(CAP);
  process.env.ARTIFACT_INLINE_MAX_BYTES_PER_SUB = String(CAP * 4);
  const { createArtifactExchangeRoutes } = await import('@/app/routes/artifact-exchange-routes');
  const app = express();
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (actingSub) (req as Request & { oidc?: unknown }).oidc = { user: { sub: actingSub } };
    next();
  });
  app.use('/api/artifacts', express.json(), createArtifactExchangeRoutes({ pool: null } as unknown as AppContext));
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Upload one artifact as the currently acting sub. */
async function upload(bytes: Buffer | string, type: string, name: string): Promise<Response2> {
  const fd = new FormData();
  fd.append('type', type);
  fd.append('name', name);
  fd.append('file', new Blob([bytes], { type }), name);
  const r = await fetch(`${base}/api/artifacts/handles/upload`, { method: 'POST', body: fd });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

interface Response2 { status: number; json: Record<string, unknown> }

describe('POST /handles/upload - the mint-with-bytes route (ADR-139 Amendment D)', () => {
  it('refuses an anonymous caller BEFORE multer buffers the body (401, not 413)', async () => {
    actingSub = null;
    const r = await upload(Buffer.alloc(CAP * 2, 1), 'text/plain', 'huge.txt');
    actingSub = OWNER;
    // 413 here would mean the parser ran first and buffered an unauthenticated caller's bytes.
    expect(r.status).toBe(401);
  });

  it('carries the artifact and round-trips it byte-for-byte through the ordinary redeem', async () => {
    const content = 'the preview envelope never served these bytes\nline two\n';
    const minted = await upload(content, 'text/plain', 'notes.txt');
    expect(minted.status).toBe(201);
    const ref = String(minted.json.ref);
    expect(ref).toMatch(/^art_/);
    expect(minted.json.type).toBe('text/plain');

    const meta = await fetch(`${base}/api/artifacts/handles/${ref}`);
    expect(meta.status).toBe(200);
    expect((await meta.json()).name).toBe('notes.txt');

    const got = await fetch(`${base}/api/artifacts/handles/${ref}/content`);
    expect(got.status).toBe(200);
    expect(got.headers.get('content-type')).toContain('text/plain');
    expect(got.headers.get('content-disposition')).toContain('notes.txt');
    expect(await got.text()).toBe(content);
  });

  it('a built-in destination consumes a carried handle with no code of its own', async () => {
    const minted = await upload('extractable body text', 'text/plain', 'doc.txt');
    const ref = String(minted.json.ref);
    const r = await fetch(`${base}/api/artifacts/builtin/extract-text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref }),
    });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.text).toContain('extractable body text');
  });

  it('is owner-bound: another sub reading the same ref gets the stranger 404', async () => {
    const minted = await upload('private', 'text/plain', 'private.txt');
    const ref = String(minted.json.ref);
    actingSub = OTHER;
    const meta = await fetch(`${base}/api/artifacts/handles/${ref}`);
    const content = await fetch(`${base}/api/artifacts/handles/${ref}/content`);
    actingSub = OWNER;
    expect(meta.status).toBe(404);
    expect(content.status).toBe(404);
  });

  it('refuses a payload over the size cap at the parser', async () => {
    const r = await upload(Buffer.alloc(CAP + 1, 2), 'text/plain', 'too-big.txt');
    expect(r.status).toBe(413);
    expect(String(r.json.error)).toMatch(/too large/);
  });

  it('refuses a request with no file part at all', async () => {
    const r = await fetch(`${base}/api/artifacts/handles/upload`, { method: 'POST', body: new FormData() });
    expect(r.status).toBe(400);
  });
});
