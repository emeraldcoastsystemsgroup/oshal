/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * Checkpoint Validator - Validates checkpoint data structure and integrity
 * Ensures checkpoints are safe to restore
 */

const logger = require('../utils/logger');

/**
 * @description Static utility for guarding checkpoint integrity so that only well-formed,
 * trustworthy state is ever restored into a running task. Validation is split into focused
 * checks (structure, per-message, metadata) and composed for comprehensive and
 * restore-time gating, with helpers to sanitize unsafe content and surface failures via logs.
 * Exposed as the module's default export.
 */
class CheckpointValidator {
  /**
   * Validate checkpoint structure
   */
  static validateCheckpoint(checkpoint) {
    const errors = [];

    // Validate required fields
    if (!checkpoint) {
      errors.push('Checkpoint is null or undefined');
      return { valid: false, errors };
    }

    if (!checkpoint.id || typeof checkpoint.id !== 'string') {
      errors.push('Checkpoint ID is missing or invalid');
    }

    if (!checkpoint.taskId || typeof checkpoint.taskId !== 'string') {
      errors.push('Task ID is missing or invalid');
    }

    if (typeof checkpoint.timestamp !== 'number') {
      errors.push('Timestamp is missing or invalid');
    }

    if (typeof checkpoint.messageCount !== 'number' || checkpoint.messageCount < 0) {
      errors.push('Message count is missing or invalid');
    }

    if (!Array.isArray(checkpoint.messages)) {
      errors.push('Messages array is missing or invalid');
    }

    // Validate message count matches actual messages
    if (checkpoint.messages && checkpoint.messageCount !== checkpoint.messages.length) {
      errors.push(`Message count mismatch: expected ${checkpoint.messageCount}, got ${checkpoint.messages.length}`);
    }

    // Validate metadata (optional but must be object if present)
    if (checkpoint.metadata !== undefined && typeof checkpoint.metadata !== 'object') {
      errors.push('Metadata is present but not an object');
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Validate message structure
   */
  static validateMessage(message, index) {
    const errors = [];

    if (!message) {
      errors.push(`Message at index ${index} is null or undefined`);
      return { valid: false, errors };
    }

    if (!message.type || typeof message.type !== 'string') {
      errors.push(`Message at index ${index} missing or invalid type`);
    }

    if (!message.say || typeof message.say !== 'string') {
      errors.push(`Message at index ${index} missing or invalid say field`);
    }

    if (typeof message.ts !== 'number') {
      errors.push(`Message at index ${index} missing or invalid timestamp`);
    }

    // Validate text field for most message types
    if (message.type !== 'tool_use' && message.type !== 'tool_result') {
      if (message.text === undefined || typeof message.text !== 'string') {
        errors.push(`Message at index ${index} missing or invalid text`);
      }
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Validate all messages in checkpoint
   */
  static validateMessages(checkpoint) {
    const errors = [];

    if (!Array.isArray(checkpoint.messages)) {
      errors.push('Messages is not an array');
      return { valid: false, errors };
    }

    checkpoint.messages.forEach((message, index) => {
      const result = this.validateMessage(message, index);
      if (!result.valid) {
        errors.push(...result.errors);
      }
    });

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Validate checkpoint metadata
   */
  static validateMetadata(checkpoint) {
    const errors = [];

    if (!checkpoint.metadata) {
      // Metadata is optional
      return { valid: true, errors };
    }

    if (typeof checkpoint.metadata !== 'object') {
      errors.push('Metadata is not an object');
      return { valid: false, errors };
    }

    // Validate status if present
    if (checkpoint.metadata.status !== undefined) {
      const validStatuses = ['created', 'running', 'completed', 'error', 'cancelled'];
      if (!validStatuses.includes(checkpoint.metadata.status)) {
        errors.push(`Invalid status: ${checkpoint.metadata.status}`);
      }
    }

    // Validate apiMetrics if present
    if (checkpoint.metadata.apiMetrics !== undefined) {
      if (typeof checkpoint.metadata.apiMetrics !== 'object') {
        errors.push('apiMetrics is not an object');
      } else {
        const metrics = checkpoint.metadata.apiMetrics;
        
        if (metrics.totalTokens !== undefined && typeof metrics.totalTokens !== 'number') {
          errors.push('apiMetrics.totalTokens is not a number');
        }
        
        if (metrics.totalCost !== undefined && typeof metrics.totalCost !== 'number') {
          errors.push('apiMetrics.totalCost is not a number');
        }
        
        if (metrics.requestCount !== undefined && typeof metrics.requestCount !== 'number') {
          errors.push('apiMetrics.requestCount is not a number');
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Comprehensive checkpoint validation
   */
  static validateComprehensive(checkpoint) {
    const results = {
      structure: this.validateCheckpoint(checkpoint),
      messages: { valid: true, errors: [] },
      metadata: { valid: true, errors: [] }
    };

    // Validate messages and metadata even if structure fails to get all errors
    if (checkpoint && checkpoint.messages) {
      results.messages = this.validateMessages(checkpoint);
    }
    
    if (checkpoint && checkpoint.metadata) {
      results.metadata = this.validateMetadata(checkpoint);
    }

    const allErrors = [
      ...results.structure.errors,
      ...results.messages.errors,
      ...results.metadata.errors
    ];

    return {
      valid: allErrors.length === 0,
      errors: allErrors,
      details: results
    };
  }

  /**
   * Validate checkpoint before restoration
   */
  static validateForRestore(checkpoint, currentTask) {
    const errors = [];

    // Run comprehensive validation
    const validation = this.validateComprehensive(checkpoint);
    if (!validation.valid) {
      errors.push(...validation.errors);
    }

    // Validate task ID matches
    if (currentTask && checkpoint.taskId !== currentTask.id) {
      errors.push(`Checkpoint task ID (${checkpoint.taskId}) does not match current task (${currentTask.id})`);
    }

    // Validate timestamp is not in future
    if (checkpoint.timestamp > Date.now()) {
      errors.push('Checkpoint timestamp is in the future');
    }

    // Validate messages are in chronological order
    if (checkpoint.messages && checkpoint.messages.length > 1) {
      for (let i = 1; i < checkpoint.messages.length; i++) {
        if (checkpoint.messages[i].ts < checkpoint.messages[i - 1].ts) {
          errors.push(`Messages are not in chronological order at index ${i}`);
          break;
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Sanitize checkpoint data (remove potentially unsafe content)
   */
  static sanitize(checkpoint) {
    // Create deep copy to avoid modifying original
    const sanitized = JSON.parse(JSON.stringify(checkpoint));

    // Remove any functions or undefined values
    const cleanObject = (obj) => {
      Object.keys(obj).forEach(key => {
        if (typeof obj[key] === 'function' || obj[key] === undefined) {
          delete obj[key];
        } else if (typeof obj[key] === 'object' && obj[key] !== null) {
          cleanObject(obj[key]);
        }
      });
    };

    cleanObject(sanitized);

    return sanitized;
  }

  /**
   * Log validation results
   */
  static logValidation(validation, checkpointId) {
    if (validation.valid) {
      logger.info(`Checkpoint ${checkpointId} validation passed`);
    } else {
      logger.error(`Checkpoint ${checkpointId} validation failed:`);
      validation.errors.forEach(error => {
        logger.error(`  - ${error}`);
      });
    }
  }
}

module.exports = CheckpointValidator;
