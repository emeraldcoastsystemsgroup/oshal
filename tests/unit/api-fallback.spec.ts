/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Regression guard for the boot-window-aware /api fallback (the 2026-07-24 sat-ops report: /api/sat/app answered a hard JSON 404 four seconds before ManifestRouteMounter mounted the sat-ops package route, and the cockpit surface sat on the error until a manual reload). Goes red if the boot window ever answers 404 again, if the settled state ever answers anything but the JSON 404 (the "<!DOCTYPE" guard), or if the HTML splash loses its self-refresh.
 */

import { describe, expect, it } from 'vitest';
import type { Request, Response } from 'express';
import { createApiFallbackHandler } from '../../src/app/routes/api-fallback';

/** Captured output of one mock response. */
interface Captured {
  status?: number;
  headers: Record<string, string>;
  jsonBody?: unknown;
  sentBody?: string;
  contentType?: string;
}

/**
 * @description Builds a minimal Express req/res pair for the fallback handler.
 * @param acceptsHtml - When true, req.accepts(['json','html']) resolves 'html'
 * (a browser/iframe navigation); otherwise 'json' (the fetch() Accept: star-slash-star shape).
 * @param originalUrl - The unmatched /api URL under test.
 * @returns The mock req, res, and the captured output record.
 */
function mockHttp(acceptsHtml: boolean, originalUrl: string): { req: Request; res: Response; out: Captured } {
  const out: Captured = { headers: {} };
  const req = {
    originalUrl,
    accepts: (types: string[]) => (acceptsHtml ? 'html' : types[0]),
  } as unknown as Request;
  const res = {
    status(code: number) { out.status = code; return res; },
    set(name: string, value: string) { out.headers[name] = value; return res; },
    type(t: string) { out.contentType = t; return res; },
    json(body: unknown) { out.jsonBody = body; return res; },
    send(body: string) { out.sentBody = body; return res; },
  } as unknown as Response;
  return { req, res, out };
}

describe('createApiFallbackHandler — boot window (auto-load NOT settled)', () => {
  it('fetch-shaped request (Accept */*) → 503 JSON with Retry-After, never 404', () => {
    const { req, res, out } = mockHttp(false, '/api/sat/app?v=1784874703248');
    createApiFallbackHandler(() => false)(req, res, () => undefined);
    expect(out.status).toBe(503);
    expect(out.headers['Retry-After']).toBeTruthy();
    const body = out.jsonBody as { error?: string; path?: string };
    expect(body.error).toBeTruthy();
    expect(body.error).not.toBe('Not found');
    expect(body.path).toBe('/api/sat/app?v=1784874703248');
  });

  it('browser/iframe navigation (Accept text/html) → 503 self-refreshing HTML splash', () => {
    const { req, res, out } = mockHttp(true, '/api/sat/app');
    createApiFallbackHandler(() => false)(req, res, () => undefined);
    expect(out.status).toBe(503);
    expect(out.contentType).toBe('html');
    // The splash must re-request itself, or the surface never self-heals — this is the
    // operator-visible half of the fix.
    expect(out.sentBody).toContain('http-equiv="refresh"');
  });
});

describe('createApiFallbackHandler — settled (auto-load complete)', () => {
  it('answers the exact JSON 404 shape, even for html-accepting navigations', () => {
    for (const acceptsHtml of [false, true]) {
      const { req, res, out } = mockHttp(acceptsHtml, '/api/definitely-not-a-route');
      createApiFallbackHandler(() => true)(req, res, () => undefined);
      expect(out.status).toBe(404);
      expect(out.jsonBody).toEqual({ error: 'Not found', path: '/api/definitely-not-a-route' });
      // Settled misses must NEVER be HTML — that regresses the "<!DOCTYPE" SyntaxError bug.
      expect(out.sentBody).toBeUndefined();
    }
  });

  it('consults the flag per REQUEST, so the same handler flips 503→404 when auto-load settles', () => {
    let settled = false;
    const handler = createApiFallbackHandler(() => settled);
    const first = mockHttp(false, '/api/x');
    handler(first.req, first.res, () => undefined);
    expect(first.out.status).toBe(503);
    settled = true;
    const second = mockHttp(false, '/api/x');
    handler(second.req, second.res, () => undefined);
    expect(second.out.status).toBe(404);
  });
});
