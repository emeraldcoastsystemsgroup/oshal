/**
 * Google Drive storage contract tests.
 *
 * These tests exercise the provider helpers with a mocked owner-token broker and mocked fetch.
 * No request can reach Google and no external file is created or deleted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tokenBroker = vi.hoisted(() => ({
  getValidAccessToken: vi.fn(),
}));

vi.mock('@/app/routes/connectors-routes', () => ({
  getValidAccessToken: tokenBroker.getValidAccessToken,
}));

import {
  browse,
  deleteEntry,
  listRoots,
  uploadBytes,
} from '@/app/routes/storage-browse';

const OWNER_SUB = 'oidc|drive-owner';
const OWNER_TOKEN = 'owner-google-access-token';

function contextWithConnections(providers: string[] = []) {
  const query = vi.fn().mockResolvedValue({
    rows: providers.map((provider) => ({ provider })),
  });
  return {
    ctx: { pool: { query } } as any,
    query,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('Google Drive storage provider', () => {
  beforeEach(() => {
    tokenBroker.getValidAccessToken.mockReset();
    tokenBroker.getValidAccessToken.mockResolvedValue(OWNER_TOKEN);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lists Google Drive only for the connected owner', async () => {
    const { ctx, query } = contextWithConnections(['google', 'dropbox']);

    const roots = await listRoots(ctx, OWNER_SUB);

    expect(query).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledWith(
      "SELECT provider FROM oshal_connections WHERE user_sub = $1 AND status = 'connected'",
      [OWNER_SUB],
    );
    expect(roots.map((root) => root.provider)).toEqual([
      'oshal-local',
      'dropbox',
      'google-drive',
    ]);
    expect(tokenBroker.getValidAccessToken).not.toHaveBeenCalled();
  });

  it('browses the Drive root with the owner token and returns deterministic paths', async () => {
    const { ctx } = contextWithConnections();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      files: [
        {
          id: 'file-9',
          name: 'Quarterly plan.txt',
          mimeType: 'text/plain',
          size: '42',
          modifiedTime: '2026-07-12T12:00:00.000Z',
        },
        {
          id: 'folder-2',
          name: 'Projects',
          mimeType: 'application/vnd.google-apps.folder',
          modifiedTime: '2026-07-12T11:00:00.000Z',
        },
      ],
    }));
    vi.stubGlobal('fetch', fetchMock);

    const entries = await browse(ctx, OWNER_SUB, 'google-drive', '');

    expect(tokenBroker.getValidAccessToken).toHaveBeenCalledOnce();
    expect(tokenBroker.getValidAccessToken).toHaveBeenCalledWith(ctx.pool, OWNER_SUB, 'google');
    expect(entries).toEqual([
      {
        name: 'Projects',
        type: 'folder',
        path: 'Projects~folder-2',
        size: undefined,
        modified: '2026-07-12T11:00:00.000Z',
      },
      {
        name: 'Quarterly plan.txt',
        type: 'file',
        path: 'Quarterly%20plan.txt~file-9',
        size: 42,
        modified: '2026-07-12T12:00:00.000Z',
      },
    ]);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [rawUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const url = new URL(rawUrl);
    expect(`${url.origin}${url.pathname}`).toBe('https://www.googleapis.com/drive/v3/files');
    expect(url.searchParams.get('q')).toBe("'root' in parents and trashed = false");
    expect(url.searchParams.get('pageSize')).toBe('100');
    expect(url.searchParams.get('supportsAllDrives')).toBe('true');
    expect(init.headers).toMatchObject({
      Authorization: `Bearer ${OWNER_TOKEN}`,
      Accept: 'application/json',
    });
  });

  it('uploads multipart bytes to Drive using the selected folder as the parent', async () => {
    const { ctx } = contextWithConnections();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      id: 'new-file-7',
      name: 'Q3 plan.txt',
      size: '11',
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await uploadBytes(
      ctx,
      OWNER_SUB,
      'google-drive',
      'Projects~folder-2',
      'Q3 plan.txt',
      Buffer.from('hello drive'),
      'text/plain',
    );

    expect(tokenBroker.getValidAccessToken).toHaveBeenCalledOnce();
    expect(tokenBroker.getValidAccessToken).toHaveBeenCalledWith(ctx.pool, OWNER_SUB, 'google');
    expect(result).toEqual({
      ok: true,
      name: 'Q3 plan.txt',
      path: 'Projects~folder-2/Q3%20plan.txt~new-file-7',
      size: 11,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [rawUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const url = new URL(rawUrl);
    expect(`${url.origin}${url.pathname}`).toBe('https://www.googleapis.com/upload/drive/v3/files');
    expect(url.searchParams.get('uploadType')).toBe('multipart');
    expect(url.searchParams.get('supportsAllDrives')).toBe('true');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${OWNER_TOKEN}` });
    expect((init.headers as Record<string, string>)['Content-Type']).toMatch(
      /^multipart\/related; boundary=oshal-[a-f0-9]{24}$/,
    );

    const multipart = Buffer.from(init.body as Uint8Array).toString('utf8');
    expect(multipart).toContain('Content-Type: application/json; charset=UTF-8');
    expect(multipart).toContain('Content-Type: text/plain');
    expect(multipart).toContain('"name":"Q3 plan.txt"');
    expect(multipart).toContain('"parents":["folder-2"]');
    expect(multipart).toContain('hello drive');
  });

  it('deletes exactly the file ID encoded in the selected Drive path', async () => {
    const { ctx } = contextWithConnections();
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await deleteEntry(
      ctx,
      OWNER_SUB,
      'google-drive',
      'Projects~folder-2/Q3%20plan.txt~file%2F7',
    );

    expect(tokenBroker.getValidAccessToken).toHaveBeenCalledOnce();
    expect(tokenBroker.getValidAccessToken).toHaveBeenCalledWith(ctx.pool, OWNER_SUB, 'google');
    expect(fetchMock).toHaveBeenCalledOnce();
    const [rawUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const url = new URL(rawUrl);
    expect(`${url.origin}${url.pathname}`).toBe(
      'https://www.googleapis.com/drive/v3/files/file%2F7',
    );
    expect(url.searchParams.get('supportsAllDrives')).toBe('true');
    expect(init.method).toBe('DELETE');
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${OWNER_TOKEN}` });
  });

  it.each([
    ['browse', () => browse(contextWithConnections().ctx, OWNER_SUB, 'google-drive', '')],
    [
      'upload',
      () => uploadBytes(
        contextWithConnections().ctx,
        OWNER_SUB,
        'google-drive',
        '',
        'note.txt',
        Buffer.from('note'),
        'text/plain',
      ),
    ],
    [
      'delete',
      () => deleteEntry(
        contextWithConnections().ctx,
        OWNER_SUB,
        'google-drive',
        'note.txt~file-1',
      ),
    ],
  ])('rejects disconnected %s operations before any Google request', async (_name, operation) => {
    tokenBroker.getValidAccessToken.mockResolvedValue(null);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(operation()).rejects.toThrow('Google Drive not connected');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(tokenBroker.getValidAccessToken).toHaveBeenCalledWith(
      expect.anything(),
      OWNER_SUB,
      'google',
    );
  });

  it('turns a Drive scope denial into a bounded reconnect error', async () => {
    const { ctx } = contextWithConnections();
    const providerDetail = `missing drive scope ${'x'.repeat(300)}`;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(providerDetail, { status: 403 })));

    const error = await browse(ctx, OWNER_SUB, 'google-drive', '').then(
      () => null,
      (caught: unknown) => caught as Error,
    );

    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain(
      'google drive 403: reconnect Google so the stored token includes Drive scope.',
    );
    expect(error?.message).toContain('missing drive scope');
    expect(error?.message).not.toContain('x'.repeat(121));
    expect(error?.message.length).toBeLessThan(220);
  });
});
