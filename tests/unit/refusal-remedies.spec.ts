/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                    | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1   | maintainer@emeraldcoastsystemsgroup.com   | Guard the reviewed operator-remediable refusal set: every member has a remedy, messages carry every exact canonical setting name, hard denials remain absent, and the recording chokepoint enriches without replacing a more specific remedy.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  configureRefusalRecorder,
  OPERATOR_REMEDIABLE_REFUSALS,
  recordRefusal,
  REFUSAL_REMEDY_SETTINGS,
  remedyForRefusal,
  type RefusalEventInput,
} from '@/shared/refusal-events';

const base: RefusalEventInput = {
  code: 'authorization_permission_denied',
  actorSub: 'service:fixture-app',
  actorIssuer: 'urn:oshal:application-service',
  owningPackage: 'fixture-app',
  targetKind: 'job',
  target: 'fixture-app-hourly',
  preparedExecutionId: 'activation-fixture',
};

afterEach(() => configureRefusalRecorder(undefined));

describe('operator-remediable refusal catalog', () => {
  it('enumerates the reviewed set and gives every member a non-empty remedy', () => {
    expect(Object.keys(OPERATOR_REMEDIABLE_REFUSALS).sort()).toEqual([
      'authorization_permission_denied',
      'authorization_recorded_delegation_required',
    ]);
    expect(Object.keys(REFUSAL_REMEDY_SETTINGS).sort())
      .toEqual(Object.keys(OPERATOR_REMEDIABLE_REFUSALS).sort());
    for (const [code, entry] of Object.entries(OPERATOR_REMEDIABLE_REFUSALS)) {
      expect(entry.remedy.trim(), `${code} needs a remedy`).not.toBe('');
      expect(remedyForRefusal(code)).toBe(entry.remedy);
    }
  });

  it('generates each configuration remedy from every exact canonical setting name', () => {
    for (const [code, settings] of Object.entries(REFUSAL_REMEDY_SETTINGS)) {
      const remedy = OPERATOR_REMEDIABLE_REFUSALS[code as keyof typeof OPERATOR_REMEDIABLE_REFUSALS].remedy;
      for (const setting of settings) expect(remedy, `${code} must name ${setting}`).toContain(setting);
    }
  });

  it('does not advertise a bypass for reviewed hard denials', () => {
    for (const code of [
      'authorization_tenant_denied',
      'authorization_management_denied',
      'authorization_executor_scope_denied',
      'guest_blocked',
      'public_tenant_profile_forbidden',
    ]) {
      expect(remedyForRefusal(code)).toBeUndefined();
    }
  });

  it('enriches at the one recording chokepoint and preserves a more specific remedy', async () => {
    const record = vi.fn(async () => undefined);
    configureRefusalRecorder({ record });

    await expect(recordRefusal(base)).resolves.toBe(true);
    expect(record).toHaveBeenLastCalledWith(expect.objectContaining({
      remedy: OPERATOR_REMEDIABLE_REFUSALS.authorization_permission_denied.remedy,
    }));

    await expect(recordRefusal({ ...base, remedy: 'Grant metrics.write to this service principal.' }))
      .resolves.toBe(true);
    expect(record).toHaveBeenLastCalledWith(expect.objectContaining({
      remedy: 'Grant metrics.write to this service principal.',
    }));
  });
});
