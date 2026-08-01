/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — services barrel for the vision-describe slice.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Export parseImageSections (per-image labeled descriptions, ADR-110 follow-up).
 */

export {
  VisionDescribeService,
  parseImageSections,
  type VisionImageInput,
  type VisionDescribeRequest,
  type VisionDescribeResult,
} from './vision-describe-service';
