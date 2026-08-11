/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the DEMO-gated operator-key lane. Pins the two failure shapes it was built for: (a) an operator turn with no connected LLM used to resolve to NOTHING, which handed the turn to a CLI harness SEC-05 refuses at the node — on a demo box it must now resolve to the deployment's own hosted key; (b) that key must NEVER be lent when DEMO_MODE is off, nor to a non-operator caller. Also pins the require-content probe budget, since a 16-token probe scores live reasoning models (gemini-2.5-flash, gpt-oss-120b) as dead by spending the whole budget on hidden thinking.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Failure-cooldown cases (live 2026-08-11): a probe can pass on a quota trickle while full turns 429, so a reported mid-turn failure must EXCLUDE the lane — resolution rotates to the next vendor even though the cooled lane's probe would answer, without ever re-probing the cooled lane; and with every configured lane cooled, resolution answers null (configured-provider fallback) rather than handing back a walled key.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getUserLlmConnection = vi.fn();
const accessibleConnections = vi.fn();

vi.mock('../../src/app/routes/byo-llm-routes', () => ({
  getUserLlmConnection: (...args: unknown[]) => getUserLlmConnection(...args),
  ANY_LLM_PROVIDER: 'any-llm',
}));

vi.mock('../../src/app/routes/connector-tenancy', () => ({
  accessibleConnections: (...args: unknown[]) => accessibleConnections(...args),
  ownerSub: (row: { user_sub?: string }) => row.user_sub ?? '',
}));

import {
  demoKeysEnabled,
  invalidateOperatorKeyLane,
  operatorKeyConnection,
  reportResolvedLlmFailure,
  resetOperatorLaneCooldownsForTesting,
  resolveUserLlmConnection,
  type ResolvedUserLlmConnection,
} from '../../src/app/routes/free-tier-rotation';

const OPERATOR_SUB = 'operator-sub-1';
const OTHER_SUB = 'someone-else';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/openai';
const GROQ_BASE = 'https://api.groq.com/openai/v1';

/** Env vars this spec owns; restored verbatim after each case so ordering can't leak state. */
const OWNED_ENV = [
  'DEMO_MODE', 'OSHAL_OPERATOR_SUBS', 'OSHAL_OPERATOR_LLM_LANES', 'OSHAL_OPERATOR_LLM_PROVIDER',
  'OSHAL_OPERATOR_LLM_MODEL', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GROQ_API_KEY',
  'CEREBRAS_API_KEY', 'MISTRAL_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY',
];
let saved: Record<string, string | undefined> = {};

/** A vendor stub that answers with real content — the shape a usable lane returns. */
function answeringFetch() {
  return vi.fn(async () => new Response(
    JSON.stringify({ choices: [{ message: { content: 'pong' } }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  ));
}

/** The reasoning-model failure shape: HTTP 200, zero content (thinking ate the budget). */
function emptyCompletionFetch() {
  return vi.fn(async () => new Response(
    JSON.stringify({ choices: [{ message: { content: '' } }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  ));
}

/** Base URL of the nth probe the stub made. */
function probedBase(stub: ReturnType<typeof vi.fn>, n: number): string {
  return String(stub.mock.calls[n]?.[0] ?? '');
}

beforeEach(() => {
  saved = Object.fromEntries(OWNED_ENV.map((k) => [k, process.env[k]]));
  for (const k of OWNED_ENV) delete process.env[k];
  process.env.OSHAL_OPERATOR_SUBS = OPERATOR_SUB;
  getUserLlmConnection.mockReset().mockResolvedValue(null);
  accessibleConnections.mockReset().mockResolvedValue([]);
  invalidateOperatorKeyLane();
  resetOperatorLaneCooldownsForTesting();
});

afterEach(() => {
  for (const k of OWNED_ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
  invalidateOperatorKeyLane();
  resetOperatorLaneCooldownsForTesting();
});

describe('demo switch', () => {
  it('is off unless DEMO_MODE is explicitly truthy', () => {
    expect(demoKeysEnabled()).toBe(false);
    for (const off of ['', '0', 'false', 'no', 'off', 'DEMO']) {
      process.env.DEMO_MODE = off;
      expect(demoKeysEnabled()).toBe(false);
    }
    for (const on of ['1', 'true', 'TRUE', 'yes', 'On']) {
      process.env.DEMO_MODE = on;
      expect(demoKeysEnabled()).toBe(true);
    }
  });

  it('lends no host key at all when the switch is off — not even one probe', async () => {
    process.env.GEMINI_API_KEY = 'k-gemini';
    const stub = answeringFetch();
    vi.stubGlobal('fetch', stub);

    expect(await operatorKeyConnection()).toBeNull();
    expect(await resolveUserLlmConnection({}, OPERATOR_SUB)).toBeUndefined();
    expect(stub).not.toHaveBeenCalled();
  });
});

describe('operator-key lane (DEMO_MODE on)', () => {
  beforeEach(() => { process.env.DEMO_MODE = 'true'; });

  it('resolves the operator to the deployment key instead of nothing', async () => {
    process.env.GEMINI_API_KEY = 'k-gemini';
    vi.stubGlobal('fetch', answeringFetch());

    const resolved = await resolveUserLlmConnection({}, OPERATOR_SUB);
    expect(resolved).toMatchObject({
      baseUrl: GEMINI_BASE,
      apiKey: 'k-gemini',
      model: 'gemini-2.5-flash',
      resolutionSource: 'operator-key',
    });
  });

  it('accepts GOOGLE_API_KEY as the gemini lane key', async () => {
    process.env.GOOGLE_API_KEY = 'k-google';
    vi.stubGlobal('fetch', answeringFetch());
    expect(await operatorKeyConnection()).toMatchObject({ baseUrl: GEMINI_BASE, apiKey: 'k-google' });
  });

  it('rotates to the next configured vendor when a lane answers 200-but-empty', async () => {
    process.env.GEMINI_API_KEY = 'k-gemini';
    process.env.GROQ_API_KEY = 'k-groq';
    let call = 0;
    const stub = vi.fn(async () => {
      call += 1;
      return call === 1
        ? new Response(JSON.stringify({ choices: [{ message: { content: '' } }] }), { status: 200 })
        : new Response(JSON.stringify({ choices: [{ message: { content: 'pong' } }] }), { status: 200 });
    });
    vi.stubGlobal('fetch', stub);

    expect(await operatorKeyConnection()).toMatchObject({ baseUrl: GROQ_BASE, apiKey: 'k-groq' });
    expect(probedBase(stub, 0)).toContain('generativelanguage');
    expect(probedBase(stub, 1)).toContain('api.groq.com');
  });

  it('skips lanes this deployment has no key for', async () => {
    process.env.MISTRAL_API_KEY = 'k-mistral';
    const stub = answeringFetch();
    vi.stubGlobal('fetch', stub);

    expect(await operatorKeyConnection()).toMatchObject({ apiKey: 'k-mistral' });
    expect(stub).toHaveBeenCalledTimes(1);
  });

  it('honours an explicit provider pin and model override', async () => {
    process.env.GEMINI_API_KEY = 'k-gemini';
    process.env.GROQ_API_KEY = 'k-groq';
    process.env.OSHAL_OPERATOR_LLM_PROVIDER = 'groq';
    process.env.OSHAL_OPERATOR_LLM_MODEL = 'llama-3.1-8b-instant';
    const stub = answeringFetch();
    vi.stubGlobal('fetch', stub);

    expect(await operatorKeyConnection()).toMatchObject({
      baseUrl: GROQ_BASE, apiKey: 'k-groq', model: 'llama-3.1-8b-instant',
    });
    expect(stub).toHaveBeenCalledTimes(1);
  });

  it('returns null (no lane) when no hosted key answers, so the caller can be honest', async () => {
    process.env.GEMINI_API_KEY = 'k-gemini';
    vi.stubGlobal('fetch', emptyCompletionFetch());
    expect(await operatorKeyConnection()).toBeNull();
    expect(await resolveUserLlmConnection({}, OPERATOR_SUB)).toBeUndefined();
  });

  it('never lends the host key to a non-operator caller', async () => {
    process.env.GEMINI_API_KEY = 'k-gemini';
    const stub = answeringFetch();
    vi.stubGlobal('fetch', stub);

    expect(await resolveUserLlmConnection({}, OTHER_SUB)).toBeUndefined();
    for (const call of stub.mock.calls) {
      expect(String(call[0])).not.toContain('generativelanguage');
    }
  });

  it('keeps an explicit BYO connection ahead of the host key', async () => {
    process.env.GEMINI_API_KEY = 'k-gemini';
    getUserLlmConnection.mockResolvedValue({ baseUrl: 'https://mine.example/v1', apiKey: 'k-mine', model: 'my-model' });
    const stub = answeringFetch();
    vi.stubGlobal('fetch', stub);

    expect(await resolveUserLlmConnection({}, OPERATOR_SUB)).toMatchObject({
      baseUrl: 'https://mine.example/v1', apiKey: 'k-mine', resolutionSource: 'explicit',
    });
    expect(stub).not.toHaveBeenCalled();
  });

  it('caches the verdict so a turn does not re-probe the vendor every time', async () => {
    process.env.GEMINI_API_KEY = 'k-gemini';
    const stub = answeringFetch();
    vi.stubGlobal('fetch', stub);

    await operatorKeyConnection();
    await operatorKeyConnection();
    expect(stub).toHaveBeenCalledTimes(1);

    invalidateOperatorKeyLane();
    await operatorKeyConnection();
    expect(stub).toHaveBeenCalledTimes(2);
  });

  it('gives a reasoning model room to answer: the require-content probe is not a 16-token probe', async () => {
    process.env.GEMINI_API_KEY = 'k-gemini';
    const stub = answeringFetch();
    vi.stubGlobal('fetch', stub);

    await operatorKeyConnection();
    const body = JSON.parse(String((stub.mock.calls[0]?.[1] as { body?: string })?.body ?? '{}'));
    expect(body.max_tokens).toBeGreaterThanOrEqual(256);
  });
});

describe('failure cooldown — a lane a real turn died on is EXCLUDED, probe or no probe', () => {
  beforeEach(() => { process.env.DEMO_MODE = 'true'; });

  /** The connection shape retryHostedBrainTurn hands to the failure report after a turn dies. */
  const failedGeminiConnection = {
    baseUrl: GEMINI_BASE, apiKey: 'k-gemini', model: 'gemini-2.5-flash', resolutionSource: 'operator-key',
  } as unknown as ResolvedUserLlmConnection;
  const QUOTA_429 = new Error('byo-hosted endpoint generativelanguage.googleapis.com returned HTTP 429: quota exceeded');

  it('after a reported mid-turn failure, resolution rotates to the next vendor WITHOUT re-probing the cooled lane — even though that probe would pass', async () => {
    process.env.GEMINI_API_KEY = 'k-gemini';
    process.env.GROQ_API_KEY = 'k-groq';
    // Every probe ANSWERS — the exact live trap: Gemini's probe passes on the quota trickle
    // while full turns 429. Invalidation alone hands Gemini straight back.
    const stub = answeringFetch();
    vi.stubGlobal('fetch', stub);

    expect(await operatorKeyConnection()).toMatchObject({ baseUrl: GEMINI_BASE });
    expect(await reportResolvedLlmFailure({}, failedGeminiConnection, QUOTA_429)).toBe(true);

    expect(await operatorKeyConnection()).toMatchObject({ baseUrl: GROQ_BASE, apiKey: 'k-groq' });
    // Probe 0 was the original Gemini resolution; after the report, the cooled lane is never
    // probed again — the next probe goes straight to the second vendor.
    expect(probedBase(stub, 0)).toContain('generativelanguage');
    for (const call of stub.mock.calls.slice(1)) {
      expect(String(call[0])).not.toContain('generativelanguage');
    }
  });

  it('with every configured lane cooled, resolution answers null — never a walled key', async () => {
    process.env.GEMINI_API_KEY = 'k-gemini';
    const stub = answeringFetch();
    vi.stubGlobal('fetch', stub);

    expect(await reportResolvedLlmFailure({}, failedGeminiConnection, QUOTA_429)).toBe(true);
    expect(await operatorKeyConnection()).toBeNull();
    expect(stub).not.toHaveBeenCalled();
  });
});
