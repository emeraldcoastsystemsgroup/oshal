import { afterEach, describe, expect, it } from 'vitest';
import {
  createRuntimeProvider,
  HARNESS_FACTORIES,
} from '../../src/app/composition/provider-runtime';

const ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_STALL_FALLBACK_PROVIDER',
  'OSHAL_PROVIDER_STALL_FALLBACK',
  'OSHAL_PROVIDER_STALL_FALLBACK_PROVIDER',
  'OSHAL_PROVIDER_STALL_FALLBACK_MODEL',
] as const;

const ORIGINAL_ENV = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof ENV_KEYS)[number], string | undefined>;

afterEach(() => {
  for (const key of ENV_KEYS) {
    const original = ORIGINAL_ENV[key];
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
});

describe('provider runtime stall fallback', () => {
  it('keeps generic Cline-backed provider ids as the configured provider override', () => {
    const provider = createRuntimeProvider('openai-codex');

    expect((provider as unknown as { configuredProvider?: string }).configuredProvider).toBe('openai-codex');
  });

  it('wraps claude-code factory with an opt-in stall fallback provider', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-unit-test-key';
    process.env.OSHAL_PROVIDER_STALL_FALLBACK = 'codex-cli';

    const provider = HARNESS_FACTORIES['claude-code']({});

    expect(provider.getProviderName()).toBe('failover:harness:claude-code->harness:codex-cli');
  });

  it('leaves claude-code unwrapped when no stall fallback is configured', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-unit-test-key';
    delete process.env.OSHAL_PROVIDER_STALL_FALLBACK;
    delete process.env.OSHAL_PROVIDER_STALL_FALLBACK_PROVIDER;
    delete process.env.CLAUDE_CODE_STALL_FALLBACK_PROVIDER;

    const provider = HARNESS_FACTORIES['claude-code']({});

    expect(provider.getProviderName()).toBe('harness:claude-code');
  });
});
