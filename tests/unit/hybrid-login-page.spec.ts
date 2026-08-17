/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Pin the opt-in combined login surface: the state API advertises Microsoft only for the hybrid composition, the first-party page is hidden by default and reveals the SSO link only on bare /login, and the same-origin returnTo is encoded into the exact /login/microsoft entry point.
 */

import express from 'express';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLocalAuthRoutes } from '@/app/routes/local-auth-routes';

async function readState(microsoftLogin: boolean): Promise<Record<string, unknown>> {
  const pool = {
    query: async () => ({ rows: [{ one: 1 }] }),
  };
  const app = express();
  app.use(createLocalAuthRoutes(pool as never, { microsoftLogin }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address() as AddressInfo;
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/local-auth/state`);
    expect(response.status).toBe(200);
    return await response.json() as Record<string, unknown>;
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

describe('hybrid local/Microsoft login page', () => {
  it('does not advertise Microsoft unless the server explicitly enables the hybrid surface', async () => {
    expect(await readState(false)).toEqual({ localAuth: true, bootstrapRequired: false });
    expect(await readState(true)).toEqual({
      localAuth: true,
      bootstrapRequired: false,
      microsoftLogin: true,
    });
  });

  it('keeps SSO hidden by default and reveals it only on bare /login with a preserved deep link', () => {
    const html = readFileSync(path.join(process.cwd(), 'src/pages/login/login.html'), 'utf8');
    expect(html).toContain('id="microsoftLoginPanel" class="hidden"');
    expect(html).toContain('Continue with Microsoft');
    expect(html).toContain('or use your invited account');
    expect(html).toContain("s.microsoftLogin === true && !s.bootstrapRequired && !forgotMode && location.pathname === '/login'");
    expect(html).toContain('s.bootstrapRequired && !forgotMode');
    expect(html).toContain("'/login/microsoft?returnTo=' + encodeURIComponent(returnTo())");
    expect(html).toContain("$('microsoftLoginPanel').classList.remove('hidden')");
    expect(html).toContain("$('microsoftLoginPanel').classList.add('hidden')");
  });
});
