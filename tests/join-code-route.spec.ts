/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — proves /api/join is operator-gated, never leaks the shared secret to a basic user, and mints a code the Windows installer can decode.
 */

import { test, expect, request } from '@playwright/test';

/**
 * A join code embeds REMOTE_CLIENT_SHARED_SECRET in plaintext. Anyone holding one can attach a
 * worker node that receives dispatched tasks, so the whole mount must be operator-only. These
 * tests exist because "I added requiresOperator" is a claim, not evidence.
 *
 * Run against an isolated server:
 *   MOCK_OIDC=true FORCE_LLM_PROVIDER=noop npx playwright test tests/join-code-route.spec.ts
 */

const SECRET = 'test-shared-secret-do-not-use';

/** MOCK_OIDC signs everyone in as this user; whether they are an operator is env-driven. */
const MOCK_USER = 'alex@demo.local';
const MOCK_USER_IS_OPERATOR = (process.env.OSHAL_OPERATOR_EMAILS ?? '').includes(MOCK_USER);

/** Decodes the installer's base64url payload back to `<url>|<secret>`. */
function decodeJoinCode(code: string): { url: string; secret: string } {
  expect(code.startsWith('OSJOIN1.')).toBeTruthy();
  const raw = Buffer.from(code.slice('OSJOIN1.'.length), 'base64url').toString('utf-8');
  const parts = raw.split('|');
  expect(parts).toHaveLength(2);
  return { url: parts[0], secret: parts[1] };
}

test.describe('/api/join — add a computer', () => {
  test('a non-operator is refused, and the response leaks nothing', async ({ baseURL }) => {
    test.skip(MOCK_USER_IS_OPERATOR, `Leave OSHAL_OPERATOR_EMAILS unset so ${MOCK_USER} is a basic user.`);
    const ctx = await request.newContext({ baseURL });
    const res = await ctx.get('/api/join/code');

    expect(res.status()).toBe(403);
    const body = await res.text();
    expect(body).not.toContain(SECRET);
    expect(body).not.toContain('OSJOIN');
    await ctx.dispose();
  });

  test('the surface itself is behind the same gate as the data', async ({ baseURL }) => {
    test.skip(MOCK_USER_IS_OPERATOR, `Leave OSHAL_OPERATOR_EMAILS unset so ${MOCK_USER} is a basic user.`);
    const ctx = await request.newContext({ baseURL });
    const res = await ctx.get('/api/join/');
    // Never 200: a basic caller must not even see the page, only the data behind it.
    expect(res.status()).toBe(403);
    await ctx.dispose();
  });

  test('an operator gets a code the installer can decode', async ({ baseURL }) => {
    test.skip(!MOCK_USER_IS_OPERATOR, `Run with OSHAL_OPERATOR_EMAILS=${MOCK_USER} to exercise the operator path.`);
    const ctx = await request.newContext({ baseURL });
    const res = await ctx.get('/api/join/code');
    expect(res.status()).toBe(200);

    const body = await res.json();
    const { url, secret } = decodeJoinCode(body.joinCode);

    expect(secret).toBe(SECRET);
    expect(url).toBe(body.controlPlaneUrl);
    expect(body.version).toBe(1);
    // Browsing over localhost cannot produce a code another machine could use, and the route
    // must say so rather than hand over something that silently only works here.
    expect(body.warning).toContain('localhost');
    await ctx.dispose();
  });
});
