/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the decision-timeout filing rule. The branch inferred that a turn which did not finish in 75s was a big build and filed a ticket titled with the user's own message; a timeout equally means the brain is unreachable, and on the operator box it did — with the codex lane answering "You've hit your usage limit" every message timed out and every message was filed. The cases below are the REAL rows that ended up in the ticket queue, read from the operator's database on 2026-09-19, rather than invented examples: "Hi" filed three separate times and escalated, "what is 9 times 9" and "what screen am i on" opened as build tickets. The counter-examples are the rows from the same query that SHOULD have been filed, so the fix cannot be "never file anything".
 */

import { describe, it, expect } from 'vitest';
import { looksLikeWorkRequest } from '@/app/routes/jarvis-orchestrator';

/**
 * Every message that actually became an auto-filed ticket on the operator's box while the codex
 * lane was out of credits. None of these is a build.
 */
const FILED_BUT_SHOULD_NOT_HAVE_BEEN = [
  'Hi',
  'hi',
  'hello',
  'Hey there',
  'thanks',
  'ok',
  'what is 9 times 9',
  'what screen am i on',
  'How did we do in the stock market today?',
  'How much money did we make in the stock market today?',
  'yes but how much did we make or loose',
  'why is engineering fireing like all the time',
];

/**
 * From the same query: messages where filing on a timeout is the RIGHT answer. A fix that
 * suppressed these would trade a noisy queue for silently dropped work.
 */
const SHOULD_STILL_FILE = [
  'Can you add google drive to our files application. We just added the connector',
  'Build the AttritionAnalyzer with Shared Types and Unit Tests',
  'Build the ReportGenerator, CLI Entry Point, and Integration tests',
  'our intelligent trading was down all day today and we lost the window',
  'implement the fallback chain in the cockpit',
  'please fix the escalation mirror',
  'set up a nightly export for the audit log',
  'migrate the persona layers to the new store',
];

describe('a decision timeout files work, and reports an outage for everything else', () => {
  for (const message of FILED_BUT_SHOULD_NOT_HAVE_BEEN) {
    it(`does not file: ${JSON.stringify(message)}`, () => {
      expect(
        looksLikeWorkRequest(message),
        'a greeting or a question is conversation; a timeout on it is an outage, not a project',
      ).toBe(false);
    });
  }

  for (const message of SHOULD_STILL_FILE) {
    it(`still files: ${JSON.stringify(message.slice(0, 48))}`, () => {
      expect(
        looksLikeWorkRequest(message),
        'suppressing these would trade a noisy queue for dropped work',
      ).toBe(true);
    });
  }

  it('a work verb wins over question grammar', () => {
    // "can you add google drive..." is a real request wearing a question mark. Deciding on
    // grammar alone would have dropped it.
    expect(looksLikeWorkRequest('can you add a column to the report?')).toBe(true);
    expect(looksLikeWorkRequest('could you fix the login redirect?')).toBe(true);
    // ...while the same grammar without a work verb stays conversation.
    expect(looksLikeWorkRequest('can you tell me what time it is?')).toBe(false);
  });

  it('an empty or whitespace message is never filed', () => {
    for (const value of ['', '   ', '\n', '?']) {
      expect(looksLikeWorkRequest(value), `${JSON.stringify(value)} must not open a ticket`).toBe(false);
    }
  });

  it('a statement that names no verb is still filed, because a problem report is work', () => {
    // The fix must not become "only file when someone uses an imperative". An operator reporting
    // that something broke is the most valuable thing in the queue.
    expect(looksLikeWorkRequest('the trading dashboard has been blank since this morning')).toBe(true);
  });
});
