/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the pairing QR's target resolution: `target=cockpit` encodes the installable cockpit (the phone tile on the Get oshal page), `remote` the Jarvis remote with a sanitized room, a code the /tv approval page, and anything else the bare /tv page — always this origin, never a secret. Also pins that the live route wires the resolver and renders a PNG for the cockpit target.
 */

import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createTvPairingRoutes, pairingQrUrl } from '@/app/routes/tv-pairing-routes';

const ORIGIN = 'https://swarm.example.test';

describe('pairingQrUrl — what a scanned pairing QR opens', () => {
  it('target=cockpit encodes the installable cockpit on this origin', () => {
    expect(pairingQrUrl(ORIGIN, { target: 'cockpit' })).toBe(`${ORIGIN}/cockpit/`);
  });

  it('target=remote encodes the Jarvis remote, carrying only a sanitized room', () => {
    expect(pairingQrUrl(ORIGIN, { target: 'remote' })).toBe(`${ORIGIN}/api/jarvis/remote`);
    expect(pairingQrUrl(ORIGIN, { target: 'remote', room: 'living room<script>' }))
      .toBe(`${ORIGIN}/api/jarvis/remote?room=livingroomscript`);
  });

  it('a pairing code prefills the /tv approval page', () => {
    expect(pairingQrUrl(ORIGIN, { code: 'ab cd-ef' })).toBe(`${ORIGIN}/tv?code=ABCD-EF`);
  });

  it('an unknown target falls back to the bare /tv page rather than encoding the value', () => {
    expect(pairingQrUrl(ORIGIN, { target: 'https://evil.example' })).toBe(`${ORIGIN}/tv`);
    expect(pairingQrUrl(ORIGIN, {})).toBe(`${ORIGIN}/tv`);
  });
});

describe('GET /api/tv/pair/qr — the live route', () => {
  let server: Server | undefined;

  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  it('routes every QR through pairingQrUrl (the URL choice is not duplicated inline)', () => {
    const src = readFileSync(path.join(process.cwd(), 'src/app/routes/tv-pairing-routes.ts'), 'utf8');
    const route = src.slice(src.indexOf("router.get('/api/tv/pair/qr'"));
    const handler = route.slice(0, route.indexOf('QRCode.toBuffer'));
    expect(handler).toContain('pairingQrUrl(appOrigin(req)');
    expect(handler).not.toContain('/api/jarvis/remote');
  });

  it('renders a PNG for target=cockpit without a session (the page it encodes is auth-gated)', async () => {
    const app = express();
    app.use(createTvPairingRoutes((_req, res) => { res.status(401).end(); }));
    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('QR spec did not bind');
    const res = await fetch(`http://127.0.0.1:${address.port}/api/tv/pair/qr?target=cockpit`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('image/png');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(bytes.slice(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });
});
