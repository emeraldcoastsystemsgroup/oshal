/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — deleteStoredFile's offline contract: local-provider delete really unlinks (and only inside the user's own store — traversal names are reduced to their basename), a missing file resolves as already-gone instead of erroring, an empty name throws, and a GitHub target refuses with keeps-history rather than synthesizing a deletion commit. Network adapters (Dropbox/Drive/OneDrive) are proven live, not here.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// storage-target computes its LOCAL_ROOT from CLINE_WORKSPACE_ROOT at module load, so the
// module under test must be imported AFTER the env points at a scratch dir — hence the
// dynamic import in beforeAll instead of a hoisted static import.
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-storage-delete-'));
process.env.CLINE_WORKSPACE_ROOT = SCRATCH;

type StorageModule = typeof import('../../src/app/routes/storage-target');
let mod: StorageModule;

const SUB = 'auth0|storage-delete-spec';
const SUBFOLDER = 'oshal/a0000000-0000-0000-0000-000000000042';

/** Mirrors storage-target's userKey() so the spec can address the user's local dir. */
function userKey(sub: string): string { return crypto.createHash('sha256').update(sub).digest('hex').slice(0, 32); }
const userRoot = () => path.join(SCRATCH, 'userfiles', userKey(SUB));

/** A pool stub: no saved prefs + no connections → the files target defaults to oshal-local. */
const localCtx = {
  pool: { query: async () => ({ rows: [] }) },
} as unknown as Parameters<StorageModule['deleteStoredFile']>[0];

/** A pool stub whose prefs row pins the files target to GitHub. */
const githubCtx = {
  pool: {
    query: async (sql: string) => (
      sql.includes('oshal_storage_prefs')
        ? { rows: [{ files_provider: 'github', files_repo: 'some-repo', files_folder: '' }] }
        : { rows: [] }
    ),
  },
} as unknown as Parameters<StorageModule['deleteStoredFile']>[0];

beforeAll(async () => {
  mod = await import('../../src/app/routes/storage-target');
});

afterAll(() => {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
});

describe('deleteStoredFile — local provider', () => {
  it('unlinks a saved file and reports removed', async () => {
    await mod.saveContent(localCtx, SUB, 'files', 'gone.pptx', Buffer.from('x'), undefined, SUBFOLDER);
    const onDisk = path.join(userRoot(), SUBFOLDER, 'gone.pptx');
    expect(fs.existsSync(onDisk)).toBe(true);

    const out = await mod.deleteStoredFile(localCtx, SUB, 'files', 'gone.pptx', SUBFOLDER);
    expect(out).toMatchObject({ provider: 'oshal-local', removed: true });
    expect(fs.existsSync(onDisk)).toBe(false);
  });

  it('treats a file that is already gone as a success, not an error', async () => {
    const out = await mod.deleteStoredFile(localCtx, SUB, 'files', 'never-existed.docx', SUBFOLDER);
    expect(out).toMatchObject({ provider: 'oshal-local', removed: true, reason: 'already-gone' });
  });

  it('reduces a traversal name to its basename — a file outside the subfolder is never touched', async () => {
    // A victim OUTSIDE the bot subfolder (at the user root); the hostile name tries to reach it.
    const victim = path.join(userRoot(), 'victim.xlsx');
    fs.mkdirSync(userRoot(), { recursive: true });
    fs.writeFileSync(victim, 'precious');

    const out = await mod.deleteStoredFile(localCtx, SUB, 'files', '../victim.xlsx', SUBFOLDER);
    // basename('../victim.xlsx') = 'victim.xlsx', looked up INSIDE the subfolder → not there.
    expect(out).toMatchObject({ removed: true, reason: 'already-gone' });
    expect(fs.existsSync(victim)).toBe(true);
    fs.rmSync(victim);
  });

  it('throws on an empty or dot-only name', async () => {
    await expect(mod.deleteStoredFile(localCtx, SUB, 'files', '', SUBFOLDER)).rejects.toThrow(/file name/);
    await expect(mod.deleteStoredFile(localCtx, SUB, 'files', '..', SUBFOLDER)).rejects.toThrow(/file name/);
  });
});

describe('deleteStoredFile — github target', () => {
  it('refuses with keeps-history instead of synthesizing a deletion commit', async () => {
    const out = await mod.deleteStoredFile(githubCtx, SUB, 'files', 'report.docx', SUBFOLDER);
    expect(out).toEqual({ provider: 'github', removed: false, reason: 'github-keeps-history' });
  });

  it('an explicit local override beats the resolved target — a row recorded on the local store deletes there', async () => {
    // The caller's CURRENT target is github, but the file physically lives in the local store
    // (they switched targets after generating). The override reaches it; no orphan.
    await mod.saveContent(localCtx, SUB, 'files', 'switched-target.pptx', Buffer.from('x'), undefined, SUBFOLDER);
    const onDisk = path.join(userRoot(), SUBFOLDER, 'switched-target.pptx');
    expect(fs.existsSync(onDisk)).toBe(true);

    const out = await mod.deleteStoredFile(githubCtx, SUB, 'files', 'switched-target.pptx', SUBFOLDER, { provider: 'oshal-local' });
    expect(out).toMatchObject({ provider: 'oshal-local', removed: true });
    expect(fs.existsSync(onDisk)).toBe(false);
  });
});
