import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  ConnectorSpecToolService,
  resolveConnectorSpecCreds,
} from '../../../src/app/connectors/runtime/spec-tools';
import type { ConnectorSpec } from '../../../src/app/connectors/runtime';

describe('connector spec tools', () => {
  it('registers connector.yaml resources as framework API tools and connector executors', async () => {
    const specDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-connector-spec-tools-'));
    fs.writeFileSync(
      path.join(specDir, 'demo.yaml'),
      [
        'provider: demo',
        'displayName: Demo',
        'version: 1.0.0',
        'baseUrl: https://api.demo.test',
        'auth: { type: oauth2 }',
        'resources:',
        '  - name: me',
        '    tool: demo-me',
        '    method: GET',
        '    path: /me',
        '  - name: get-thing',
        '    tool: demo-get-thing',
        '    method: GET',
        '    path: /things/{thingId}',
        '  - name: create-thing',
        '    tool: demo-create-thing',
        '    method: POST',
        '    path: /things',
        '    body: { name: "{name}" }',
        '    retry: { maxRetries: 0 }',
      ].join('\n'),
    );
    const registeredTools: any[] = [];
    const descriptors: any[] = [];
    const service = new ConnectorSpecToolService({
      pool: {},
      specDir,
      getAccessToken: async () => 'token',
    });

    try {
      const registrations = await service.registerConnectorSpecTools(
        {
          registerOrUpdateTool: async (tool: any) => {
            registeredTools.push(tool);
            return { tool, created: true };
          },
        } as any,
        {
          register: (descriptor: any) => descriptors.push(descriptor),
        } as any,
      );

      expect(registrations).toHaveLength(3);
      expect(registeredTools.map((tool) => tool.name)).toEqual(['demo-me', 'demo-get-thing', 'demo-create-thing']);
      expect(registeredTools[1].inputSchema.required).toEqual(['thingId']);
      expect(registeredTools[2].requiresApproval).toBe(true);
      expect(registeredTools[2].inputSchema.properties).toMatchObject({
        name: { type: 'string' },
        dryRun: { type: 'boolean' },
        confirm: { type: 'boolean', const: true },
      });
      expect(descriptors[1]).toMatchObject({
        toolName: 'demo-get-thing',
        executorType: 'connector',
        connectorProvider: 'demo',
        connectorResource: 'get-thing',
      });
    } finally {
      fs.rmSync(specDir, { recursive: true, force: true });
    }
  });

  it('honors the connector marketplace provider gate for bulk and runtime registration', async () => {
    const specDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-connector-spec-tools-gate-'));
    fs.writeFileSync(
      path.join(specDir, 'alpha.yaml'),
      [
        'provider: alpha',
        'displayName: Alpha',
        'version: 1.0.0',
        'baseUrl: https://api.alpha.test',
        'auth: { type: oauth2 }',
        'resources:',
        '  - name: me',
        '    tool: alpha-me',
        '    method: GET',
        '    path: /me',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(specDir, 'beta.yaml'),
      [
        'provider: beta',
        'displayName: Beta',
        'version: 1.0.0',
        'baseUrl: https://api.beta.test',
        'auth: { type: oauth2 }',
        'resources:',
        '  - name: me',
        '    tool: beta-me',
        '    method: GET',
        '    path: /me',
      ].join('\n'),
    );
    const enabled = new Set(['alpha']);
    const registeredTools: any[] = [];
    const descriptors: any[] = [];
    const toolRegistry = {
      registerOrUpdateTool: async (tool: any) => {
        registeredTools.push(tool);
        return { tool, created: true };
      },
      getToolByName: async (name: string) => ({ toolId: name, name, tags: ['connector-spec'] }),
      updateTool: async () => ({}),
    } as any;
    const executorRegistry = {
      register: (descriptor: any) => descriptors.push(descriptor),
      deregister: (toolName: string) => descriptors.push({ deregistered: toolName }),
    } as any;
    const service = new ConnectorSpecToolService({
      pool: {},
      specDir,
      getAccessToken: async () => 'token',
      providerGate: { isProviderEnabled: (provider) => enabled.has(provider) },
    });

    try {
      await service.registerConnectorSpecTools(toolRegistry, executorRegistry);
      expect(registeredTools.map((tool) => tool.name)).toEqual(['alpha-me']);
      expect(descriptors[0]).toMatchObject({ toolName: 'alpha-me', runtimeRegistered: true });

      enabled.add('beta');
      await service.registerConnectorProvider('beta', toolRegistry, executorRegistry);
      expect(registeredTools.map((tool) => tool.name)).toEqual(['alpha-me', 'beta-me']);

      await service.deregisterConnectorProvider('beta', toolRegistry, executorRegistry);
      expect(descriptors).toContainEqual({ deregistered: 'beta-me' });
    } finally {
      fs.rmSync(specDir, { recursive: true, force: true });
    }
  });

  it('pre-filters disabled connector files before parsing mass-imported specs', async () => {
    const specDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-connector-spec-tools-prefilter-'));
    fs.writeFileSync(
      path.join(specDir, 'alpha.yaml'),
      [
        'provider: alpha',
        'displayName: Alpha',
        'version: 1.0.0',
        'baseUrl: https://api.alpha.test',
        'auth: { type: oauth2 }',
        'resources:',
        '  - name: me',
        '    tool: alpha-me',
        '    method: GET',
        '    path: /me',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(specDir, 'beta.yaml'),
      [
        'provider: beta',
        'displayName: Broken Disabled Connector',
        'auth: { type: oauth2 }',
        'resources: []',
      ].join('\n'),
    );
    const registeredTools: any[] = [];
    const service = new ConnectorSpecToolService({
      pool: {},
      specDir,
      getAccessToken: async () => 'token',
      providerGate: {
        enabledProviderSet: () => new Set(['alpha']),
        isProviderEnabled: (provider) => provider === 'alpha',
      },
    });

    try {
      await service.registerConnectorSpecTools(
        {
          registerOrUpdateTool: async (tool: any) => {
            registeredTools.push(tool);
            return { tool, created: true };
          },
        } as any,
        { register: () => undefined } as any,
      );

      expect(registeredTools.map((tool) => tool.name)).toEqual(['alpha-me']);
    } finally {
      fs.rmSync(specDir, { recursive: true, force: true });
    }
  });

  it('resolves connector credentials per user without cross-user leakage', async () => {
    const spec: ConnectorSpec = {
      provider: 'github',
      baseUrl: 'https://api.github.com',
      auth: { type: 'oauth2' },
      resources: [{ name: 'me', method: 'GET', path: '/user' }],
    };
    const tokens: Record<string, string> = {
      'user-a:github': 'token-a',
      'user-b:github': 'token-b',
    };
    const getAccessToken = async (_pool: unknown, userSub: string, provider: string) => (
      tokens[`${userSub}:${provider}`] ?? null
    );

    const userACreds = await resolveConnectorSpecCreds(spec, {}, 'user-a', getAccessToken);
    const userBCreds = await resolveConnectorSpecCreds(spec, {}, 'user-b', getAccessToken);

    await expect(userACreds.token?.()).resolves.toBe('token-a');
    await expect(userBCreds.token?.()).resolves.toBe('token-b');
  });

  it('splits per-user basic credentials on the first colon only', async () => {
    const spec: ConnectorSpec = {
      provider: 'jira',
      baseUrl: 'https://example.atlassian.net',
      auth: { type: 'basic' },
      resources: [{ name: 'me', method: 'GET', path: '/rest/api/3/myself' }],
    };

    const creds = await resolveConnectorSpecCreds(
      spec,
      {},
      'user-a',
      async () => 'me@example.com:api:token:with:colon',
    );

    expect(creds.username).toBe('me@example.com');
    expect(creds.password).toBe('api:token:with:colon');
  });
});
