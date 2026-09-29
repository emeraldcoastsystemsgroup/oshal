/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The oshal-local delete path on the real filesystem and through the real files router: a file the surface uploaded is listed, deleted through DELETE /api/files?provider=oshal-local and absent from the folder read-back; a folder, a missing file, a traversal and another caller's file are refused with nothing removed; the surface's own upload/browse/download routes are the ones used, under a temporary workspace root.
 */
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppContext } from '@/app/composition/app-context';
import { createFilesRoutes } from '@/app/routes/files-routes';
import { deleteEntry, uploadBytes } from '@/app/routes/storage-browse';

const OWNER = 'fixture|local-delete-owner';
const OTHER = 'fixture|local-delete-other';
let root: string, server: Server, base: string, saved: string | undefined;
/** The owner's own directory on disk (userfiles/<sha256(sub) prefix>), so the delete is checked where the bytes live. */
const ownerDir = () => join(root, 'userfiles', createHash('sha256').update(OWNER).digest('hex').slice(0, 32));
const ctx = { pool: { query: async () => ({ rows: [] }) } } as unknown as AppContext;

/** One request as a signed-in caller (the fixture stamps req.oidc from a header). */
async function call(sub: string, method: string, route: string, body?: Buffer, type = 'application/pdf') {
  const response = await fetch(`${base}${route}`, { method, headers: { 'x-fixture-sub': sub, ...(body ? { 'content-type': type } : {}) }, ...(body ? { body: new Uint8Array(body) } : {}) });
  const text = await response.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text); } catch { json = {}; }
  return { status: response.status, json, text };
}
function names(sub: string, route = '/api/files/browse?provider=oshal-local&path=') {
  return call(sub, 'GET', route).then((r) => ((r.json.entries as Array<{ name: string }>) || []).map((e) => e.name));
}

beforeAll(async () => {
  saved = process.env.OSHAL_WORKSPACE_ROOT;
  root = mkdtempSync(join(tmpdir(), 'storage-local-delete-'));
  process.env.OSHAL_WORKSPACE_ROOT = root;
  const app = express();
  app.use((req, _res, next) => {
    const sub = req.headers['x-fixture-sub'];
    if (typeof sub === 'string' && sub) Object.assign(req, { oidc: { user: { sub }, isAuthenticated: () => true } });
    next();
  });
  app.use('/api/files', createFilesRoutes(ctx, root));
  server = app.listen(0, '127.0.0.1'); await new Promise<void>((done) => server.once('listening', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  if (saved === undefined) delete process.env.OSHAL_WORKSPACE_ROOT; else process.env.OSHAL_WORKSPACE_ROOT = saved;
  server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done()));
  rmSync(root, { recursive: true, force: true });
});

describe('oshal-local delete through the files surface routes', () => {
  it('uploads, lists, downloads, deletes and reads the folder back empty', async () => {
    const pdf = Buffer.from('%PDF-1.4 fixture');
    const up = await call(OWNER, 'POST', '/api/files/upload?provider=oshal-local&name=handout.pdf&dir=lesson', pdf);
    expect(up).toMatchObject({ status: 200, json: { ok: true, path: 'lesson/handout.pdf' } });
    expect(await names(OWNER, '/api/files/browse?provider=oshal-local&path=lesson')).toEqual(['handout.pdf']);
    const down = await call(OWNER, 'GET', '/api/files/download?provider=oshal-local&path=lesson%2Fhandout.pdf');
    expect(down.status).toBe(200); expect(down.text).toBe('%PDF-1.4 fixture');
    const del = await call(OWNER, 'DELETE', '/api/files?provider=oshal-local&path=lesson%2Fhandout.pdf');
    expect(del).toMatchObject({ status: 200, json: { ok: true } });
    expect(await names(OWNER, '/api/files/browse?provider=oshal-local&path=lesson')).toEqual([]);
    expect((await call(OWNER, 'DELETE', '/api/files?provider=oshal-local&path=lesson%2Fhandout.pdf')).status).toBe(502);
  });

  it('refuses a folder, a traversal, and another caller reaching for the file, removing nothing', async () => {
    await call(OWNER, 'POST', '/api/files/upload?provider=oshal-local&name=keep.pdf&dir=lesson', Buffer.from('%PDF-keep'));
    expect((await call(OWNER, 'DELETE', '/api/files?provider=oshal-local&path=lesson')).status).toBe(502);
    expect((await call(OWNER, 'DELETE', '/api/files?provider=oshal-local&path=..%2F..%2Fkeep.pdf')).status).toBe(502);
    expect((await call(OTHER, 'DELETE', '/api/files?provider=oshal-local&path=lesson%2Fkeep.pdf')).status).toBe(502);
    expect((await call('', 'DELETE', '/api/files?provider=oshal-local&path=lesson%2Fkeep.pdf')).status).toBe(401);
    expect(await names(OWNER, '/api/files/browse?provider=oshal-local&path=lesson')).toEqual(['keep.pdf']);
    await expect(deleteEntry(ctx, OWNER, 'oshal-local', 'lesson')).rejects.toThrow('file not found');
    await expect(deleteEntry(ctx, OWNER, 'oshal-local', '../escape.pdf')).rejects.toThrow('invalid path');
    expect(existsSync(join(ownerDir(), 'lesson', 'keep.pdf'))).toBe(true);
    await deleteEntry(ctx, OWNER, 'oshal-local', 'lesson/keep.pdf');
    expect(existsSync(join(ownerDir(), 'lesson', 'keep.pdf'))).toBe(false);
    expect(existsSync(join(ownerDir(), 'lesson'))).toBe(true);
    await uploadBytes(ctx, OWNER, 'oshal-local', '', 'root.pdf', Buffer.from('%PDF-root'));
    expect(await names(OWNER)).toContain('root.pdf');
    await deleteEntry(ctx, OWNER, 'oshal-local', 'root.pdf');
    expect(await names(OWNER)).not.toContain('root.pdf');
  });
});
