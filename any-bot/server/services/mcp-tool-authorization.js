/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | SEC-04: centralize exact caller, tool allowlist, scope, and registry-attestation checks for every legacy MCP transport invocation.
 */

'use strict';

const { optionalExactUserSubject } = require('./codebase/exact-user-subject');
const {
  requireDispatchAuthorityList,
  requiredScope,
} = require('../utils/dispatch-capabilities');

const MCP_SERVER_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9.:-]{0,127}$/;
const MCP_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/**
 * @description Build the one registry name used to authorize a server/tool pair. Rejecting
 * aliases prevents a caller from authorizing one spelling while a transport executes another.
 * @param {unknown} serverName - MCP server identifier.
 * @param {unknown} toolName - MCP tool identifier.
 * @returns {string} Exact ToolRegistry capability name.
 */
function canonicalMcpToolName(serverName, toolName) {
  const server = exactServerIdentifier(serverName);
  const tool = exactIdentifier(toolName, 'toolName');
  const capability = `mcp_${server}_${tool}`;
  if (capability.length > 256) {
    throw authorizationError('MCP serverName/toolName pair is too long.');
  }
  return capability;
}

/**
 * @description Validate caller identity plus exact dispatch authorities before registry lookup.
 * This is transport validation, not a second policy engine: the ToolRegistry snapshot and its
 * approval bit remain the execution authority.
 * @param {unknown} value - Trusted controller-supplied execution context.
 * @param {string} capabilityName - Canonical MCP registry capability.
 * @returns {{userSub:string,agentId:string,taskId:string,allowedTools:readonly string[],authorizedScopes:readonly string[],taskWorkspace:string|undefined}} Sanitized context.
 */
function requireMcpCallerContext(value, capabilityName) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw authorizationError('MCP execution context is required.');
  }
  const context = value;
  const topLevelSub = context.userSub;
  const environmentSub = context.extraEnv?.OSHAL_USER_SUB;
  if (topLevelSub !== undefined && environmentSub !== undefined && topLevelSub !== environmentSub) {
    throw authorizationError('MCP caller identity assertions conflict.');
  }
  let userSub;
  try {
    userSub = optionalExactUserSubject(topLevelSub ?? environmentSub, 'MCP caller userSub');
  } catch {
    throw authorizationError('MCP caller identity is invalid.');
  }
  if (!userSub) throw authorizationError('MCP caller identity is required.');

  const agentId = exactIdentifier(context.agentId, 'agentId');
  const taskId = exactIdentifier(context.taskId, 'taskId');
  const allowedTools = exactAuthorityList(context.allowedTools, 'allowedTools', 256);
  const authorizedScopes = exactAuthorityList(context.authorizedScopes, 'authorizedScopes', 512);
  if (!allowedTools.includes(capabilityName)) {
    throw authorizationError(`MCP capability is not allowlisted: ${capabilityName}`);
  }
  const scope = requiredScope(capabilityName);
  if (!authorizedScopes.includes(scope)) {
    throw authorizationError(`MCP capability is missing exact scope: ${scope}`);
  }
  const taskWorkspace = context.taskWorkspace === undefined
    ? undefined
    : String(context.taskWorkspace);
  return Object.freeze({
    userSub,
    agentId,
    taskId,
    allowedTools,
    authorizedScopes,
    taskWorkspace,
  });
}

/**
 * @description Require the non-forgeable ToolRegistry execution attestation as the final seam
 * before a network or stdio transport receives tool arguments.
 * @param {object} registry - Canonical ToolRegistry instance.
 * @param {unknown} context - Handler context emitted by ToolRegistry.
 * @param {string} capabilityName - Exact registered MCP tool name.
 * @returns {ReturnType<typeof requireMcpCallerContext>} Sanitized caller context.
 */
function assertMcpExecutionAttestation(registry, context, capabilityName) {
  const caller = requireMcpCallerContext(context, capabilityName);
  if (!registry || typeof registry.isAuthorizedExecutionContext !== 'function'
    || !registry.isAuthorizedExecutionContext(context, capabilityName)) {
    throw authorizationError('MCP ToolRegistry execution attestation is missing or stale.');
  }
  return caller;
}

function exactIdentifier(value, field) {
  if (typeof value !== 'string' || !MCP_IDENTIFIER.test(value)) {
    throw authorizationError(`MCP ${field} is invalid.`);
  }
  return value;
}

function exactServerIdentifier(value) {
  if (typeof value !== 'string' || !MCP_SERVER_IDENTIFIER.test(value)) {
    throw authorizationError('MCP serverName is invalid.');
  }
  return value;
}

function exactAuthorityList(value, field, maxEntryLength) {
  try {
    return requireDispatchAuthorityList(value, field, maxEntryLength);
  } catch {
    throw authorizationError(`MCP ${field} authority is invalid.`);
  }
}

function authorizationError(message) {
  const error = new Error(message);
  error.code = 'MCP_TOOL_AUTHORIZATION_DENIED';
  return error;
}

module.exports = {
  assertMcpExecutionAttestation,
  canonicalMcpToolName,
  requireMcpCallerContext,
};
