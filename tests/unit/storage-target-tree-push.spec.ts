/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for pushTree() — the large-tree multi-file git push leg. Mocks the git boundary (fetch + token/owner helpers) and pins the three honest outcomes: a clean success (many files -> ONE commit), partial-failure (a blob that fails is reported in failed[] while the rest still commit), and an oversize reject that refuses the whole push BEFORE any API call (atomic). Plus wrong-provider + all-blobs-failed guards.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock the git boundary helpers the SUT reaches for (token + owner). Both are keyed by resolved
// module id, so mocking via the @/ alias intercepts storage-target's ./relative imports.
vi.mock('@/app/routes/connectors-routes', () => ({ getValidAccessToken: vi.fn(async () => 'gh-token') }));
vi.mock('@/app/routes/storage-browse', () => ({ resolveGithubOwner: vi.fn(async () => 'octocat') }));

import { pushTree, type TreePushFile } from '@/app/routes/storage-target';
import type { AppContext } from '@/app/composition/app-context';

const ctx = { pool: { query: async () => ({ rows: [] }) } } as unknown as AppContext;
const GITHUB_TARGET = { provider: 'github' as const, repo: 'my-build' };
const FILES: TreePushFile[] = [
  { path: 'src/a.ts', content: 'export const a = 1;' },
  { path: 'README.md', content: 'hello' },
];

type Json = Record<string, unknown>;
/** A Response-shaped stub — only .ok/.status/.json are read by the SUT. */
function res(body: Json, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

/** Route the Git Data API calls the SUT makes. blobFailAt fails the Nth blob; blobFailAll fails every blob. */
function makeFetch(opts: { blobFailAt?: number; blobFailAll?: boolean } = {}): ReturnType<typeof vi.fn> {
  let blobN = 0;
  return vi.fn(async (input: unknown, init?: { method?: string }) => {
    const url = String(input);
    const method = (init?.method || 'GET').toUpperCase();
    if (method === 'GET' && url.includes('/git/ref/heads/')) return res({ object: { sha: 'HEADSHA' } });
    if (method === 'GET' && url.includes('/git/commits/')) return res({ tree: { sha: 'BASETREE' } });
    if (method === 'POST' && url.endsWith('/git/blobs')) {
      blobN += 1;
      if (opts.blobFailAll || opts.blobFailAt === blobN) return res({ message: 'blob rejected' }, 422);
      return res({ sha: `blob-${blobN}` });
    }
    if (method === 'POST' && url.endsWith('/git/trees')) return res({ sha: 'NEWTREE' });
    if (method === 'POST' && url.endsWith('/git/commits')) {
      return res({ sha: 'NEWCOMMIT', html_url: 'https://github.com/octocat/my-build/commit/NEWCOMMIT' });
    }
    if (method === 'PATCH' && url.includes('/git/refs/heads/')) return res({ object: { sha: 'NEWCOMMIT' } });
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('pushTree — multi-file tree push (git boundary mocked)', () => {
  it('batches many files into ONE commit on success', async () => {
    vi.stubGlobal('fetch', makeFetch());
    const out = await pushTree(ctx, 'user-1', FILES, { target: GITHUB_TARGET, branch: 'main' });
    expect(out.provider).toBe('github');
    expect(out.commitSha).toBe('NEWCOMMIT');
    expect(out.commitUrl).toContain('/commit/NEWCOMMIT');
    expect(out.branch).toBe('main');
    expect(out.pushed).toEqual(['src/a.ts', 'README.md']);
    expect(out.failed).toEqual([]);
  });

  it('prefixes the target base folder onto each pushed path', async () => {
    vi.stubGlobal('fetch', makeFetch());
    const out = await pushTree(ctx, 'user-1', FILES, { target: { ...GITHUB_TARGET, folder: '/builds/' }, branch: 'main' });
    expect(out.pushed).toEqual(['builds/src/a.ts', 'builds/README.md']);
  });

  it('reports a per-file blob failure in failed[] while the rest still commit (partial-failure)', async () => {
    vi.stubGlobal('fetch', makeFetch({ blobFailAt: 2 }));
    const out = await pushTree(ctx, 'user-1', FILES, { target: GITHUB_TARGET, branch: 'main' });
    expect(out.commitSha).toBe('NEWCOMMIT'); // the survivors still land
    expect(out.pushed).toEqual(['src/a.ts']);
    expect(out.failed).toHaveLength(1);
    expect(out.failed[0].path).toBe('README.md');
    expect(out.failed[0].reason).toContain('422');
  });

  it('rejects the whole push atomically when a file exceeds the size cap (nothing sent)', async () => {
    const fetchMock = makeFetch();
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      pushTree(ctx, 'user-1', [{ path: 'big.bin', content: 'way-too-long' }], { target: GITHUB_TARGET, branch: 'main', maxFileBytes: 3 }),
    ).rejects.toThrow(/rejected/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects the whole push when the aggregate exceeds the tree cap', async () => {
    const fetchMock = makeFetch();
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      pushTree(ctx, 'user-1', FILES, { target: GITHUB_TARGET, branch: 'main', maxTreeBytes: 4 }),
    ).rejects.toThrow(/rejected/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a non-GitHub target', async () => {
    const fetchMock = makeFetch();
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      pushTree(ctx, 'user-1', FILES, { target: { provider: 'dropbox', folder: '/' } }),
    ).rejects.toThrow(/GitHub Code target/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws (no empty commit) when every blob fails', async () => {
    vi.stubGlobal('fetch', makeFetch({ blobFailAll: true }));
    await expect(
      pushTree(ctx, 'user-1', FILES, { target: GITHUB_TARGET, branch: 'main' }),
    ).rejects.toThrow(/no blobs created/);
  });
});
