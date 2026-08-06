/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard World CLI write authentication: ingest/contribute send the machine token only as a bearer header and never serialize it into request URLs
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';

const requireFromTest = createRequire(import.meta.url);
const CLI_PATH = path.join(process.cwd(), 'scripts', 'oshal-world.js');
const priorToken = process.env.WORLD_INGEST_TOKEN;

afterEach(() => {
  vi.unstubAllGlobals();
  delete requireFromTest.cache[requireFromTest.resolve(CLI_PATH)];
  if (priorToken === undefined) delete process.env.WORLD_INGEST_TOKEN;
  else process.env.WORLD_INGEST_TOKEN = priorToken;
});

function loadCli(token: string): {
  buildWorldWriteHeaders(value?: string): Record<string, string>;
  run(verb: string, input: Record<string, unknown>): Promise<unknown>;
} {
  process.env.WORLD_INGEST_TOKEN = token;
  delete requireFromTest.cache[requireFromTest.resolve(CLI_PATH)];
  return requireFromTest(CLI_PATH);
}

describe('World CLI header-only machine authentication', () => {
  it('keeps ingest and contribution credentials out of URLs', async () => {
    const secret = 'world-example-token-not-for-urls';
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return { json: async () => ({ ok: true }) } as Response;
    }));
    const cli = loadCli(secret);

    expect(cli.buildWorldWriteHeaders(secret)).toEqual({
      Authorization: `Bearer ${secret}`,
    });
    await cli.run('ingest', { q: 'security', entity: 'world:topic:security' });
    await cli.run('contribute', { source: 'guard', entities: [{ id: 'world:topic:security' }] });

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.url).not.toContain(secret);
      expect(call.url).not.toMatch(/[?&]token=/);
      expect(call.init?.headers).toMatchObject({ Authorization: `Bearer ${secret}` });
    }
  });
});
