/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added follow-up question interrupt for true pause/resume orchestration behavior
 */

/**
 * @description Control-flow signal thrown by the tool executor when the agent
 * needs user clarification before continuing.
 */
export class FollowupQuestionSignal extends Error {
  readonly question: string;

  constructor(question: string) {
    super(question);
    this.name = 'FollowupQuestionSignal';
    this.question = question;
  }
}
