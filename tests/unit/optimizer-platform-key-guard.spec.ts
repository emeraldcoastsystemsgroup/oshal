/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Pins the optimizer spend guard: the Token Chase framework:openrouter lane, when backed by the platform's shared OPENROUTER_API_KEY (which now carries the one-time $10 credit), must coerce to platformFreeConnection()'s :free pick — and refuse the lane when free quota is walled — instead of replaying on the registry's paid default model (found 2026-07-11: the lane defaulted to anthropic/claude-3.5-sonnet and bypassed the 791286de :free-only guard entirely).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Keep the platform-key guard isolated while optimizer provider discovery also reads the aggregate free-lane eligibility and rotation APIs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PLATFORM_KEY = 'sk-or-v1-platform-test-key';

vi.mock('../../src/app/routes/provider-routes', () => ({
  listConfiguredProviders: vi.fn(() => ({
    activeProvider: 'claude-code',
    providers: [
      { id: 'claude-code', label: 'Claude Code', selectedModel: '', defaultModelId: 'claude-haiku-4-5' },
      { id: 'openrouter', label: 'OpenRouter', selectedModel: '', defaultModelId: 'anthropic/claude-3.5-sonnet' },
    ],
  })),
}));

vi.mock('../../src/app/routes/byo-llm-routes', () => ({
  ANY_LLM_PROVIDER: 'any-llm',
  getUserLlmConnection: vi.fn(async () => null),
  buildAnyLlmListEntry: vi.fn(() => ({ connections: [] })),
}));

vi.mock('../../src/app/routes/connector-tenancy', () => ({
  accessibleConnections: vi.fn(async () => []),
}));

vi.mock('../../src/app/routes/free-tier-rotation', () => ({
  freeTierRuntimeSnapshot: vi.fn(() => ({ configured: false, verdict: 'unknown', model: null })),
  listFreeTierConnections: vi.fn(async () => []),
  platformFreeConnection: vi.fn(),
  reportResolvedLlmFailure: vi.fn(async () => false),
  reportSuccess: vi.fn(async () => undefined),
  resolveLiveFreeTierConnection: vi.fn(async () => null),
}));

import { listOptimizerLogins, resolveOptimizerLane } from '../../src/app/routes/optimizer-providers';
import { platformFreeConnection } from '../../src/app/routes/free-tier-rotation';

const mockedFree = vi.mocked(platformFreeConnection);

describe('Token Chase optimizer — platform OpenRouter key spend guard', () => {
  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = PLATFORM_KEY;
    mockedFree.mockReset();
  });
  afterEach(() => {
    delete process.env.OPENROUTER_API_KEY;
  });

  it('coerces the framework:openrouter lane to the probed-live :free model', async () => {
    mockedFree.mockResolvedValue({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: PLATFORM_KEY,
      model: 'openai/gpt-oss-20b:free',
    } as any);

    const lane = await resolveOptimizerLane({} as any, 'user-1', 'framework:openrouter');

    expect(lane).not.toBeNull();
    expect(lane!.kind).toBe('byo');
    if (lane!.kind === 'byo') {
      expect(lane!.model).toBe('openai/gpt-oss-20b:free');
      expect(lane!.model.endsWith(':free')).toBe(true);
      expect(lane!.apiKey).toBe(PLATFORM_KEY);
    }
  });

  it('refuses the lane (null) when the platform free quota is walled — never falls back to paid', async () => {
    mockedFree.mockResolvedValue(null);

    const lane = await resolveOptimizerLane({} as any, 'user-1', 'framework:openrouter');

    expect(lane).toBeNull();
  });

  it('does not touch a lane whose configured model is already :free', async () => {
    const { listConfiguredProviders } = await import('../../src/app/routes/provider-routes');
    vi.mocked(listConfiguredProviders).mockReturnValueOnce({
      activeProvider: 'claude-code',
      providers: [
        { id: 'openrouter', label: 'OpenRouter', selectedModel: 'meta-llama/llama-3.3-70b-instruct:free', defaultModelId: 'anthropic/claude-3.5-sonnet' },
      ],
    } as any);

    const lane = await resolveOptimizerLane({} as any, 'user-1', 'framework:openrouter');

    expect(lane).not.toBeNull();
    if (lane!.kind === 'byo') expect(lane!.model).toBe('meta-llama/llama-3.3-70b-instruct:free');
    expect(mockedFree).not.toHaveBeenCalled();
  });

  it('the lane picker shows the :free coercion instead of the paid default', async () => {
    const logins = await listOptimizerLogins({} as any, 'user-1');
    const openrouter = logins.find((l) => l.connectionId === 'framework:openrouter');

    expect(openrouter).toBeDefined();
    expect(openrouter!.model).toBe(':free (auto — platform key)');
    expect(openrouter!.model).not.toContain('sonnet');
  });
});
