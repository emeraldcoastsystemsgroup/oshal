/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Pre-OSS: genericized internal workspace_dir default path (removed internal username)
 */

/**
 * TicketProcessor - Ticket processing utilities
 * Extracted from QueueManagerService for better maintainability
 * 
 * PHASE_58_SESSION_04: Simplified - persona injection moved to Front Door API (ClineProvider)
 * This module now only builds basic ticket prompts. Persona is injected by the unified path.
 */

const logger = require('../../utils/logger');

/**
 * @description Stateless helper that normalizes Plane tickets into the prompt text
 * fed to the agent pipeline. It exists to keep ticket-to-prompt formatting out of
 * QueueManagerService so the same shaping logic can be reused and tested in isolation.
 * Deliberately persona-agnostic: persona injection is handled downstream by the Front
 * Door API (ClineProvider), so these prompts intentionally omit any persona context.
 * All members are static because no per-instance state is needed.
 */
class TicketProcessor {
  /**
   * Extract description text from ticket
   * @param {Object} ticket - Ticket object
   * @returns {string} - Description text
   */
  static extractDescription(ticket) {
    let descriptionText = ticket.name || 'No description';
    
    try {
      if (ticket.description && typeof ticket.description === 'object') {
        // Parse Plane's JSON description format
        const content = ticket.description.content;
        if (Array.isArray(content)) {
          const texts = content
            .filter(block => block.content)
            .map(block => {
              if (Array.isArray(block.content)) {
                return block.content
                  .filter(item => item.text)
                  .map(item => item.text)
                  .join(' ');
              }
              return '';
            })
            .join(' ');
          
          if (texts) {
            descriptionText = texts;
          }
        }
      } else if (typeof ticket.description === 'string') {
        descriptionText = ticket.description;
      }
    } catch (e) {
      logger.warn(`Failed to parse description for ticket ${ticket.id}:`, e.message);
    }

    return descriptionText;
  }

  /**
   * Build comprehensive ticket prompt for Front Door API
   * NOTE: Persona injection happens in ClineProvider (Front Door), not here
   * @param {Object} ticket - Plane ticket object
   * @param {Object} task - Task object with workspace_dir
   * @returns {string} - Formatted prompt (without persona - Front Door adds it)
   */
  static buildTicketPrompt(ticket, task) {
    const ticketName = ticket.name || 'Untitled Ticket';
    // Use description_stripped (plain text) first, then fall back to extractDescription
    const ticketDescription = ticket.description_stripped || 
      TicketProcessor.extractDescription(ticket) || 
      'No description provided';
    const workspaceDir = task.workspace_dir || '/Users/you/Projects/oshal';
    
    return `
# Plane Ticket: ${ticketName}

## Description
${ticketDescription}

## Task Workspace
${workspaceDir}

## Instructions
You are processing a Plane project management ticket with full codebase awareness.

1. **Analyze the codebase** in the workspace directory
2. **Understand the context** from existing code patterns
3. **Address the issue** described in the ticket
4. **Make necessary code changes** if applicable
5. **Test your changes** if applicable
6. **Provide a comprehensive summary** of what was done

## Output Requirements
- Clear explanation of what was analyzed/changed
- List of files examined or modified
- Reasoning behind decisions made
- Any recommendations or next steps
    `.trim();
  }

  /**
   * Build clean prompt for standard agent processing
   * @param {Object} ticket - Ticket object
   * @param {string} description - Ticket description text
   * @returns {string} - Clean prompt
   */
  static buildCleanPrompt(ticket, description) {
    return `Plane Ticket #${ticket.id}: ${ticket.name}

${description}

Complete this task using available tools. When done, use attempt_completion.`;
  }
}

module.exports = TicketProcessor;
