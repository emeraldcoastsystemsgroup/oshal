/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the ATS verification-code
 *   extractor. Greenhouse's human-check emails an 8-char ALPHANUMERIC code ("MOdQxvYC"); the old
 *   \d{4,8} extractor matched the "© 2026" YEAR instead, so every code entry failed and Greenhouse
 *   applications always deferred. This pins: alphanumeric labelled codes win, mixed-case codes are
 *   distinguished from Title-case words, pure-numeric OTPs still work, and a year is never returned.
 */
import { describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { extractCode } = require('../../scripts/oshal-apply.js') as { extractCode: (hay: string) => string | null };

describe('ATS email verification-code extraction', () => {
  it('extracts a Greenhouse alphanumeric code, not the © year', () => {
    const hay = 'Security code for your application to Life360 Hi the operator, Copy and paste this code into the '
      + 'security code field on your application: MOdQxvYC After you enter the code, resubmit your '
      + 'application. © 2026 Greenhouse';
    expect(extractCode(hay)).toBe('MOdQxvYC');
  });

  it('extracts a 6-digit numeric OTP', () => {
    expect(extractCode('Your verification code is 483920. It expires in 10 minutes.')).toBe('483920');
  });

  it('extracts a labelled short passcode', () => {
    expect(extractCode('Your one-time passcode: 5567')).toBe('5567');
  });

  it('extracts an alphanumeric code that contains a digit', () => {
    expect(extractCode('Enter this code: A1B2C7 to continue')).toBe('A1B2C7');
  });

  it('returns null when the email matches keywords but has no real code (never a year)', () => {
    expect(extractCode('Thanks for applying in 2026. No code here, just a confirmation.')).toBeNull();
  });

  it('does not mistake a Title-case word for a code', () => {
    expect(extractCode('Security notice: your application was received. Regards, Recruiting')).toBeNull();
  });
});
