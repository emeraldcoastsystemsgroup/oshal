/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Unit tests for the Jarvis morning-brief composition: every availability guard produces an explained skip (never fabricated content), a throwing section degrades in isolation, populated sections carry real summaries, the HTML render escapes external headline text, and the delivery formatters keep the mandatory opt-in pointer.
 */
import { describe, it, expect } from 'vitest';
import {
  composeMorningBrief,
  type BriefDeps, type BriefSection, type MorningBrief,
} from '@/app/routes/jarvis-brief-sections';
import { renderBriefHtml, escapeHtml } from '@/app/routes/jarvis-brief-routes';
import { formatBriefEmail, formatBriefSms } from '@/app/routes/jarvis-brief-cron';

const SUB = 'user-123';

/** Fully-available mock deps — every section has data. Override per test. */
function fullDeps(overrides: Partial<BriefDeps> = {}): BriefDeps {
  return {
    isOperator: () => true,
    readDeckData: () => ({
      date: 'July 14, 2026', generatedAt: '2026-07-14T22:00:00.000Z', mode: 'paper',
      results: { pl: -592.28, pct: -0.58, equity: 101415.57, fills: 23, positions: 12, leaders: 'SCHW · AMD' },
      ytd: { retPct: 1.42, retUsd: 1415.57, last: 101415.57 },
    }),
    hasCareerStore: () => true,
    readCareerCursor: async () => '2026-07-14T13:00:00.000Z',
    findCareerHits: () => [
      { id: 1, title: 'Staff Platform Developer', company: 'Monster Beverage', fit: 89, location: 'Corona, CA', url: 'https://x/1', salaryMax: 165000 },
      { id: 2, title: 'Cloud Solution Architect', company: 'L3Harris', fit: 82, location: 'Remote', url: null, salaryMax: null },
    ],
    worldHeadlines: async () => [
      { entity: 'NVIDIA', title: 'Nvidia unveils <new> chip', outlet: 'Reuters', sentiment: 0.4, pubDate: '2026-07-15T09:00:00.000Z' },
      { entity: 'OPEC', title: 'Output steady', outlet: 'AP', sentiment: 0, pubDate: null },
    ],
    gmailToken: async () => 'tok',
    gmailUnread: async () => ({ messagesUnread: 7, threadsUnread: 5 }),
    emailDigestUpdatedAt: async () => '2026-07-15T11:00:00.000Z',
    ...overrides,
  };
}

function section(brief: MorningBrief, name: string): BriefSection {
  const s = brief.sections.find((x) => x.section === name);
  if (!s) throw new Error(`section ${name} missing`);
  return s;
}

describe('composeMorningBrief — all sections available', () => {
  it('returns four populated sections in stable order with real summaries', async () => {
    const brief = await composeMorningBrief(fullDeps(), SUB);
    expect(brief.sections.map((s) => s.section)).toEqual(['trading', 'career', 'world', 'comms']);
    expect(brief.sections.every((s) => !s.skipped)).toBe(true);
    expect(brief.userSub).toBe(SUB);
    expect(Date.parse(brief.generatedAt)).not.toBeNaN();

    const trading = section(brief, 'trading');
    expect(trading.skipped).toBe(false);
    if (!trading.skipped) {
      expect(trading.summary).toContain('-$592.28');
      expect(trading.summary).toContain('1.42%');
      expect(trading.data.leaders).toBe('SCHW · AMD');
    }
    const career = section(brief, 'career');
    if (!career.skipped) {
      expect(career.summary).toContain('2 new high-fit matches');
      expect(career.summary).toContain('89% Staff Platform Developer @ Monster Beverage');
    }
    const comms = section(brief, 'comms');
    if (!comms.skipped) expect(comms.summary).toContain('7 unread emails');
  });
});

describe('composeMorningBrief — availability guards', () => {
  it('trading skips FAIL-CLOSED for non-operators (never leaks the operator recap)', async () => {
    const brief = await composeMorningBrief(fullDeps({ isOperator: () => false }), SUB);
    const s = section(brief, 'trading');
    expect(s.skipped).toBe(true);
    if (s.skipped) expect(s.reason).toContain('operator');
  });

  it('trading skips when the recap pipeline has not produced deck-data.json', async () => {
    const brief = await composeMorningBrief(fullDeps({ readDeckData: () => null }), SUB);
    const s = section(brief, 'trading');
    expect(s.skipped).toBe(true);
    if (s.skipped) expect(s.reason).toContain('deck-data.json');
  });

  it('career skips when the user has no career-hunter store', async () => {
    const brief = await composeMorningBrief(fullDeps({ hasCareerStore: () => false }), SUB);
    const s = section(brief, 'career');
    expect(s.skipped).toBe(true);
    if (s.skipped) expect(s.reason.toLowerCase()).toContain('career-hunter');
  });

  it('career with a store but zero new hits is a POPULATED "nothing new" section, not a skip', async () => {
    const brief = await composeMorningBrief(fullDeps({ findCareerHits: () => [] }), SUB);
    const s = section(brief, 'career');
    expect(s.skipped).toBe(false);
    if (!s.skipped) expect(s.summary).toContain('No new high-fit matches');
  });

  it('world skips when world intelligence is disabled (null) vs. empty archive (both explained)', async () => {
    const off = await composeMorningBrief(fullDeps({ worldHeadlines: async () => null }), SUB);
    const sOff = section(off, 'world');
    expect(sOff.skipped).toBe(true);
    if (sOff.skipped) expect(sOff.reason).toContain('disabled');

    const empty = await composeMorningBrief(fullDeps({ worldHeadlines: async () => [] }), SUB);
    const sEmpty = section(empty, 'world');
    expect(sEmpty.skipped).toBe(true);
    if (sEmpty.skipped) expect(sEmpty.reason).toContain('no items');
  });

  it('comms skips without a Google connection, and on a failed unread read', async () => {
    const noConn = await composeMorningBrief(fullDeps({ gmailToken: async () => null }), SUB);
    const s1 = section(noConn, 'comms');
    expect(s1.skipped).toBe(true);
    if (s1.skipped) expect(s1.reason).toContain('Google');

    const badRead = await composeMorningBrief(fullDeps({ gmailUnread: async () => null }), SUB);
    const s2 = section(badRead, 'comms');
    expect(s2.skipped).toBe(true);
    if (s2.skipped) expect(s2.reason).toContain('unread');
  });

  it('a throwing section degrades to an explained skip WITHOUT poisoning its siblings', async () => {
    const brief = await composeMorningBrief(
      fullDeps({ worldHeadlines: async () => { throw new Error('tsdb down'); } }), SUB);
    const world = section(brief, 'world');
    expect(world.skipped).toBe(true);
    if (world.skipped) expect(world.reason).toContain('tsdb down');
    expect(section(brief, 'trading').skipped).toBe(false);
    expect(section(brief, 'career').skipped).toBe(false);
    expect(section(brief, 'comms').skipped).toBe(false);
  });
});

describe('renderBriefHtml', () => {
  it('renders populated summaries, keeps skips visible with their reason, and escapes external text', async () => {
    const brief = await composeMorningBrief(fullDeps({ gmailToken: async () => null }), SUB);
    const html = renderBriefHtml(brief);
    expect(html).toContain('Your morning brief');
    expect(html).toContain('Trading recap');
    // Skipped comms stays visible with its reason (muted, not hidden).
    expect(html).toContain('connect Gmail');
    // Headline text with angle brackets is escaped, never raw.
    expect(html).toContain('Nvidia unveils &lt;new&gt; chip');
    expect(html).not.toContain('<new>');
  });

  it('escapeHtml covers the five dangerous characters', () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&</a>`)).toBe('&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  });
});

describe('delivery formatters (opt-in product rule)', () => {
  it('email lists populated sections, rolls skips into one footnote, and carries the opt-in pointer', async () => {
    const brief = await composeMorningBrief(fullDeps({ gmailToken: async () => null }), SUB);
    const { subject, body } = formatBriefEmail(brief);
    expect(subject).toContain('morning brief');
    expect(body).toContain('## Trading recap');
    expect(body).toContain('Not included today: Email');
    expect(body.toLowerCase()).toContain('turn it off');
  });

  it('sms stays SMS-sized and names the manage surface', async () => {
    const brief = await composeMorningBrief(fullDeps(), SUB);
    const sms = formatBriefSms(brief);
    expect(sms.length).toBeLessThan(500);
    expect(sms).toContain('OSHAL brief:');
    expect(sms.toLowerCase()).toContain('notification prefs');
  });
});
