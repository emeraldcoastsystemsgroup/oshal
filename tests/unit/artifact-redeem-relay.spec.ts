/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-139 wave 2 guard for the SHARED package-side redeem, crossed over a real HTTP server standing in for the kernel relay: a good ref returns named+typed bytes with the service secret + caller sub actually sent; a 404 from the relay reads as expired; a missing secret or bad ref shape fails closed before any request; an oversize body is refused at the helper's own ceiling. If the helper's header contract or fail-closed order drifts, importing app destinations break silently — this goes red first.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

vi.mock('@/shared/logger', () => ({ createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

import { redeemArtifactViaRelay } from '@/shared/artifact-exchange';

const SECRET = 'redeem-relay-spec-secret';
const SUB = 'auth0|redeem-user';
const GOOD_REF = 'art_good-ref-1234567890';
const BIG_REF = 'art_big-ref-12345678901';

let server: Server;
let port = 0;
let prevSecret: string | undefined;
let lastHeaders: Record<string, string | string[] | undefined> = {};

beforeAll(async () => {
  prevSecret = process.env.SWARM_SERVICE_SECRET;
  process.env.SWARM_SERVICE_SECRET = SECRET;
  const app = express();
  app.get('/api/artifacts/handles/:ref', (req, res) => {
    lastHeaders = req.headers;
    if (req.headers['x-service-secret'] !== SECRET || req.headers['x-oshal-user-sub'] !== SUB) { res.status(401).json({ error: 'unauthorized' }); return; }
    if (req.params.ref === GOOD_REF || req.params.ref === BIG_REF) { res.json({ ref: req.params.ref, name: 'proof "doc".pdf', type: 'Application/PDF; q=1' }); return; }
    res.status(404).json({ error: 'artifact handle not found' });
  });
  app.get('/api/artifacts/handles/:ref/content', (req, res) => {
    if (req.headers['x-service-secret'] !== SECRET || req.headers['x-oshal-user-sub'] !== SUB) { res.status(401).json({ error: 'unauthorized' }); return; }
    if (req.params.ref === GOOD_REF) { res.type('application/pdf').send(Buffer.from('real-bytes')); return; }
    if (req.params.ref === BIG_REF) { res.type('application/pdf').send(Buffer.alloc(2048, 7)); return; }
    res.status(404).json({ error: 'artifact handle not found' });
  });
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  if (prevSecret === undefined) delete process.env.SWARM_SERVICE_SECRET;
  else process.env.SWARM_SERVICE_SECRET = prevSecret;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('redeemArtifactViaRelay (the shared package-side redeem)', () => {
  it('returns named, typed, sanitized bytes for a good ref — with the rail headers actually sent', async () => {
    const r = await redeemArtifactViaRelay({ port, callerSub: SUB, ref: GOOD_REF });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.buffer.toString()).toBe('real-bytes');
      expect(r.type).toBe('application/pdf');
      expect(r.name).not.toMatch(/["\\/]/);
    }
    expect(lastHeaders['x-service-secret']).toBe(SECRET);
    expect(lastHeaders['x-oshal-user-sub']).toBe(SUB);
  });

  it('an unknown ref reads as expired (404), never as a distinguishable state', async () => {
    const r = await redeemArtifactViaRelay({ port, callerSub: SUB, ref: 'art_unknown-ref-000000' });
    expect(r).toMatchObject({ ok: false, status: 404 });
  });

  it('fails closed before any request on a bad ref shape or a missing secret', async () => {
    expect(await redeemArtifactViaRelay({ port, callerSub: SUB, ref: 'not-a-ref' })).toMatchObject({ ok: false, status: 400 });
    const saved = process.env.SWARM_SERVICE_SECRET;
    delete process.env.SWARM_SERVICE_SECRET;
    expect(await redeemArtifactViaRelay({ port, callerSub: SUB, ref: GOOD_REF })).toMatchObject({ ok: false, status: 503 });
    process.env.SWARM_SERVICE_SECRET = saved;
    expect(await redeemArtifactViaRelay({ port: undefined, callerSub: SUB, ref: GOOD_REF })).toMatchObject({ ok: false, status: 503 });
  });

  it('refuses a body over the caller-declared ceiling', async () => {
    expect(await redeemArtifactViaRelay({ port, callerSub: SUB, ref: BIG_REF, maxBytes: 1024 })).toMatchObject({ ok: false, status: 413 });
  });
});
