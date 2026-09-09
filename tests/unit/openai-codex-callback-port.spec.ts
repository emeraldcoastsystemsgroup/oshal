/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the empty-callback-port regression (2026-09-09): compose forwards `${OPENAI_CODEX_CALLBACK_PORT:-}` as an EMPTY string on every deployment that doesn't set it, the old `??`-only fallback parsed "" to NaN, the :1455 listener was skipped, and every codex OAuth login died at ERR_EMPTY_RESPONSE. Pins ""/whitespace → default 1455 for the shared port reader and proves callback-port request detection still matches the default port under an empty var.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_OPENAI_CODEX_CALLBACK_PORT,
  isOpenAiCodexCallbackPortRequest,
  resolveConfiguredOpenAiCodexCallbackPort,
} from '@/app/server-auth-helpers';

let savedPort: string | undefined;

beforeEach(() => {
  savedPort = process.env.OPENAI_CODEX_CALLBACK_PORT;
});

afterEach(() => {
  if (savedPort === undefined) delete process.env.OPENAI_CODEX_CALLBACK_PORT;
  else process.env.OPENAI_CODEX_CALLBACK_PORT = savedPort;
});

function requestWithHost(host: string): Parameters<typeof isOpenAiCodexCallbackPortRequest>[0] {
  return { get: (name: string) => (name.toLowerCase() === 'host' ? host : undefined) } as never;
}

describe('resolveConfiguredOpenAiCodexCallbackPort', () => {
  it('falls back to the default when the var is unset', () => {
    delete process.env.OPENAI_CODEX_CALLBACK_PORT;
    expect(resolveConfiguredOpenAiCodexCallbackPort()).toBe(String(DEFAULT_OPENAI_CODEX_CALLBACK_PORT));
  });

  it('treats the compose-forwarded EMPTY string as unset — the live regression', () => {
    process.env.OPENAI_CODEX_CALLBACK_PORT = '';
    expect(resolveConfiguredOpenAiCodexCallbackPort()).toBe(String(DEFAULT_OPENAI_CODEX_CALLBACK_PORT));
  });

  it('treats whitespace as unset', () => {
    process.env.OPENAI_CODEX_CALLBACK_PORT = '   ';
    expect(resolveConfiguredOpenAiCodexCallbackPort()).toBe(String(DEFAULT_OPENAI_CODEX_CALLBACK_PORT));
  });

  it('honors an explicit override', () => {
    process.env.OPENAI_CODEX_CALLBACK_PORT = '2455';
    expect(resolveConfiguredOpenAiCodexCallbackPort()).toBe('2455');
  });
});

describe('isOpenAiCodexCallbackPortRequest', () => {
  it('matches the default callback port when the var is the compose-forwarded empty string', () => {
    process.env.OPENAI_CODEX_CALLBACK_PORT = '';
    // Before the fix this compared '1455' === '' and answered false — callback-port
    // requests then fell into normal-port routing on top of the missing listener.
    expect(isOpenAiCodexCallbackPortRequest(requestWithHost('localhost:1455'))).toBe(true);
    expect(isOpenAiCodexCallbackPortRequest(requestWithHost('localhost:35457'))).toBe(false);
  });

  it('matches an explicit override port', () => {
    process.env.OPENAI_CODEX_CALLBACK_PORT = '2455';
    expect(isOpenAiCodexCallbackPortRequest(requestWithHost('localhost:2455'))).toBe(true);
    expect(isOpenAiCodexCallbackPortRequest(requestWithHost('localhost:1455'))).toBe(false);
  });
});
