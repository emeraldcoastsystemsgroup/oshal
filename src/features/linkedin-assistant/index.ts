/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Feature barrel — the ONE public surface of the LinkedIn AI Content Assistant (orchestration service, per-user draft store, pure state machine + rubric, and the domain types). Consumers import from '@/features/linkedin-assistant', never a deep path. This feature does NOT import the sibling quality-judge slice (FSD same-layer rule); the app layer adapts the judge verdict onto the Grader contract when wiring the service.
 */

export * from './types';
export * from './services';
