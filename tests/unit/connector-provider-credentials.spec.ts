/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * DATE/TIME           | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 2026-08-17 00:00:00 | maintainer@emeraldcoastsystemsgroup.com   | Guard Outlook connector reuse of the Entra login app as a whole credential pair, including dedicated-pair precedence and fail-closed handling of partial configuration.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { providerCreds } from '@/app/routes/connector-provider-registry';

const OUTLOOK_ENV = [
  'AZURE_EMAIL_APPLICATION_ID',
  'AZURE_EMAIL_APPLICCATION_ID',
  'AZURE_EMAIL_CLIENT_SECRET',
  'OUTLOOK_CLIENT_VALUE',
  'OUTLOOK_CLIENT_SECRET',
  'MICROSOFT_OIDC_CLIENT_ID',
  'MICROSOFT_OIDC_CLIENT_SECRET',
  'OUTLOOK_OIDC_CLIENT_ID',
  'OUTLOOK_OIDC_CLIENT_SECRET',
] as const;

const original = new Map<string, string | undefined>();

describe.sequential('Outlook connector OAuth client resolution', () => {
  beforeEach(() => {
    for (const name of OUTLOOK_ENV) {
      original.set(name, process.env[name]);
      delete process.env[name];
    }
  });

  afterEach(() => {
    for (const name of OUTLOOK_ENV) {
      const value = original.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    original.clear();
  });

  it('reuses the Microsoft Entra login app when no connector-specific pair exists', () => {
    process.env.MICROSOFT_OIDC_CLIENT_ID = 'shared-entra-client';
    process.env.MICROSOFT_OIDC_CLIENT_SECRET = 'shared-entra-secret';

    expect(providerCreds('outlook')).toEqual({
      clientId: 'shared-entra-client',
      clientSecret: 'shared-entra-secret',
    });
  });

  it('uses the personal-Outlook login override ahead of the shared Microsoft login pair', () => {
    process.env.OUTLOOK_OIDC_CLIENT_ID = 'outlook-login-client';
    process.env.OUTLOOK_OIDC_CLIENT_SECRET = 'outlook-login-secret';
    process.env.MICROSOFT_OIDC_CLIENT_ID = 'shared-login-client';
    process.env.MICROSOFT_OIDC_CLIENT_SECRET = 'shared-login-secret';

    expect(providerCreds('outlook')).toEqual({
      clientId: 'outlook-login-client',
      clientSecret: 'outlook-login-secret',
    });
  });

  it('keeps a dedicated connector pair ahead of either login pair', () => {
    process.env.AZURE_EMAIL_APPLICATION_ID = 'connector-client';
    process.env.OUTLOOK_CLIENT_VALUE = 'connector-secret-value';
    process.env.MICROSOFT_OIDC_CLIENT_ID = 'login-client';
    process.env.MICROSOFT_OIDC_CLIENT_SECRET = 'login-secret';

    expect(providerCreds('outlook')).toEqual({
      clientId: 'connector-client',
      clientSecret: 'connector-secret-value',
    });
  });

  it('does not combine a partial dedicated pair with a different login app', () => {
    process.env.AZURE_EMAIL_APPLICATION_ID = 'incomplete-connector-client';
    process.env.MICROSOFT_OIDC_CLIENT_ID = 'login-client';
    process.env.MICROSOFT_OIDC_CLIENT_SECRET = 'login-secret';

    expect(providerCreds('outlook')).toEqual({
      clientId: 'incomplete-connector-client',
      clientSecret: '',
    });
  });
});
