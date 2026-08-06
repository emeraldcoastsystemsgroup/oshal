/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                     | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Guard the controller seal that makes Apply ticket
 *   authorization server-derived: exact ticket/owner/posting/source verify; copies, edits, missing
 *   seals, truthy strings, and missing controller key all deny or fail before durable mutation.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applySubmitAuthorizationFromMetadata,
  applySubmitAuthorizationMetadata,
  AUTHENTICATED_SINGLE_JOB_SUBMIT,
  CAREER_AUTO_SUBMIT_SETTING,
  isApplyFinalSubmitAuthorized,
  requireApplySubmitAuthorizationSealing,
} from '@/app/apply-submit-authorization';

const priorSecret = process.env.SESSION_SECRET;
const priorAuthSecret = process.env.AUTH_SESSION_SECRET;
const binding = { ticketId: 'ticket-exact', userSub: ' Tenant|Exact Subject ', postingId: 42 };

beforeEach(() => { process.env.SESSION_SECRET = 'apply-authorization-unit-secret-placeholder'; });
afterEach(() => {
  if (priorSecret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = priorSecret;
  if (priorAuthSecret === undefined) delete process.env.AUTH_SESSION_SECRET;
  else process.env.AUTH_SESSION_SECRET = priorAuthSecret;
});

describe('durable Apply final-submit authorization seal', () => {
  it('round-trips a strict controller decision only under its exact binding', () => {
    const metadata = applySubmitAuthorizationMetadata(CAREER_AUTO_SUBMIT_SETTING, binding);
    expect(applySubmitAuthorizationFromMetadata(metadata, binding)).toBe(CAREER_AUTO_SUBMIT_SETTING);
    expect(applySubmitAuthorizationFromMetadata(metadata, { ...binding, ticketId: 'ticket-copy' }))
      .toMatchObject({ finalSubmitAuthorized: false });
    expect(applySubmitAuthorizationFromMetadata(metadata, { ...binding, userSub: `${binding.userSub}x` }))
      .toMatchObject({ finalSubmitAuthorized: false });
    expect(applySubmitAuthorizationFromMetadata(metadata, { ...binding, postingId: 43 }))
      .toMatchObject({ finalSubmitAuthorized: false });
  });

  it('rejects unsealed, malformed, or source-edited metadata', () => {
    expect(isApplyFinalSubmitAuthorized({ finalSubmitAuthorized: true })).toBe(false);
    expect(isApplyFinalSubmitAuthorized({
      finalSubmitAuthorized: true, source: 'model-text',
    })).toBe(false);
    expect(applySubmitAuthorizationFromMetadata({
      applyFinalSubmitAuthorized: true,
      applyFinalSubmitAuthorizationSource: 'authenticated-single-job',
    }, binding)).toMatchObject({ finalSubmitAuthorized: false });
    const metadata = applySubmitAuthorizationMetadata(AUTHENTICATED_SINGLE_JOB_SUBMIT, binding);
    expect(applySubmitAuthorizationFromMetadata({
      ...metadata, applyFinalSubmitAuthorizationSource: 'career-auto-submit-setting',
    }, binding)).toMatchObject({ finalSubmitAuthorized: false });
    expect(applySubmitAuthorizationFromMetadata({
      ...metadata, applyFinalSubmitAuthorized: 'true',
    }, binding)).toMatchObject({ finalSubmitAuthorized: false });
  });

  it('fails closed when the controller signing key is unavailable', () => {
    delete process.env.SESSION_SECRET;
    delete process.env.AUTH_SESSION_SECRET;
    expect(requireApplySubmitAuthorizationSealing).toThrow(/session secret/i);
    expect(() => applySubmitAuthorizationMetadata(CAREER_AUTO_SUBMIT_SETTING, binding))
      .toThrow(/session secret/i);
    expect(applySubmitAuthorizationFromMetadata({
      applyFinalSubmitAuthorized: true,
      applyFinalSubmitAuthorizationSource: 'career-auto-submit-setting',
      applyFinalSubmitAuthorizationSeal: 'A'.repeat(43),
    }, binding)).toMatchObject({ finalSubmitAuthorized: false });
  });
});
