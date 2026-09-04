/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the Hugging Face Inference Providers lane. Boundary under test: the two lane TABLES (free-tier catalog + OpenAI-compatible operator lanes) and the RESOLVER that turns an env key into a probed operator connection — both run for real. Doubled: the vendor HTTP probe (a Response stub); its real companion is scripts/evidence/prove-free-tier-live.ts with HF_TOKEN set (recorded in docs/governance/real-boundary-regression-audit.md). Pins: one router base URL shared by both tables (no drift), `:cheapest` on every candidate (the monthly credit is $0.10), HF last in the default operator order, HF_TOKEN and HUGGINGFACE_API_KEY both accepted, and the probe actually addressed to router.huggingface.co with the bearer token.
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

import { FREE_PROVIDERS, getFreeProvider } from '../../src/app/routes/free-tier-providers';
import {
  DEFAULT_OPERATOR_LANE_ORDER,
  OPENAI_COMPAT_LANES,
  laneKeyFromEnv,
} from '../../src/app/routes/openai-compat-lanes';
import {
  invalidateOperatorKeyLane,
  operatorKeyConnection,
  resetOperatorLaneCooldownsForTesting,
} from '../../src/app/routes/free-tier-rotation';

const ROUTER = 'https://router.huggingface.co/v1';

/** Env vars this spec owns; restored verbatim after each case so ordering can't leak state. */
const OWNED_ENV = [
  'DEMO_MODE', 'OSHAL_OPERATOR_SUBS', 'OSHAL_OPERATOR_LLM_LANES', 'OSHAL_OPERATOR_LLM_PROVIDER',
  'OSHAL_OPERATOR_LLM_MODEL', 'HF_TOKEN', 'HUGGINGFACE_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
  'GROQ_API_KEY', 'CEREBRAS_API_KEY', 'MISTRAL_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY',
];
let saved: Record<string, string | undefined> = {};

/** A vendor stub that answers with real content — the shape a usable lane returns. */
function answeringFetch() {
  return vi.fn(async () => new Response(
    JSON.stringify({ choices: [{ message: { content: 'pong' } }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  ));
}

/** URL of the nth probe the stub made. */
function probedUrl(stub: ReturnType<typeof vi.fn>, n: number): string {
  return String(stub.mock.calls[n]?.[0] ?? '');
}

/** Authorization header of the nth probe, whatever container the resolver used. */
function probedAuth(stub: ReturnType<typeof vi.fn>, n: number): string {
  const init = stub.mock.calls[n]?.[1] as RequestInit | undefined;
  const h = init?.headers;
  if (!h) return '';
  if (h instanceof Headers) return h.get('authorization') ?? '';
  if (Array.isArray(h)) return (h.find(([k]) => k.toLowerCase() === 'authorization') ?? [])[1] ?? '';
  const rec = h as Record<string, string>;
  return rec.Authorization ?? rec.authorization ?? '';
}

beforeEach(() => {
  saved = Object.fromEntries(OWNED_ENV.map((k) => [k, process.env[k]]));
  for (const k of OWNED_ENV) delete process.env[k];
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

describe('Hugging Face lane tables', () => {
  it('is a first-class free-tier catalog entry on the OpenAI-compatible router', () => {
    const lane = getFreeProvider('huggingface');
    expect(lane).toBeDefined();
    expect(lane!.baseUrl).toBe(ROUTER);
    expect(lane!.baseUrl.endsWith('/')).toBe(false);
    expect(lane!.freeModels.length).toBeGreaterThan(0);
    expect(lane!.oauth).toBe(false);
    expect(lane!.keyHelpUrl).toMatch(/^https:\/\/huggingface\.co\/settings\/tokens/);
  });

  it('carries the :cheapest policy suffix on every candidate — the monthly credit is thin', () => {
    for (const id of FREE_PROVIDERS.huggingface.freeModels) {
      expect(id).toMatch(/^[\w.-]+\/[\w.-]+:cheapest$/);
    }
    expect(OPENAI_COMPAT_LANES.huggingface.defaultModel).toMatch(/:cheapest$/);
  });

  it('shares ONE base URL between the free-tier catalog and the operator lane table', () => {
    expect(OPENAI_COMPAT_LANES.huggingface.baseUrl).toBe(FREE_PROVIDERS.huggingface.baseUrl);
  });

  it('is the LAST default operator lane, listed exactly once', () => {
    expect(DEFAULT_OPERATOR_LANE_ORDER.filter((id) => id === 'huggingface')).toHaveLength(1);
    expect(DEFAULT_OPERATOR_LANE_ORDER[DEFAULT_OPERATOR_LANE_ORDER.length - 1]).toBe('huggingface');
  });

  it('accepts HF_TOKEN first and HUGGINGFACE_API_KEY as the alias', () => {
    const lane = OPENAI_COMPAT_LANES.huggingface;
    expect(laneKeyFromEnv(lane)).toBeNull();
    process.env.HUGGINGFACE_API_KEY = 'hf_alias';
    expect(laneKeyFromEnv(lane)).toBe('hf_alias');
    process.env.HF_TOKEN = 'hf_primary';
    expect(laneKeyFromEnv(lane)).toBe('hf_primary');
  });
});

describe('Hugging Face operator-key lane (DEMO_MODE on)', () => {
  beforeEach(() => {
    process.env.DEMO_MODE = 'true';
    process.env.OSHAL_OPERATOR_SUBS = 'operator-sub-1';
  });

  it('probes the router with the bearer token and resolves to it when it is the only configured lane', async () => {
    process.env.HF_TOKEN = 'hf_live';
    const stub = answeringFetch();
    vi.stubGlobal('fetch', stub);
    const resolved = await operatorKeyConnection();
    expect(resolved).toMatchObject({ baseUrl: ROUTER, apiKey: 'hf_live', model: 'openai/gpt-oss-20b:cheapest' });
    expect(stub).toHaveBeenCalledTimes(1);
    expect(probedUrl(stub, 0)).toBe(`${ROUTER}/chat/completions`);
    expect(probedAuth(stub, 0)).toBe('Bearer hf_live');
  });

  it('runs AFTER every other configured lane — Groq wins when both keys are present', async () => {
    process.env.HF_TOKEN = 'hf_live';
    process.env.GROQ_API_KEY = 'k-groq';
    const stub = answeringFetch();
    vi.stubGlobal('fetch', stub);
    const resolved = await operatorKeyConnection();
    expect(resolved).toMatchObject({ apiKey: 'k-groq' });
    expect(probedUrl(stub, 0)).toContain('api.groq.com');
    expect(stub).toHaveBeenCalledTimes(1);
  });
});
