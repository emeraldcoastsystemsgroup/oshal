/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Services barrel for the linkedin-assistant feature — the state machine, the per-user draft store, and the orchestration service + its injected-transport contracts.
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
} from './content-draft-store';

export {
  LinkedInContentService,
  type DraftGenerator,
  type Grader,
  type DraftPublisher,
  type LinkedInContentServiceDeps,
} from './linkedin-content-service';
