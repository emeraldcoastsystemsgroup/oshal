/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1   | maintainer@emeraldcoastsystemsgroup.com     | Prove package Takeout registration, archive guards, owner dispatch, and lifecycle teardown.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import JSZip from 'jszip';
import type { AppContext } from '@/app/composition/app-context';
import { createTakeoutRoutes } from '@/app/routes/takeout-routes';
import { TakeoutSliceRegistry } from '@/app/takeout-slice-registry';
import { readManifest, SwarmAppService, type SwarmAppTakeoutSliceDeclaration } from '@/features/swarm-apps';
import { ingestTakeoutWatchHistory as ingestKidLensTakeout } from '../../../oshal-applications/youtube-kids/src-routes/youtube-kids-routes';

const ARCHIVE_JSON = 'Takeout/Product/history.json';
const ARCHIVE_HTML = 'Takeout/Product/history.html';
const HANDLER_JS = `
exports.ingestProduct = async function (ctx, input) {
  return { summary: input.userSub + '|' + input.content + '|' + require('path').basename(ctx.appPackageDir) };
};
`;

const fakeContext = { pool: { query: async () => ({ rows: [], rowCount: 0 }) } } as unknown as AppContext;
let packageDir: string;
let registry: TakeoutSliceRegistry;
let server: Server;
let baseUrl: string;
const manifestDirs: string[] = [];

function declaration(overrides: Partial<SwarmAppTakeoutSliceDeclaration> = {}): SwarmAppTakeoutSliceDeclaration {
  return {
    kind: 'product-activity',
    label: 'Product activity',
    pathSuffix: ARCHIVE_JSON,
    htmlPathSuffix: ARCHIVE_HTML,
    maxBytes: 1024,
    module: 'handler.js',
    handler: 'ingestProduct',
    ...overrides,
  };
}

async function archive(entries: Record<string, string>): Promise<Buffer> {
  const zip = new JSZip();
  for (const [name, value] of Object.entries(entries)) zip.file(name, value);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

async function postZip(buffer: Buffer, userSub = 'owner-a'): Promise<Response> {
  return fetch(`${baseUrl}/api/takeout/ingest-zip`, {
    method: 'POST',
    headers: { 'content-type': 'application/zip', 'x-test-sub': userSub },
    body: new Uint8Array(buffer),
  });
}

beforeAll(async () => {
  packageDir = mkdtempSync(join(tmpdir(), 'oshal-takeout-package-'));
  writeFileSync(join(packageDir, 'handler.js'), HANDLER_JS, 'utf8');
  registry = new TakeoutSliceRegistry(fakeContext);

  const app = express();
  app.use((req, _res, next) => {
    (req as typeof req & { oidc: { user: { sub: string } } }).oidc = {
      user: { sub: String(req.headers['x-test-sub'] ?? '') },
    };
    next();
  });
  app.use('/api/takeout', createTakeoutRoutes(fakeContext, registry));
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  rmSync(packageDir, { recursive: true, force: true });
  for (const dir of manifestDirs) rmSync(dir, { recursive: true, force: true });
});

describe('package-contributed Takeout route', () => {
  it('routes one whole archive to the authenticated owner and keeps owners distinct', async () => {
    await registry.register('product-app', packageDir, [declaration()]);
    const payload = await archive({ [ARCHIVE_JSON]: '{"rows":[1]}' });

    const ownerA = await postZip(payload, 'owner-a');
    const ownerB = await postZip(payload, 'owner-b');
    expect(ownerA.status).toBe(200);
    expect(ownerB.status).toBe(200);
    const bodyA = await ownerA.json() as { ingested: Array<{ ok: boolean; summary: string }> };
    const bodyB = await ownerB.json() as { ingested: Array<{ ok: boolean; summary: string }> };
    expect(bodyA.ingested).toEqual([
      expect.objectContaining({ ok: true, summary: expect.stringContaining('owner-a|{"rows":[1]}') }),
    ]);
    expect(bodyB.ingested).toEqual([
      expect.objectContaining({ ok: true, summary: expect.stringContaining('owner-b|{"rows":[1]}') }),
    ]);
    expect(bodyA.ingested[0].summary).not.toContain('owner-b');
  });

  it('retracts the archive path immediately on unregister', async () => {
    await registry.register('product-app', packageDir, [declaration()]);
    registry.unregister('product-app');
    const response = await postZip(await archive({ [ARCHIVE_JSON]: '{}' }));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: 'no_known_slices', ingested: [] });
  });

  it('reports a known HTML export without handing it to the JSON handler', async () => {
    await registry.register('product-app', packageDir, [declaration()]);
    const response = await postZip(await archive({ [ARCHIVE_HTML]: '<html></html>' }));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: 'no_known_slices', htmlHits: [ARCHIVE_HTML] });
  });

  it('returns 413 before package code for declared uncompressed-byte overflow', async () => {
    await registry.register('product-app', packageDir, [declaration({ maxBytes: 5 })]);
    const response = await postZip(await archive({ [ARCHIVE_JSON]: '123456' }));
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: 'takeout_slice_too_large' });
  });

  it('rejects duplicate logical entries and cross-app path/kind collisions', async () => {
    await registry.register('product-app', packageDir, [declaration()]);
    const duplicate = await postZip(await archive({
      [`one/${ARCHIVE_JSON}`]: '{}',
      [`two/${ARCHIVE_JSON}`]: '{}',
    }));
    expect(duplicate.status).toBe(422);
    expect(await duplicate.json()).toMatchObject({ error: 'bad_archive' });

    await expect(registry.register('other-app', packageDir, [declaration()]))
      .rejects.toThrow(/already registered/);
  });

  it('confines handler modules to the real package directory', async () => {
    registry.unregister('product-app');
    await expect(registry.register('escaped-app', packageDir, [declaration({ module: '../outside.js' })]))
      .rejects.toThrow(/outside package/);
  });
});

describe('Kid Lens package handler', () => {
  it('reuses the encrypted direct-upload store and keys each write to the supplied owner', async () => {
    const previousSecret = process.env.SESSION_SECRET;
    process.env.SESSION_SECRET = 'takeout-registration-test-secret';
    const writes: Array<{ sql: string; params?: unknown[] }> = [];
    const pool = {
      query: async (sql: string, params?: unknown[]) => {
        if (sql.includes('INSERT INTO oshal_youtube_activity')) writes.push({ sql, params });
        return { rows: [], rowCount: 0 };
      },
    };
    const content = JSON.stringify([{
      title: 'Watched Build a glider',
      subtitles: [{ name: 'Science Channel' }],
      time: '2026-08-05T10:00:00.000Z',
    }]);
    try {
      const ownerA = await ingestKidLensTakeout(
        { ...fakeContext, pool } as unknown as AppContext,
        { userSub: 'parent-a', content, fileName: ARCHIVE_JSON },
      );
      const ownerB = await ingestKidLensTakeout(
        { ...fakeContext, pool } as unknown as AppContext,
        { userSub: 'parent-b', content, fileName: ARCHIVE_JSON },
      );
      expect(ownerA.summary).toContain('1 watch entries across 1 channels');
      expect(ownerB.summary).toContain('1 watch entries across 1 channels');
      expect(writes.map((write) => write.params?.[0])).toEqual(['parent-a', 'parent-b']);
      expect(writes[0].params?.[2]).not.toBe(content);
      expect(String(writes[0].params?.[2]).split(':')).toHaveLength(3);
    } finally {
      if (previousSecret === undefined) delete process.env.SESSION_SECRET;
      else process.env.SESSION_SECRET = previousSecret;
    }
  });
});

describe('Takeout manifest validation', () => {
  function manifest(body: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'oshal-takeout-manifest-'));
    manifestDirs.push(dir);
    const file = join(dir, 'oshal-app.yaml');
    writeFileSync(file, `name: takeout-test\ndisplayName: Takeout Test\nsuite: ai-home\n${body}`, 'utf8');
    return file;
  }

  it('accepts the bounded literal declaration and rejects regex/traversal/byte/path ambiguity', () => {
    expect(readManifest(manifest([
      'takeout:',
      '  - kind: product-activity',
      '    label: Product activity',
      `    pathSuffix: ${ARCHIVE_JSON}`,
      `    htmlPathSuffix: ${ARCHIVE_HTML}`,
      '    maxBytes: 1024',
      '    module: routes/product.js',
      '    handler: ingestProduct',
      '',
    ].join('\n'))).takeout).toHaveLength(1);

    expect(() => readManifest(manifest([
      'takeout:',
      '  - kind: product-activity',
      '    label: Product activity',
      '    pathSuffix: "(?i)history.json"',
      '    module: ../outside.js',
      '    handler: ingestProduct',
      '',
    ].join('\n')))).toThrow(/pathSuffix|module/);

    expect(() => readManifest(manifest([
      'takeout:',
      '  - kind: product-activity',
      '    label: Product activity',
      `    pathSuffix: ${ARCHIVE_JSON}`,
      `    htmlPathSuffix: ${ARCHIVE_JSON}`,
      '    module: routes/product.js',
      '    handler: ingestProduct',
      '',
    ].join('\n')))).toThrow(/HTML file/);

    expect(() => readManifest(manifest([
      'takeout:',
      '  - kind: product-activity',
      '    label: Product activity',
      `    pathSuffix: ${ARCHIVE_JSON}`,
      '    maxBytes: 134217729',
      '    module: routes/product.js',
      '    handler: ingestProduct',
      '',
    ].join('\n')))).toThrow(/maxBytes/);

    expect(() => readManifest(manifest([
      'takeout:',
      '  - kind: product-activity',
      '    label: Product activity',
      `    pathSuffix: ${ARCHIVE_JSON}`,
      '    module: routes/product.js',
      '    handler: ingestProduct',
      '  - kind: product-activity-copy',
      '    label: Product activity copy',
      `    pathSuffix: ${ARCHIVE_JSON}`,
      '    module: routes/product.js',
      '    handler: ingestProduct',
      '',
    ].join('\n')))).toThrow(/duplicate Takeout pathSuffix/);
  });
});

describe('SwarmAppService Takeout lifecycle', () => {
  it('registers on active load and unregisters on toggle-off', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oshal-takeout-lifecycle-'));
    const manifestPath = join(dir, 'oshal-app.yaml');
    writeFileSync(manifestPath, [
      'name: lifecycle-app',
      'displayName: Lifecycle App',
      'suite: ai-home',
      'status: active',
      'takeout:',
      '  - kind: product-activity',
      '    label: Product activity',
      `    pathSuffix: ${ARCHIVE_JSON}`,
      '    module: handler.js',
      '    handler: ingestProduct',
      '',
    ].join('\n'), 'utf8');

    let record: any;
    const repo = {
      findByName: async () => record ?? null,
      upsert: async (loaded: any) => {
        record = {
          appId: loaded.name,
          name: loaded.name,
          displayName: loaded.displayName,
          description: '',
          version: '1',
          status: loaded.status ?? 'active',
          manifestPath,
          agentIds: [],
          toolNames: [],
          manifest: loaded,
          scope: 'public',
          ownerSub: null,
          tenantId: null,
          guestTierApproved: null,
          loadedAt: new Date(),
          updatedAt: new Date(),
        };
        return record;
      },
      list: async () => record ? [record] : [],
      updateStatus: async (_name: string, status: 'active' | 'inactive') => {
        record = { ...record, status };
        return record;
      },
    };
    const events: string[] = [];
    const service = new SwarmAppService(
      fakeContext.pool,
      repo as never,
      { updateAgentStatus: async () => undefined } as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        register: async (appName, loadedPackageDir, declarations) => {
          events.push(`register:${appName}:${loadedPackageDir}:${declarations.length}`);
        },
        unregister: (appName) => { events.push(`unregister:${appName}`); },
      },
    );
    try {
      await service.loadApp(manifestPath);
      expect(events).toEqual([`register:lifecycle-app:${dir}:1`]);
      await service.toggleApp('lifecycle-app', false);
      expect(events).toEqual([`register:lifecycle-app:${dir}:1`, 'unregister:lifecycle-app']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
