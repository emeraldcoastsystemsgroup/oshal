/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Barrel for the LinkedIn Profile Studio feature slice (per-user plan store + domain types + state machine).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Export the one-use, generation-bound desktop result capability contract.
 */

export { ProfilePlanStore } from './services/profile-plan-store';
export { PLAN_STATES, canTransition } from './types/plan';
export type { LinkedInProfilePlan, PlanDraftInput, PlanState } from './types/plan';
export {
  PROFILE_CALLBACK_OPERATION,
  PROFILE_CALLBACK_TTL_MS,
  ProfileCallbackContextSchema,
  ProfileCallbackRequestSchema,
  ProfileCallbackResultSchema,
  hashProfileDispatchCapability,
  mintProfileDispatchCapability,
  parseProfileDispatchCapability,
} from './services/profile-dispatch-capability';
export type {
  ProfileCallbackRequest,
  ProfileDispatchCapability,
} from './services/profile-dispatch-capability';
