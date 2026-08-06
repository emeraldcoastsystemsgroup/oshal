/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Prove trusted browser callbacks remain same-origin/allowlisted, strictly parse whole bounded JSON, keep capability outside the body/model result, and retry only the identical outcome.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Split callback validation and delivery cases into bounded test groups while preserving identical-retry proof.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Prove trusted callback requests disable redirects before attaching their one-use capability header.
 * 4 | maintainer@emeraldcoastsystemsgroup.com | Permit only one bounded direct-child confirmation image name as optional immutable callback evidence.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deliverTaskCompletionCallback,
  parseBrowserTaskCallbackResult,
} from '@/features/remote-client';

const callback = {
  kind: 'trusted-http-json-v1' as const,
  url: 'https://controller.example/api/profile-studio/ingest',
  capability: `pscap_${'c'.repeat(43)}`,
  context: {
    userSub: 'opaque-owner', generation: 3, clientId: 'desktop-a', operation: 'resolve-profile-plan',
  },
};

afterEach(() => vi.unstubAllGlobals());

describe('trusted remote-task completion callback', () => {
  it('accepts required result fields plus only the bounded optional confirmation filename', () => {
    expect(parseBrowserTaskCallbackResult({ result: 'applied', note: 'verified' })).toEqual({
      result: 'applied', note: 'verified',
    });
    expect(parseBrowserTaskCallbackResult({
      content: [{ type: 'text', text: '{"result":"failed","note":"blocked"}' }],
    })).toEqual({ result: 'failed', note: 'blocked' });
    expect(parseBrowserTaskCallbackResult({
      result: 'applied', note: 'visible confirmation', confirmationFile: 'confirmation-1.png',
    })).toEqual({
      result: 'applied', note: 'visible confirmation', confirmationFile: 'confirmation-1.png',
    });
    expect(() => parseBrowserTaskCallbackResult('prose {"result":"applied","note":"x"}')).toThrow();
    expect(() => parseBrowserTaskCallbackResult('```json\n{"result":"applied","note":"x"}\n```')).toThrow();
    expect(() => parseBrowserTaskCallbackResult({ result: 'applied', note: 'x', extra: true })).toThrow();
    expect(() => parseBrowserTaskCallbackResult({
      result: 'applied', note: 'x', confirmationFile: '../confirmation.png',
    })).toThrow();
  });

  it('refuses cross-origin and non-ingest targets before making an HTTP request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(deliverTaskCompletionCallback(
      { ...callback, url: 'https://attacker.example/api/profile-studio/ingest' },
      'liprofile-7-a',
      { result: 'failed', note: 'x' },
      'https://controller.example/base',
    )).rejects.toThrow(/registered control-plane origin/);
    await expect(deliverTaskCompletionCallback(
      { ...callback, url: 'https://controller.example/api/admin/users' },
      'liprofile-7-a',
      { result: 'failed', note: 'x' },
      'https://controller.example/base',
    )).rejects.toThrow(/allowlisted ingest/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('trusted remote-task completion delivery', () => {
  it('retries the identical validated result and keeps the capability only in its header', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response('', { status: 502 }))
      .mockResolvedValueOnce(new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await deliverTaskCompletionCallback(
      callback,
      'liprofile-7-a',
      { result: 'applied', note: 'all fields verified' },
      'https://controller.example/device-registration',
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const requests = fetchMock.mock.calls.map(([, init]) => init as RequestInit);
    expect(new Set(requests.map((request) => request.body)).size).toBe(1);
    for (const request of requests) {
      const headers = request.headers as Record<string, string>;
      expect(request.redirect).toBe('error');
      expect(headers['x-oshal-callback-capability']).toBe(callback.capability);
      expect(String(request.body)).not.toContain(callback.capability);
      expect(JSON.parse(String(request.body))).toEqual({
        taskId: 'liprofile-7-a', context: callback.context,
        result: { result: 'applied', note: 'all fields verified' },
      });
    }
  });
});
