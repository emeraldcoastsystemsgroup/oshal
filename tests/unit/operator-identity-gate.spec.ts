/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Pins isOperatorIdentity — the sub/email allowlist check that gates swarm-wide Codex credential propagation (a guest's ChatGPT import must NOT become the platform default; only an operator's does). Fail-closed on an empty allowlist.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isOperatorIdentity } from '../../src/shared/middleware/authz';

const OPERATOR_SUB = 'example-user-sub';
const OPERATOR_EMAIL = 'maintainer@emeraldcoastsystemsgroup.com';

describe('isOperatorIdentity — swarm-wide credential propagation gate', () => {
  const savedSubs = process.env.OSHAL_OPERATOR_SUBS;
  const savedEmails = process.env.OSHAL_OPERATOR_EMAILS;

  beforeEach(() => {
    process.env.OSHAL_OPERATOR_SUBS = OPERATOR_SUB;
    process.env.OSHAL_OPERATOR_EMAILS = OPERATOR_EMAIL;
  });
  afterEach(() => {
    if (savedSubs === undefined) delete process.env.OSHAL_OPERATOR_SUBS; else process.env.OSHAL_OPERATOR_SUBS = savedSubs;
    if (savedEmails === undefined) delete process.env.OSHAL_OPERATOR_EMAILS; else process.env.OSHAL_OPERATOR_EMAILS = savedEmails;
  });

  it('recognizes the operator by sub (propagation runs for the local-swarm operator)', () => {
    expect(isOperatorIdentity(OPERATOR_SUB, null)).toBe(true);
  });

  it('recognizes the operator by email, case-insensitively', () => {
    expect(isOperatorIdentity(null, OPERATOR_EMAIL.toUpperCase())).toBe(true);
  });

  it('does NOT treat a guest as operator (guest import stays per-user only)', () => {
    expect(isOperatorIdentity('guest-999', 'someone@example.com')).toBe(false);
    expect(isOperatorIdentity('guest-999', null)).toBe(false);
    expect(isOperatorIdentity(null, null)).toBe(false);
  });

  it('fails closed when the allowlist is empty — nobody propagates', () => {
    process.env.OSHAL_OPERATOR_SUBS = '';
    process.env.OSHAL_OPERATOR_EMAILS = '';
    expect(isOperatorIdentity(OPERATOR_SUB, OPERATOR_EMAIL)).toBe(false);
  });

  it('does not partial-match a sub (no substring/oracle leak)', () => {
    expect(isOperatorIdentity(OPERATOR_SUB.slice(0, 8), null)).toBe(false);
    expect(isOperatorIdentity(OPERATOR_SUB + '0', null)).toBe(false);
  });
});
