/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * Message Controller - Handles message routing, filtering, and grouping
 * Coordinates message flow between UI and backend
 */

const logger = require('../utils/logger');
const { MESSAGE_TYPES, isValidMessageType, createMessage } = require('../utils/messageTypes');

/**
 * @description Orchestrates the lifecycle of task messages so the UI and
 * backend share a single, consistent view of a conversation. Beyond simple
 * persistence, it exists to shape raw message streams into something
 * presentable: hiding internal bookkeeping messages, collapsing noisy
 * API/command request-response pairs, and surfacing aggregate insight (counts,
 * latest-of-type, error/tool flags). Centralizing this logic keeps message
 * formatting rules in one place rather than scattered across views.
 */
class MessageController {
  /**
   * @description Wires the controller to its persistence backend. The store is
   * injected (rather than constructed here) so the controller stays agnostic to
   * how messages are stored and remains easy to test with a fake store.
   * @param {Object} messageStore - Persistence layer exposing saveMessage,
   *   getMessages, and deleteMessages used to read and write task messages.
   */
  constructor(messageStore) {
    this.messageStore = messageStore;
  }

  /**
   * Add a message to a task
   */
  async addMessage(taskId, message) {
    // Validate message type
    if (!isValidMessageType(message.type)) {
      throw new Error(`Invalid message type: ${message.type}`);
    }

    // Save message
    const saved = await this.messageStore.saveMessage(taskId, message);
    
    logger.debug(`Message added: ${message.type} for task ${taskId}`);
    
    return saved;
  }

  /**
   * Get messages for a task
   */
  async getMessages(taskId) {
    const messages = await this.messageStore.getMessages(taskId);
    return messages;
  }

  /**
   * Get filtered messages (visible messages only)
   */
  async getVisibleMessages(taskId) {
    const messages = await this.getMessages(taskId);
    return this.filterVisibleMessages(messages);
  }

  /**
   * Filter messages to show only visible ones
   * (Hides internal system messages that shouldn't be displayed)
   */
  filterVisibleMessages(messages) {
    return messages.filter((message) => {
      // Always show these types
      const alwaysVisible = [
        MESSAGE_TYPES.TASK,
        MESSAGE_TYPES.SAY,
        MESSAGE_TYPES.ASK,
        MESSAGE_TYPES.TOOL_USE,
        MESSAGE_TYPES.TOOL_RESULT,
        MESSAGE_TYPES.ERROR,
        MESSAGE_TYPES.TASK_PROGRESS,
        MESSAGE_TYPES.COMPLETION_RESULT,
      ];

      return alwaysVisible.includes(message.type);
    });
  }

  /**
   * Group consecutive messages of the same type
   * Combines API requests and tool sequences for cleaner display
   */
  groupMessages(messages) {
    if (!messages || messages.length === 0) {
      return [];
    }

    const grouped = [];
    let currentGroup = null;

    messages.forEach((message) => {
      // Messages that should be grouped
      const shouldGroup = 
        message.type === MESSAGE_TYPES.API_REQ_STARTED ||
        message.type === MESSAGE_TYPES.API_REQ_FINISHED;

      if (shouldGroup && currentGroup && currentGroup.type === message.type) {
        // Add to existing group
        currentGroup.messages.push(message);
      } else {
        // Start new group or add as standalone
        if (currentGroup) {
          grouped.push(currentGroup);
        }

        if (shouldGroup) {
          currentGroup = {
            type: 'group',
            groupType: message.type,
            messages: [message],
            ts: message.ts,
          };
        } else {
          currentGroup = message;
          grouped.push(currentGroup);
          currentGroup = null;
        }
      }
    });

    // Add final group if exists
    if (currentGroup) {
      grouped.push(currentGroup);
    }

    return grouped;
  }

  /**
   * Combine API request messages
   * Merges api_req_started and api_req_finished into single message
   */
  combineApiRequests(messages) {
    const combined = [];
    let pendingApiStart = null;

    messages.forEach((message) => {
      if (message.type === MESSAGE_TYPES.API_REQ_STARTED) {
        pendingApiStart = message;
      } else if (message.type === MESSAGE_TYPES.API_REQ_FINISHED && pendingApiStart) {
        // Merge started and finished
        combined.push({
          type: MESSAGE_TYPES.API_REQ_FINISHED,
          say: MESSAGE_TYPES.API_REQ_FINISHED,
          ts: pendingApiStart.ts,
          text: '',
          request: {
            ...pendingApiStart.request,
            ...message.request,
          },
        });
        pendingApiStart = null;
      } else {
        // Not an API message or no pending start
        if (pendingApiStart) {
          combined.push(pendingApiStart);
          pendingApiStart = null;
        }
        combined.push(message);
      }
    });

    // Add any orphaned api_req_started
    if (pendingApiStart) {
      combined.push(pendingApiStart);
    }

    return combined;
  }

  /**
   * Combine command sequences
   * Merges command execution with its output
   */
  combineCommandSequences(messages) {
    const combined = [];
    let pendingCommand = null;

    messages.forEach((message) => {
      if (message.type === MESSAGE_TYPES.COMMAND) {
        pendingCommand = message;
      } else if (message.type === MESSAGE_TYPES.COMMAND_OUTPUT && pendingCommand) {
        // Merge command and output
        combined.push({
          ...pendingCommand,
          output: message.text,
          exitCode: message.exitCode || 0,
        });
        pendingCommand = null;
      } else {
        // Not a command message or no pending command
        if (pendingCommand) {
          combined.push(pendingCommand);
          pendingCommand = null;
        }
        combined.push(message);
      }
    });

    // Add any orphaned command
    if (pendingCommand) {
      combined.push(pendingCommand);
    }

    return combined;
  }

  /**
   * Get message statistics
   */
  async getMessageStats(taskId) {
    const messages = await this.getMessages(taskId);
    
    const stats = {
      total: messages.length,
      byType: {},
      hasErrors: false,
      hasToolUse: false,
      apiRequests: 0,
    };

    messages.forEach((message) => {
      // Count by type
      stats.byType[message.type] = (stats.byType[message.type] || 0) + 1;

      // Track specific features
      if (message.type === MESSAGE_TYPES.ERROR) {
        stats.hasErrors = true;
      }
      if (message.type === MESSAGE_TYPES.TOOL_USE) {
        stats.hasToolUse = true;
      }
      if (message.type === MESSAGE_TYPES.API_REQ_STARTED || message.type === MESSAGE_TYPES.API_REQ_FINISHED) {
        stats.apiRequests++;
      }
    });

    return stats;
  }

  /**
   * Get latest message of a specific type
   */
  async getLatestMessageOfType(taskId, messageType) {
    if (!isValidMessageType(messageType)) {
      throw new Error(`Invalid message type: ${messageType}`);
    }

    const messages = await this.getMessages(taskId);
    
    // Search backwards for efficiency
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].type === messageType) {
        return messages[i];
      }
    }

    return null;
  }

  /**
   * Count messages of a specific type
   */
  async countMessagesByType(taskId, messageType) {
    const messages = await this.getMessages(taskId);
    return messages.filter((m) => m.type === messageType).length;
  }

  /**
   * Delete all messages for a task
   */
  async deleteMessages(taskId) {
    const deleted = await this.messageStore.deleteMessages(taskId);
    logger.info(`Deleted ${deleted} messages for task ${taskId}`);
    return deleted;
  }
}

module.exports = MessageController;
