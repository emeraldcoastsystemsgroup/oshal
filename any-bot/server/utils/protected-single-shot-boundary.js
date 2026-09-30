/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Validate that the protected Cline single-shot marker came through the signed remote-execution path with exact zero-tool authority before TaskController forwards an internal verified marker to a provider.
 */

'use strict';

function boundaryError(message) {
  const error = new Error(message);
  error.code = 'DIRECT_REASONING_BOUNDARY_INVALID';
  return error;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * @description Convert the handler-only request marker into a provider-facing verified marker.
 * A raw boolean is never sufficient: the request must still carry the live authorization closure,
 * signed protected execution bridge, trusted runtime identity, and the exact original empty
 * application-tool declaration. This check happens before tool-less normalization can erase a
 * caller's non-empty allowlist.
 * @param {object} options TaskController direct-call options.
 * @returns {boolean} True only for a fully verified protected single-shot request.
 */
function assertProtectedSingleShotBoundary(options = {}) {
  if (options.singleShotToolless !== true) return false;

  const bridge = options.toolBridge;
  const bridgeValid = bridge && typeof bridge === 'object'
    && ['agentId', 'taskId', 'userSub', 'applicationExecutionId', 'applicationExecutionToken']
      .every((field) => nonEmptyString(bridge[field]));
  const exactOriginalToolBoundary = Array.isArray(options.allowedTools)
    && options.allowedTools.length === 0;
  const runtimeAgentId = nonEmptyString(options.agentId) ? options.agentId.trim() : '';

  if (options.toolLess !== true
    || options.source !== 'swarm-dispatch'
    || typeof options.assertCurrentAuthorization !== 'function'
    || !bridgeValid
    || !exactOriginalToolBoundary
    || !runtimeAgentId
    || runtimeAgentId !== bridge.agentId
    || options.byoLlmConnection) {
    throw boundaryError(
      'Protected single-shot reasoning requires signed protected provenance, trusted runtime identity, and an exact empty original tool boundary.',
    );
  }
  return true;
}

module.exports = { assertProtectedSingleShotBoundary };
