/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added end-to-end callback route regression coverage to prove OpenAI Codex OAuth completes on the initiating origin and syncs runtime credentials during repo-root test execution
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Switched callback regression to static route imports so Playwright transpilation resolves TypeScript route modules without raw ESM runtime errors
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | The APP_URL fixture follows PLAYWRIGHT_PORT via the shared baseOrigin() helper instead of a hardcoded localhost:3456 (byte-identical under the default env)
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import express, { RequestHandler } from 'express';
import { test, expect } from '@playwright/test';
import { createOpenAiCodexOAuthRoutes } from '@/app/routes/openai-codex-oauth-routes';
import { baseOrigin } from './helpers';

/** Test-only JWT payload used to simulate OpenAI token exchange responses. */
const JWT_PAYLOAD = Buffer.from(JSON.stringify({
  sub: 'acct-123',
  chatgpt_account_id: 'acct-123',
})).toString('base64url');

/** Test-only fake JWT used by the mocked token endpoint. */
const FAKE_JWT = `x.${JWT_PAYLOAD}.y`;

/** Minimal authenticated request middleware for mock-OIDC route testing. */
const MOCK_REQUIRES_AUTH: RequestHandler = (_req, _res, next) => {
  next();
};

/** Injects a stable mock OIDC user for route-level callback testing. */
function attachMockOidcUser(app: express.Application): void {
  app.use((req, _res, next) => {
    (req as any).oidc = {
      isAuthenticated: () => true,
      user: { sub: 'mock-user-001' },
    };
    next();
  });
}

/** Builds a deterministic fake OpenAI token response for callback completion tests. */
function buildTokenResponse(): Record<string, unknown> {
  return {
    access_token: FAKE_JWT,
    refresh_token: 'refresh-token-123',
    expires_in: 3600,
    email: 'dev@example.com',
    id_token: FAKE_JWT,
  };
}

/** Writes a minimal persisted config so runtime sync has a Codex selection to mirror. */
function seedPersistedConfig(outputDir: string): void {
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(
    path.join(outputDir, 'global-config.json'),
    JSON.stringify({
      actModeApiProvider: 'openai-codex',
      actModeApiModelId: 'gpt-5.3-codex',
    }, null, 2),
    'utf-8',
  );
}

test.describe('OpenAI Codex OAuth callback route', () => {
  test('completes callback on the initiating origin and syncs runtime credentials', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-oauth-callback-'));
    const outputDir = path.join(tempRoot, 'output');
    const clineDir = path.join(tempRoot, 'cline');
    const sharedSeedPath = path.join(tempRoot, 'config-seed', 'secrets.json');
    const originalFetch = global.fetch;
    const originalEnv = {
      MOCK_OIDC: process.env.MOCK_OIDC,
      CONFIG_OUTPUT_DIR: process.env.CONFIG_OUTPUT_DIR,
      CLINE_CONFIG_DIR: process.env.CLINE_CONFIG_DIR,
      APP_URL: process.env.APP_URL,
      OPENAI_CODEX_SHARED_SEED_PATH: process.env.OPENAI_CODEX_SHARED_SEED_PATH,
      LLM_MODEL: process.env.LLM_MODEL,
    };

    let server: import('http').Server | null = null;

    // Resolve the origin BEFORE flipping MOCK_OIDC below — baseOrigin() reads the
    // live env, and an in-process MOCK_OIDC=true would move its default to 4458.
    const appUrl = baseOrigin();

    try {
      process.env.MOCK_OIDC = 'true';
      process.env.CONFIG_OUTPUT_DIR = outputDir;
      process.env.CLINE_CONFIG_DIR = clineDir;
      process.env.APP_URL = appUrl;
      process.env.OPENAI_CODEX_SHARED_SEED_PATH = sharedSeedPath;
      process.env.LLM_MODEL = 'gpt-5.3-codex';

      seedPersistedConfig(outputDir);

      global.fetch = async (input: URL | RequestInfo, init?: RequestInit) => {
        if (String(input).includes('https://auth.openai.com/oauth/token')) {
          return {
            ok: true,
            status: 200,
            async json() {
              return buildTokenResponse();
            },
          } as Response;
        }

        if (!originalFetch) {
          throw new Error('Global fetch is unavailable for local callback verification');
        }

        return originalFetch(input, init);
      };

      const app = express();
      attachMockOidcUser(app);
      app.use('/api/openai-codex/oauth', createOpenAiCodexOAuthRoutes(MOCK_REQUIRES_AUTH));

      server = await new Promise<import('http').Server>((resolve) => {
        const listeningServer = app.listen(0, () => resolve(listeningServer));
      });

      const address = server.address();
      expect(address).not.toBeNull();
      expect(typeof address).toBe('object');
      const port = typeof address === 'object' && address ? address.port : 0;
      const baseUrl = `http://127.0.0.1:${port}`;

      const startResponse = await fetch(`${baseUrl}/api/openai-codex/oauth/start`);
      expect(startResponse.ok).toBeTruthy();
      const startPayload = await startResponse.json() as { authUrl: string; success: boolean };
      expect(startPayload.success).toBe(true);

      const authorizationUrl = new URL(startPayload.authUrl);
      const state = authorizationUrl.searchParams.get('state');
      expect(state).toBeTruthy();
      expect(authorizationUrl.searchParams.get('redirect_uri')).toBe('http://localhost:1455/auth/callback');

      const callbackResponse = await fetch(
        `${baseUrl}/api/openai-codex/oauth/callback?state=${encodeURIComponent(state || '')}&code=fake-code-123`,
      );
      const callbackHtml = await callbackResponse.text();
      expect(callbackResponse.status).toBe(200);
      expect(callbackHtml).toContain('Authentication Successful');

      const statusResponse = await fetch(`${baseUrl}/api/openai-codex/oauth/status`);
      expect(statusResponse.ok).toBeTruthy();
      const statusPayload = await statusResponse.json() as Record<string, unknown>;
      expect(statusPayload.success).toBe(true);
      expect(statusPayload.authenticated).toBe(true);
      expect(statusPayload.email).toBe('dev@example.com');

      const clineSecrets = JSON.parse(
        fs.readFileSync(path.join(clineDir, 'data', 'secrets.json'), 'utf-8'),
      ) as Record<string, string>;
      expect(Object.keys(clineSecrets)).toContain('openai-codex-oauth-credentials');

      const runtimeConfig = JSON.parse(
        fs.readFileSync(path.join(clineDir, 'config.json'), 'utf-8'),
      ) as Record<string, unknown>;
      expect(runtimeConfig.provider).toBe('openai-codex');
      expect(runtimeConfig.model).toBe('gpt-5.3-codex');
    } finally {
      global.fetch = originalFetch;

      if (server) {
        await new Promise<void>((resolve, reject) => {
          server?.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        });
      }

      process.env.MOCK_OIDC = originalEnv.MOCK_OIDC;
      process.env.CONFIG_OUTPUT_DIR = originalEnv.CONFIG_OUTPUT_DIR;
      process.env.CLINE_CONFIG_DIR = originalEnv.CLINE_CONFIG_DIR;
      process.env.APP_URL = originalEnv.APP_URL;
      process.env.OPENAI_CODEX_SHARED_SEED_PATH = originalEnv.OPENAI_CODEX_SHARED_SEED_PATH;
      process.env.LLM_MODEL = originalEnv.LLM_MODEL;

      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});