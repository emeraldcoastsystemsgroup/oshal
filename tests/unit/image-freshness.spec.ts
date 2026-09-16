/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard-per-fix for the stale-image install. The regression being held is a real one with real numbers: on 2026-09-16 the documented default install pulled an image built 2026-07-26 and the operator on that box reported MISSING FEATURES (no App Loader, apps that would not install) rather than an old image. The reproduction case below uses those exact dates. Also pins the two properties the rule depends on and that a later "tidy-up" would plausibly break: lag is measured against the head commit date rather than wall-clock, and an unreachable API fails OPEN.
 */

import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';

const require_ = createRequire(import.meta.url);
const { classifyImageFreshness } = require_(path.join(process.cwd(), 'scripts', 'image-freshness.js'));

/** The image the remote box actually installed, and the repository state it lagged. */
const INCIDENT = {
  imageCreated: '2026-07-26T04:27:03.806Z',
  imageCommit: 'f7204c4f82c3515da03f7523ddb2733812335850',
  headCommit: '5b2e5e40aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  headCommitDate: '2026-09-16T15:12:15Z',
};

describe('image freshness: the 2026-09-16 stale-install regression', () => {
  it('refuses the exact image that shipped a 52-day-old swarm as if it were current', () => {
    const r = classifyImageFreshness(INCIDENT);
    expect(r.verdict).toBe('refuse');
    expect(r.behindDays).toBe(52);
    expect(r.message).toContain('52 days behind');
    // The message must name both exits, or the operator re-runs the same command and gets the
    // same image — which is exactly what happened before this guard existed.
    expect(r.message).toContain('--mode 2');
    expect(r.message).toContain('Run workflow');
    expect(r.message).toContain('--allow-stale-image');
  });

  it('says the features are ABSENT, not broken — the misdiagnosis this exists to prevent', () => {
    expect(classifyImageFreshness(INCIDENT).message).toContain('ABSENT');
  });
});

describe('image freshness: what the verdict is measured against', () => {
  it('measures lag against the head COMMIT date, not wall-clock age', () => {
    // A repository that has not changed in a year must not scold anyone for running a
    // year-old image OF IT. Wall-clock age would call this stale; it is not.
    const r = classifyImageFreshness({
      imageCreated: '2025-09-16T00:00:00Z',
      headCommitDate: '2025-09-17T00:00:00Z',
      imageCommit: 'aaaa', headCommit: 'bbbb',
    });
    expect(r.verdict).toBe('current');
    expect(r.behindDays).toBe(1);
  });

  it('short-circuits to current on an exact commit match regardless of dates', () => {
    const r = classifyImageFreshness({
      imageCreated: '2020-01-01T00:00:00Z',
      headCommitDate: '2026-09-16T00:00:00Z',
      imageCommit: 'deadbeef', headCommit: 'deadbeef',
    });
    expect(r.verdict).toBe('current');
    expect(r.behindDays).toBe(0);
  });

  it('clamps a locally-built image that is AHEAD of the published head to zero', () => {
    const r = classifyImageFreshness({
      imageCreated: '2026-09-16T12:00:00Z',
      headCommitDate: '2026-09-16T00:00:00Z',
      imageCommit: 'aaaa', headCommit: 'bbbb',
    });
    expect(r.verdict).toBe('current');
    expect(r.behindDays).toBe(0);
  });
});

describe('image freshness: fails open on inability to check, closed on measured lag', () => {
  it.each([
    ['no head date (API unreachable, offline, rate-limited)', { imageCreated: '2026-07-26T00:00:00Z', headCommitDate: '' }],
    ['no image build date', { imageCreated: '', headCommitDate: '2026-09-16T00:00:00Z' }],
    ['garbage timestamps', { imageCreated: 'not-a-date', headCommitDate: 'also-not' }],
    ['nothing at all', {}],
  ])('reports unknown and never blocks: %s', (_label, input) => {
    const r = classifyImageFreshness(input as Record<string, unknown>);
    expect(r.verdict).toBe('unknown');
    expect(r.behindDays).toBeNull();
  });

  it('warns but does not refuse inside the warn band', () => {
    const r = classifyImageFreshness({
      imageCreated: '2026-09-01T00:00:00Z', headCommitDate: '2026-09-16T00:00:00Z',
      imageCommit: 'aaaa', headCommit: 'bbbb',
    });
    expect(r.verdict).toBe('warn');
    expect(r.behindDays).toBe(15);
    expect(r.message).toContain('WARNING');
    // A warning must not offer the override — there is nothing to override.
    expect(r.message).not.toContain('--allow-stale-image');
  });

  it('honours caller thresholds, so a deployment can be stricter than the default', () => {
    const tight = classifyImageFreshness({
      imageCreated: '2026-09-14T00:00:00Z', headCommitDate: '2026-09-16T00:00:00Z',
      imageCommit: 'aaaa', headCommit: 'bbbb', warnDays: 0, refuseDays: 1,
    });
    expect(tight.verdict).toBe('refuse');
    expect(tight.behindDays).toBe(2);
  });
});
