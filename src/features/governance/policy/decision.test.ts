import { describe, it, expect } from 'vitest';
import { evaluatePolicy, policyEnforced, type PolicyInput } from './decision';

const OFF = {} as unknown as NodeJS.ProcessEnv;
const ON = { OSHAL_POLICY_ENFORCE: 'true' } as unknown as NodeJS.ProcessEnv;

const base: PolicyInput = { subjectSub: 'u1', isOperator: false, action: 'data.read', resourceType: 'vault' };

describe('policyEnforced — default off', () => {
  it('off by default', () => expect(policyEnforced(OFF)).toBe(false));
  it('on when set', () => expect(policyEnforced(ON)).toBe(true));
});

describe('evaluatePolicy — enforcement off = permissive', () => {
  it('allows everything but still obliges audit', () => {
    const d = evaluatePolicy({ ...base, subjectSub: null, ownerSub: 'someone-else' }, OFF);
    expect(d.allow).toBe(true);
    expect(d.reason).toBe('enforcement-off');
    expect(d.obligations).toContain('audit');
  });
});

describe('evaluatePolicy — enforcement on', () => {
  it('operator bypasses ownership', () => {
    const d = evaluatePolicy({ ...base, isOperator: true, ownerSub: 'other' }, ON);
    expect(d.allow).toBe(true);
    expect(d.reason).toBe('operator-bypass');
  });

  it('owner may read their resource', () => {
    const d = evaluatePolicy({ ...base, subjectSub: 'u1', ownerSub: 'u1' }, ON);
    expect(d.allow).toBe(true);
    expect(d.reason).toBe('owner');
  });

  it('non-owner is denied', () => {
    const d = evaluatePolicy({ ...base, subjectSub: 'u1', ownerSub: 'u2' }, ON);
    expect(d.allow).toBe(false);
    expect(d.reason).toBe('not-owner');
  });

  it('no identity fails closed', () => {
    const d = evaluatePolicy({ ...base, subjectSub: null, ownerSub: 'u1' }, ON);
    expect(d.allow).toBe(false);
    expect(d.reason).toBe('no-identity');
  });

  it('sensitive data requires ownership even for an otherwise-allowed read', () => {
    const denied = evaluatePolicy({ ...base, subjectSub: 'u1', ownerSub: 'u2', dataClass: 'sensitive' }, ON);
    expect(denied.allow).toBe(false);
    expect(denied.reason).toBe('sensitive-requires-owner');

    const owned = evaluatePolicy({ ...base, subjectSub: 'u1', ownerSub: 'u1', dataClass: 'sensitive' }, ON);
    expect(owned.allow).toBe(true);
    expect(owned.reason).toBe('owner-sensitive');
    expect(owned.obligations).toContain('redact-egress');
  });

  it('unowned resource: allows reads, denies writes', () => {
    const read = evaluatePolicy({ ...base, action: 'data.read', ownerSub: null }, ON);
    expect(read.allow).toBe(true);
    expect(read.reason).toBe('unowned-read');

    const write = evaluatePolicy({ ...base, action: 'data.write', ownerSub: null }, ON);
    expect(write.allow).toBe(false);
    expect(write.reason).toBe('unowned-write-denied');
  });
});
