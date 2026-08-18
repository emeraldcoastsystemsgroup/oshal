/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the SECOND SEC-05 boundary (any-bot's final spawn gate). ADR-127 carves it under the same demo+operator condition as the TS preflight, so the risk is a carve that reads the WRONG authority: the subject must come from the handler-threaded spawn env (extraEnv.OSHAL_USER_SUB) and never from a caller-supplied option, or any request could assert its way past the last containment layer before a process spawn.
 * 2 | Codex                                      | Pin the separate exact-sub demo-user list at the final spawn boundary; it remains DEMO_MODE-gated and cannot be asserted through caller options.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertCliToolBoundary } = require('../../any-bot/server/services/llm/assert-cli-tool-boundary');

const OPERATOR = 'operator-sub-1';
const DEMO_USER = 'demo-user-sub-2';
const GUEST = 'guest-sub-9';
const OWNED_ENV = ['DEMO_MODE', 'MOCK_OIDC', 'OSHAL_OPERATOR_SUBS', 'OSHAL_DEMO_CLI_SUBS'];
let saved: Record<string, string | undefined> = {};

/** Assert the spawn boundary denies, with the code the wrappers surface. */
function expectDenied(options: unknown): void {
  try {
    assertCliToolBoundary(options, 'claude-code');
  } catch (err) {
    expect((err as Error & { code?: string }).code).toBe('UNENFORCEABLE_CLI_TOOL_BOUNDARY');
    return;
  }
  throw new Error('spawn boundary allowed a launch it must deny');
}

beforeEach(() => {
  saved = Object.fromEntries(OWNED_ENV.map((k) => [k, process.env[k]]));
  for (const k of OWNED_ENV) delete process.env[k];
  process.env.OSHAL_OPERATOR_SUBS = OPERATOR;
  process.env.OSHAL_DEMO_CLI_SUBS = DEMO_USER;
});

afterEach(() => {
  for (const k of OWNED_ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('any-bot CLI spawn boundary', () => {
  it('denies every launch when the deployment is not a demo', () => {
    expectDenied({ extraEnv: { OSHAL_USER_SUB: OPERATOR } });
    expectDenied({ extraEnv: { OSHAL_USER_SUB: DEMO_USER } });
    expectDenied({});
    expectDenied(undefined);
  });

  it('denies a non-operator subject on a demo box', () => {
    process.env.DEMO_MODE = 'true';
    expectDenied({ extraEnv: { OSHAL_USER_SUB: GUEST } });
  });

  it('denies a launch carrying no subject at all', () => {
    process.env.DEMO_MODE = 'true';
    expectDenied({});
    expectDenied({ extraEnv: {} });
    expectDenied({ extraEnv: { OSHAL_USER_SUB: '' } });
    expectDenied({ extraEnv: { OSHAL_USER_SUB: '   ' } });
  });

  it('reads the subject ONLY from the handler-threaded spawn env, never a caller option', () => {
    process.env.DEMO_MODE = 'true';
    // Every shape a caller might use to assert operator authority must be ignored.
    expectDenied({ userSub: OPERATOR });
    expectDenied({ sub: OPERATOR });
    expectDenied({ operator: true, brokeredSandbox: true });
    expectDenied({ env: { OSHAL_USER_SUB: OPERATOR } });
    expectDenied({ extraEnv: { OSHAL_USER_SUB: GUEST }, userSub: OPERATOR });
  });

  it('does not treat MOCK_OIDC as a demo deployment', () => {
    process.env.MOCK_OIDC = 'true';
    expectDenied({ extraEnv: { OSHAL_USER_SUB: OPERATOR } });
  });

  it('denies operator-subject lookalikes', () => {
    process.env.DEMO_MODE = 'true';
    for (const lookalike of [OPERATOR.toUpperCase(), ` ${OPERATOR}`, `${OPERATOR}x`]) {
      expectDenied({ extraEnv: { OSHAL_USER_SUB: lookalike } });
    }
  });

  it('denies demo-user subject lookalikes', () => {
    process.env.DEMO_MODE = 'true';
    for (const lookalike of [DEMO_USER.toUpperCase(), ` ${DEMO_USER}`, `${DEMO_USER}x`]) {
      expectDenied({ extraEnv: { OSHAL_USER_SUB: lookalike } });
    }
  });

  it('never treats a wildcard as a demo-user match', () => {
    process.env.DEMO_MODE = 'true';
    process.env.OSHAL_DEMO_CLI_SUBS = '*';
    expectDenied({ extraEnv: { OSHAL_USER_SUB: GUEST } });
  });

  it('permits the demo operator — the one carve', () => {
    process.env.DEMO_MODE = 'true';
    expect(() => assertCliToolBoundary({ extraEnv: { OSHAL_USER_SUB: OPERATOR } }, 'claude-code')).not.toThrow();
  });

  it('permits an explicitly listed demo user without operator membership', () => {
    process.env.DEMO_MODE = 'true';
    expect(process.env.OSHAL_OPERATOR_SUBS).not.toContain(DEMO_USER);
    expect(() => assertCliToolBoundary({ extraEnv: { OSHAL_USER_SUB: DEMO_USER } }, 'openai-codex')).not.toThrow();
    expectDenied({ extraEnv: { OSHAL_USER_SUB: DEMO_USER } });
  });
});
