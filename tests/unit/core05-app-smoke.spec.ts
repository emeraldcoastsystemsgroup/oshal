/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | CORE-05 manifest and real-loopback HTTP proof for package smoke validation/execution, rejected sentinel values, and no-AI behavior.
 */

import express from 'express';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
