/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the ADR-034 boot bootstrap-pull resolution order (env-as-seed): a pulled authoritative record WINS over the container env seeds (FORCE_LLM_PROVIDER/FORCE_LLM_MODEL + provider-specific CODEX_MODEL/CLAUDE_CODE_MODEL); an absent/failed/disabled pull leaves the env completely untouched (legacy self-resolve, fail-open). Also drives pullBotConfigFromController against a stub fetch: success parse, 404 → null, non-OK → null, network error → null, malformed body → null, X-Service-Secret header sent when configured.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Thundering-herd regression guard (BACKLOG 2026-07-19 deploy-herd): the boot pull must jitter uniform-[0, OSHAL_BOT_CONFIG_BOOTSTRAP_JITTER_MS) BEFORE fetching /api/agents/:id/runtime — goes red if the jitter is removed, moved after the pull, or the default is silently zeroed. Covers: sleep-before-fetch ordering with duration = rng()*window; knob=0 kill switch (no sleep, behavior identical to pre-fix); default-on when the env var is absent (window 12000); garbage/negative knob falls back to the default (fail-safe toward protection); window resolver semantics. Existing end-to-end tests inject a no-op sleep so the suite stays fast.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const logSpies = vi.hoisted(() => ({
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('@/shared/logger', () => ({
  createChildLogger: () => logSpies,
}));

import {
  applyPulledBotConfigToEnv,
  isBootstrapPullEnabled,
  normalizePulledProviderName,
  pullBotConfigFromController,
  resolveBootConfigJitterWindowMs,
  runBootConfigBootstrap,
} from '../../src/app/bot-node-config-bootstrap';

const AGENT_ID = 'a0000000-0000-0000-0000-000000000042';

/** No-op sleep so end-to-end bootstrap tests never wait on the (default-on) herd jitter. */
const noopSleep = async (_ms: number): Promise<void> => {};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function runtimeBody(providerId: string | null, modelId: string | null, configVersion = 3): unknown {
  return { success: true, agentId: AGENT_ID, runtime: { providerId, modelId, mode: null, requestTimeoutMs: null }, configVersion };
}

let savedSecret: string | undefined;
beforeEach(() => {
  savedSecret = process.env.SWARM_SERVICE_SECRET;
  delete process.env.SWARM_SERVICE_SECRET;
  logSpies.warn.mockClear();
  logSpies.info.mockClear();
});
afterEach(() => {
  if (savedSecret === undefined) delete process.env.SWARM_SERVICE_SECRET;
  else process.env.SWARM_SERVICE_SECRET = savedSecret;
});

describe('bot-node boot config bootstrap-pull (ADR-034 env-as-seed)', () => {
  describe('resolution order — applyPulledBotConfigToEnv', () => {
    it('pulled provider + model WIN over the container env seeds', () => {
      const env: NodeJS.ProcessEnv = { FORCE_LLM_PROVIDER: 'cline-cli', FORCE_LLM_MODEL: 'seed-model', CODEX_MODEL: 'seed-codex' };
      const applied = applyPulledBotConfigToEnv(
        { providerId: 'openai-codex', modelId: 'gpt-5.5-pulled', configVersion: 7 },
        env,
      );
      expect(env.FORCE_LLM_PROVIDER).toBe('openai-codex');
      expect(env.FORCE_LLM_MODEL).toBe('gpt-5.5-pulled');
      expect(env.CODEX_MODEL).toBe('gpt-5.5-pulled');
      expect(applied).toEqual(['FORCE_LLM_PROVIDER', 'FORCE_LLM_MODEL', 'CODEX_MODEL']);
    });

    it('absent record (null) leaves the env untouched — legacy self-resolve', () => {
      const env: NodeJS.ProcessEnv = { FORCE_LLM_PROVIDER: 'claude-code', CLAUDE_CODE_MODEL: 'claude-sonnet-4-6' };
      const applied = applyPulledBotConfigToEnv(null, env);
      expect(applied).toEqual([]);
      expect(env).toEqual({ FORCE_LLM_PROVIDER: 'claude-code', CLAUDE_CODE_MODEL: 'claude-sonnet-4-6' });
    });

    it('a record with only a provider does not clobber the model seeds', () => {
      const env: NodeJS.ProcessEnv = { FORCE_LLM_MODEL: 'seed-model', CODEX_MODEL: 'seed-codex' };
      const applied = applyPulledBotConfigToEnv({ providerId: 'claude-code', modelId: null, configVersion: 1 }, env);
      expect(applied).toEqual(['FORCE_LLM_PROVIDER']);
      expect(env.FORCE_LLM_MODEL).toBe('seed-model');
      expect(env.CODEX_MODEL).toBe('seed-codex');
    });

    it('a model pulled WITHOUT a provider only sets the generic FORCE_LLM_MODEL (never a harness-specific key)', () => {
      const env: NodeJS.ProcessEnv = {};
      const applied = applyPulledBotConfigToEnv({ providerId: null, modelId: 'some-model', configVersion: 2 }, env);
      expect(applied).toEqual(['FORCE_LLM_MODEL']);
      expect(env.CODEX_MODEL).toBeUndefined();
      expect(env.CLAUDE_CODE_MODEL).toBeUndefined();
    });

    it('claude-code records write CLAUDE_CODE_MODEL; legacy aliases normalize (codex-cli → openai-codex)', () => {
      const claudeEnv: NodeJS.ProcessEnv = {};
      applyPulledBotConfigToEnv({ providerId: 'claude-code', modelId: 'claude-opus-4-5', configVersion: 1 }, claudeEnv);
      expect(claudeEnv.CLAUDE_CODE_MODEL).toBe('claude-opus-4-5');
      expect(claudeEnv.CODEX_MODEL).toBeUndefined();

      const codexAliasEnv: NodeJS.ProcessEnv = {};
      applyPulledBotConfigToEnv({ providerId: 'codex-cli', modelId: 'gpt-5.5', configVersion: 1 }, codexAliasEnv);
      // FORCE_LLM_PROVIDER keeps the raw vocabulary (resolveCurrentProvider accepts both);
      // the harness-specific model key routes via the normalized name.
      expect(codexAliasEnv.FORCE_LLM_PROVIDER).toBe('codex-cli');
      expect(codexAliasEnv.CODEX_MODEL).toBe('gpt-5.5');
      expect(normalizePulledProviderName('codex-cli')).toBe('openai-codex');
      expect(normalizePulledProviderName('cline')).toBe('cline-cli');
      expect(normalizePulledProviderName('anthropic')).toBe('anthropic');
    });
  });

  describe('pullBotConfigFromController — fail-open pull', () => {
    it('parses a successful controller response', async () => {
      const fetchImpl = vi.fn(async () => jsonResponse(runtimeBody('openai-codex', 'gpt-5.5', 9)));
      const pulled = await pullBotConfigFromController({
        agentId: AGENT_ID, controllerBaseUrl: 'http://controller:5000', fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      expect(pulled).toEqual({ providerId: 'openai-codex', modelId: 'gpt-5.5', configVersion: 9 });
      const [url] = fetchImpl.mock.calls[0] as unknown as [string];
      expect(url).toBe(`http://controller:5000/api/agents/${AGENT_ID}/runtime`);
    });

    it('sends the X-Service-Secret header when the swarm secret is configured', async () => {
      process.env.SWARM_SERVICE_SECRET = 'boot-pull-secret';
      const fetchImpl = vi.fn(async () => jsonResponse(runtimeBody('claude-code', null)));
      await pullBotConfigFromController({ agentId: AGENT_ID, fetchImpl: fetchImpl as unknown as typeof fetch });
      const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
      expect((init.headers as Record<string, string>)['X-Service-Secret']).toBe('boot-pull-secret');
    });

    it('returns null on 404 (no record yet) without warning', async () => {
      const fetchImpl = vi.fn(async () => jsonResponse({ success: false, error: 'no record' }, 404));
      const pulled = await pullBotConfigFromController({ agentId: AGENT_ID, fetchImpl: fetchImpl as unknown as typeof fetch });
      expect(pulled).toBeNull();
      expect(logSpies.warn).not.toHaveBeenCalled();
    });

    it('returns null (fail-open, WARN) on non-OK, network error, and malformed body', async () => {
      const nonOk = vi.fn(async () => jsonResponse({ success: false }, 503));
      expect(await pullBotConfigFromController({ agentId: AGENT_ID, fetchImpl: nonOk as unknown as typeof fetch })).toBeNull();

      const netErr = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
      expect(await pullBotConfigFromController({ agentId: AGENT_ID, fetchImpl: netErr as unknown as typeof fetch })).toBeNull();

      const malformed = vi.fn(async () => jsonResponse({ success: true }));
      expect(await pullBotConfigFromController({ agentId: AGENT_ID, fetchImpl: malformed as unknown as typeof fetch })).toBeNull();

      expect(logSpies.warn).toHaveBeenCalledTimes(3);
    });
  });

  describe('runBootConfigBootstrap — end-to-end order', () => {
    it('applies the pulled record over the env seeds and reports what it overwrote', async () => {
      const env: NodeJS.ProcessEnv = { FORCE_LLM_PROVIDER: 'cline-cli' };
      const fetchImpl = vi.fn(async () => jsonResponse(runtimeBody('claude-code', 'claude-opus-4-5', 4)));
      const pulled = await runBootConfigBootstrap(AGENT_ID, { env, fetchImpl: fetchImpl as unknown as typeof fetch, sleepImpl: noopSleep });
      expect(pulled?.providerId).toBe('claude-code');
      expect(env.FORCE_LLM_PROVIDER).toBe('claude-code');
      expect(env.CLAUDE_CODE_MODEL).toBe('claude-opus-4-5');
    });

    it('pull failure leaves the env untouched (legacy self-resolve wins)', async () => {
      const env: NodeJS.ProcessEnv = { FORCE_LLM_PROVIDER: 'openai-codex', CODEX_MODEL: 'gpt-5.5' };
      const fetchImpl = vi.fn(async () => { throw new Error('controller down'); });
      const pulled = await runBootConfigBootstrap(AGENT_ID, { env, fetchImpl: fetchImpl as unknown as typeof fetch, sleepImpl: noopSleep });
      expect(pulled).toBeNull();
      expect(env).toEqual({ FORCE_LLM_PROVIDER: 'openai-codex', CODEX_MODEL: 'gpt-5.5' });
    });

    it('OSHAL_BOT_CONFIG_BOOTSTRAP=off disables the pull entirely', async () => {
      const env: NodeJS.ProcessEnv = { OSHAL_BOT_CONFIG_BOOTSTRAP: 'off', FORCE_LLM_PROVIDER: 'cline-cli' };
      const fetchImpl = vi.fn(async () => jsonResponse(runtimeBody('claude-code', 'claude-opus-4-5')));
      const pulled = await runBootConfigBootstrap(AGENT_ID, { env, fetchImpl: fetchImpl as unknown as typeof fetch, sleepImpl: noopSleep });
      expect(pulled).toBeNull();
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(env.FORCE_LLM_PROVIDER).toBe('cline-cli');
      expect(isBootstrapPullEnabled({ OSHAL_BOT_CONFIG_BOOTSTRAP: 'off' })).toBe(false);
      expect(isBootstrapPullEnabled({})).toBe(true);
    });
  });

  describe('boot herd jitter — thundering-herd regression guard (BACKLOG deploy-herd)', () => {
    it('sleeps rng()*window BEFORE the pull fetch (ordering + bound)', async () => {
      const order: string[] = [];
      const sleepImpl = vi.fn(async (_ms: number) => { order.push('sleep'); });
      const fetchImpl = vi.fn(async () => {
        order.push('fetch');
        return jsonResponse(runtimeBody('claude-code', 'claude-opus-4-5'));
      });
      const env: NodeJS.ProcessEnv = { OSHAL_BOT_CONFIG_BOOTSTRAP_JITTER_MS: '12000' };
      await runBootConfigBootstrap(AGENT_ID, {
        env, fetchImpl: fetchImpl as unknown as typeof fetch, sleepImpl, rng: () => 0.5,
      });
      expect(sleepImpl).toHaveBeenCalledTimes(1);
      expect(sleepImpl).toHaveBeenCalledWith(6000); // floor(0.5 * 12000)
      expect(order).toEqual(['sleep', 'fetch']); // jitter must precede the herd-forming request
    });

    it('knob=0 is a kill switch: no sleep, pull behavior identical to pre-fix', async () => {
      const sleepImpl = vi.fn(async (_ms: number) => {});
      const fetchImpl = vi.fn(async () => jsonResponse(runtimeBody('openai-codex', 'gpt-5.5')));
      const env: NodeJS.ProcessEnv = { OSHAL_BOT_CONFIG_BOOTSTRAP_JITTER_MS: '0' };
      const pulled = await runBootConfigBootstrap(AGENT_ID, {
        env, fetchImpl: fetchImpl as unknown as typeof fetch, sleepImpl, rng: () => 0.99,
      });
      expect(sleepImpl).not.toHaveBeenCalled();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(pulled?.providerId).toBe('openai-codex');
    });

    it('default-on: with the env var absent a nonzero, bounded delay is requested (goes red if the default is silently zeroed)', async () => {
      const sleepImpl = vi.fn(async (_ms: number) => {});
      const fetchImpl = vi.fn(async () => jsonResponse(runtimeBody('claude-code', null)));
      await runBootConfigBootstrap(AGENT_ID, {
        env: {}, fetchImpl: fetchImpl as unknown as typeof fetch, sleepImpl, rng: () => 0.25,
      });
      expect(sleepImpl).toHaveBeenCalledTimes(1);
      const requested = (sleepImpl.mock.calls[0] as unknown as [number])[0];
      expect(requested).toBe(3000); // floor(0.25 * default 12000)
      expect(requested).toBeGreaterThan(0);
      expect(requested).toBeLessThan(12000);
    });

    it('a zero rng draw skips the sleep call but still pulls', async () => {
      const sleepImpl = vi.fn(async (_ms: number) => {});
      const fetchImpl = vi.fn(async () => jsonResponse(runtimeBody('claude-code', null)));
      await runBootConfigBootstrap(AGENT_ID, {
        env: {}, fetchImpl: fetchImpl as unknown as typeof fetch, sleepImpl, rng: () => 0,
      });
      expect(sleepImpl).not.toHaveBeenCalled();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('resolveBootConfigJitterWindowMs: default 12000; explicit values honored; garbage/negative fail-safe to the default', () => {
      expect(resolveBootConfigJitterWindowMs({})).toBe(12000);
      expect(resolveBootConfigJitterWindowMs({ OSHAL_BOT_CONFIG_BOOTSTRAP_JITTER_MS: '' })).toBe(12000);
      expect(resolveBootConfigJitterWindowMs({ OSHAL_BOT_CONFIG_BOOTSTRAP_JITTER_MS: '5000' })).toBe(5000);
      expect(resolveBootConfigJitterWindowMs({ OSHAL_BOT_CONFIG_BOOTSTRAP_JITTER_MS: '0' })).toBe(0);
      expect(resolveBootConfigJitterWindowMs({ OSHAL_BOT_CONFIG_BOOTSTRAP_JITTER_MS: '2500.9' })).toBe(2500);
      expect(resolveBootConfigJitterWindowMs({ OSHAL_BOT_CONFIG_BOOTSTRAP_JITTER_MS: 'not-a-number' })).toBe(12000);
      expect(resolveBootConfigJitterWindowMs({ OSHAL_BOT_CONFIG_BOOTSTRAP_JITTER_MS: '-5' })).toBe(12000);
    });

    it('OSHAL_BOT_CONFIG_BOOTSTRAP=off still short-circuits before any jitter sleep', async () => {
      const sleepImpl = vi.fn(async (_ms: number) => {});
      const fetchImpl = vi.fn(async () => jsonResponse(runtimeBody('claude-code', null)));
      const pulled = await runBootConfigBootstrap(AGENT_ID, {
        env: { OSHAL_BOT_CONFIG_BOOTSTRAP: 'off' }, fetchImpl: fetchImpl as unknown as typeof fetch, sleepImpl,
      });
      expect(pulled).toBeNull();
      expect(sleepImpl).not.toHaveBeenCalled();
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });
});
