/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1   | maintainer@emeraldcoastsystemsgroup.com     | Added adversarial operator, mixed-principal, and directional machine-path tests for platform config, agent, and Claude credential control planes
 * 2   | maintainer@emeraldcoastsystemsgroup.com     | Configured the encrypted-store prerequisite in config-route harnesses after plaintext secret mode was retired
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express, { type RequestHandler, type Router } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createConfigRoutes } from '@/app/routes/config-routes';
import { createAgentProfileRoutes } from '@/app/routes/agent-profile-routes';
import { createAgentStatusRoutes } from '@/app/routes/agent-status-routes';
import { createClaudeCodeAuthRoutes } from '@/app/routes/claude-code-auth-routes';
import { createConfigRuntimeRoutes } from '@/app/extensions/swarm/routes/config-runtime-routes';
import { createConfigPropagationRoutes } from '@/app/extensions/swarm/routes/config-propagation-routes';
import { isConfirmedClaudeCredentialImport } from '@/app/claude-code-auth-propagation-result';

interface Harness { url: string; close: () => Promise<void> }

/** Start one real HTTP server and stamp the optional test subject as an OIDC identity. */
async function serve(router: Router, mount = '/api'): Promise<Harness> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const sub = req.get('x-test-sub');
    if (sub) (req as any).oidc = { isAuthenticated: () => true, user: { sub } };
    next();
  });
  app.use(mount, router);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}${mount}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

/** Issue a request with exact identity and optional machine credential headers. */
async function call(url: string, method: string, sub?: string, body?: unknown, secret?: string) {
  const response = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(sub ? { 'x-test-sub': sub } : {}),
      ...(secret ? { 'X-Service-Secret': secret } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as Record<string, any> : {} };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('/api/config global control plane', () => {
  it('denies ordinary and case-alias mutations before filesystem/runtime changes', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-config-authz-'));
    const settingsPath = path.join(tempRoot, 'global-config.json');
    fs.writeFileSync(settingsPath, JSON.stringify({ sentinel: 'unchanged' }), 'utf8');
    configureTempConfig(tempRoot);
    const harness = await serve(createConfigRoutes(), '/api/config');
    try {
      expect((await call(harness.url, 'POST', 'ordinary-user', { sentinel: 'changed' })).status).toBe(403);
      expect((await call(harness.url, 'POST', 'operator-exact', { sentinel: 'changed' })).status).toBe(403);
      expect((await call(harness.url, 'DELETE', 'ordinary-user')).status).toBe(403);
      expect((await call(harness.url + '/mcp', 'POST', 'ordinary-user', { mcpServers: {} })).status).toBe(403);
      expect(JSON.parse(fs.readFileSync(settingsPath, 'utf8'))).toEqual({ sentinel: 'unchanged' });
      expect(fs.existsSync(path.join(tempRoot, 'cline', 'mcp_settings.json'))).toBe(false);
    } finally {
      await harness.close();
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('allows an exact operator and recursively redacts nested credential responses', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-config-redact-'));
    configureTempConfig(tempRoot);
    fs.writeFileSync(path.join(tempRoot, 'global-config.json'), JSON.stringify({
      ragServiceConfig: { endpoint: 'http://rag:8000', apiKey: 'rag-secret' },
      nested: { env: { UNUSUAL_NAME: 'environment-secret' }, label: 'visible' },
    }), 'utf8');
    const harness = await serve(createConfigRoutes(), '/api/config');
    try {
      const read = await call(harness.url, 'GET', 'Operator-Exact');
      expect(read.status).toBe(200);
      expect(read.body.config.ragServiceConfig.apiKey).toBe('[REDACTED]');
      expect(read.body.config.nested.env.UNUSUAL_NAME).toBe('[REDACTED]');
      expect(read.body.config.nested.label).toBe('visible');

      const saved = await call(harness.url + '/mcp', 'POST', 'Operator-Exact', {
        mcpServers: { demo: { command: 'node', env: { ODD_CREDENTIAL_NAME: 'secret-value' } } },
      });
      expect(saved.status).toBe(200);
      expect(saved.body.config.mcpServers.demo.env.ODD_CREDENTIAL_NAME).toBe('[REDACTED]');
      expect(fs.readFileSync(path.join(tempRoot, 'cline', 'mcp_settings.json'), 'utf8')).toContain('secret-value');
    } finally {
      await harness.close();
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

describe('agent global mutation control planes', () => {
  it('gates profile bulk/update/avatar handlers before controller or upload work', async () => {
    vi.stubEnv('OSHAL_OPERATOR_SUBS', 'Operator-Exact');
    const update = vi.fn((_req, res) => res.json({ updated: true }));
    const bulk = vi.fn((_req, res) => res.json({ updated: true }));
    const controller = routeController({ updateAgentProfile: update, configureAllProfiles: bulk });
    const harness = await serve(createAgentProfileRoutes(controller as any), '/api/agents');
    try {
      expect((await call(harness.url + '/a/profile', 'PUT', 'ordinary-user', {})).status).toBe(403);
      expect((await call(harness.url + '/a/profile', 'PUT', 'operator-exact', {})).status).toBe(403);
      expect((await call(harness.url + '/bulk/configure-all', 'POST', 'ordinary-user', {})).status).toBe(403);
      expect(update).not.toHaveBeenCalled();
      expect(bulk).not.toHaveBeenCalled();
      expect((await call(harness.url + '/a/profile', 'PUT', 'Operator-Exact', {})).status).toBe(200);
      expect(update).toHaveBeenCalledOnce();
    } finally {
      await harness.close();
    }
  });

  it('gates status/container lifecycle routes before repository or compose operations', async () => {
    vi.stubEnv('OSHAL_OPERATOR_SUBS', 'Operator-Exact');
    const pool = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };
    const harness = await serve(createAgentStatusRoutes(pool as any), '/api/agents');
    try {
      expect((await call(harness.url + '/agent-a/status', 'PATCH', 'ordinary-user', { status: 'active' })).status).toBe(403);
      expect((await call(harness.url + '/agent-a/launch', 'POST', 'operator-exact')).status).toBe(403);
      expect(pool.query).not.toHaveBeenCalled();
      expect((await call(harness.url + '/status-list', 'GET', 'Operator-Exact')).status).not.toBe(403);
      expect(pool.query).toHaveBeenCalled();
    } finally {
      await harness.close();
    }
  });
});

describe('agent runtime configuration authorization', () => {
  it('keeps machine access read-only and rejects non-operators before config services', async () => {
    vi.stubEnv('OSHAL_OPERATOR_SUBS', 'Operator-Exact');
    vi.stubEnv('SWARM_SERVICE_SECRET', 'runtime-machine-secret');
    const agentConfig = { getConfig: vi.fn(async () => runtimeConfig()) };
    const configSync = { pushToBot: vi.fn(async () => ({ pushed: true, newVersion: 2 })) };
    const harness = await serve(createConfigRuntimeRoutes(configSync as any, agentConfig as any), '/api/agents');
    try {
      const body = { providerId: 'openai', modelId: 'gpt-5' };
      expect((await call(harness.url + '/a/runtime', 'PUT', 'ordinary-user', body)).status).toBe(403);
      expect((await call(harness.url + '/a/runtime', 'PUT', 'operator-exact', body)).status).toBe(403);
      expect((await call(harness.url + '/a/runtime', 'GET', 'ordinary-user', undefined, 'runtime-machine-secret')).status).toBe(403);
      expect((await call(harness.url + '/a/runtime', 'PUT', undefined, body, 'runtime-machine-secret')).status).toBe(403);
      expect(agentConfig.getConfig).not.toHaveBeenCalled();
      expect(configSync.pushToBot).not.toHaveBeenCalled();
      expect((await call(harness.url + '/a/runtime', 'GET', undefined, undefined, 'runtime-machine-secret')).status).toBe(200);
      expect((await call(harness.url + '/a/runtime', 'PUT', 'Operator-Exact', body, 'runtime-machine-secret')).status).toBe(200);
      expect(configSync.pushToBot).toHaveBeenCalledOnce();
    } finally {
      await harness.close();
    }
  });
});

describe('Claude Code shared credential control plane', () => {
  it('never reports an accepted read-only target no-op as propagated credentials', () => {
    expect(isConfirmedClaudeCredentialImport(true, { success: true, imported: false })).toBe(false);
    expect(isConfirmedClaudeCredentialImport(true, { success: true })).toBe(false);
    expect(isConfirmedClaudeCredentialImport(false, { success: true, imported: true })).toBe(false);
    expect(isConfirmedClaudeCredentialImport(true, { success: true, imported: true })).toBe(true);
  });

  it('gates browser operations and keeps the former import path a fail-closed no-op', async () => {
    vi.stubEnv('OSHAL_OPERATOR_SUBS', 'Operator-Exact');
    vi.stubEnv('SWARM_SERVICE_SECRET', 'claude-machine-secret');
    const requiresAuth: RequestHandler = (req, res, next) => {
      if ((req as any).oidc?.user?.sub) next();
      else res.status(401).json({ error: 'Authentication required' });
    };
    const harness = await serve(createClaudeCodeAuthRoutes(requiresAuth), '/api/claude-code/auth');
    try {
      expect((await call(harness.url + '/start', 'GET', 'ordinary-user')).status).toBe(403);
      expect((await call(harness.url + '/credentials', 'GET', 'operator-exact')).status).toBe(403);
      expect((await call(harness.url + '/import', 'POST', 'ordinary-user', {})).status).toBe(403);
      expect((await call(harness.url + '/import', 'POST', 'ordinary-user', {}, 'claude-machine-secret')).status).toBe(403);
      expect((await call(harness.url + '/import', 'POST', undefined, {}, 'wrong-secret')).status).toBe(401);
      expect((await call(harness.url + '/import', 'POST', undefined, {}, 'claude-machine-secret')).status).toBe(401);
      expect((await call(harness.url + '/import', 'POST', 'Operator-Exact', {}, 'claude-machine-secret')).status).toBe(409);
    } finally {
      await harness.close();
    }
  });

  it('operator-gates fleet propagation and fails before network/credential reads without a machine secret', async () => {
    vi.stubEnv('OSHAL_OPERATOR_SUBS', 'Operator-Exact');
    vi.stubEnv('SWARM_SERVICE_SECRET', '');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const harness = await serve(createConfigPropagationRoutes(), '/api/swarm/config');
    try {
      expect((await call(harness.url + '/propagate/claude-code-auth', 'POST', 'ordinary-user')).status).toBe(403);
      expect((await call(harness.url + '/propagate/claude-code-auth', 'POST', 'operator-exact')).status).toBe(403);
      expect((await call(harness.url + '/propagate/claude-code-auth', 'POST', 'Operator-Exact')).status).toBe(503);
      const remoteCalls = fetchSpy.mock.calls.filter(([input]) => String(input).includes('/api/claude-code/auth/import'));
      expect(remoteCalls).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });
});

/** Configure all mutable config/runtime paths beneath one disposable root. */
function configureTempConfig(tempRoot: string): void {
  vi.stubEnv('OSHAL_OPERATOR_SUBS', 'Operator-Exact');
  vi.stubEnv('ENCRYPTION_KEY', 'platform-control-plane-test-encryption-key');
  vi.stubEnv('CONFIG_OUTPUT_DIR', tempRoot);
  vi.stubEnv('CLINE_CONFIG_DIR', path.join(tempRoot, 'cline'));
  vi.stubEnv('OPENAI_CODEX_SHARED_SEED_PATH', path.join(tempRoot, 'seed', 'secrets.json'));
}

/** Supply harmless handlers for controller methods outside one focused route assertion. */
function routeController(overrides: Record<string, unknown>): Record<string, unknown> {
  return new Proxy(overrides, {
    get(target, property) {
      if (property in target) return target[property as string];
      return (_req: unknown, res: any) => res.json({ ok: true });
    },
  });
}

/** Minimal authoritative runtime record returned by the agent config double. */
function runtimeConfig() {
  return {
    agentId: 'a', values: { providerId: 'openai', modelId: 'gpt-5', configVersion: 1 },
    updatedAt: new Date(),
  };
}
