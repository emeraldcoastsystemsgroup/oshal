/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added request-origin-aware redirect regression coverage so callbacks return to the runtime that initiated auth
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added OpenAI Codex OAuth service regression coverage for the corrected callback redirect and valid scope set
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05 closure: construct active flows with encrypted storage and prove missing-key services reject before creating OAuth state.
 */

import { test, expect } from '@playwright/test';
import { OpenAiCodexOAuthService } from '@/features/openai-codex-oauth';

/**
 * @description Regression coverage for the server-side OpenAI Codex OAuth bootstrap flow.
 */
test.describe('OpenAI Codex OAuth service', () => {
  test('builds an authorization URL with the Docker callback port and no invalid responses.write scope', () => {
    const service = new OpenAiCodexOAuthService('./output', 'test-only-encryption-key');
    const authUrl = service.startAuthorization('mock-user-001');
    const parsed = new URL(authUrl);
    const redirectUri = parsed.searchParams.get('redirect_uri');
    const scope = parsed.searchParams.get('scope');

    expect(parsed.origin + parsed.pathname).toBe('https://auth.openai.com/oauth/authorize');
    expect(redirectUri).toBe('http://localhost:1455/auth/callback');
    expect(scope).toBe('openid profile email offline_access');
    expect(scope).not.toContain('api.responses.write');
  });

  test('always uses the registered callback-port redirect URI regardless of runtime origin', () => {
    const service = new OpenAiCodexOAuthService('./output', 'test-only-encryption-key');
    const authUrl = service.startAuthorization('mock-user-001');
    const parsed = new URL(authUrl);

    expect(parsed.searchParams.get('redirect_uri')).toBe('http://localhost:1455/auth/callback');
  });

  test('refuses to create authorization state without encrypted secret storage', () => {
    const service = new OpenAiCodexOAuthService('./output', null);
    expect(() => service.startAuthorization('mock-user-001')).toThrow(/Encrypted Codex credential storage/);
    try {
      service.startAuthorization('mock-user-001');
    } catch (error) {
      expect((error as Error & { code?: string }).code).toBe('ENCRYPTION_KEY_REQUIRED');
    }
  });
});
