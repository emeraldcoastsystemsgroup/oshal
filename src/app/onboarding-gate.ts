/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted the onboarding-gate decision from server.ts into a pure, unit-testable predicate — and changed its semantics per INSTALLER-GAPS G3: DISABLE_ONBOARDING_GATE now suppresses only the per-user seen-once wizard, it can no longer waive the "an LLM provider must be active" requirement. A deliberately model-less box declares that posture explicitly with OSHAL_NO_AI=true (written by oshal-install.sh --no-ai), which waives the requirement AND the wizard (the wizard exists to connect a model, so on a declared no-AI box it can never complete — gating users into it would trap them). This is the enforcement half of the G-Squared incident fix: a box can no longer silently advertise AI with nothing behind it just because someone hid the wizard.
 */

/**
 * @description Inputs to the onboarding-gate decision, gathered by the caller
 * (server.ts) from env, the request, and the provider/onboarding stores.
 */
export interface OnboardingGateInputs {
  /** DISABLE_ONBOARDING_GATE === 'true' — suppresses the per-user wizard ONLY. */
  disableGateFlag: boolean;
  /** OSHAL_NO_AI === 'true' — this deployment deliberately runs without a model. */
  noAiDeclared: boolean;
  /** Guest identities never onboard (they cannot write provider config). */
  isGuest: boolean;
  /** An LLM provider is actively configured (cockpit selection present). */
  hasActiveProvider: boolean;
  /** Per-user seen-once state; null = unknown / not looked up. */
  onboardingCompleted: boolean | null;
}

/**
 * @description Decide whether this request must be redirected to the /welcome
 * wizard. The load-bearing rule (INSTALLER-GAPS G3): the "a model must be
 * connected" requirement is only waivable by the explicit OSHAL_NO_AI
 * declaration — never by DISABLE_ONBOARDING_GATE, which only hides the
 * per-user wizard on a box whose setup is already complete.
 *
 * @param inputs - The gathered gate inputs.
 * @returns true when the caller should be sent to /welcome.
 */
export function onboardingRequired(inputs: OnboardingGateInputs): boolean {
  if (inputs.isGuest) return false;
  // Declared no-AI: the wizard's job is connecting a model, which this box has
  // explicitly opted out of — it could never complete, so nobody is gated into it.
  if (inputs.noAiDeclared) return false;
  // Mandatory and NOT waivable by disableGateFlag: no active provider means no
  // bot can run — hiding the wizard here is how a customer box shipped dead.
  if (!inputs.hasActiveProvider) return true;
  if (inputs.disableGateFlag) return false;
  return inputs.onboardingCompleted === false;
}
