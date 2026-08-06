/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | New — pins the 2026-07-10 free-tier fixes: platformFreeConnection returns null (never an unprobed dead model) when every candidate is walled and caches the verdict so probes stop burning the shared key's daily quota; resolveUserLlmConnection skips the free-tier legs for the operator (ambient identity + OSHAL_OPERATOR_SUBS) so their turns stay on the bot's configured provider.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Runtime discovery era: fetch fake now speaks BOTH OpenRouter endpoints (GET /models + POST /chat/completions) since candidates come from live discovery, probe counts assert on completion calls only, and new tests pin: catalog-sourced candidates (no hardcoded ids), the zero-pricing+:free double filter, 200-but-empty (reasoning-model) rotation, and discovery-failure → null without burning probes.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Guard exact operator-subject exemption semantics: configuration delimiter whitespace remains accepted, while case and caller-whitespace aliases use the free-tier lane instead of inheriting paid-provider privilege.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** A pool whose every query returns no rows: no BYO connection, no user free tiers. */
const emptyPool = { query: async () => ({ rows: [] }) } as any;

/** Fresh module registry per test — platformFreeConnection caches its verdict, discovered
 *  catalog, and last-live model in module state. */
async function loadFresh() {
  vi.resetModules();
  const rotation = await import('../../src/app/routes/free-tier-rotation');
  const identity = await import('../../src/shared/services/database/request-identity');
  return { rotation, identity };
}

type CatalogEntry = { id: string; context_length?: number; pricing?: { prompt?: string; completion?: string } };

/** Default discovered catalog: two live :free ids + one paid id that must never surface. */
const CATALOG: CatalogEntry[] = [
  { id: 'openai/test-small:free', context_length: 131072, pricing: { prompt: '0', completion: '0' } },
  { id: 'qwen/test-large:free', context_length: 262144, pricing: { prompt: '0', completion: '0' } },
  { id: 'vendor/paid-model', context_length: 200000, pricing: { prompt: '0.002', completion: '0.01' } },
];

/** fetch fake speaking both OpenRouter endpoints the rotation uses: GET /models (discovery)
 *  and POST /chat/completions (probes / user-connection liveness). */
function openRouterFetch(opts?: {
  catalog?: CatalogEntry[] | 'unavailable';
  completion?: (model: string) => { status: number; content?: string };
}) {
  return vi.fn(async (url: unknown, init?: { body?: unknown }) => {
    if (String(url).endsWith('/models')) {
      if (opts?.catalog === 'unavailable') return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ data: opts?.catalog ?? CATALOG }) };
    }
    const model = String(JSON.parse(String(init?.body ?? '{}')).model ?? '');
    const r = opts?.completion?.(model) ?? { status: 200, content: 'pong' };
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => ({ choices: [{ message: { content: r.content ?? '' } }] }),
    };
  });
}

/** The models actually probed with a REAL completion (the calls that spend daily quota). */
const completionModels = (fetchMock: ReturnType<typeof vi.fn>): string[] =>
  fetchMock.mock.calls
    .filter((c) => String(c[0]).endsWith('/chat/completions'))
    .map((c) => String(JSON.parse(String((c[1] as { body?: unknown })?.body ?? '{}')).model ?? ''));

const SAVED_ENV = ['OPENROUTER_API_KEY', 'OPENROUTER_FREE_MODEL', 'OSHAL_OPERATOR_SUBS'] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(SAVED_ENV.map((k) => [k, process.env[k]]));
  for (const k of SAVED_ENV) delete process.env[k];
});

afterEach(() => {
  for (const k of SAVED_ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
});

describe('platformFreeConnection — walled-key behavior (2026-07-10 live incident)', () => {
  it('returns null when every candidate probe is rate-limited, and caches the verdict', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test-not-real';
    const fetchMock = openRouterFetch({ completion: () => ({ status: 429 }) });
    vi.stubGlobal('fetch', fetchMock);
    const { rotation } = await loadFresh();

    // All models 429 (OpenRouter's free-requests/day cap is account-wide) → null, so the
    // caller falls back to the bot's configured provider instead of a guaranteed-dead conn.
    expect(await rotation.platformFreeConnection()).toBeNull();
    const probesUsed = completionModels(fetchMock).length;
    expect(probesUsed).toBeGreaterThan(0);

    // Second resolution inside the TTL must not re-burn probes (probes are real completions
    // that spend the daily quota).
    expect(await rotation.platformFreeConnection()).toBeNull();
    expect(completionModels(fetchMock).length).toBe(probesUsed);
  });

  it('returns the first live candidate and caches it (no re-probe per ask)', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test-not-real';
    const fetchMock = openRouterFetch();
    vi.stubGlobal('fetch', fetchMock);
    const { rotation } = await loadFresh();

    const conn = await rotation.platformFreeConnection();
    expect(conn?.model).toMatch(/:free$/);
    expect(completionModels(fetchMock).length).toBe(1);

    const again = await rotation.platformFreeConnection();
    expect(again).toEqual(conn);
    expect(completionModels(fetchMock).length).toBe(1); // served from the cached verdict
  });

  it('invalidates a stale live verdict after the real completion returns 429', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test-not-real';
    const fetchMock = openRouterFetch();
    vi.stubGlobal('fetch', fetchMock);
    const { rotation } = await loadFresh();

    const resolved = await rotation.resolveUserLlmConnection(emptyPool, 'regular-user');
    expect(resolved?.resolutionSource).toBe('platform');
    expect(completionModels(fetchMock).length).toBe(1);

    expect(await rotation.reportResolvedLlmFailure(
      emptyPool, resolved, new Error('Bot node execution failed: 429 Provider returned error'),
    )).toBe(true);

    // The follow-up does not burn another model probe. It returns undefined so Jarvis retries once
    // on its configured bot provider instead of trusting the stale ten-minute "live" result.
    expect(await rotation.resolveUserLlmConnection(emptyPool, 'regular-user')).toBeUndefined();
    expect(completionModels(fetchMock).length).toBe(1);
  });

  it('does not invalidate rotation state for an unrelated execution error', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test-not-real';
    const fetchMock = openRouterFetch();
    vi.stubGlobal('fetch', fetchMock);
    const { rotation } = await loadFresh();
    const resolved = await rotation.resolveUserLlmConnection(emptyPool, 'regular-user');

    expect(await rotation.reportResolvedLlmFailure(
      emptyPool, resolved, new Error('Renderer failed'),
    )).toBe(false);
    expect((await rotation.resolveUserLlmConnection(emptyPool, 'regular-user'))?.model).toBe(resolved?.model);
    expect(completionModels(fetchMock).length).toBe(1);
  });

  it('does not replay an explicitly selected BYO prompt on the configured provider', async () => {
    const { rotation } = await loadFresh();
    const explicit = {
      baseUrl: 'https://llm.user.example/v1', apiKey: 'user-key', model: 'user-model',
      resolutionSource: 'explicit' as const,
    };

    expect(await rotation.reportResolvedLlmFailure(
      emptyPool, explicit, new Error('429 rate limit'),
    )).toBe(false);
  });

  it('treats an empty final answer from a free model as retryable without exposing reasoning', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test-not-real';
    vi.stubGlobal('fetch', openRouterFetch());
    const { rotation } = await loadFresh();
    const resolved = await rotation.resolveUserLlmConnection(emptyPool, 'regular-user');

    expect(await rotation.reportResolvedLlmFailure(
      emptyPool, resolved, Object.assign(new Error('OpenAI-compatible endpoint returned no final answer'), {
        code: 'EMPTY_FINAL_ANSWER',
      }),
    )).toBe(true);
  });

  it('does not retry a generic provider error that is not a quota wall', async () => {
    const { rotation } = await loadFresh();
    const platform = {
      baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'platform-key', model: 'model:free',
      resolutionSource: 'platform' as const,
    };

    expect(await rotation.reportResolvedLlmFailure(
      emptyPool, platform, new Error('Provider returned error: invalid request'),
    )).toBe(false);
  });
});

describe('resolveUserLlmConnection — operator exemption from the free-tier legs', () => {
  it('skips the free-tier legs for an allowlisted sub (background/scheduled work)', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test-not-real';
    process.env.OSHAL_OPERATOR_SUBS = ' op-sub-123 ';
    const fetchMock = openRouterFetch();
    vi.stubGlobal('fetch', fetchMock);
    const { rotation } = await loadFresh();

    // Operator → undefined (bot's configured provider runs); no discovery, no probe.
    expect(await rotation.resolveUserLlmConnection(emptyPool, 'op-sub-123')).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not exempt case or caller-whitespace aliases of the operator subject', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test-not-real';
    process.env.OSHAL_OPERATOR_SUBS = 'op-sub-123';
    const fetchMock = openRouterFetch();
    vi.stubGlobal('fetch', fetchMock);
    const { rotation } = await loadFresh();

    for (const alias of ['OP-SUB-123', ' op-sub-123', 'op-sub-123 ']) {
      expect((await rotation.resolveUserLlmConnection(emptyPool, alias))?.resolutionSource).toBe('platform');
    }
    expect(fetchMock).toHaveBeenCalled();
  });

  it('skips the free-tier legs when the ambient request identity is an operator', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test-not-real';
    const fetchMock = openRouterFetch();
    vi.stubGlobal('fetch', fetchMock);
    const { rotation, identity } = await loadFresh();

    await identity.runWithRequestIdentity({ sub: 'interactive-op', isOperator: true }, async () => {
      expect(await rotation.resolveUserLlmConnection(emptyPool, 'interactive-op')).toBeUndefined();
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still resolves the platform free connection for a regular user', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test-not-real';
    const fetchMock = openRouterFetch();
    vi.stubGlobal('fetch', fetchMock);
    const { rotation } = await loadFresh();

    const conn = await rotation.resolveUserLlmConnection(emptyPool, 'regular-user');
    expect(conn?.model).toMatch(/:free$/);
  });
});

describe('platformFreeConnection — hard free-only guard (operator directive 2026-07-11)', () => {
  it('never probes or returns a non-:free override — the shared account now carries real credit', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test-not-real';
    process.env.OPENROUTER_FREE_MODEL = 'openai/gpt-5.5'; // paid model id, misconfigured
    const fetchMock = openRouterFetch();
    vi.stubGlobal('fetch', fetchMock);
    const { rotation } = await loadFresh();

    const conn = await rotation.platformFreeConnection();
    expect(conn?.model).toMatch(/:free$/);                       // rotation still serves a :free model
    expect(completionModels(fetchMock)).not.toContain('openai/gpt-5.5'); // the paid id was never even probed
  });
});

describe('platformFreeConnection — runtime discovery (BACKLOG "Free-tier model rot")', () => {
  it('sources candidates from GET /models — first live catalog model wins, paid ids never surface', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test-not-real';
    const fetchMock = openRouterFetch();
    vi.stubGlobal('fetch', fetchMock);
    const { rotation } = await loadFresh();

    const conn = await rotation.platformFreeConnection();
    // openai/ family ranks ahead of qwen/ in the probe-order heuristic.
    expect(conn?.model).toBe('openai/test-small:free');
    expect(completionModels(fetchMock)).not.toContain('vendor/paid-model');
  });

  it('drops a :free-suffixed id whose pricing is not zero (spend-safety is a double filter)', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test-not-real';
    const fetchMock = openRouterFetch({
      catalog: [
        { id: 'sneaky/costs-money:free', context_length: 999999, pricing: { prompt: '0.001', completion: '0.004' } },
        { id: 'honest/actually-free:free', context_length: 8192, pricing: { prompt: '0', completion: '0' } },
      ],
    });
    vi.stubGlobal('fetch', fetchMock);
    const { rotation } = await loadFresh();

    const conn = await rotation.platformFreeConnection();
    expect(conn?.model).toBe('honest/actually-free:free');
    expect(completionModels(fetchMock)).not.toContain('sneaky/costs-money:free');
  });

  it('rotates past a reasoning model that answers 200 with empty content', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test-not-real';
    const fetchMock = openRouterFetch({
      catalog: [
        // Same family rank — the larger context makes the reasoner rank (and probe) first.
        { id: 'openai/reasoner:free', context_length: 262144, pricing: { prompt: '0', completion: '0' } },
        { id: 'openai/talker:free', context_length: 131072, pricing: { prompt: '0', completion: '0' } },
      ],
      completion: (model) => (model === 'openai/reasoner:free'
        ? { status: 200, content: '' }        // eats the probe's max_tokens on hidden reasoning
        : { status: 200, content: 'pong' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const { rotation } = await loadFresh();

    const conn = await rotation.platformFreeConnection();
    expect(conn?.model).toBe('openai/talker:free');
    expect(completionModels(fetchMock)).toEqual(['openai/reasoner:free', 'openai/talker:free']);
  });

  it('returns null without burning any probe when discovery fails and no override is set', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test-not-real';
    const fetchMock = openRouterFetch({ catalog: 'unavailable' });
    vi.stubGlobal('fetch', fetchMock);
    const { rotation } = await loadFresh();

    expect(await rotation.platformFreeConnection()).toBeNull();
    expect(completionModels(fetchMock).length).toBe(0);
  });
});
