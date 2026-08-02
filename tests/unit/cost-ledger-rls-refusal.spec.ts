/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-124 guard for the cost-ledger half of RLS Phase 2. Migration 112 forces RLS on oshal_cost_events, so a mismatched owner_sub is now refused with SQLSTATE 42501 — and both ledger catches used to log EVERY failure at warn and continue, which turned a refused cost row into invisible spend and made windowed budget caps fail OPEN. This pins the classifier that separates a policy refusal from a missing column or a dead table, in both directions: dropping the 42501 arm, dropping the message arm, or widening it to swallow the pre-090 42703 fallback all go red.
 */

import { describe, expect, it } from 'vitest';

import { isRlsRefusal } from '../../src/features/operational-intelligence/services/cost-tracking-service';

describe('ADR-124 — cost-ledger RLS refusal classification', () => {
  // The two arms are pinned SEPARATELY and on purpose. A real pg error carries BOTH the
  // SQLSTATE and the text, so a case supplying both would keep passing after either arm was
  // deleted — a guard that cannot fail is not a guard (MUTATION-tested: with both signals in
  // one case, dropping the 42501 arm left all six green).
  it('the SQLSTATE alone is recognised — no "row-level security" text in the message', () => {
    // node-postgres surfaces the policy refusal as 42501 (insufficient_privilege). Deleting
    // that arm must go red here, which it can only do if the text arm cannot rescue it.
    expect(isRlsRefusal({ code: '42501', message: 'permission denied for table oshal_cost_events' })).toBe(true);
  });

  it('the message alone is recognised — no code (a driver that rewrapped the error)', () => {
    // Some pooling layers rewrap and drop the SQLSTATE; the text is then the only signal.
    expect(isRlsRefusal(new Error('new row violates row-level security policy for table "oshal_cost_events"'))).toBe(true);
  });

  it('the real pg shape — both signals present — is recognised', () => {
    expect(isRlsRefusal({ code: '42501', message: 'new row violates row-level security policy for table "oshal_cost_events"' })).toBe(true);
  });

  it('the pre-090 undefined-column error is NOT an RLS refusal', () => {
    // 42703 must keep routing to appendLegacyCostLedgerRow. If this returns true the
    // legacy fallback is bypassed and every pre-090 deployment silently loses cost rows.
    expect(isRlsRefusal({ code: '42703', message: 'column "duration_ms" of relation "oshal_cost_events" does not exist' })).toBe(false);
  });

  it('a missing table is NOT an RLS refusal', () => {
    expect(isRlsRefusal({ code: '42P01', message: 'relation "oshal_cost_events" does not exist' })).toBe(false);
  });

  it('an ordinary infrastructure failure is NOT an RLS refusal', () => {
    expect(isRlsRefusal(new Error('connection terminated unexpectedly'))).toBe(false);
    expect(isRlsRefusal({ code: 'ECONNREFUSED' })).toBe(false);
  });

  it('null / undefined never classify as a refusal', () => {
    expect(isRlsRefusal(null)).toBe(false);
    expect(isRlsRefusal(undefined)).toBe(false);
  });
});
