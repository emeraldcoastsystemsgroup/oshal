import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import {
  executeTrustedProviderIntent,
  extractWeatherIntentLocation,
  parseTrustedProviderIntent,
  trustedProviderAgentId,
  type TrustedProviderExecutionDeps,
} from '../../src/app/bot-node-provider-intent';
import { createBotNodeExecutionHandler } from '../../src/app/bot-node-execution-handler';

const requireModule = createRequire(import.meta.url);
const normalizers = requireModule('../../any-bot/server/services/codebase/provider-record-capture.js') as {
  normalizeWeatherRecord(data: unknown): unknown;
  normalizeGmailRecord(data: unknown): unknown;
  normalizeWalmartCatalogRecord(data: unknown, query: string, retrievedAt?: string): unknown;
};

const WEATHER_INTENT = {
  schemaVersion: 1 as const,
  kind: 'weather' as const,
  operation: 'current-forecast' as const,
  location: 'Destin, Florida',
};
const EMAIL_INTENT = {
  schemaVersion: 1 as const,
  kind: 'priority-email' as const,
  operation: 'priority-summary' as const,
};
const WALMART_INTENT = {
  schemaVersion: 1 as const,
  kind: 'walmart-catalog' as const,
  operation: 'product-search' as const,
  query: "Ben & Jerry's ice cream + fish food",
  limit: 4,
};

function weatherData(): Record<string, unknown> {
  return {
    location: 'Destin, FL',
    timestamp: '2026-07-10T14:00:00.000Z',
    current: { temp_f: 84, temp_c: 28.9, conditions: 'Sunny', humidity: 50 },
    forecast: [{ name: 'Tonight', temp_f: 76, temp_c: 24.4, conditions: 'Clear' }],
  };
}

function walmartData(): Record<string, unknown> {
  return {
    source: 'walmart',
    retrievedAt: '2026-07-12T14:30:00.000Z',
    items: [{
      retailer: 'walmart',
      productId: '10849069',
      title: 'Tetra TetraMin Tropical Flakes',
      brand: 'Tetra',
      price: 7.97,
      imageUrl: 'https://i5.walmartimages.com/asr/tetra.jpeg',
      productUrl: 'https://www.walmart.com/ip/10849069',
    }],
  };
}

function deps(overrides: Partial<TrustedProviderExecutionDeps> = {}): TrustedProviderExecutionDeps {
  return {
    formatWeather: vi.fn(async () => ({ success: true, data: weatherData() })),
    gmailDigest: vi.fn(async () => [{
      id: 'message-1', from: 'Ada <ada@example.com>', subject: 'Decision needed',
      receivedAt: '2026-07-10T13:00:00.000Z', snippet: 'private preview', body: 'private body',
      providerFlags: { unread: true, important: true, starred: false },
    }]),
    walmartSearch: vi.fn(async () => walmartData()),
    normalizeWeatherRecord: normalizers.normalizeWeatherRecord,
    normalizeGmailRecord: normalizers.normalizeGmailRecord,
    normalizeWalmartCatalogRecord: normalizers.normalizeWalmartCatalogRecord,
    now: () => new Date('2026-07-10T14:05:00.000Z'),
    ...overrides,
  };
}

describe('trusted provider intent schema and direct execution', () => {
  it('pins each structured provider intent to its least-privilege owner', () => {
    expect(trustedProviderAgentId({
      schemaVersion: 1, kind: 'weather', operation: 'current-forecast', location: 'Destin, FL',
    })).toBe('a0000000-0000-0000-0000-000000000036');
    expect(trustedProviderAgentId({
      schemaVersion: 1, kind: 'priority-email', operation: 'priority-summary',
    })).toBe('b0000000-0000-0000-0000-000000000001');
    expect(trustedProviderAgentId(WALMART_INTENT)).toBe('b0070000-0000-0000-0000-000000000001');
  });
  it('extracts a literal weather location and rejects command-shaped or widened intents', () => {
    expect(extractWeatherIntentLocation('What is the weather today in Destin, Florida?')).toBe('Destin, Florida');
    expect(extractWeatherIntentLocation('Show current conditions near Chicago.')).toBe('Chicago');
    expect(extractWeatherIntentLocation('Prepare a weather brief for our Destin trip.')).toBe('Destin');
    expect(extractWeatherIntentLocation('Prepare a weather brief for our family trip.')).toBeUndefined();
    expect(parseTrustedProviderIntent(WEATHER_INTENT)).toEqual(WEATHER_INTENT);
    expect(parseTrustedProviderIntent({ ...WEATHER_INTENT, location: 'Destin; env' })).toBeUndefined();
    expect(parseTrustedProviderIntent({ ...WEATHER_INTENT, location: '$(whoami)' })).toBeUndefined();
    expect(parseTrustedProviderIntent({ ...WEATHER_INTENT, command: 'node /tmp/attack.js' })).toBeUndefined();
    expect(parseTrustedProviderIntent({ ...EMAIL_INTENT, query: 'from:anyone' })).toBeUndefined();
    expect(parseTrustedProviderIntent(WALMART_INTENT)).toEqual(WALMART_INTENT);
    expect(parseTrustedProviderIntent({ ...WALMART_INTENT, limit: 0 })).toBeUndefined();
    expect(parseTrustedProviderIntent({ ...WALMART_INTENT, limit: 7 })).toBeUndefined();
    expect(parseTrustedProviderIntent({ ...WALMART_INTENT, limit: 1.5 })).toBeUndefined();
    expect(parseTrustedProviderIntent({ ...WALMART_INTENT, limit: '4' })).toBeUndefined();
    expect(parseTrustedProviderIntent({ ...WALMART_INTENT, query: 'fish\u0000food' })).toBeUndefined();
    expect(parseTrustedProviderIntent({ ...WALMART_INTENT, query: 'fish food; env' })).toBeUndefined();
    expect(parseTrustedProviderIntent({ ...WALMART_INTENT, query: '$(whoami)' })).toBeUndefined();
    expect(parseTrustedProviderIntent({ ...WALMART_INTENT, query: '`whoami`' })).toBeUndefined();
    expect(parseTrustedProviderIntent({ ...WALMART_INTENT, url: 'https://attacker.example' })).toBeUndefined();
  });

  it('runs weather in-process with only the validated location and returns one schema-valid record', async () => {
    const executionDeps = deps();
    const result = await executeTrustedProviderIntent(
      WEATHER_INTENT,
      { userSub: 'owner-1', creds: { PATH: '/attacker', OSHAL_CRED_GOOGLE: 'not-used' } },
      executionDeps,
    );

    expect(executionDeps.formatWeather).toHaveBeenCalledWith('Destin, Florida');
    expect(result).toMatchObject({
      completion: 'Live weather provider lookup completed for Destin, FL.',
      providerRecords: [{ kind: 'nws-weather', provider: 'nws', record: { location: 'Destin, FL' } }],
    });
  });

  it('uses only the request-scoped Google credential and strips Gmail snippets/bodies', async () => {
    const executionDeps = deps();
    const result = await executeTrustedProviderIntent(
      EMAIL_INTENT,
      {
        userSub: 'owner-2',
        creds: { OSHAL_CRED_GOOGLE: 'owner-2-token', OSHAL_CRED_TWITTER: 'unrelated-token' },
      },
      executionDeps,
    );

    expect(executionDeps.gmailDigest).toHaveBeenCalledWith('owner-2-token');
    expect(result.providerRecords[0]).toMatchObject({
      kind: 'gmail-summary', provider: 'gmail', mailbox: 'connected Gmail',
      messages: [{ id: 'message-1', important: true, unread: true }],
    });
    expect(JSON.stringify(result.providerRecords)).not.toContain('private preview');
    expect(JSON.stringify(result.providerRecords)).not.toContain('private body');
    await expect(executeTrustedProviderIntent(
      EMAIL_INTENT,
      { userSub: 'owner-2', creds: { OSHAL_CRED_TWITTER: 'wrong-provider' } },
      executionDeps,
    )).rejects.toThrow('request-scoped Google credential');
  });

  it('uses only the request-scoped Walmart credential and returns one live schema-valid catalog record', async () => {
    const executionDeps = deps();
    const previousAmbient = process.env.OSHAL_CRED_WALMART;
    process.env.OSHAL_CRED_WALMART = 'ambient-credential-must-not-be-read';
    try {
      const result = await executeTrustedProviderIntent(
        WALMART_INTENT,
        {
          userSub: 'owner-shopping',
          creds: {
            OSHAL_CRED_WALMART: 'request-scoped-walmart-credential',
            OSHAL_CRED_GOOGLE: 'unrelated-token',
          },
        },
        executionDeps,
      );

      expect(executionDeps.walmartSearch).toHaveBeenCalledWith(
        'request-scoped-walmart-credential',
        "Ben & Jerry's ice cream + fish food",
        4,
      );
      expect(process.env.OSHAL_CRED_WALMART).toBe('ambient-credential-must-not-be-read');
      expect(result).toMatchObject({
        completion: 'Live Walmart catalog lookup completed for 1 product.',
        providerRecords: [{
          kind: 'walmart-catalog',
          provider: 'walmart',
          query: "Ben & Jerry's ice cream + fish food",
          items: [{ productId: '10849069', title: 'Tetra TetraMin Tropical Flakes' }],
        }],
      });
      expect(JSON.stringify(result.providerRecords)).not.toContain('ambient-credential');
      expect(JSON.stringify(result.providerRecords)).not.toContain('request-scoped-walmart-credential');
    } finally {
      if (previousAmbient === undefined) delete process.env.OSHAL_CRED_WALMART;
      else process.env.OSHAL_CRED_WALMART = previousAmbient;
    }

    await expect(executeTrustedProviderIntent(
      WALMART_INTENT,
      { userSub: 'owner-shopping', creds: { OSHAL_CRED_GOOGLE: 'wrong-provider' } },
      executionDeps,
    )).rejects.toThrow('request-scoped Walmart credential');
  });

  it('rejects demo/fallback Walmart responses instead of converting them into provider evidence', async () => {
    const executionDeps = deps({
      walmartSearch: vi.fn(async () => ({
        source: 'demo', fallbackReason: 'provider_error', items: walmartData().items,
      })),
    });
    await expect(executeTrustedProviderIntent(
      WALMART_INTENT,
      { userSub: 'owner-shopping', creds: { OSHAL_CRED_WALMART: 'request-token' } },
      executionDeps,
    )).rejects.toThrow('Walmart catalog provider lookup failed');
  });

  it('fails before provider access without an authenticated owner or on provider failure', async () => {
    const executionDeps = deps({ formatWeather: vi.fn(async () => ({ error: 'offline' })) });
    await expect(executeTrustedProviderIntent(
      WEATHER_INTENT,
      { creds: {} },
      executionDeps,
    )).rejects.toThrow('authenticated owner');
    expect(executionDeps.formatWeather).not.toHaveBeenCalled();

    await expect(executeTrustedProviderIntent(
      WEATHER_INTENT,
      { userSub: 'owner-1', creds: {} },
      executionDeps,
    )).rejects.toThrow('Weather provider lookup failed');
  });
});

describe('bot-node provider-independent completion path', () => {
  function envelope(
    providerIntent: unknown,
    userSub = 'owner-1',
    options: { agentId?: string; creds?: Record<string, string> } = {},
  ) {
    const agentId = options.agentId || 'weather-agent';
    return {
      correlationId: 'provider-intent-correlation',
      fromAgentId: 'swarm-controller',
      toAgentId: agentId,
      channel: `swarm.agent.${agentId}`,
      messageType: 'request' as const,
      payload: {
        text: 'Worker prompt that must not control the provider call.',
        workspaceTaskId: 'provider-ticket-1',
        userSub,
        creds: options.creds || { OSHAL_CRED_GOOGLE: 'owner-token' },
        providerIntent,
      },
    };
  }

  it('returns the trusted record without invoking the worker LLM', async () => {
    const processMessage = vi.fn(async () => { throw new Error('quota exhausted'); });
    const executeProviderIntent = vi.fn(async () => ({
      completion: 'Live weather provider lookup completed for Destin, FL.',
      providerRecords: [normalizers.normalizeWeatherRecord(weatherData())],
    }));
    const handler = createBotNodeExecutionHandler({
      anyBotTaskController: {
        getTask: vi.fn(async () => null),
        createTask: vi.fn(async () => ({ id: 'provider-ticket-1' })),
        processMessage,
      },
      providerName: 'openai-codex',
      modelName: 'quota-limited-model',
      executeProviderIntent,
    });

    const result = await handler(envelope(WEATHER_INTENT));
    expect(executeProviderIntent).toHaveBeenCalledWith(WEATHER_INTENT, {
      userSub: 'owner-1', creds: { OSHAL_CRED_GOOGLE: 'owner-token' },
    });
    expect(processMessage).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: true,
      output: {
        response: 'Live weather provider lookup completed for Destin, FL.',
        provider: 'deterministic-provider',
        model: 'none',
        providerRecords: [{ kind: 'nws-weather', provider: 'nws' }],
      },
    });
  });

  it('returns a deterministic Walmart record without invoking Shopping Codex or web search', async () => {
    const processMessage = vi.fn(async () => { throw new Error('Shopping Codex must not run'); });
    const executeProviderIntent = vi.fn(async () => ({
      completion: 'Live Walmart catalog lookup completed for 1 product.',
      providerRecords: [normalizers.normalizeWalmartCatalogRecord(
        walmartData(),
        WALMART_INTENT.query,
        '2026-07-12T14:30:00.000Z',
      )],
    }));
    const handler = createBotNodeExecutionHandler({
      anyBotTaskController: {
        getTask: vi.fn(async () => null),
        createTask: vi.fn(async () => ({ id: 'provider-ticket-1' })),
        processMessage,
      },
      providerName: 'openai-codex',
      modelName: 'gpt-5.5',
      executeProviderIntent,
    });

    const result = await handler(envelope(WALMART_INTENT, 'owner-shopping', {
      agentId: 'b0070000-0000-0000-0000-000000000001',
      creds: { OSHAL_CRED_WALMART: 'owner-shopping-walmart-credential' },
    }));

    expect(executeProviderIntent).toHaveBeenCalledWith(WALMART_INTENT, {
      userSub: 'owner-shopping',
      creds: { OSHAL_CRED_WALMART: 'owner-shopping-walmart-credential' },
    });
    expect(processMessage).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: true,
      output: {
        response: 'Live Walmart catalog lookup completed for 1 product.',
        provider: 'deterministic-provider',
        model: 'none',
        providerRecords: [{ kind: 'walmart-catalog', provider: 'walmart' }],
      },
    });
  });

  it('fails closed on an invalid or failed intent and never falls through to model text', async () => {
    const processMessage = vi.fn(async () => ({
      messages: [{ say: 'completion_result', text: 'Model-authored fake weather.' }],
    }));
    const executeProviderIntent = vi.fn(async () => { throw new Error('Weather provider lookup failed'); });
    const handler = createBotNodeExecutionHandler({
      anyBotTaskController: {
        getTask: vi.fn(async () => null),
        createTask: vi.fn(async () => ({ id: 'provider-ticket-1' })),
        processMessage,
      },
      providerName: 'test-provider',
      modelName: 'test-model',
      executeProviderIntent,
    });

    await expect(handler(envelope({ ...WEATHER_INTENT, command: 'env' }))).resolves.toMatchObject({
      success: false, error: 'Invalid trusted provider intent',
    });
    await expect(handler(envelope(WEATHER_INTENT))).resolves.toMatchObject({
      success: false, error: 'Weather provider lookup failed',
    });
    expect(processMessage).not.toHaveBeenCalled();
  });
});
