/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05: bind exact operation scopes to request-start tool-handler snapshots and model completion control.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05 audit: revalidate every captured handler generation immediately before provider and operation boundaries.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05 closure: reject missing or malformed HTTP authority carriers instead of normalizing them to an unrestricted legacy boundary.
 */
'use strict';

const { isDispatchToolAllowed } = require('./untrusted-content');

const COMPLETION_TOOL = 'attempt_completion';
const COMPLETION_SCOPE = 'control:attempt_completion';

/** Require a bounded, exact authority list at a privileged transport boundary. */
function requireDispatchAuthorityList(value, field, maxEntryLength) {
  if (!Array.isArray(value) || value.length > 256) {
    const error = new TypeError(`${field} must be a bounded array`);
    error.code = 'INVALID_DISPATCH_AUTHORITY';
    throw error;
  }
  const exact = [];
  const seen = new Set();
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > maxEntryLength
      || /[\u0000-\u001f\u007f]/.test(entry)) {
      const error = new TypeError(`${field} contains an invalid entry`);
      error.code = 'INVALID_DISPATCH_AUTHORITY';
      throw error;
    }
    if (!seen.has(entry)) {
      seen.add(entry);
      exact.push(entry);
    }
  }
  return Object.freeze(exact);
}

/** Normalize server-issued scopes while preserving null as the legacy interactive boundary. */
function normalizeAuthorizedScopes(value) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) return new Set();
  return new Set(value.filter((entry) => (
    typeof entry === 'string' && entry.length > 0 && entry.length <= 512
  )));
}

/** Return the exact scope required to perform one operation. */
function requiredScope(toolName) {
  return toolName === COMPLETION_TOOL ? COMPLETION_SCOPE : `tool:${toolName}`;
}

/** Scope absence is allowed only on the legacy interactive path (null scope set). */
function hasOperationScope(scopes, toolName) {
  return scopes === null || scopes.has(requiredScope(toolName));
}

/**
 * Capture every callable definition once, before the model receives tool schemas.
 * Constrained dispatch fails closed if its registry cannot provide snapshot semantics.
 */
function captureDispatchCapabilities(registry, allowedTools, scopes) {
  if (!registry || typeof registry.capture !== 'function') {
    throw new Error('Tool registry does not support request-scoped capability snapshots.');
  }
  const snapshots = new Map();
  const definitions = [];
  for (const advertised of registry.getAll()) {
    if (!isDispatchToolAllowed(allowedTools, advertised.name)) continue;
    if (!hasOperationScope(scopes, advertised.name)) continue;
    const snapshot = registry.capture(advertised.name);
    if (!snapshot) continue;
    snapshots.set(advertised.name, snapshot);
    definitions.push(toolDefinition(snapshot.tool));
  }
  if (isDispatchToolAllowed(allowedTools, COMPLETION_TOOL)
    && hasOperationScope(scopes, COMPLETION_TOOL)) {
    definitions.push(completionDefinition());
  }
  return { allowedTools, scopes, snapshots, definitions };
}

/** Resolve one model request against both the exact allowlist and operation scope. */
function authorizeCapability(capabilities, toolName) {
  if (!isDispatchToolAllowed(capabilities.allowedTools, toolName)) {
    return { allowed: false, error: 'Tool is not authorized for this dispatch.' };
  }
  if (!hasOperationScope(capabilities.scopes, toolName)) {
    return { allowed: false, error: `Missing exact operation scope: ${requiredScope(toolName)}` };
  }
  if (toolName === COMPLETION_TOOL) return { allowed: true, control: true };
  const snapshot = capabilities.snapshots.get(toolName);
  return snapshot
    ? { allowed: true, snapshot }
    : { allowed: false, error: 'Tool was absent when request capabilities were captured.' };
}

/** Fail the whole request when any capability advertised at request start was revoked/replaced. */
function assertDispatchCapabilitiesCurrent(registry, capabilities) {
  if (!registry || typeof registry.isSnapshotCurrent !== 'function') {
    throw new Error('Tool registry cannot revalidate captured capabilities.');
  }
  for (const snapshot of capabilities.snapshots.values()) {
    if (!registry.isSnapshotCurrent(snapshot)) {
      throw new Error('Tool capability was replaced or revoked after request authorization.');
    }
  }
}

function toolDefinition(tool) {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema || { type: 'object', properties: {}, required: [] },
  };
}

function completionDefinition() {
  return {
    name: COMPLETION_TOOL,
    description: 'Return the final task result without performing any additional side effect.',
    inputSchema: {
      type: 'object',
      properties: { result: { type: 'string' } },
      required: ['result'],
    },
  };
}

module.exports = {
  COMPLETION_SCOPE,
  COMPLETION_TOOL,
  assertDispatchCapabilitiesCurrent,
  authorizeCapability,
  captureDispatchCapabilities,
  hasOperationScope,
  normalizeAuthorizedScopes,
  requireDispatchAuthorityList,
  requiredScope,
};
