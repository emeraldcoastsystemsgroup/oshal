/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for INSTALLER-GAPS G3: DISABLE_ONBOARDING_GATE suppresses only the per-user wizard — it must NEVER waive the "a model must be connected" requirement (that is exactly how the G-Squared customer box shipped with a dead engine and nobody noticed). Only the explicit OSHAL_NO_AI declaration waives it, and a declared no-AI box gates nobody (the wizard could never complete there). Mutation-proven: restoring the old early-return-on-flag behavior turns the load-bearing case red.
 */

import { describe, it, expect } from 'vitest';

import { onboardingRequired, type OnboardingGateInputs } from '@/app/onboarding-gate';

function inputs(overrides: Partial<OnboardingGateInputs> = {}): OnboardingGateInputs {
  return {
    disableGateFlag: false,
    noAiDeclared: false,
    isGuest: false,
    hasActiveProvider: true,
    onboardingCompleted: true,
    ...overrides,
  };
}

describe('onboardingRequired (INSTALLER-GAPS G3)', () => {
  it('THE G3 RULE: no active provider still gates even with DISABLE_ONBOARDING_GATE', () => {
    // The old behavior returned false unconditionally on the flag — which is how a
    // customer box advertised AI with nothing behind it. This case must stay red-proof.
    expect(onboardingRequired(inputs({ hasActiveProvider: false, disableGateFlag: true }))).toBe(true);
  });

  it('no active provider gates without the flag too', () => {
    expect(onboardingRequired(inputs({ hasActiveProvider: false }))).toBe(true);
  });

  it('the explicit OSHAL_NO_AI declaration waives the model requirement', () => {
    expect(onboardingRequired(inputs({ hasActiveProvider: false, noAiDeclared: true }))).toBe(false);
  });

  it('a declared no-AI box gates nobody — the wizard could never complete there', () => {
    expect(onboardingRequired(inputs({
      hasActiveProvider: false, noAiDeclared: true, disableGateFlag: false, onboardingCompleted: false,
    }))).toBe(false);
  });

  it('guests never onboard', () => {
    expect(onboardingRequired(inputs({ isGuest: true, hasActiveProvider: false }))).toBe(false);
  });

  it('provider active + flag set: per-user wizard suppressed even when incomplete', () => {
    expect(onboardingRequired(inputs({ disableGateFlag: true, onboardingCompleted: false }))).toBe(false);
  });

  it('provider active, no flag: incomplete per-user onboarding gates (seen-once)', () => {
    expect(onboardingRequired(inputs({ onboardingCompleted: false }))).toBe(true);
  });

  it('provider active, onboarding done: no gate', () => {
    expect(onboardingRequired(inputs())).toBe(false);
  });

  it('provider active, per-user state unknown (null): fail-open, no gate', () => {
    expect(onboardingRequired(inputs({ onboardingCompleted: null }))).toBe(false);
  });
});
