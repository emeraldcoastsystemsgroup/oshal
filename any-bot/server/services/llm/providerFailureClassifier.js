/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Centralized CLI/provider failure classification for failover and ticket status.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Add narrow isProviderRuntimeBanner (stall + CLI-error banners only) for classifying SUCCESSFUL output; the broad throttle/auth keyword patterns must only classify the error/failure channel, never a valid answer.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Recognize a logged-out CLI ("Not logged in · Please run /login") as an auth failure, and the providers' own "<vendor> CLI task failed" banner as a runtime failure. Both were unclassified, so an expired CLI login was handed to the user AS THE ANSWER instead of failing over.
 */

'use strict';

const STALL_PATTERN = /CLI stalled|INACTIVITY CIRCUIT BREAKER|no output for \d+s|no output for 180s|runtime stall/i;
const THROTTLE_PATTERN = /\b(?:429|too many requests|rate[-\s]?limit(?:ed)?|retry-after|quota|insufficient_quota|resource_exhausted|throttl\w*|ThrottlingException|ResourceExhaustedException|ServiceUnavailableException|overloaded|temporarily unavailable)\b/i;
// "not logged in" / "please run /login" / "logged out" are how the Claude Code and Codex CLIs report
// an expired or absent OAuth login. Without them an auth failure reads as ordinary prose and escapes
// every classifier here, which is exactly how a logged-out CLI became a user-visible "answer".
const AUTH_PATTERN = /\b(?:401 Unauthorized|403 Forbidden|unauthorized|not authenticated|not logged in|logged out|login required|please run \/login|run \/login|authentication (?:issue|failed|required)|invalid api key|invalid_api_key|ANTHROPIC_API_KEY|OPENAI_API_KEY|OAuth (?:file|token|login|credentials)|oauth (?:token|login|credentials|expired|required|failed))\b/i;
// `task failed` is the banner ClaudeCodeProvider/ClineProvider build themselves for a non-zero exit
// ("Claude Code CLI task failed: ..."). It belongs here for the same reason `encountered an error`
// does: a provider must be able to recognize its OWN failure text when it comes back as a response.
const CLI_RUNTIME_PATTERN = /(?:Claude Code|Cline|Codex|Gemini)[\w\s-]*CLI (?:encountered an error|error|task failed)|Command failed with exit code \d+|runtime failed before completion|failed to connect to websocket/i;

function formatProviderFailure(value) {
  if (value instanceof Error) {
    const details = [];
    details.push(`${value.name}: ${value.message}`);
    if (typeof value.stderr === 'string' && value.stderr.trim()) details.push(value.stderr);
    if (typeof value.stdout === 'string' && value.stdout.trim()) details.push(value.stdout);
    if (typeof value.stderrTail === 'string' && value.stderrTail.trim()) details.push(value.stderrTail);
    if (typeof value.stdoutTail === 'string' && value.stdoutTail.trim()) details.push(value.stdoutTail);
    return details.join(' ');
  }
  if (typeof value === 'string') {
    return value;
  }
  if (value && typeof value === 'object') {
    const parts = [];
    for (const key of ['content', 'response', 'error', 'message', 'status', 'claudeCodeError', 'clineError', 'codexError', 'stderr', 'stdout']) {
      if (typeof value[key] === 'string' && value[key].trim()) parts.push(value[key]);
    }
    if (parts.length > 0) return parts.join(' ');
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function isProviderRuntimeStall(value) {
  return STALL_PATTERN.test(formatProviderFailure(value));
}

function isProviderThrottle(value) {
  return THROTTLE_PATTERN.test(formatProviderFailure(value));
}

function isProviderAuthFailure(value) {
  return AUTH_PATTERN.test(formatProviderFailure(value));
}

function isProviderCliRuntimeFailure(value) {
  return CLI_RUNTIME_PATTERN.test(formatProviderFailure(value));
}

function isProviderRecoverableRuntimeFailure(value) {
  const text = formatProviderFailure(value);
  return STALL_PATTERN.test(text)
    || THROTTLE_PATTERN.test(text)
    || AUTH_PATTERN.test(text)
    || CLI_RUNTIME_PATTERN.test(text);
}

/**
 * Narrow failure detector for SUCCESSFUL output text (exit code 0 but the CLI
 * printed a runtime/stall banner instead of a real answer). Deliberately EXCLUDES
 * the broad THROTTLE_PATTERN / AUTH_PATTERN plain-English keywords ("429", "quota",
 * "rate limit", "unauthorized", "overloaded", ...) because those appear routinely in
 * correct answers — especially on an RCA/DevOps platform — and must never cause a
 * paid-for, successful generation to be discarded. Use this to classify a success
 * path; use isProviderRecoverableRuntimeFailure only on the error/failure channel
 * (stderr, thrown errors, success===false).
 */
function isProviderRuntimeBanner(value) {
  const text = formatProviderFailure(value);
  return STALL_PATTERN.test(text) || CLI_RUNTIME_PATTERN.test(text);
}

function classifyProviderFailure(value) {
  const text = formatProviderFailure(value);
  if (STALL_PATTERN.test(text)) return 'provider_runtime_stall';
  if (THROTTLE_PATTERN.test(text)) return 'provider_throttle';
  if (AUTH_PATTERN.test(text)) return 'provider_auth';
  if (CLI_RUNTIME_PATTERN.test(text)) return 'provider_runtime_error';
  return null;
}

module.exports = {
  classifyProviderFailure,
  formatProviderFailure,
  isProviderAuthFailure,
  isProviderCliRuntimeFailure,
  isProviderRecoverableRuntimeFailure,
  isProviderRuntimeBanner,
  isProviderRuntimeStall,
  isProviderThrottle,
};
