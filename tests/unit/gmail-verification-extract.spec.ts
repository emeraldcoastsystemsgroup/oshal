/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Regression lock for the ATS verification extractor (scripts/oshal-gmail.js `verify`). Two behaviors are load-bearing and easy to regress: (1) an activation LINK must be recovered from the message BODY — Workday/account-activation mail sends a link, not a code, and the digest path only ever saw headers+snippet, which is why those ATS families were unautomatable; (2) a bare number must NOT win over a labeled code — ATS mail is full of requisition ids, years, and salaries, so the naive first-\d{4,8} grab returned junk.
 */

import { describe, expect, it } from 'vitest';

const { extractVerification, collectBodyText } = require('../../scripts/oshal-gmail.js');

/** base64url-encode, the wire shape Gmail returns body parts in. */
const b64url = (s: string): string => Buffer.from(s, 'utf8').toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_');

describe('extractVerification', () => {
  it('recovers a Workday-style activation LINK from the body (no code present)', () => {
    const got = extractVerification(
      'Welcome! Please activate your candidate account. Click here: '
      + 'https://acme.wd5.myworkdayjobs.com/activate?token=abc123XYZ Thanks.',
    );
    expect(got.link).toContain('/activate?token=abc123XYZ');
    expect(got.code).toBeNull();
  });

  it('extracts a labeled security code', () => {
    expect(extractVerification('Your verification code is 483920. It expires in 10 minutes.').code)
      .toBe('483920');
  });

  it('prefers a labeled code over a requisition id / year / salary decoy', () => {
    // The whole point: a bare-number grab would return 402931 (the req id) here.
    expect(extractVerification('Req 402931 posted 2024. Compensation up to 195000. Your security code: 7391').code)
      .toBe('7391');
  });

  it('falls back to a bare 6-digit code only when nothing is labeled', () => {
    expect(extractVerification('Use 918273 to continue signing in.').code).toBe('918273');
  });

  it('returns nulls rather than guessing when there is no token at all', () => {
    expect(extractVerification('Thanks for applying. We will be in touch about next steps.'))
      .toEqual({ code: null, link: null });
  });

  it('ignores a plain marketing URL that is not a verification link', () => {
    expect(extractVerification('See our careers page: https://acme.com/careers for more roles.').link)
      .toBeNull();
  });
});

describe('collectBodyText', () => {
  it('walks nested MIME parts so a link past the snippet is still seen', () => {
    // The digest path uses format=metadata and would never see this; `verify` must.
    const payload = {
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/plain', body: { data: b64url('Ignore this preamble.') } },
        {
          mimeType: 'multipart/related',
          parts: [{ mimeType: 'text/html', body: { data: b64url('<a href="https://x.wd5.myworkdayjobs.com/confirm/9f2b1">Confirm</a>') } }],
        },
      ],
    };
    const text = collectBodyText(payload);
    expect(text).toContain('Ignore this preamble.');
    expect(extractVerification(text).link).toContain('/confirm/9f2b1');
  });

  it('is empty (not throwing) for a payload with no text parts', () => {
    expect(collectBodyText({ mimeType: 'image/png', body: { attachmentId: 'x' } })).toBe('');
  });
});
