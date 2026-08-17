/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * DATE/TIME           | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 2026-08-17 00:00:00 | maintainer@emeraldcoastsystemsgroup.com   | Guard Outlook connector account labeling through the Microsoft OIDC id_token without requiring Graph User.Read.
 */
import { describe, expect, it } from 'vitest';
import { fetchAccount } from '@/app/routes/connector-account-lookup';

function unsignedIdToken(claims: Record<string, unknown>): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(claims)}.`;
}

describe('connector account lookup', () => {
  it('labels the outlook connector from its Microsoft id_token', async () => {
    const account = await fetchAccount('outlook', {
      id_token: unsignedIdToken({
        preferred_username: 'rep@example.com',
        oid: 'entra-object-id',
      }),
    });

    expect(account).toEqual({ email: 'rep@example.com', id: 'entra-object-id' });
  });
});
