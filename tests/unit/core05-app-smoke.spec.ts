/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | CORE-05 manifest and real-loopback HTTP proof for package smoke validation/execution, rejected sentinel values, and no-AI behavior.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Prove CLI/runtime requiresUser validation parity and pending, malformed, revoked and authorized user smoke execution.
 */

import express from 'express';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  readManifest,
  verifyAppSmokes,
  type SwarmApplicationRecord,
  type SwarmAppManifest,
} from '../../src/features/swarm-apps';

let root: string;
let packageDir: string;
let manifestPath: string;
let server: Server;
let baseUrl: string;
const USER_PAT = `Bearer oshal_pat_${'a'.repeat(48)}`;
let userHits: Array<{ authorization?: string; serviceSecret?: string }> = [];

/** Construct a read-only probe whose route requires a current user identity. */
function userManifest(): SwarmAppManifest {
  return {
    name: 'user-smoke', displayName: 'User Smoke', version: '1.0.0', suite: 'ai-home',
    routes: [{ module: 'routes.js', factory: 'createRoutes', mountPath: '/api/user', auth: 'oidc' }],
    smoke: [{ name: 'user-readiness', method: 'GET', path: '/api/user/_smoke', auth: 'pat',
      requiresUser: true, expect: { status: 200, jsonPointer: '/ready', rejectValues: [false] } }],
  };
}

/** Validate through the actual standalone CLI in a separate process. */
function cliValidation(manifest: SwarmAppManifest) {
  writeFileSync(manifestPath, yaml.dump(manifest));
  return spawnSync(process.execPath, ['scripts/oshal-app.js', 'validate', packageDir], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 15000,
  });
}

/** Build the persisted record shape consumed by the verifier. */
function record(manifest: SwarmAppManifest): SwarmApplicationRecord {
  return {
    appId: 'app-1',
    name: manifest.name,
    displayName: manifest.displayName,
    description: manifest.description ?? '',
    version: manifest.version ?? '1.0.0',
    status: 'active',
    manifestPath,
    agentIds: [],
    toolNames: [],
    manifest,
    scope: 'public',
    ownerSub: null,
    tenantId: null,
    guestTierApproved: null,
    loadedAt: new Date(),
    updatedAt: new Date(),
  };
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'oshal-core05-smoke-'));
  packageDir = join(root, 'structured-note');
  mkdirSync(join(packageDir, 'fixtures'), { recursive: true });
  manifestPath = join(packageDir, 'oshal-app.yaml');
  writeFileSync(join(packageDir, 'fixtures', 'smoke.json'), '{"note":"real boundary"}', 'utf8');
  writeFileSync(join(root, 'outside.json'), '{"outside":true}', 'utf8');

  const app = express();
  app.use(express.json());
  app.get('/api/user/_smoke', (req, res) => {
    userHits.push({ authorization: req.headers.authorization, serviceSecret: req.headers['x-service-secret'] as string | undefined });
    if (req.headers.authorization !== USER_PAT) { res.status(403).json({ error: 'no_current_access' }); return; }
    res.json({ ready: true });
  });
  app.post('/api/example/_smoke', (req, res) => {
    if (req.headers['x-service-secret'] !== 'smoke-secret') {
      res.status(401).json({ error: 'bad service identity' });
      return;
    }
    res.json({ result: { type: req.body?.note === 'real boundary' ? 'structured' : 'stub' } });
  });
  app.post('/api/example/redirect', (_req, res) => res.redirect(307, '/api/example/_smoke'));
  app.post('/api/ai/_smoke', (_req, res) => {
    res.status(503).json({ error: 'ai_disabled', code: 'ai_disabled' });
  });
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  rmSync(root, { recursive: true, force: true });
});

it.each(['oidc', 'service-or-oidc'] as const)('accepts user smoke on %s in runtime and standalone CLI', auth => {
  const manifest = userManifest();
  manifest.routes![0].auth = auth;
  const cli = cliValidation(manifest);
  expect(cli.status, cli.stdout + cli.stderr).toBe(0);
  expect(readManifest(manifestPath).smoke![0].requiresUser).toBe(true);
  manifest.smoke![0].method = 'HEAD';
  delete manifest.smoke![0].expect.jsonPointer;
  delete manifest.smoke![0].expect.rejectValues;
  expect(cliValidation(manifest).status).toBe(0);
  expect(readManifest(manifestPath).smoke![0].method).toBe('HEAD');
});

it.each([
  { field: 'requiresUser', value: 'true' }, { field: 'requiresUser', value: null },
  { field: 'method', value: 'POST' }, { field: 'method', value: 'DELETE' },
  { field: 'auth', value: 'service' }, { field: 'auth', value: 'public' },
])('rejects invalid user smoke $field=$value in CLI and runtime', ({ field, value }) => {
  const manifest = userManifest();
  (manifest.smoke![0] as unknown as Record<string, unknown>)[field] = value;
  const cli = cliValidation(manifest);
  expect(cli.status).not.toBe(0);
  expect(cli.stdout + cli.stderr).toMatch(/requiresUser/);
  expect(() => readManifest(manifestPath)).toThrow(/requiresUser/);
});

it.each(['service', 'public'] as const)('rejects a closer %s route even below a user-authenticated parent', auth => {
  const manifest = userManifest();
  manifest.routes!.push({ ...manifest.routes![0], mountPath: '/api/user/_smoke', auth });
  const cli = cliValidation(manifest);
  expect(cli.status).not.toBe(0);
  expect(cli.stdout + cli.stderr).toMatch(/requiresUser/);
  expect(() => readManifest(manifestPath)).toThrow(/requiresUser/);
});

it('leaves a user smoke pending with no caller PAT even when the service secret is present', async () => {
  userHits = [];
  const manifest = userManifest();
  const result = await verifyAppSmokes([{ requestedName: manifest.name, record: record(manifest) }], {
    apiBaseUrl: baseUrl, serviceSecret: 'must-not-be-lent',
  });
  expect(result).toMatchObject({ success: true, failedApps: [], pendingApps: [manifest.name] });
  expect(result.apps[0].smokes[0]).toMatchObject({ status: 'pending', error: expect.stringContaining('Verified user context') });
  expect(userHits).toEqual([]);
});

it.each(['', 'Bearer arbitrary', `Bearer\noshal_pat_${'a'.repeat(48)}`, `${USER_PAT}\n`, `${USER_PAT} `, `Bearer oshal_pat_${'A'.repeat(48)}`])(
  'fails a supplied malformed PAT %j without sending it or hiding it behind AI prerequisites', async authorization => {
    userHits = [];
    const manifest = userManifest();
    manifest.smoke![0].requiresAi = true;
    const result = await verifyAppSmokes([{ requestedName: manifest.name, record: record(manifest) }], {
      apiBaseUrl: baseUrl, authorization, preOnboarding: true,
    });
    expect(result).toMatchObject({ success: false, failedApps: [manifest.name], pendingApps: [] });
    expect(result.apps[0].smokes[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('bearer token') });
    expect(userHits).toEqual([]);
  },
);

it('checks validly shaped PATs over HTTP, preserving a revoked denial and carrying only caller authority', async () => {
  userHits = [];
  const manifest = userManifest();
  const records = [{ requestedName: manifest.name, record: record(manifest) }];
  const revoked = `Bearer oshal_pat_${'b'.repeat(48)}`;
  const denied = await verifyAppSmokes(records, { apiBaseUrl: baseUrl, authorization: revoked });
  expect(denied.apps[0].smokes[0]).toMatchObject({ status: 'failed', error: 'HTTP 403, expected 200' });
  const passed = await verifyAppSmokes(records, { apiBaseUrl: baseUrl, authorization: USER_PAT, serviceSecret: 'must-not-be-lent' });
  expect(passed.apps[0].smokes[0]).toMatchObject({ status: 'passed', httpStatus: 200 });
  expect(userHits).toEqual([
    { authorization: revoked, serviceSecret: undefined }, { authorization: USER_PAT, serviceSecret: undefined },
  ]);
});

describe('CORE-05 app smoke contract', () => {
  it('loads the specified smoke shape and its confined static fixture', () => {
    writeFileSync(manifestPath, `
name: structured-note
displayName: Structured Note
routes:
  - module: routes.js
    factory: createRoutes
    mountPath: /api/example
    auth: service
smoke:
  - name: structured-note
    method: POST
    path: /api/example/_smoke
    auth: service
    bodyFixture: fixtures/smoke.json
    expect:
      status: 200
      jsonPointer: /result/type
      rejectValues: [noop, stub, empty]
    requiresAi: false
`, 'utf8');
    expect(readManifest(manifestPath).smoke?.[0]).toMatchObject({
      name: 'structured-note',
      path: '/api/example/_smoke',
      auth: 'service',
    });
  });

  it('fails closed on route escape, AI metadata mismatch, and secret interpolation', () => {
    writeFileSync(manifestPath, `
name: structured-note
displayName: Structured Note
routes:
  - module: routes.js
    factory: createRoutes
    mountPath: /api/example
    auth: service
smoke:
  - name: wrong-owner
    method: POST
    path: /api/other/_smoke
    auth: service
    bodyFixture: ../outside.json
    expect: { status: 200 }
    requiresAi: true
`, 'utf8');
    expect(() => readManifest(manifestPath)).toThrow(/not owned by a declared routes/);

    writeFileSync(join(packageDir, 'fixtures', 'smoke.json'), '{"token":"${SWARM_SERVICE_SECRET}"}', 'utf8');
    writeFileSync(manifestPath, `
name: structured-note
displayName: Structured Note
routes:
  - module: routes.js
    factory: createRoutes
    mountPath: /api/example
    auth: service
smoke:
  - name: interpolation
    method: POST
    path: /api/example/_smoke
    auth: service
    bodyFixture: fixtures/smoke.json
    expect: { status: 200 }
`, 'utf8');
    expect(() => readManifest(manifestPath)).toThrow(/may not reference secrets|interpolation syntax/);
    writeFileSync(join(packageDir, 'fixtures', 'smoke.json'), '{"note":"real boundary"}', 'utf8');
  });

  it('executes the real HTTP route, sends only declared auth, and rejects stub sentinels', async () => {
    const manifest: SwarmAppManifest = {
      name: 'structured-note',
      displayName: 'Structured Note',
      routes: [{ module: 'routes.js', factory: 'createRoutes', mountPath: '/api/example', auth: 'service' }],
      smoke: [{
        name: 'structured-note',
        method: 'POST',
        path: '/api/example/_smoke',
        auth: 'service',
        bodyFixture: 'fixtures/smoke.json',
        expect: { status: 200, jsonPointer: '/result/type', rejectValues: ['noop', 'stub', 'empty'] },
      }],
    };
    const passed = await verifyAppSmokes(
      [{ requestedName: manifest.name, record: record(manifest) }],
      { apiBaseUrl: baseUrl, serviceSecret: 'smoke-secret' },
    );
    expect(passed).toMatchObject({ success: true, failedApps: [] });
    expect(passed.apps[0].smokes[0]).toMatchObject({ status: 'passed', httpStatus: 200 });

    manifest.smoke![0].expect.rejectValues = ['structured'];
    const rejected = await verifyAppSmokes(
      [{ requestedName: manifest.name, record: record(manifest) }],
      { apiBaseUrl: baseUrl, serviceSecret: 'smoke-secret' },
    );
    expect(rejected.success).toBe(false);
    expect(rejected.failedApps).toEqual(['structured-note']);
    expect(rejected.apps[0].smokes[0].error).toMatch(/rejected value/);
  });

  it('proves a declared AI app route returns 503 ai_disabled on a no-AI box', async () => {
    const manifest: SwarmAppManifest = {
      name: 'ai-note',
      displayName: 'AI Note',
      routes: [{
        module: 'routes.js', factory: 'createRoutes', mountPath: '/api/ai', auth: 'service', requiresAi: true,
      }],
      smoke: [{
        name: 'ai-note', method: 'POST', path: '/api/ai/_smoke', auth: 'service',
        expect: { status: 200, jsonPointer: '/result/type', rejectValues: ['noop', 'stub', 'empty'] },
        requiresAi: true,
      }],
    };
    const result = await verifyAppSmokes(
      [{ requestedName: manifest.name, record: record(manifest) }],
      { apiBaseUrl: baseUrl, serviceSecret: 'smoke-secret', noAi: true },
    );
    expect(result.success).toBe(true);
    expect(result.apps[0].smokes[0]).toMatchObject({ status: 'passed', httpStatus: 503 });
  });

  it('does not follow package redirects while carrying verifier credentials', async () => {
    const manifest: SwarmAppManifest = {
      name: 'redirecting-app',
      displayName: 'Redirecting App',
      routes: [{ module: 'routes.js', factory: 'createRoutes', mountPath: '/api/example', auth: 'service' }],
      smoke: [{
        name: 'redirect', method: 'POST', path: '/api/example/redirect', auth: 'service',
        bodyFixture: 'fixtures/smoke.json', expect: { status: 200 },
      }],
    };
    const result = await verifyAppSmokes(
      [{ requestedName: manifest.name, record: record(manifest) }],
      { apiBaseUrl: baseUrl, serviceSecret: 'smoke-secret' },
    );
    expect(result.success).toBe(false);
    expect(result.apps[0].smokes[0].error).toBe('HTTP 307, expected 200');
  });

  it('names missing and no-smoke apps instead of inferring green', async () => {
    const noSmoke = record({ name: 'empty-app', displayName: 'Empty App' });
    const result = await verifyAppSmokes([
      { requestedName: 'missing-app', record: null },
      { requestedName: 'empty-app', record: noSmoke },
    ], { apiBaseUrl: baseUrl });
    expect(result.success).toBe(false);
    expect(result.failedApps).toEqual(['missing-app', 'empty-app']);
  });
});
