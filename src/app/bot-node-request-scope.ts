/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Preserve exact bot-node owner subjects and reject invalid supplied assertions instead of trimming, truncating, or collapsing them into ownerless execution.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05 closure: remove Twilio from bot-node credential materialization; SMS credentials are confined to fixed controller operations.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Validate the trusted app/capability/pattern carrier at the bot-node HTTP boundary before promoting it into an execution envelope.
 */

import crypto from 'crypto';
import { optionalExactUserSubject } from '@/shared/security/exact-user-subject';
import { isSkillCapabilityId, type SkillCapabilityId } from '@/shared/skill-profiles';

const SUPPORTED_BROKERED_CRED_KEYS = new Set([
  'OSHAL_CRED_GOOGLE',
  'OSHAL_CRED_OUTLOOK',
  'OSHAL_CRED_TWITTER',
  'OSHAL_CRED_SMARTTHINGS',
  'OSHAL_CRED_GCP',
  'OSHAL_CRED_WALMART',
  'OSHAL_CRED_UBER',
  'OSHAL_CRED_UBER_RIDES',
  'OSHAL_CRED_SPOTIFY',
  'OSHAL_CRED_TMDB',
  'OSHAL_CRED_DUFFEL',
]);

const CANONICAL_WORKSPACE_SEGMENT = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const WINDOWS_DEVICE_SEGMENT = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MAX_WORKSPACE_SOURCE_BYTES = 2_048;
const APP_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_TRUSTED_PATTERN_BYTES = 65_536;
const DISALLOWED_PROMPT_CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;

/** Trusted configuration fields a controller may carry across the bot-node HTTP boundary. */
export interface BotNodePromptCarrier {
  app?: string;
  capability?: SkillCapabilityId;
  pattern?: string;
}

/**
 * @description Preserves an optional bot-node caller subject exactly. Nullish absence is allowed
 * for internal system work; any supplied invalid value throws so it cannot become ownerless work.
 * @param value - Candidate user subject from an authenticated envelope or request.
 * @returns The exact subject or undefined for genuine absence.
 */
export function normalizeBotNodeUserSub(value: unknown): string | undefined {
  return optionalExactUserSubject(value, 'bot-node userSub');
}

/**
 * @description Converts a logical controller task/workspace identifier into one cross-platform
 * path segment. Existing lowercase server IDs stay readable; unsafe, mixed-case, Unicode, drive,
 * UNC, traversal, or multi-segment inputs become deterministic SHA-256 scope IDs. Controls,
 * malformed UTF-16, empty strings, and unreasonable sizes are rejected rather than encoded.
 * @param value - Logical task/workspace identifier; never used as a path directly.
 * @returns A Windows/POSIX-safe canonical workspace segment.
 */
export function canonicalBotWorkspaceId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || /[\u0000-\u001F\u007F-\u009F]/.test(value)) {
    throw new TypeError('bot workspace id is invalid');
  }
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length > MAX_WORKSPACE_SOURCE_BYTES || bytes.toString('utf8') !== value) {
    throw new TypeError('bot workspace id is invalid');
  }
  if (CANONICAL_WORKSPACE_SEGMENT.test(value) && !WINDOWS_DEVICE_SEGMENT.test(value)) return value;
  const digest = crypto.createHash('sha256')
    .update('oshal-bot-workspace-v1\0', 'utf8')
    .update(bytes)
    .digest('hex');
  return `scope-${digest}`;
}

/**
 * @description Validates the server-authored prompt carrier before it is promoted from an HTTP
 * body into trusted execution-envelope configuration. Supplied invalid fields fail closed instead
 * of being silently dropped: a missing carrier is backward compatible, while a malformed carrier
 * is evidence that the authenticated controller and bot disagree on the wire contract. Pattern
 * text is preserved exactly (the execution handler owns whitespace composition), but bounded by
 * UTF-8 bytes and forbidden from carrying non-text control characters.
 * @param value - Parsed `/api/swarm-execute` request body.
 * @returns A new, schema-bounded carrier safe to spread into `envelope.payload`.
 */
export function parseBotNodePromptCarrier(value: unknown): BotNodePromptCarrier {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const body = value as Record<string, unknown>;
  const carrier: BotNodePromptCarrier = {};

  if (Object.prototype.hasOwnProperty.call(body, 'app')) {
    if (typeof body.app !== 'string' || !APP_NAME.test(body.app)) {
      throw new TypeError('bot prompt carrier app is invalid');
    }
    carrier.app = body.app;
  }

  if (Object.prototype.hasOwnProperty.call(body, 'capability')) {
    if (!isSkillCapabilityId(body.capability)) {
      throw new TypeError('bot prompt carrier capability is invalid');
    }
    carrier.capability = body.capability;
  }

  if (Object.prototype.hasOwnProperty.call(body, 'pattern')) {
    if (typeof body.pattern !== 'string' || !body.pattern.trim()) {
      throw new TypeError('bot prompt carrier pattern is invalid');
    }
    const patternBytes = Buffer.from(body.pattern, 'utf8');
    if (
      patternBytes.length > MAX_TRUSTED_PATTERN_BYTES
      || patternBytes.toString('utf8') !== body.pattern
      || DISALLOWED_PROMPT_CONTROLS.test(body.pattern)
    ) {
      throw new TypeError('bot prompt carrier pattern is invalid');
    }
    carrier.pattern = body.pattern;
  }

  return carrier;
}

/**
 * @description Accepts only credential keys both bot runtimes can materialize and wipe.
 * @param value - Candidate credential map.
 * @returns A new allowlisted, size-bounded credential map.
 */
export function sanitizeBotNodeCreds(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key, token]) => (
    SUPPORTED_BROKERED_CRED_KEYS.has(key)
      && typeof token === 'string'
      && token.length > 0
      && token.length <= 32_768
  ))) as Record<string, string>;
}
