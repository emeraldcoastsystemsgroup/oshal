/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * Message Type Definitions
 * Defines all message types used in the system (Cline-compatible)
 */

/**
 * @description Canonical registry of message-type discriminators exchanged across
 * the system. Centralizing these string constants keeps producers and consumers
 * in sync, prevents typo-driven mismatches, and preserves Cline compatibility.
 */
const MESSAGE_TYPES = {
  // Core message types
  TASK: 'task',                          // Initial task description
  SAY: 'say',                            // Assistant/user text message
  ASK: 'ask',                            // Question requiring user input
  
  // Tool-related types
  TOOL_USE: 'tool_use',                  // Tool execution request
  TOOL_RESULT: 'tool_result',            // Tool execution result
  
  // API tracking types
  API_REQ_STARTED: 'api_req_started',    // API request initiated
  API_REQ_FINISHED: 'api_req_finished',  // API request completed
  
  // Progress and completion
  TASK_PROGRESS: 'task_progress',        // Progress checklist update
  COMPLETION_RESULT: 'completion_result', // Task completion
  
  // Error and system
  ERROR: 'error',                        // Error message
  COMMAND: 'command',                    // Command execution
  COMMAND_OUTPUT: 'command_output',      // Command output
  
  // File operations
  FILE_OPERATION: 'file_operation',      // File read/write/list
  
  // Browser actions
  BROWSER_ACTION: 'browser_action',      // Browser interaction
  
  // Hook execution
  HOOK_EXECUTION: 'hook_execution',      // Hook result
};

/**
 * @description Enumerates the kinds of "ask" interactions that pause execution to
 * solicit user input (questions, approvals, resume decisions). Defined as shared
 * constants so the prompt flow and the UI agree on which response each ask expects.
 */
const ASK_TYPES = {
  FOLLOWUP: 'followup',                  // Follow-up question
  COMPLETION: 'completion',              // Completion confirmation
  TOOL_APPROVAL: 'tool_approval',        // Tool approval request
  COMMAND_APPROVAL: 'command_approval',  // Command approval request
  RESUME_TASK: 'resume_task',            // Task resume decision
  RESUME_COMPLETED_TASK: 'resume_completed_task', // Resume after completion
};

/**
 * @description Lifecycle states a tool invocation can occupy, from awaiting
 * approval through execution to a terminal success or error. Shared so approval
 * gating and result rendering reason about tool state consistently.
 */
const TOOL_STATUS = {
  PENDING: 'pending',                    // Awaiting approval
  APPROVED: 'approved',                  // User approved
  REJECTED: 'rejected',                  // User rejected
  EXECUTING: 'executing',                // Currently running
  SUCCESS: 'success',                    // Completed successfully
  ERROR: 'error',                        // Failed with error
};

/**
 * Validate message type
 */
function isValidMessageType(type) {
  return Object.values(MESSAGE_TYPES).includes(type);
}

/**
 * Validate ask type
 */
function isValidAskType(type) {
  return Object.values(ASK_TYPES).includes(type);
}

/**
 * Create a message object with proper structure
 */
function createMessage(type, text, additionalFields = {}) {
  if (!isValidMessageType(type)) {
    throw new Error(`Invalid message type: ${type}`);
  }

  return {
    type,
    say: type, // Cline compatibility
    text,
    ts: Date.now(),
    ...additionalFields,
  };
}

/**
 * Create a task message
 */
function createTaskMessage(taskText) {
  return createMessage(MESSAGE_TYPES.TASK, taskText);
}

/**
 * Create a say message (assistant or user)
 */
function createSayMessage(text, isUser = false) {
  return createMessage(MESSAGE_TYPES.SAY, text, {
    partial: false,
  });
}

/**
 * Create an ask message
 */
function createAskMessage(question, askType = ASK_TYPES.FOLLOWUP) {
  if (!isValidAskType(askType)) {
    throw new Error(`Invalid ask type: ${askType}`);
  }

  return createMessage(MESSAGE_TYPES.ASK, question, {
    ask: askType,
  });
}

/**
 * Create a tool use message
 */
function createToolUseMessage(toolName, toolInput, requiresApproval = true) {
  return createMessage(MESSAGE_TYPES.TOOL_USE, `Using tool: ${toolName}`, {
    tool: {
      name: toolName,
      input: toolInput,
      status: requiresApproval ? TOOL_STATUS.PENDING : TOOL_STATUS.EXECUTING,
      requiresApproval,
    },
  });
}

/**
 * Create a tool result message
 */
function createToolResultMessage(toolName, result, success = true, error = null) {
  return createMessage(MESSAGE_TYPES.TOOL_RESULT, result, {
    tool: {
      name: toolName,
      status: success ? TOOL_STATUS.SUCCESS : TOOL_STATUS.ERROR,
      success,
      error,
    },
  });
}

/**
 * Create an API request started message
 */
function createApiRequestStartedMessage(model, tokensIn = 0) {
  return createMessage(MESSAGE_TYPES.API_REQ_STARTED, '', {
    request: {
      model,
      tokensIn,
      tokensOut: 0,
      cacheWrites: 0,
      cacheReads: 0,
      cost: 0,
    },
  });
}

/**
 * Create an API request finished message
 */
function createApiRequestFinishedMessage(model, tokensIn, tokensOut, cost, cacheWrites = 0, cacheReads = 0) {
  return createMessage(MESSAGE_TYPES.API_REQ_FINISHED, '', {
    request: {
      model,
      tokensIn,
      tokensOut,
      cacheWrites,
      cacheReads,
      cost,
    },
  });
}

/**
 * Create a progress update message
 */
function createProgressMessage(checklist, completed = []) {
  const checklistText = checklist.map((item) => {
    const isComplete = completed.includes(item);
    return `- [${isComplete ? 'x' : ' '}] ${item}`;
  }).join('\n');

  return createMessage(MESSAGE_TYPES.TASK_PROGRESS, checklistText, {
    progress: {
      checklist,
      completed,
    },
  });
}

/**
 * Create an error message
 */
function createErrorMessage(errorText, errorDetails = {}) {
  return createMessage(MESSAGE_TYPES.ERROR, errorText, {
    error: errorDetails,
  });
}

/**
 * Create a completion result message
 */
function createCompletionMessage(result, command = null) {
  return createMessage(MESSAGE_TYPES.COMPLETION_RESULT, result, {
    command,
  });
}

module.exports = {
  MESSAGE_TYPES,
  ASK_TYPES,
  TOOL_STATUS,
  isValidMessageType,
  isValidAskType,
  createMessage,
  createTaskMessage,
  createSayMessage,
  createAskMessage,
  createToolUseMessage,
  createToolResultMessage,
  createApiRequestStartedMessage,
  createApiRequestFinishedMessage,
  createProgressMessage,
  createErrorMessage,
  createCompletionMessage,
};
