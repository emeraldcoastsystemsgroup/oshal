/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05: fail closed when a caller requests constrained tools from an autonomous CLI whose internal actions bypass the server tool broker.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05 closure: expose a provider-selection preflight so unbrokered autonomous CLIs are rejected before task/workspace acceptance, with an explicit hosted-or-brokered remediation.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Remove the unaudited caller-supplied brokeredSandbox bypass and include Gemini CLI aliases in unattended preflight; no broker attestation exists today.
 */
'use strict';

const UNBROKERED_AUTONOMOUS_PROVIDERS = new Set([
  'cline', 'cline-cli', 'claude', 'claude-code', 'codex', 'codex-cli', 'openai-codex',
  'gemini', 'gemini-cli',
]);

/** Reject an unbrokered autonomous provider before durable work is accepted. */
function assertUnattendedProviderSelection(providerName, options = {}) {
  if (options.deterministicIntent === true || options.byoHostedInference === true) return;
  const normalized = typeof providerName === 'string' ? providerName.trim().toLowerCase() : '';
  if (!UNBROKERED_AUTONOMOUS_PROVIDERS.has(normalized)) return;
  const error = new Error(
    `${normalized} is an unbrokered autonomous CLI; unattended execution requires a hosted provider or audited brokered sandbox.`,
  );
  error.code = 'UNBROKERED_AUTONOMOUS_PROVIDER';
  error.provider = normalized;
  throw error;
}

/**
 * Autonomous CLI harnesses own an internal tool loop and cannot enforce OSHAL's exact handler
 * snapshots or operation scopes. Until one runs behind a proven brokered sandbox, a constrained
 * request must stop before gateway calls, credential setup, or process spawn.
 */
function assertCliToolBoundary(_options, providerName) {
  // No audited brokered sandbox exists. Do not accept a request/model/provider option as
  // attestation; every autonomous CLI launch remains denied at this final spawn boundary.
  const error = new Error(
    `${providerName} cannot enforce the server-issued tool boundary; autonomous CLI launch denied.`,
  );
  error.code = 'UNENFORCEABLE_CLI_TOOL_BOUNDARY';
  error.provider = providerName;
  throw error;
}

module.exports = { assertCliToolBoundary, assertUnattendedProviderSelection };
