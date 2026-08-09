/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for ADR-127's SEC-05 carve. The carve is the one place an autonomous CLI harness may run at a bot node, so the guard's real job is the NEGATIVE space: every provider in the refused set stays refused off-demo, for a non-operator, and for an identity-less request, and the demo flag reads DEMO_MODE alone (never MOCK_OIDC — mock auth must not unlock a real subscription). Exercises the exported preflight directly, which is the function the handler calls before any task or workspace is created.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertUnattendedProviderPreflight } from '../../src/app/bot-node-execution-handler';

const OPERATOR = 'operator-sub-1';
const GUEST = 'guest-sub-9';
const CLI_PROVIDERS = ['cline', 'cline-cli', 'claude', 'claude-code', 'codex', 'codex-cli', 'openai-codex'];

const OWNED_ENV = ['DEMO_MODE', 'MOCK_OIDC', 'OSHAL_OPERATOR_SUBS'];
let saved: Record<string, string | undefined> = {};

/** Assert the preflight refuses, with the SEC-05 code intact (callers branch on it). */
function expectRefusal(input: Parameters<typeof assertUnattendedProviderPreflight>[0]): void {
  try {
    assertUnattendedProviderPreflight(input);
  } catch (err) {
    expect((err as Error & { code?: string }).code).toBe('UNBROKERED_AUTONOMOUS_PROVIDER');
    return;
  }
  throw new Error(`preflight allowed ${String(input.providerName)} when it must refuse`);
}

beforeEach(() => {
  saved = Object.fromEntries(OWNED_ENV.map((k) => [k, process.env[k]]));
  for (const k of OWNED_ENV) delete process.env[k];
  process.env.OSHAL_OPERATOR_SUBS = OPERATOR;
});

afterEach(() => {
  for (const k of OWNED_ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('SEC-05 preflight — the refusal that must survive', () => {
  it('refuses every autonomous CLI when DEMO_MODE is off, operator or not', () => {
    for (const providerName of CLI_PROVIDERS) {
      expectRefusal({ providerName, userSub: OPERATOR });
      expectRefusal({ providerName, userSub: GUEST });
    }
  });

  it('refuses a non-operator caller even in demo mode', () => {
    process.env.DEMO_MODE = 'true';
    for (const providerName of CLI_PROVIDERS) expectRefusal({ providerName, userSub: GUEST });
  });

  it('refuses an identity-less request in demo mode — unattended work is never unlocked', () => {
    process.env.DEMO_MODE = 'true';
    for (const providerName of CLI_PROVIDERS) {
      expectRefusal({ providerName });
      expectRefusal({ providerName, userSub: '' });
      expectRefusal({ providerName, userSub: '   ' });
      expectRefusal({ providerName, userSub: null });
    }
  });

  it('does not treat MOCK_OIDC as a demo deployment', () => {
    process.env.MOCK_OIDC = 'true';
    for (const providerName of CLI_PROVIDERS) expectRefusal({ providerName, userSub: OPERATOR });
  });

  it('refuses a sub that only looks like the operator (case/whitespace variants)', () => {
    process.env.DEMO_MODE = 'true';
    for (const lookalike of [OPERATOR.toUpperCase(), ` ${OPERATOR}`, `${OPERATOR} `, `${OPERATOR}x`]) {
      expectRefusal({ providerName: 'claude-code', userSub: lookalike });
    }
  });
});

describe('SEC-05 preflight — what it must allow', () => {
  it('allows the CLI for the deployment operator on a demo box', () => {
    process.env.DEMO_MODE = 'true';
    for (const providerName of CLI_PROVIDERS) {
      expect(() => assertUnattendedProviderPreflight({ providerName, userSub: OPERATOR })).not.toThrow();
    }
  });

  it('keeps the pre-existing bypasses intact regardless of the demo switch', () => {
    for (const providerName of CLI_PROVIDERS) {
      expect(() => assertUnattendedProviderPreflight({ providerName, deterministicIntent: true })).not.toThrow();
      expect(() => assertUnattendedProviderPreflight({ providerName, byoHostedInference: true })).not.toThrow();
    }
  });

  it('never refuses a hosted provider', () => {
    for (const providerName of ['openai', 'anthropic-api', 'gemini', 'byo-llm', 'noop', '']) {
      expect(() => assertUnattendedProviderPreflight({ providerName })).not.toThrow();
    }
  });
});
