/**
 * Slack outbound file-upload contract.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Guard the approval-gated Office adapter's bounded Slack external-upload handshake without contacting Slack.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Refuse malformed provider JSON before continuing the external upload.
 */

import { describe, expect, it } from 'vitest';
import { uploadSlackFile } from '@/app/routes/slack-client';

function response(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as Response;
}

describe('Slack file upload primitive', () => {
  it('prepares, uploads and completes one caller-owned file', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (calls.length === 1) return response({ ok: true, upload_url: 'https://upload.invalid/file', file_id: 'F123' });
      if (calls.length === 2) return response({ ok: true });
      return response({ ok: true, files: [{ id: 'F123', permalink: 'https://slack.invalid/files/F123' }] });
    };

    const result = await uploadSlackFile('slack-user-token-fixture', {
      channelId: 'C123', filename: 'review.pptx', mimeType: 'application/octet-stream',
      content: new Uint8Array([1, 2, 3]), title: 'Review', initialComment: 'Confirmed artifact',
    }, fetchImpl);

    expect(result).toEqual({ fileId: 'F123', channelId: 'C123', permalink: 'https://slack.invalid/files/F123' });
    expect(calls).toHaveLength(3);
    expect(calls[0].url).toContain('files.getUploadURLExternal');
    expect(String(calls[0].init?.body)).toContain('filename=review.pptx');
    expect(calls[1].url).toBe('https://upload.invalid/file');
    expect(calls[2].url).toContain('files.completeUploadExternal');
    expect(String(calls[2].init?.body)).toContain('"channel_id":"C123"');
    expect(String(calls[2].init?.body)).toContain('Confirmed artifact');
  });

  it('refuses malformed channel/file input before any outbound call', async () => {
    let calls = 0;
    const fetchImpl = async () => { calls += 1; return response({ ok: true }); };
    await expect(uploadSlackFile('slack-user-token-fixture', {
      channelId: 'not a channel', filename: 'review.pptx', mimeType: 'application/octet-stream', content: new Uint8Array([1]),
    }, fetchImpl)).rejects.toThrow('valid Slack channel id required');
    expect(calls).toBe(0);
  });

  it('does not continue to file upload when Slack preparation refuses', async () => {
    const calls: string[] = [];
    const fetchImpl = async (url: string | URL | Request) => { calls.push(String(url)); return response({ ok: false, error: 'missing_scope' }); };
    await expect(uploadSlackFile('slack-user-token-fixture', {
      channelId: 'C123', filename: 'review.pptx', mimeType: 'application/octet-stream', content: new Uint8Array([1]),
    }, fetchImpl)).rejects.toThrow('missing_scope');
    expect(calls).toHaveLength(1);
  });

  it('does not upload bytes when Slack preparation is not an object with string upload fields', async () => {
    let calls = 0;
    const fetchImpl = async () => { calls += 1; return response({ ok: true, upload_url: 42, file_id: 'F123' }); };
    await expect(uploadSlackFile('slack-user-token-fixture', {
      channelId: 'C123', filename: 'review.pptx', mimeType: 'application/octet-stream', content: new Uint8Array([1]),
    }, fetchImpl)).rejects.toThrow('files.getUploadURLExternal failed');
    expect(calls).toBe(1);
  });
});
