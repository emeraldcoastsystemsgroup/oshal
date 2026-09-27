/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Services barrel for the linkedin-assistant feature — the state machine, the per-user draft store, and the orchestration service + its injected-transport contracts.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Export the publish-outcome recorder contract and the draft store's publish-provenance input.
 */

export {
  ALLOWED_TRANSITIONS,
  assertTransition,
  canTransition,
  computeNextSlot,
  isTerminal,
  needsRefine,
  resolveJudgeBar,
} from './draft-state-machine';

export {
  ContentDraftStore,
  type InsertDraftInput,
  type GradeUpdate,
  type PublishProvenance,
} from './content-draft-store';

export {
  LinkedInContentService,
  type DraftGenerator,
  type Grader,
  type DraftPublisher,
  type PublishOutcomeRecorder,
  type LinkedInContentServiceDeps,
} from './linkedin-content-service';
