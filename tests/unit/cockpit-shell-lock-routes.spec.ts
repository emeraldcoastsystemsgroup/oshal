/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The cockpit document and the experience entry pages behind a real Express listener: a non-operator on a focused deployment is redirected to the landing (plain cockpit, index.html, /portal, /homebase, /little-monsters), an operator and a focused ?app= request are served, assets are untouched, and a deployment without a focused landing serves everyone as before.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
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
    for (const path of ['/cockpit/', '/cockpit', '/cockpit/index.html', '/portal', '/experience/', '/homebase?preset=family', '/nexus', '/studio', '/jarvis', '/orbit', '/commons', '/simple', '/little-monsters']) {
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
});

describe('deployment without a focused landing', () => {
  beforeAll(() => startApp('/cockpit/'));
  afterAll(stop);

  it('serves the plain cockpit and the experience pages to a non-operator as before', async () => {
    expect((await get('/cockpit/')).status).toBe(200);
    expect((await get('/portal')).status).toBe(200);
    const classroom = await get('/little-monsters');
    expect(classroom.status).toBe(302);
    expect(classroom.headers.get('location')).toBe('/homebase?preset=classroom');
  });
});
