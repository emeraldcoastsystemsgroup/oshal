/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * Persona Loader Utility
 * Loads bot persona configuration from YAML files
 * Used by route handlers to inject persona into Cline CLI prompts
 */

const fs = require('fs');
const yaml = require('js-yaml');
const logger = require('./logger');

/**
 * Load persona configuration from YAML file
 * @param {string} agentId - Agent ID (e.g., 'project-manager')
 * @returns {Object|null} Persona config with systemPromptPrefix
 */
function loadPersona(agentId = null) {
  // Try BOT_PERSONA_FILE env var first
  let personaFile = process.env.BOT_PERSONA_FILE;
  
  // If not set and agentId provided, try to find persona file
  if (!personaFile && agentId) {
    const possiblePaths = [
      `/app/bot-configs/${agentId}.yaml`,
      `/app/ai-lab/bot-personas/${agentId}.yaml`,
    ];
    
    for (const path of possiblePaths) {
      if (fs.existsSync(path)) {
        personaFile = path;
        break;
      }
    }
  }
  
  if (!personaFile) {
    logger.debug('No persona file configured');
    return null;
  }
  
  try {
    if (!fs.existsSync(personaFile)) {
      logger.warn(`Persona file not found: ${personaFile}`);
      return null;
    }
    
    const content = fs.readFileSync(personaFile, 'utf8');
    const parsed = yaml.load(content);
    
    if (!parsed || !parsed.perspective) {
      logger.warn(`Invalid persona file (missing perspective): ${personaFile}`);
      return null;
    }
    
    const persona = {
      name: parsed.name || agentId || 'AI Agent',
      role: parsed.role || 'AI Assistant',
      agentId: parsed.agent_id || agentId || 'agent',
      perspective: parsed.perspective,
      capabilities: parsed.capabilities || [],
      routingKeywords: parsed.routing_keywords || [],
      selectorDescriptor: parsed.selector_descriptor || '',
      
      // Build system prompt prefix for Cline CLI
      systemPromptPrefix: buildSystemPromptPrefix(parsed),
    };
    
    logger.info(`✓ Persona loaded: ${persona.name} (${persona.role})`);
    return persona;
    
  } catch (err) {
    logger.error(`Failed to load persona from ${personaFile}: ${err.message}`);
    return null;
  }
}

/**
 * Build system prompt prefix from persona YAML
 * @param {Object} parsed - Parsed YAML content
 * @param {Object} options - Build options
 * @param {boolean} options.isDashboardChat - If true, adds dashboard-specific instructions
 * @returns {string} System prompt prefix
 */
function buildSystemPromptPrefix(parsed, options = {}) {
  const parts = [];
  
  parts.push('## YOUR IDENTITY AND ROLE');
  parts.push(`You are **${parsed.name || 'an AI agent'}** — ${parsed.role || 'AI assistant'}.`);
  parts.push('');
  
  if (parsed.perspective) {
    parts.push(parsed.perspective);
    parts.push('');
  }
  
  if (parsed.capabilities && parsed.capabilities.length > 0) {
    parts.push('## YOUR CAPABILITIES');
    parsed.capabilities.forEach(cap => {
      parts.push(`- ${cap}`);
    });
    parts.push('');
  }
  
  // Add dashboard-specific instructions
  if (options.isDashboardChat) {
    parts.push('## DASHBOARD CHAT MODE');
    parts.push('');
    parts.push('You are having a CONVERSATION with a human through the dashboard chat interface.');
    parts.push('');
    parts.push('**Important:**');
    parts.push('- This is NOT a task to complete - it\'s an ongoing conversation');
    parts.push('- Do NOT use attempt_completion unless explicitly asked to complete a specific task');
    parts.push('- Be helpful, conversational, and responsive');
    parts.push('- Answer questions directly without claiming "task complete"');
    parts.push('- You CAN use tools if they help answer questions');
    parts.push('- Continue the conversation naturally');
    parts.push('');
  }
  
  parts.push('---');
  parts.push('');
  
  return parts.join('\n');
}

module.exports = {
  loadPersona,
};
