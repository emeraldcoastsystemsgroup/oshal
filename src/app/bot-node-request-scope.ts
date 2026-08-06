/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Preserve exact bot-node owner subjects and reject invalid supplied assertions instead of trimming, truncating, or collapsing them into ownerless execution.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05 closure: remove Twilio from bot-node credential materialization; SMS credentials are confined to fixed controller operations.
 */

import crypto from 'crypto';
import { optionalExactUserSubject } from '@/shared/security/exact-user-subject';

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
