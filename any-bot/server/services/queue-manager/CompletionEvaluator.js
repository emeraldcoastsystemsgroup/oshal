/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * CompletionEvaluator — Agent Work Completion Assessment
 *
 * @module queue-manager/CompletionEvaluator
 * @description Evaluates whether an agent's response constitutes completed work
 * or requires human intervention. Uses a three-tier evaluation strategy:
 * 
 * ## Evaluation Tiers
 * 1. **Self-completion**: Agent used `attempt_completion` tool → CUSTOMER_ACTION
 * 2. **Blocking signals**: Agent is asking questions or missing info → TODO (back to queue)
 * 3. **Default**: Response exists but no explicit signal → CUSTOMER_ACTION
 * 
 * ## Integration Context
 * Called by {@link QueueManagerService} after each agent HTTP dispatch response.
 * The returned status determines the ticket's next state in Plane:
 * - `CUSTOMER_ACTION` → Ticket moves to Done/review (agent work complete)
 * - `TODO` → Ticket stays in queue for human input or re-processing
 * 
 * ## Return Values
 * ```
 * { status: 'CUSTOMER_ACTION', summary: '...' }   // Work complete
 * { status: 'TODO', summary: '...', reason: '...' } // Needs human input
 * ```
 * 
 * @see {@link QueueManagerService} for dispatch context
 * @see {@link CommentFormatter.completionComment} for how results are formatted
 * @see {@link TicketPhaseManager} for phase advancement based on completion
 * 
 * @example
 * const result = await CompletionEvaluator.evaluateAgentCompletion(
 *   agentResponse, ticket, clineResult
 * );
 * if (result.status === 'CUSTOMER_ACTION') {
 *   await planeDb.updateTicketState(ticket.id, 'done');
 * }
 */

const logger = require('../../utils/logger');

/**
 * @description Encapsulates the heuristics that decide an agent run's outcome so
 * that the queue pipeline has a single, consistent place to translate raw agent
 * output into a Plane ticket state transition. Exposed as static-only methods
 * because the evaluation is pure (no instance state): callers want a one-shot
 * judgement, not a stateful object. Defaulting to CUSTOMER_ACTION keeps work
 * flowing toward human review and only re-queues a ticket when the agent gives
 * an explicit signal that it is blocked or awaiting input.
 */
class CompletionEvaluator {
  /**
   * Evaluate if agent's work is complete or needs human input
   * DEFAULT: Complete (Customer Action) UNLESS agent explicitly asks for help
   * @param {string} agentResponse - Full agent response text
   * @param {object} ticket - Plane ticket object
   * @param {object} result - Full result object from TaskController with messages array
   * @returns {object} - { status: 'CUSTOMER_ACTION' | 'TODO', summary: string, reason?: string }
   */
  static async evaluateAgentCompletion(agentResponse, ticket, result) {
    try {
      // PRIMARY: Check if agent used attempt_completion (self-evaluated as done)
      if (result && result.messages) {
        const completionMessage = result.messages.find(msg => msg.say === 'completion_result');
        
        if (completionMessage && completionMessage.text) {
          // Agent explicitly signaled completion via attempt_completion tool
          logger.info(`✅ Ticket ${ticket.id}: Agent used attempt_completion (self-evaluated as done)`);
          
          return {
            status: 'CUSTOMER_ACTION',
            summary: this.generateUserSummary(completionMessage.text, ticket)
          };
        }
      }
      
      // SECONDARY: Check if agent is BLOCKED and asking for human help
      const response = agentResponse.toLowerCase();
      
      // Only return to Todo if agent explicitly asks questions or is blocked
      const blockingSignals = [
        'i need you to',
        'please provide',
        'what is your',
        'which',
        'could you',
        'can you provide',
        'need more information',
        'cannot proceed without',
        'missing credentials',
        'missing access',
        'permission denied',
        'access denied'
      ];
      
      // Check for questions (ending with ?)
      const hasQuestions = response.includes('?') && 
        (response.match(/\?/g) || []).length > 0;
      
      const isBlocked = blockingSignals.some(sig => response.includes(sig));
      
      logger.info(`Evaluation for ${ticket.id}: hasQuestions=${hasQuestions}, isBlocked=${isBlocked}`);
      
      if (hasQuestions || isBlocked) {
        // Agent needs human input
        return {
          status: 'TODO',
          reason: 'Agent waiting for human response or blocked by missing information'
        };
      }
      
      // DEFAULT: Agent did work, send to Customer Action for human review
      logger.info(`✅ Ticket ${ticket.id}: Agent completed work (no questions/blockers), sending to Customer Action`);
      return {
        status: 'CUSTOMER_ACTION',
        summary: this.generateUserSummary(agentResponse, ticket)
      };
      
    } catch (error) {
      logger.error(`Failed to evaluate completion for ${ticket.id}:`, error.message);
      // On error, default to CUSTOMER_ACTION (let human decide)
      return {
        status: 'CUSTOMER_ACTION',
        summary: 'Agent processing complete. See work above.'
      };
    }
  }

  /**
   * Generate clean user-friendly summary from agent response
   * @param {string} agentResponse - Full agent response
   * @param {object} ticket - Plane ticket object
   * @returns {string} - Clean formatted summary
   */
  static generateUserSummary(agentResponse, ticket) {
    try {
      // Extract key information from response
      const lines = agentResponse.split('\n').filter(line => line.trim());
      
      // Find deliverables (URLs, file paths, etc.)
      const deliverables = [];
      lines.forEach(line => {
        // Extract URLs
        const urlMatch = line.match(/(https?:\/\/[^\s]+)/);
        if (urlMatch) {
          deliverables.push(urlMatch[1]);
        }
        
        // Extract file paths
        const fileMatch = line.match(/(workspace\/[^\s]+\.(md|json|js|py|txt))/i);
        if (fileMatch) {
          deliverables.push(fileMatch[1]);
        }
      });
      
      // Build clean summary (compact, no extra blank lines)
      let summary = '✅ Work Complete\n';
      
      // Add brief description (first meaningful sentence)
      const firstSentence = lines.find(line => 
        line.length > 20 && 
        !line.includes('**') && 
        !line.startsWith('━')
      );
      
      if (firstSentence) {
        // Truncate to reasonable length
        const description = firstSentence.substring(0, 200);
        summary += `**Summary:** ${description}\n`;
      }
      
      // Add deliverables if found
      if (deliverables.length > 0) {
        summary += `**Deliverables:**\n`;
        deliverables.slice(0, 3).forEach(item => {
          summary += `- ${item}\n`;
        });
      }
      
      // Add next steps
      summary += `**Next Steps:** Review the work above and verify it meets requirements.`;
      
      return summary;
      
    } catch (error) {
      logger.error('Failed to generate user summary:', error.message);
      // Fallback to simple completion message
      return '✅ Work Complete\n**Summary:** Agent has completed work on this ticket.\n**Next Steps:** Review the detailed response above.';
    }
  }
}

module.exports = CompletionEvaluator;