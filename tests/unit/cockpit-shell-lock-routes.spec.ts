/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | The cockpit document and the experience entry pages behind a real Express listener: a non-operator on a focused deployment is redirected to the landing (plain cockpit, index.html, /portal, /homebase, /little-monsters), an operator and a focused ?app= request are served, assets are untouched, and a deployment without a focused landing serves everyone as before.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Preserve focused shell lock for package entry aliases, including raw legacy documents.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Every spelling of a surface over a raw socket (fetch would normalise the dot segments and %2e escapes before sending): case, doubled-slash, dot-segment, percent-encoded and malformed spellings of the cockpit document, /experience/index.html, nexus.html and simple.html, and HEAD, all redirect a non-operator on a focused host; ?app= exempts only the cockpit document; operators, the unfocused deployment and assets are unchanged.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { request as httpRequest, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerCockpitStaticRoutes } from '@/app/routes/cockpit-static-routes';

const LANDING = '/cockpit/?app=intelligent-sales';
let server: Server;
let baseUrl = '';
let dir = '';

/** The fake session: the operator header stands in for the swarm_roles snapshot; every request is signed in. */
function startApp(landing: string): Promise<void> {
  const app = express();
  const requiresAuth: express.RequestHandler = (req, _res, next) => {
    (req as unknown as { oidc: { user: { sub: string } } }).oidc = { user: { sub: String(req.headers['x-test-sub'] || 'local-rep') } };
    next();
  };
  registerCockpitStaticRoutes({
    app, requiresAuth, cockpitDir: join(dir, 'cockpit'), uiEnhancedDir: join(dir, 'ui-enhanced'),
    codiconFontsDir: join(dir, 'fonts'), sharedUiCssDir: join(dir, 'css'), sharedUiJsDir: join(dir, 'js'),
    shellLock: { isOperator: (req) => req.headers['x-test-operator'] === '1', landingPath: () => landing },
  });
  return new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => { baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; resolve(); });
  });
}

/**
 * @description One request over a raw socket with the path exactly as written: fetch (WHATWG URL)
 * collapses dot segments and %2e escapes before sending, which is the spelling under test.
 * @param path - The raw request target. @param operator - Whether the fake session is an operator.
 * @param method - GET or HEAD.
 * @returns Status, Location and body text.
 */
function raw(path: string, operator = false, method = 'GET'): Promise<{ status: number; location: string | undefined; text: string }> {
  const { port } = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: Number(port), path, method, headers: operator ? { 'x-test-operator': '1' } : {} }, (res) => {
      let text = ''; res.setEncoding('utf8'); res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, location: res.headers.location, text }));
    });
    req.on('error', reject); req.end();
  });
}

const get = (path: string, operator = false) => fetch(`${baseUrl}${path}`, { redirect: 'manual', headers: operator ? { 'x-test-operator': '1' } : {} });
const stop = () => new Promise<void>((resolve) => { server ? server.close(() => resolve()) : resolve(); });

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cockpit-shell-lock-'));
  for (const sub of ['cockpit', 'cockpit/js', 'ui-enhanced', 'fonts', 'css', 'js']) mkdirSync(join(dir, sub), { recursive: true });
  writeFileSync(join(dir, 'cockpit', 'index.html'), '<!doctype html><title>cockpit fixture</title>');
  writeFileSync(join(dir, 'cockpit', 'js', 'app.js'), '// fixture asset');
});
afterAll(async () => { await stop(); rmSync(dir, { recursive: true, force: true }); });

describe('focused-landing deployment', () => {
  beforeAll(() => startApp(LANDING));
  afterAll(stop);

  it('redirects a non-operator from the plain cockpit document and every experience entry page to the landing', async () => {
    for (const path of ['/cockpit/', '/cockpit', '/cockpit/index.html', '/portal', '/experience/', '/homebase?preset=family', '/nexus', '/studio', '/jarvis', '/orbit', '/commons', '/simple', '/little-monsters', '/experience/studio.html', '/experience/homebase.html']) {
      const res = await get(path);
      expect(res.status, path).toBe(302);
      expect(res.headers.get('location'), path).toBe(LANDING);
    }
  });

  it('serves the cockpit document to an operator, and a focused ?app= request to anyone', async () => {
    const operator = await get('/cockpit/', true);
    expect(operator.status).toBe(200);
    expect(await operator.text()).toContain('cockpit fixture');
    const portal = await get('/portal', true);
    expect(portal.status).toBe(200);
    const focused = await get('/cockpit/?app=intelligent-sales');
    expect(focused.status).toBe(200);
    expect(await focused.text()).toContain('cockpit fixture');
    const other = await get('/cockpit/?app=dnd');
    expect(other.status).toBe(200);
  });

  it('leaves cockpit assets alone for everyone', async () => {
    const asset = await get('/cockpit/js/app.js');
    expect(asset.status).toBe(200);
    expect(await asset.text()).toContain('fixture asset');
  });

  it('redirects every spelling of the cockpit document and the experience pages, including HEAD', async () => {
    for (const path of ['/Cockpit/', '/COCKPIT/', '/COCKPIT/index.html', '/Cockpit/index.html', '/cockpit/js/../index.html', '/cockpit//',
      '/cockpit/%69ndex.html', '/%63ockpit/', '/cockpit%2Findex.html', '/cockpit/%2e%2e/cockpit/', '/cockpit/./', '/cockpit/%E0%A4%A',
      '/experience/index.html', '/experience/nexus.html', '/experience/simple.html', '/Experience/Index.html', '/experience//nexus.html',
      '/Portal', '/Nexus', '/SIMPLE/', '/Studio']) {
      const res = await raw(path);
      expect(res.status, path).toBe(302);
      expect(res.location, path).toBe(LANDING);
    }
    const head = await raw('/Cockpit/', false, 'HEAD');
    expect([head.status, head.location]).toEqual([302, LANDING]);
  });

  it('honours ?app= on the cockpit document only, never on an experience page', async () => {
    expect((await raw('/Cockpit/?app=dnd')).status).toBe(200);
    for (const path of ['/portal?app=zzz', '/nexus?app=zzz', '/simple?app=zzz', '/experience/?app=zzz', '/experience/index.html?app=zzz', '/studio?app=zzz']) {
      const res = await raw(path);
      expect([res.status, res.location], path).toEqual([302, LANDING]);
    }
  });

  it('serves every spelling to an operator, and leaves assets and the experience scripts alone for a non-operator', async () => {
    for (const path of ['/Cockpit/', '/cockpit/js/../index.html', '/cockpit//']) {
      const res = await raw(path, true);
      expect(res.status, path).toBe(200);
      expect(res.text, path).toContain('cockpit fixture');
    }
    expect((await raw('/experience/nexus.html', true)).status).toBe(200);
    expect((await raw('/cockpit/js/app.js')).status).toBe(200);
    expect((await raw('/COCKPIT/js/app.js')).status).toBe(200);
    expect((await raw('/experience/live-data.js')).status).toBe(200);
  });
});

describe('deployment without a focused landing', () => {
  beforeAll(() => startApp('/cockpit/'));
  afterAll(stop);

  it('serves the plain cockpit and the experience pages to a non-operator as before', async () => {
    expect((await get('/cockpit/')).status).toBe(200);
    expect((await get('/portal')).status).toBe(200);
    const classroom = await get('/little-monsters');
    expect(classroom.status).toBe(302);
    expect(classroom.headers.get('location')).toBe('/api/ui/experiences/classroom-experience/open');
  });

  it('serves the spellings and the experience pages exactly as before', async () => {
    for (const path of ['/Cockpit/', '/cockpit/js/../index.html', '/experience/index.html', '/experience/nexus.html', '/portal?app=zzz']) {
      expect((await raw(path)).status, path).toBe(200);
    }
  });
});
