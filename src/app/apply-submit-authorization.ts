/**
 * Server-derived final-submit authorization carried by Apply tickets and dispatches. Only the two
 * named controller decisions below can authorize the final click: an authenticated single-job user
 * action, or an exact-user Career setting read. Ticket metadata is parsed strictly so strings, stale
 * flags, model text, and unrecognized sources fail closed.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                     | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Initial immutable decision values and strict ticket
 *   metadata projection for per-ticket/per-dispatch authorization.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Bind authorized metadata to exact ticket, owner,
 *   posting, and source with a controller-only HMAC. Generic ticket metadata create/PATCH, copied
 *   fields, service-secret holders, and model text cannot mint a valid server decision.
 *
 * @module app/apply-submit-authorization
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export type ApplySubmitAuthorizationSource =
  | 'authenticated-single-job'
  | 'career-auto-submit-setting';

export type ApplySubmitAuthorization =
  | Readonly<{ finalSubmitAuthorized: false; source?: never }>
  | Readonly<{ finalSubmitAuthorized: true; source: ApplySubmitAuthorizationSource }>;

export interface ApplySubmitAuthorizationBinding {
  ticketId: string;
  userSub: string;
  postingId: number;
}

export const FINAL_SUBMIT_DENIED: Readonly<ApplySubmitAuthorization> = Object.freeze({
  finalSubmitAuthorized: false,
});

export const AUTHENTICATED_SINGLE_JOB_SUBMIT: Readonly<ApplySubmitAuthorization> = Object.freeze({
  finalSubmitAuthorized: true,
  source: 'authenticated-single-job',
});

export const CAREER_AUTO_SUBMIT_SETTING: Readonly<ApplySubmitAuthorization> = Object.freeze({
  finalSubmitAuthorized: true,
  source: 'career-auto-submit-setting',
});

/** @description Accept only a strict positive decision carrying one named controller source. */
export function isApplyFinalSubmitAuthorized(value: unknown): value is Extract<
  ApplySubmitAuthorization,
  { finalSubmitAuthorized: true }
> {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return row.finalSubmitAuthorized === true &&
    (row.source === 'authenticated-single-job' || row.source === 'career-auto-submit-setting');
}

/** Stable failure when durable authorization cannot be sealed by this controller. */
export class ApplySubmitAuthorizationConfigurationError extends Error {
  constructor() {
    super('controller session secret is required to seal Apply final-submit authorization');
    this.name = 'ApplySubmitAuthorizationConfigurationError';
  }
}

/** @description Resolve a controller-only key; fleet service secrets are deliberately excluded. */
function signingSecret(): string {
  const secret = process.env.SESSION_SECRET || process.env.AUTH_SESSION_SECRET || '';
  if (!secret) throw new ApplySubmitAuthorizationConfigurationError();
  return secret;
}

/** @description Fail before any durable mutation when authorized ticket sealing is unavailable. */
export function requireApplySubmitAuthorizationSealing(): void {
  void signingSecret();
}

/** @description Canonical domain-separated bytes for one exact durable authorization binding. */
function sealPayload(binding: ApplySubmitAuthorizationBinding, source: ApplySubmitAuthorizationSource): string {
  if (!binding.ticketId || !binding.userSub || !Number.isSafeInteger(binding.postingId) || binding.postingId <= 0) {
    throw new TypeError('invalid Apply authorization binding');
  }
  return JSON.stringify(['oshal.apply.final-submit.v1', binding.ticketId, binding.userSub, binding.postingId, source]);
}

/** @description HMAC one binding without exposing the controller key to the ticket or worker. */
function authorizationSeal(binding: ApplySubmitAuthorizationBinding, source: ApplySubmitAuthorizationSource): string {
  return createHmac('sha256', signingSecret()).update(sealPayload(binding, source)).digest('base64url');
}

/** @description Constant-time equality for a presented base64url seal. */
function validSeal(presented: unknown, expected: string): boolean {
  if (typeof presented !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(presented)) return false;
  const left = Buffer.from(presented, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/** @description Seal a server decision into ticket metadata; denied state needs no secret. */
export function applySubmitAuthorizationMetadata(
  authorization: ApplySubmitAuthorization,
  binding?: ApplySubmitAuthorizationBinding,
): Record<string, unknown> {
  if (!isApplyFinalSubmitAuthorized(authorization)) return { applyFinalSubmitAuthorized: false };
  if (!binding) throw new TypeError('Apply authorization binding required');
  return {
    applyFinalSubmitAuthorized: true,
    applyFinalSubmitAuthorizationSource: authorization.source,
    applyFinalSubmitAuthorizationSeal: authorizationSeal(binding, authorization.source),
  };
}

/** @description Verify only controller-sealed exact ticket fields; all legacy/near-miss state denies. */
export function applySubmitAuthorizationFromMetadata(
  metadata: unknown,
  binding?: ApplySubmitAuthorizationBinding,
): Readonly<ApplySubmitAuthorization> {
  if (!metadata || typeof metadata !== 'object') return FINAL_SUBMIT_DENIED;
  const row = metadata as Record<string, unknown>;
  if (row.applyFinalSubmitAuthorized !== true || !binding) return FINAL_SUBMIT_DENIED;
  const source = row.applyFinalSubmitAuthorizationSource;
  if (source !== 'authenticated-single-job' && source !== 'career-auto-submit-setting') return FINAL_SUBMIT_DENIED;
  try {
    if (!validSeal(row.applyFinalSubmitAuthorizationSeal, authorizationSeal(binding, source))) return FINAL_SUBMIT_DENIED;
    return source === 'authenticated-single-job' ? AUTHENTICATED_SINGLE_JOB_SUBMIT : CAREER_AUTO_SUBMIT_SETTING;
  } catch {
    return FINAL_SUBMIT_DENIED;
  }
}
