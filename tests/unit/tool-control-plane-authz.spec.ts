/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1   | maintainer@emeraldcoastsystemsgroup.com     | Added fail-closed tool control-plane authorization, secret-redaction, and no-shell execution regressions
 * 2   | maintainer@emeraldcoastsystemsgroup.com     | Prove the tool-config HTTP response exposes fixed configured-state only, including for opaque metadata, headers, and credential-bearing URLs
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express, { type Router } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createToolRoutes,
  deregisterDynamicToolUI,
  listDynamicToolNames,
} from '@/app/routes/tool-routes';
import { createVerificationRoutes } from '@/app/routes/verification-routes';
import { createAgentToolRoutes } from '@/app/routes/agent-tool-routes';
import { SetAgentToolConfigSchema } from '@/entities/tool';
import {
  AgentToolController,
  redactToolConfig,
} from '@/features/tool-switch/controllers/agent-tool-controller';
import { ToolVerificationService } from '@/features/tool-verification/services/tool-verification-service';
import { SwitchFrameworkService } from '@/features/tool-switch/services/switch-framework-service';
import {
  AuthMode,
  InstallMethod,
  ToolAuthType,
  ToolType,
  VerificationStatus,
} from '@/shared/types/tool';

interface Harness {
  url: string;
  close: () => Promise<void>;
}

/** Start one identity-header-driven HTTP router harness. */
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

/** Issue a JSON request as one exact test subject. */
async function request(url: string, method: string, sub: string, body?: unknown, serviceSecret?: string) {
  const response = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-test-sub': sub,
      ...(serviceSecret ? { 'X-Service-Secret': serviceSecret } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const name of listDynamicToolNames()) deregisterDynamicToolUI(name);
});

describe('tool control-plane route authorization', () => {
  it('denies basic and case-alias users before catalog, verifier, or grant side effects', async () => {
    vi.stubEnv('OSHAL_OPERATOR_SUBS', 'Operator-Exact');
    const calls = { catalog: 0, verify: 0, grant: 0 };
    const root = express.Router();
    root.use('/tools', createToolRoutes(routeController({ createTool: (_req: any, res: any) => {
      calls.catalog += 1; res.status(201).json({ ok: true });
    } }) as any));
    root.use('/tools/verify', createVerificationRoutes(routeController({ runSchedulerNow: (_req: any, res: any) => {
      calls.verify += 1; res.json({ ok: true });
    } }) as any));
    root.use('/agents', createAgentToolRoutes(routeController({ setToolAuthMode: (_req: any, res: any) => {
      calls.grant += 1; res.json({ ok: true });
    } }) as any));
    const harness = await serve(root);
    try {
      expect((await request(`${harness.url}/tools`, 'POST', 'ordinary-user', {})).status).toBe(403);
      expect((await request(`${harness.url}/tools`, 'POST', 'operator-exact', {})).status).toBe(403);
      expect((await request(`${harness.url}/tools/verify/scheduler/run`, 'POST', 'ordinary-user')).status).toBe(403);
      expect((await request(`${harness.url}/agents/a/tools/t`, 'PUT', 'ordinary-user', {})).status).toBe(403);
      expect(calls).toEqual({ catalog: 0, verify: 0, grant: 0 });
      expect((await request(`${harness.url}/tools`, 'POST', 'Operator-Exact', {})).status).toBe(201);
      expect(calls.catalog).toBe(1);
    } finally {
      await harness.close();
    }
  });

  it('keeps process-global ribbon registration operator-only and prevents fleet-secret overwrite/delete', async () => {
    vi.stubEnv('OSHAL_OPERATOR_SUBS', 'Operator-Exact');
    vi.stubEnv('SWARM_SERVICE_SECRET', 'test-machine-secret');
    const harness = await serve(createToolRoutes(routeController({}) as any), '/api/tools');
    const payload = {
      toolName: 'test-ribbon', serverUrl: 'http://trusted:5000', registeredBy: 'operator',
      ttlMs: 60_000, ui: { iframeUrl: '/trusted' },
    };
    try {
      expect((await request(harness.url + '/register', 'POST', 'ordinary-user', payload)).status).toBe(403);
      expect(listDynamicToolNames()).not.toContain('test-ribbon');

      expect((await request(harness.url + '/register', 'POST', 'Operator-Exact', payload)).status).toBe(201);
      expect(listDynamicToolNames()).toContain('test-ribbon');

      const overwrite = await request(harness.url + '/register', 'POST', '', {
        ...payload, registeredBy: 'compromised-bot', ui: { iframeUrl: 'https://attacker.invalid' },
      }, 'test-machine-secret');
      expect(overwrite.status).toBe(403);
      const listing = await request(harness.url + '/dynamic', 'GET', 'Operator-Exact');
      expect((listing.body.tools as Array<any>)[0].registeredBy).toBe('operator');
      expect((listing.body.tools as Array<any>)[0].ui.iframeUrl).toBe('/trusted');

      expect((await request(
        harness.url + '/dynamic/test-ribbon', 'DELETE', '', undefined, 'test-machine-secret',
      )).status).toBe(403);
      expect(listDynamicToolNames()).toContain('test-ribbon');
      expect((await request(
        harness.url + '/dynamic/test-ribbon', 'DELETE', 'Operator-Exact',
      )).status).toBe(200);
      expect(listDynamicToolNames()).not.toContain('test-ribbon');
    } finally {
      await harness.close();
    }
  });
});

describe('tool credential response redaction', () => {
  it('returns only fixed configured-state for every schema-valid opaque section', () => {
    const input = credentialBearingToolConfig();
    const redacted = redactToolConfig(input) as any;
    expect(redacted).toEqual({
      auth: { type: ToolAuthType.OAUTH2, enabled: true },
      configured: { auth: true, env: true, endpoint: true, metadata: true },
    });
    const serialized = JSON.stringify(redacted);
    for (const forbidden of [
      'authorization-header-secret', 'cookie-header-secret', 'safe-looking-opaque-secret',
      'url-user-secret', 'url-query-secret', 'Authorization', 'Cookie', 'safeLookingLeaf',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect((input.metadata as any).headers.Authorization).toBe('Bearer authorization-header-secret');
  });

  it('enforces configured-state-only redaction across the real Express response boundary', async () => {
    vi.stubEnv('OSHAL_OPERATOR_SUBS', 'Operator-Exact');
    const agentId = '11111111-1111-4111-8111-111111111111';
    const toolId = '22222222-2222-4222-8222-222222222222';
    const controller = new AgentToolController({
      getAgentTools: vi.fn(async () => [{
        agentId,
        toolId,
        authMode: AuthMode.OFF,
        installed: false,
        installVerified: false,
        toolConfig: credentialBearingToolConfig(),
        tool: { toolId, name: 'opaque-config-tool', displayName: 'Opaque Config Tool' },
      }]),
    } as any, {} as any, { info: vi.fn(), warn: vi.fn(), error: vi.fn() });
    const harness = await serve(createAgentToolRoutes(controller), '/api/agents');
    try {
      const response = await request(`${harness.url}/${agentId}/tools`, 'GET', 'Operator-Exact');
      expect(response.status).toBe(200);
      expect((response.body.tools as Array<any>)[0].toolConfig).toEqual({
        auth: { type: ToolAuthType.OAUTH2, enabled: true },
        configured: { auth: true, env: true, endpoint: true, metadata: true },
      });
      const serialized = JSON.stringify(response.body);
      for (const forbidden of [
        'authorization-header-secret', 'cookie-header-secret', 'safe-looking-opaque-secret',
        'url-user-secret', 'url-query-secret', 'Authorization', 'Cookie', 'safeLookingLeaf',
      ]) {
        expect(serialized).not.toContain(forbidden);
      }
    } finally {
      await harness.close();
    }
  });
});

describe('persisted tool command strings are inert data', () => {
  it('records a legacy verifyCommand as skipped and never executes it', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-verify-inert-'));
    const marker = path.join(tempRoot, 'should-not-exist.txt');
    const pool = verificationPool(`powershell -NoProfile -Command "Set-Content '${marker}' owned"`);
    try {
      const result = await new ToolVerificationService(pool as any).verifyTool('tool-1', 'operator');
      expect(result.status).toBe(VerificationStatus.SKIPPED);
      expect(result.verifyCommand).toBeNull();
      expect(result.errorMessage).toContain('free-form verify commands are disabled');
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('refuses non-NONE installation before writing a durable grant or install flag', async () => {
    const agentRepo = {
      getAgentTools: vi.fn(async () => []),
      setAuthMode: vi.fn(),
      markInstalled: vi.fn(),
    };
    const toolRepo = { getToolById: vi.fn(async () => inertTool()) };
    const service = new SwitchFrameworkService(agentRepo as any, toolRepo as any, console);
    const result = await service.setToolAuthMode('agent-1', 'tool-1', AuthMode.AUTO);
    expect(result.success).toBe(false);
    expect(agentRepo.setAuthMode).not.toHaveBeenCalled();
    expect(agentRepo.markInstalled).not.toHaveBeenCalled();
  });

  it('does not bypass provisioning when an inconsistent ASK row is uninstalled', async () => {
    const agentRepo = {
      getAgentTools: vi.fn(async () => [{ toolId: 'tool-1', authMode: AuthMode.ASK, installed: false }]),
      setAuthMode: vi.fn(),
      markInstalled: vi.fn(),
    };
    const toolRepo = { getToolById: vi.fn(async () => inertTool()) };
    const service = new SwitchFrameworkService(agentRepo as any, toolRepo as any, console);
    const result = await service.setToolAuthMode('agent-1', 'tool-1', AuthMode.AUTO);
    expect(result.success).toBe(false);
    expect(agentRepo.setAuthMode).not.toHaveBeenCalled();
  });
});

/** Build the minimal SQL double needed to observe a skipped verification record. */
function verificationPool(verifyCommand: string) {
  return { query: vi.fn(async (sql: string, values: unknown[] = []) => {
    if (/FROM tools\s+WHERE tool_id/i.test(sql)) {
      return { rows: [{ ...toolRow(), install_spec: { method: 'script', verifyCommand } }] };
    }
    if (/INSERT INTO tool_verification_results/i.test(sql)) {
      return { rows: [{
        id: 'result-1', tool_id: values[0], tool_name: values[1], verify_command: values[2],
        status: values[3], exit_code: values[4], stdout: values[5], stderr: values[6],
        duration_ms: values[7], verified_by: values[8], error_message: values[9], verified_at: new Date(),
      }] };
    }
    return { rows: [] };
  }) };
}

/** Minimal persisted tool row for verification mapping. */
function toolRow() {
  return {
    tool_id: 'tool-1', name: 'dangerous-legacy-tool', display_name: 'Dangerous', type: ToolType.API,
    category: 'test', version: '1.0.0', skills: [], selector_fragment: '', routing_tags: [],
    auth_group: 'test', default_auth_mode: AuthMode.OFF, description: '', input_schema: {},
    output_schema: {}, usage_instructions: '', examples: [], requires_approval: false,
    timeout_ms: 1000, tags: [], enabled: true, registered_by: 'test', registered_at: new Date(),
    created_at: new Date(), updated_at: new Date(),
  };
}

/** Minimal non-NONE tool used to exercise the no-process grant policy. */
function inertTool() {
  return {
    toolId: 'tool-1', name: 'legacy-script-tool', type: ToolType.CLI,
    installSpec: { method: InstallMethod.SCRIPT, verifyCommand: 'whoami', cleanupCommand: 'whoami' },
  } as any;
}

/**
 * @description Builds a schema-valid runtime config containing secrets behind names and shapes
 * that a key-pattern blacklist cannot enumerate.
 * @returns Parsed tool runtime config accepted by the production write schema.
 */
function credentialBearingToolConfig(): Record<string, unknown> {
  return SetAgentToolConfigSchema.parse({
    toolConfig: {
      auth: {
        type: ToolAuthType.OAUTH2,
        enabled: true,
        oauth2: {
          flow: 'authorization_code',
          authorizeUrl: 'https://url-user:url-user-secret@identity.invalid/authorize?state=url-query-secret',
          tokenUrl: 'https://identity.invalid/token?client_secret=url-query-secret',
          clientId: 'client-id-is-also-write-only',
          clientSecret: 'oauth-client-secret',
          accessToken: 'oauth-access-token',
          scopes: ['scope-is-write-only'],
        },
      },
      env: { SAFE_LOOKING_NAME: 'environment-secret' },
      endpoint: {
        url: 'https://url-user:url-user-secret@service.invalid/path?token=url-query-secret',
        baseUrl: 'https://service.invalid/base?authorization=url-query-secret',
        region: 'opaque-region-secret',
      },
      metadata: {
        headers: {
          Authorization: 'Bearer authorization-header-secret',
          Cookie: 'session=cookie-header-secret',
        },
        nested: [{ safeLookingLeaf: 'safe-looking-opaque-secret' }],
        callback: 'https://url-user:url-user-secret@callback.invalid/?key=url-query-secret',
      },
    },
  }).toolConfig;
}

/** Supply harmless Express handlers for controller methods not relevant to one focused assertion. */
function routeController(overrides: Record<string, unknown>): Record<string, unknown> {
  return new Proxy(overrides, {
    get(target, property) {
      if (property in target) return target[property as string];
      return (_req: unknown, res: any) => res.json({ ok: true });
    },
  });
}
