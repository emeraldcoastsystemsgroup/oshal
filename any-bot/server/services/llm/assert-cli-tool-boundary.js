/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05: fail closed when a caller requests constrained tools from an autonomous CLI whose internal actions bypass the server tool broker.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05 closure: expose a provider-selection preflight so unbrokered autonomous CLIs are rejected before task/workspace acceptance, with an explicit hosted-or-brokered remediation.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Remove the unaudited caller-supplied brokeredSandbox bypass and include Gemini CLI aliases in unattended preflight; no broker attestation exists today.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | ADR-127: the SPAWN boundary gets the same demo carve the TS preflight has, and for the same reason — a deployment running as a demo may launch the CLI for its own operator. Authority is read from the PROCESS environment plus the per-request OSHAL_USER_SUB the handler already threads into extraEnv; a caller-supplied option is never accepted as attestation (that bypass was removed in entry 3 and stays removed). Everything else — every other caller, every identity-less launch, every non-demo deployment — keeps the denial.
 * 5 | Codex                                      | Mirror the TS Codex-only demo-user allowlist at the final spawn boundary. Exact OSHAL_DEMO_CLI_SUBS matches are admitted only for Codex aliases under DEMO_MODE and gain no operator authority or access to other CLI subscriptions.
 */
'use strict';

const UNBROKERED_AUTONOMOUS_PROVIDERS = new Set([
  'cline', 'cline-cli', 'claude', 'claude-code', 'codex', 'codex-cli', 'openai-codex',
  'gemini', 'gemini-cli',
]);

/** True when this deployment runs as a demo. Mirrors src/shared/deployment-mode.ts (DEMO_MODE alone). */
function demoDeployment() {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env.DEMO_MODE || '').trim().toLowerCase());
}

/**
 * The exact subject this launch runs for. Read from the per-request spawn env the execution handler
 * builds (extraEnv.OSHAL_USER_SUB) — NOT from a free-form option, which a caller could assert.
 */
function launchSubject(options) {
  const extraEnv = options && options.extraEnv;
  const sub = extraEnv && extraEnv.OSHAL_USER_SUB;
  return typeof sub === 'string' ? sub : '';
}

/**
 * ADR-127: the one condition under which a CLI launch is permitted — a demo deployment launching
 * for an exact operator or demo-CLI-user subject. Exact, case-sensitive subject comparison; an
 * empty or absent subject can never match, so an unattended launch stays denied.
 */
function demoAllowedLaunch(options, providerName) {
  if (!demoDeployment()) return false;
  const sub = launchSubject(options);
  if (!sub.trim()) return false;
  const exactMatch = (raw) => String(raw || '')
    .split(',').map((s) => s.trim()).filter(Boolean).includes(sub);
  if (exactMatch(process.env.OSHAL_OPERATOR_SUBS)) return true;
  const provider = typeof providerName === 'string' ? providerName.trim().toLowerCase() : '';
  return ['codex', 'codex-cli', 'openai-codex'].includes(provider)
    && exactMatch(process.env.OSHAL_DEMO_CLI_SUBS);
}

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
function assertCliToolBoundary(options, providerName) {
  // ADR-127: a demo deployment may launch the CLI for an exact operator/demo-user allowlist match.
  // The authority comes from the process environment plus the handler-threaded request subject,
  // never from an option the caller could set. Audited on every pass, because this is a posture exception.
  if (demoAllowedLaunch(options, providerName)) {
    // eslint-disable-next-line no-console
    console.warn(`[ADR-127] DEMO_MODE: launching ${providerName} for an explicitly allowed demo user — CLI tool boundary deliberately carved`);
    return;
  }
  // Otherwise: no audited brokered sandbox exists. Do not accept a request/model/provider option as
  // attestation; every autonomous CLI launch remains denied at this final spawn boundary.
  const error = new Error(
    `${providerName} cannot enforce the server-issued tool boundary; autonomous CLI launch denied.`,
  );
  error.code = 'UNENFORCEABLE_CLI_TOOL_BOUNDARY';
  error.provider = providerName;
  throw error;
}

module.exports = { assertCliToolBoundary, assertUnattendedProviderSelection };
