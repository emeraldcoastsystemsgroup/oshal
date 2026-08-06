/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard deterministic full-body canonicalization, security-field mutation sensitivity, array ordering, and fail-closed unsupported JSON values.
 */

import { describe, expect, it } from 'vitest';
import {
  DelegationRequestBindingError,
  delegationRequestBodySha256,
} from '@/shared/security/delegation-request-binding';

describe('delegation canonical request-body binding', () => {
  it('is stable across object insertion order and omitted undefined properties', () => {
    const first = {
      text: 'approved',
      taskId: 'task-1',
      nested: { z: 3, a: true },
      omitted: undefined,
    };
    const second = {
      nested: { a: true, z: 3 },
      taskId: 'task-1',
      text: 'approved',
    };
    expect(delegationRequestBodySha256(first)).toBe(delegationRequestBodySha256(second));
    expect(delegationRequestBodySha256(first)).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([
    ['prompt', { text: 'replaced' }],
    ['direct entitlement', { direct: false }],
    ['credential', { creds: { google: 'replacement' } }],
    ['provider intent', { providerIntent: { provider: 'replacement' } }],
  ])('changes when the %s field changes', (_label, mutation) => {
    const approved = {
      text: 'approved',
      direct: true,
      creds: { google: 'approved' },
      providerIntent: { provider: 'approved' },
    };
    expect(delegationRequestBodySha256({ ...approved, ...mutation }))
      .not.toBe(delegationRequestBodySha256(approved));
  });

  it('preserves array order and fails closed on non-JSON or cyclic values', () => {
    expect(delegationRequestBodySha256({ scope: ['a', 'b'] }))
      .not.toBe(delegationRequestBodySha256({ scope: ['b', 'a'] }));
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => delegationRequestBodySha256(cyclic)).toThrow(DelegationRequestBindingError);
    expect(() => delegationRequestBodySha256({ value: Number.NaN }))
      .toThrow(DelegationRequestBindingError);
  });
});
