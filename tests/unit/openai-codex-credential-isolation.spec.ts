/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1   | maintainer@emeraldcoastsystemsgroup.com     | Added two-user, status-read, and revoked-broadcast proofs for tenant/platform Codex credential isolation
 * 2   | maintainer@emeraldcoastsystemsgroup.com     | SEC-05 closure: prove operator promotion never copies raw OAuth material into the Cline runtime and legacy Cline secrets remain absent or empty across import, status, and sign-out.
 * 3   | maintainer@emeraldcoastsystemsgroup.com     | SEC-05 closure: prove exact-operator promotion targets only the explicit native live auth source and active code contains no shared-seed or config-output OAuth fallback.
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express, { type RequestHandler } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOpenAiCodexOAuthRoutes } from '@/app/routes/openai-codex-oauth-routes';

interface Harness { url: string; close: () => Promise<void> }
const RETIRED_RUNTIME_KEY = 'openai-codex-oauth-credentials';

/** Start the real per-user OAuth router with an exact header-backed test identity. */
async function serveOAuthRoutes(): Promise<Harness> {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use((req, _res, next) => {
    const sub = req.get('x-test-sub');
    if (sub) (req as any).oidc = { isAuthenticated: () => true, user: { sub } };
    next();
  });
  const requiresAuth: RequestHandler = (req, res, next) => {
    if ((req as any).oidc?.user?.sub) next();
    else res.status(401).json({ error: 'Authentication required' });
  };
  app.use('/api/openai-codex/oauth', createOpenAiCodexOAuthRoutes(requiresAuth));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/api/openai-codex/oauth`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

/** Import one native Codex auth.json payload through the shipped route. */
async function importCredentials(harness: Harness, sub: string, label: string) {
  const response = await fetch(harness.url + '/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-test-sub': sub },
    body: JSON.stringify({ authJson: codexAuthJson(label) }),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

/** Sign one user out through the shipped route. */
async function signOut(harness: Harness, sub: string) {
  const response = await fetch(harness.url + '/signout', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-test-sub': sub },
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

/** Read one user's status through the shipped route. */
async function readStatus(harness: Harness, sub: string) {
  const response = await fetch(harness.url + '/status', {
    headers: { 'x-test-sub': sub },
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

/** Build a valid native CLI token bag with deterministic, distinct token material. */
function codexAuthJson(label: string): Record<string, unknown> {
  const jwt = fakeJwt({
    sub: `account-${label}`,
    email: `${label}@example.test`,
    chatgpt_account_id: `account-${label}`,
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  return {
    tokens: {
      access_token: `${jwt}-${label}-access`,
      refresh_token: `${label}-refresh-token`,
      id_token: jwt,
      account_id: `account-${label}`,
    },
  };
}

/** Serialize a test-only JWT whose claims can be parsed without signature verification. */
function fakeJwt(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${header}.${payload}.test-signature`;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('OpenAI Codex per-user/platform credential isolation', () => {
  it('returns 503 before OAuth state/import persistence when encrypted storage is unavailable', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-codex-no-encryption-'));
    const outputDir = path.join(tempRoot, 'output');
    const clineDir = path.join(tempRoot, 'cline');
    const liveAuthPath = path.join(tempRoot, 'codex-live', 'auth.json');
    configureEnvironment(outputDir, clineDir, liveAuthPath);
    vi.stubEnv('ENCRYPTION_KEY', '');
    const harness = await serveOAuthRoutes();
    try {
      const start = await fetch(harness.url + '/start', { headers: { 'x-test-sub': 'Operator-A' } });
      expect(start.status).toBe(503);
      expect(await start.json()).toEqual({
        success: false,
        error: 'encrypted_secret_storage_required',
      });

      const imported = await importCredentials(harness, 'Operator-A', 'must-not-persist');
      expect(imported.status).toBe(503);
      expect(imported.body.error).toBe('encrypted_secret_storage_required');
      expect(fs.existsSync(path.join(outputDir, 'secrets.json'))).toBe(false);
      expect(fs.existsSync(path.join(outputDir, 'secrets.enc.json'))).toBe(false);
      expect(fs.existsSync(liveAuthPath)).toBe(false);
    } finally {
      await harness.close();
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('keeps user B import and sign-out from changing user A live platform auth or creating Cline secrets', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-codex-isolation-'));
    const outputDir = path.join(tempRoot, 'output');
    const clineDir = path.join(tempRoot, 'cline');
    const liveAuthPath = path.join(tempRoot, 'codex-live', 'auth.json');
    configureEnvironment(outputDir, clineDir, liveAuthPath);
    seedRuntimeSelection(outputDir);
    const harness = await serveOAuthRoutes();
    try {
      expect((await importCredentials(harness, 'Operator-A', 'operator-a')).status).toBe(200);
      const liveAuthAfterA = fs.readFileSync(liveAuthPath, 'utf8');
      const runtimePath = path.join(clineDir, 'data', 'secrets.json');
      const parsedLiveAuth = JSON.parse(liveAuthAfterA) as Record<string, any>;
      expect(parsedLiveAuth.auth_mode).toBe('chatgpt');
      expect(parsedLiveAuth.OPENAI_API_KEY).toBeNull();
      expect(parsedLiveAuth.tokens.refresh_token).toBe('operator-a-refresh-token');
      expect(parsedLiveAuth.tokens.id_token).toBeTruthy();
      expect(readOptionalSecrets(runtimePath)).toEqual({});

      const writeSpy = vi.spyOn(fs, 'writeFileSync');
      expect((await readStatus(harness, 'Operator-A')).status).toBe(200);
      expect(fs.readFileSync(liveAuthPath, 'utf8')).toBe(liveAuthAfterA);
      expect(writeSpy.mock.calls.filter(([target]) => path.resolve(String(target)) === path.resolve(liveAuthPath))).toHaveLength(0);
      writeSpy.mockRestore();

      // The imported provider token claims an allowlisted email. It is intentionally untrusted:
      // only the validated OSHAL session identity may authorize platform promotion.
      expect((await importCredentials(harness, 'tenant-b', 'forged-operator')).status).toBe(200);
      expect(fs.readFileSync(liveAuthPath, 'utf8')).toBe(liveAuthAfterA);
      expect(readOptionalSecrets(runtimePath)).toEqual({});

      expect((await signOut(harness, 'tenant-b')).status).toBe(200);
      expect(fs.readFileSync(liveAuthPath, 'utf8')).toBe(liveAuthAfterA);
      expect(readOptionalSecrets(runtimePath)).toEqual({});

      expect((await importCredentials(harness, 'operator-a', 'case-alias')).status).toBe(200);
      expect((await signOut(harness, 'operator-a')).status).toBe(200);
      expect(fs.readFileSync(liveAuthPath, 'utf8')).toBe(liveAuthAfterA);
      expect(readOptionalSecrets(runtimePath)).toEqual({});

      expect((await signOut(harness, 'Operator-A')).status).toBe(200);
      expect(fs.existsSync(liveAuthPath)).toBe(false);
      expect(readOptionalSecrets(runtimePath)).toEqual({});
    } finally {
      await harness.close();
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('does not promote a private credential when its owner is allowlisted after import', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-codex-status-'));
    const outputDir = path.join(tempRoot, 'output');
    const clineDir = path.join(tempRoot, 'cline');
    const liveAuthPath = path.join(tempRoot, 'codex-live', 'auth.json');
    configureEnvironment(outputDir, clineDir, liveAuthPath);
    seedRuntimeSelection(outputDir);
    const harness = await serveOAuthRoutes();
    try {
      expect((await importCredentials(harness, 'tenant-later-operator', 'private')).status).toBe(200);
      expect(fs.existsSync(liveAuthPath)).toBe(false);

      vi.stubEnv('OSHAL_OPERATOR_SUBS', 'Operator-A,tenant-later-operator');
      expect((await readStatus(harness, 'tenant-later-operator')).status).toBe(200);
      expect(fs.existsSync(liveAuthPath)).toBe(false);
      expect(fs.existsSync(path.join(clineDir, 'data', 'secrets.json'))).toBe(false);
    } finally {
      await harness.close();
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('ships no unordered Redis credential publisher or subscriber that can resurrect sign-out', () => {
    const serviceSource = fs.readFileSync(
      path.join(process.cwd(), 'src/features/openai-codex-oauth/services/openai-codex-oauth-service.ts'),
      'utf8',
    );
    const swarmSource = fs.readFileSync(path.join(process.cwd(), 'src/app/extensions/swarm/index.ts'), 'utf8');
    const runtimeSyncSource = fs.readFileSync(
      path.join(process.cwd(), 'src/features/llm-provider/services/cline-runtime-config-sync-service.ts'),
      'utf8',
    );
    const harnessAdapterSource = fs.readFileSync(
      path.join(process.cwd(), 'src/features/llm-provider/services/codex-cli-harness-adapter.ts'),
      'utf8',
    );
    expect(serviceSource).not.toContain('swarm.codex-credentials.update');
    expect(serviceSource).not.toContain('subscribeToBroadcast');
    expect(swarmSource).not.toContain('OpenAiCodexOAuthService.subscribeToBroadcast');
    expect(runtimeSyncSource).not.toContain('private loadCredentialBag');
    expect(runtimeSyncSource).not.toContain('private findOpenAiCodexCredentialBlob');
    expect(runtimeSyncSource).not.toContain('JSON.stringify(credentials)');
    expect(runtimeSyncSource).not.toContain(`['${RETIRED_RUNTIME_KEY}'] =`);
    expect(serviceSource).not.toContain('OPENAI_CODEX_SHARED_SEED_PATH');
    expect(serviceSource).not.toContain('writeSharedSeedCredentials');
    expect(serviceSource).not.toContain('resolveSharedSeedPath');
    expect(harnessAdapterSource).not.toContain('OPENAI_CODEX_SHARED_SEED_PATH');
    expect(harnessAdapterSource).not.toContain('CONFIG_OUTPUT_DIR');
    expect(harnessAdapterSource).not.toContain('loadCredentialPayload');
  });
});

/** Read an optional legacy Cline envelope without manufacturing a runtime credential file. */
function readOptionalSecrets(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) return {};
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
}

/** Point every credential/config side effect at disposable paths and allow one exact operator sub. */
function configureEnvironment(outputDir: string, clineDir: string, liveAuthPath: string): void {
  vi.stubEnv('CONFIG_OUTPUT_DIR', outputDir);
  vi.stubEnv('CLINE_CONFIG_DIR', clineDir);
  vi.stubEnv('CODEX_AUTH_SOURCE_PATH', liveAuthPath);
  vi.stubEnv('ENCRYPTION_KEY', 'codex-isolation-test-encryption-key');
  vi.stubEnv('OSHAL_OPERATOR_SUBS', 'Operator-A');
  vi.stubEnv('OSHAL_OPERATOR_EMAILS', 'forged-operator@example.test');
  vi.stubEnv('REDIS_URL', '');
}

/** Persist the platform runtime selection used when an operator explicitly promotes credentials. */
function seedRuntimeSelection(outputDir: string): void {
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, 'global-config.json'), JSON.stringify({
    actModeApiProvider: 'openai-codex',
    actModeApiModelId: 'gpt-5.3-codex',
  }, null, 2), 'utf8');
}
