/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Types barrel for the linkedin-assistant feature — re-exports the draft domain types + rubric so consumers import from '@/features/linkedin-assistant', never a deep path.
 */

export {
  DRAFT_STATES,
  LINKEDIN_RUBRIC,
  type DraftState,
  type DraftGenerationInput,
  type GradeResult,
  type SocialContentDraft,
  type PublishOutcome,
} from './draft';
