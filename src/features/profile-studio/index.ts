/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Barrel for the LinkedIn Profile Studio feature slice (per-user plan store + domain types + state machine).
 */

export { ProfilePlanStore } from './services/profile-plan-store';
export { PLAN_STATES, canTransition } from './types/plan';
export type { LinkedInProfilePlan, PlanDraftInput, PlanState } from './types/plan';
