/**
 * Storage Browse (OSHAL-local) — real filesystem exercise of the unified file browser's core.
 *
 * The Dropbox/GitHub providers need live per-user tokens, but OSHAL-local is pure filesystem, so
 * these tests prove the browser logic for real: roots, folder drill-down (folders-first sort),
 * inline text preview, byte download, the 'none' encoding for binaries, and — critically —
 * path-traversal safety (a `..`-laden path can't escape the per-user root).
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — oshal-local browse/preview/readBytes + traversal-safety tests for the unified file browser.
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import * as mod from '@/app/routes/storage-browse';

const SUB = 'test-user-sub-123';
const userKey = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 32);
/** Local-only functions ignore ctx.pool; listRoots queries it (no connections → local-only). */
const ctx = { pool: { query: async () => ({ rows: [] as unknown[] }) } } as any;

let root: string;

test.beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-browse-'));
  process.env.CLINE_WORKSPACE_ROOT = root; // read lazily per call → fine to set after import
  const userRoot = path.join(root, 'userfiles', userKey(SUB));
  const deep = path.join(userRoot, 'oshal', 'deck-bot');
  fs.mkdirSync(deep, { recursive: true });
  fs.writeFileSync(path.join(userRoot, 'top.md'), '# Top level');
  fs.writeFileSync(path.join(deep, 'Q3 deck.txt'), 'hello world'); // space in name on purpose
  fs.writeFileSync(path.join(deep, 'blob.bin'), Buffer.from([0, 1, 2, 3, 255]));
});

test.afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

test('listRoots returns OSHAL-local when nothing else is connected', async () => {
  const roots = await mod.listRoots(ctx, SUB);
  expect(roots.map((r) => r.provider)).toEqual(['oshal-local']);
});

test('browse root lists folders before files', async () => {
  const entries = await mod.browse(ctx, SUB, 'oshal-local', '');
  expect(entries.map((e) => `${e.type}:${e.name}`)).toEqual(['folder:oshal', 'file:top.md']);
});

test('drill-down into a subfolder reaches a file with a space in its name', async () => {
  const entries = await mod.browse(ctx, SUB, 'oshal-local', 'oshal/deck-bot');
  const deck = entries.find((e) => e.name === 'Q3 deck.txt');
  expect(deck).toBeTruthy();
  expect(deck!.path).toBe('oshal/deck-bot/Q3 deck.txt');
  expect(deck!.size).toBe('hello world'.length);
});

test('previewFile returns inline text for a text file', async () => {
  const pv = await mod.previewFile(ctx, SUB, 'oshal-local', 'oshal/deck-bot/Q3 deck.txt');
  expect(pv.encoding).toBe('text');
  expect(pv.content).toBe('hello world');
  expect(pv.name).toBe('Q3 deck.txt');
  expect(pv.downloadUrl).toContain('provider=oshal-local');
});

test('previewFile returns none (download-only) for a binary', async () => {
  const pv = await mod.previewFile(ctx, SUB, 'oshal-local', 'oshal/deck-bot/blob.bin');
  expect(pv.encoding).toBe('none');
});

test('readBytes returns the exact file bytes', async () => {
  const { name, buf } = await mod.readBytes(ctx, SUB, 'oshal-local', 'oshal/deck-bot/Q3 deck.txt');
  expect(name).toBe('Q3 deck.txt');
  expect(buf.toString('utf8')).toBe('hello world');
});

test('path traversal cannot escape the per-user root', async () => {
  // `..` segments are stripped, so this resolves to <root>/etc/passwd (nonexistent), never the real one.
  await expect(mod.readBytes(ctx, SUB, 'oshal-local', '../../../../etc/passwd')).rejects.toThrow();
  // Browsing `..` stays at the user root rather than climbing out.
  const up = await mod.browse(ctx, SUB, 'oshal-local', '..');
  expect(up.map((e) => e.name).sort()).toEqual(['oshal', 'top.md']);
});
