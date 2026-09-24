/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                    | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1   | maintainer@emeraldcoastsystemsgroup.com   | Guard the reviewed operator-remediable refusal set: every member has a remedy, messages carry every exact canonical setting name, hard denials remain absent, and the recording chokepoint enriches without replacing a more specific remedy.
 * 2   | maintainer@emeraldcoastsystemsgroup.com   | Lock the completed remedy catalog to the cross-language 151-token disposition inventory and keep globally ambiguous permission denials non-prescriptive.
 * 3   | maintainer@emeraldcoastsystemsgroup.com   | Lock delegation key topology so private signing material is never prescribed for a bot node.
 * 4   | maintainer@emeraldcoastsystemsgroup.com   | Keep edge nodes free of the controller service secret and advertise only the OpenRouter setting the vision runtime actually reads after an operator action.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  configureRefusalRecorder,
  OPERATOR_REMEDIABLE_REFUSALS,
  recordRefusal,
  REFUSAL_CODES_BY_DISPOSITION,
  REFUSAL_REMEDY_SETTINGS,
  remedyForRefusal,
  type RefusalEventInput,
} from '@/shared/refusal-events';

const base: RefusalEventInput = {
  code: 'database_pool_unavailable',
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
    expect(Object.keys(OPERATOR_REMEDIABLE_REFUSALS).sort())
      .toEqual([...REFUSAL_CODES_BY_DISPOSITION['operator-remediable']].sort());
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

  it('keeps private delegation signing material on the controller and public verification keys on bots', () => {
    const remedy = OPERATOR_REMEDIABLE_REFUSALS.authorization_recorded_delegation_required.remedy;
    expect(remedy).toContain('On the controller, set OSHAL_DELEGATION_SIGNING_KID and OSHAL_DELEGATION_SIGNING_PRIVATE_KEY.');
    expect(remedy).toContain('On every bot node, set the matching OSHAL_DELEGATION_PUBLIC_KEYS.');
    expect(remedy).not.toMatch(/SIGNING_PRIVATE_KEY[^.]*bot node/i);
  });

  it('keeps controller secrets off remote nodes and names only a live vision setting', () => {
    expect(OPERATOR_REMEDIABLE_REFUSALS.intake_unavailable.remedy)
      .toBe('Set SWARM_SERVICE_SECRET on the controller API, restart the API, then retry the intake from the remote node.');
    expect(REFUSAL_REMEDY_SETTINGS.vision_unavailable).toEqual(['OPENROUTER_API_KEY']);
    expect(OPERATOR_REMEDIABLE_REFUSALS.vision_unavailable.remedy)
      .toBe('Set OPENROUTER_API_KEY on the controller API, restart the API, then retry image understanding.');
  });

  it('does not advertise a bypass for reviewed hard denials', () => {
    for (const code of [
      'authorization_tenant_denied',
      'authorization_management_denied',
      'authorization_executor_scope_denied',
      'authorization_app_admin_required',
      'authorization_permission_denied',
      'authorization_tier_denied',
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
      remedy: OPERATOR_REMEDIABLE_REFUSALS.database_pool_unavailable.remedy,
    }));

    await expect(recordRefusal({ ...base, remedy: 'Grant metrics.write to this service principal.' }))
      .resolves.toBe(true);
    expect(record).toHaveBeenLastCalledWith(expect.objectContaining({
      remedy: 'Grant metrics.write to this service principal.',
    }));
  });

  it('leaves a globally ambiguous permission denial without unsafe grant advice', () => {
    expect(remedyForRefusal('authorization_permission_denied')).toBeUndefined();
    expect(remedyForRefusal('facebook_encrypted_storage_required')).toBeUndefined();
    expect(remedyForRefusal('enrollment_unavailable')).toBeUndefined();
    expect(remedyForRefusal('prefs_unavailable')).toBeUndefined();
    expect(remedyForRefusal('rotation_unavailable')).toBeUndefined();
  });
});
