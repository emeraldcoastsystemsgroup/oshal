/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * LoggingStandard — Structured Logging Utility for Queue Manager Services
 * 
 * @module queue-manager/LoggingStandard
 * @description Provides standardized logging helpers with automatic function name
 * injection, structured context objects, and consistent log format across all
 * queue-manager services.
 * 
 * ## Required Logging Pattern (Issue #006)
 * Every function MUST log:
 * 1. START — at the beginning with input params
 * 2. COMPLETE — at the end with result summary
 * 3. ERROR — on every catch block with error + stack + context
 * 4. Key business events — with ticketId, agentId, phase, details
 * 
 * ## Usage
 * ```javascript
 * const { createLogger } = require('./LoggingStandard');
 * const log = createLogger('QueueManagerService');
 * 
 * async function processTicket(ticketId, agentId) {
 *   log.start('processTicket', { ticketId, agentId });
 *   try {
 *     // ... work ...
 *     log.complete('processTicket', { ticketId, result: 'dispatched' });
 *   } catch (err) {
 *     log.error('processTicket', err, { ticketId, agentId });
 *     throw err;
 *   }
 * }
 * ```
 * 
 * Created: 2026-02-24 — Issue #006, Swarm Improvement Sprint
 */

const logger = require('../../utils/logger');

/**
 * Create a structured logger bound to a service name.
 * All log messages will be prefixed with [ServiceName.methodName].
 * 
 * @param {string} serviceName - Name of the service (e.g., 'QueueManagerService')
 * @returns {Object} Logger instance with start/complete/error/event/debug methods
 */
function createLogger(serviceName) {
  return {
    /**
     * Log function entry — call at the START of every function
     * @param {string} methodName - Name of the method being entered
     * @param {Object} [params] - Input parameters (sanitize sensitive data)
     */
    start(methodName, params = {}) {
      logger.debug(`[${serviceName}.${methodName}] START`, params);
    },

    /**
     * Log function completion — call at the END of every function
     * @param {string} methodName - Name of the method completing
     * @param {Object} [result] - Result summary (not full data)
     */
    complete(methodName, result = {}) {
      logger.debug(`[${serviceName}.${methodName}] COMPLETE`, result);
    },

    /**
     * Log an error — call in every catch block
     * @param {string} methodName - Name of the method that errored
     * @param {Error} err - The error object
     * @param {Object} [context] - Additional context (ticketId, agentId, etc.)
     */
    error(methodName, err, context = {}) {
      logger.error(`[${serviceName}.${methodName}] ERROR`, {
        error: err.message,
        stack: err.stack,
        ...context,
      });
    },

    /**
     * Log a key business event — for important state transitions
     * @param {string} methodName - Name of the method
     * @param {string} eventName - Event name (e.g., 'TICKET_DISPATCHED', 'AGENT_SELECTED')
     * @param {Object} [details] - Event details (ticketId, agentId, phase, etc.)
     */
    event(methodName, eventName, details = {}) {
      logger.info(`[${serviceName}.${methodName}] ${eventName}`, details);
    },

    /**
     * Log info-level message
     * @param {string} methodName - Name of the method
     * @param {string} message - Log message
     * @param {Object} [context] - Additional context
     */
    info(methodName, message, context = {}) {
      logger.info(`[${serviceName}.${methodName}] ${message}`, context);
    },

    /**
     * Log warning
     * @param {string} methodName - Name of the method
     * @param {string} message - Warning message
     * @param {Object} [context] - Additional context
     */
    warn(methodName, message, context = {}) {
      logger.warn(`[${serviceName}.${methodName}] ${message}`, context);
    },

    /**
     * Log debug message
     * @param {string} methodName - Name of the method
     * @param {string} message - Debug message
     * @param {Object} [context] - Additional context
     */
    debug(methodName, message, context = {}) {
      logger.debug(`[${serviceName}.${methodName}] ${message}`, context);
    },

    /**
     * Wrap an async function with automatic START/COMPLETE/ERROR logging.
     * Use this for simple functions where you want automatic tracing.
     * 
     * @param {string} methodName - Name of the method
     * @param {Function} fn - Async function to wrap
     * @param {Object} [params] - Input params to log at start
     * @returns {Promise<*>} Result of fn()
     * 
     * @example
     * const result = await log.traced('findBestAgent', async () => {
     *   return await capabilityMatcher.findBestMatch(agents, requirements);
     * }, { ticketId, agentCount: agents.length });
     */
    async traced(methodName, fn, params = {}) {
      this.start(methodName, params);
      try {
        const result = await fn();
        this.complete(methodName, { success: true });
        return result;
      } catch (err) {
        this.error(methodName, err, params);
        throw err;
      }
    },
  };
}

/**
 * Standard log format for ticket lifecycle events.
 * Use this for consistent ticket state transition logging.
 * 
 * @param {string} serviceName - Service name
 * @param {string} methodName - Method name
 * @param {string} ticketId - Ticket ID
 * @param {string} event - Event description
 * @param {Object} [details] - Additional details
 */
function logTicketEvent(serviceName, methodName, ticketId, event, details = {}) {
  logger.info(`[${serviceName}.${methodName}] TICKET_EVENT: ${event}`, {
    ticketId,
    ...details,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Standard log format for agent dispatch events.
 * 
 * @param {string} serviceName - Service name
 * @param {string} methodName - Method name
 * @param {string} agentId - Agent ID
 * @param {string} ticketId - Ticket ID
 * @param {string} event - Event description
 * @param {Object} [details] - Additional details
 */
function logAgentEvent(serviceName, methodName, agentId, ticketId, event, details = {}) {
  logger.info(`[${serviceName}.${methodName}] AGENT_EVENT: ${event}`, {
    agentId,
    ticketId,
    ...details,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Standard log format for phase transitions.
 * 
 * @param {string} serviceName - Service name
 * @param {string} methodName - Method name
 * @param {string} ticketId - Ticket ID
 * @param {number} fromPhase - Previous phase number
 * @param {number} toPhase - New phase number
 * @param {string} [agentId] - Agent involved
 */
function logPhaseTransition(serviceName, methodName, ticketId, fromPhase, toPhase, agentId = null) {
  const phaseNames = { 1: 'INTAKE', 2: 'PLANNING', 3: 'SPECIALIST_INPUT', 4: 'EXECUTION', 5: 'TESTING', 6: 'REVIEW', 7: 'DELIVERY' };
  logger.info(`[${serviceName}.${methodName}] PHASE_TRANSITION`, {
    ticketId,
    from: `${fromPhase}:${phaseNames[fromPhase] || 'UNKNOWN'}`,
    to: `${toPhase}:${phaseNames[toPhase] || 'UNKNOWN'}`,
    agentId,
    timestamp: new Date().toISOString(),
  });
}

module.exports = {
  createLogger,
  logTicketEvent,
  logAgentEvent,
  logPhaseTransition,
};
