/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-100 Phases 2/3 guard: the person-model front door detects recall, open-asks, trend and connection shapes deterministically (recall wins, ordinary chat falls through) and phrases each answer from literal rows — asks and topics flagged as OSHAL's read beside the verbatim quote.
 */

import { describe, expect, it } from 'vitest';
import {
  detectPersonModelIntent, detectOpenAsksIntent, detectTrendIntent, detectConnectionIntent,
  buildOpenAsksSpokenAnswer, buildTrendSpokenAnswer, buildConnectionSpokenAnswer,
  type PersonAsk, type TopicTrendResult,
} from '@/features/person-model';

const ask = (over: Partial<PersonAsk> = {}): PersonAsk => ({
  askId: 'a1', kind: 'ask', text: 'a ride to practice Thursday', sourceQuote: 'can you drive me to practice on Thursday?',
  status: 'open', personLabel: 'Ella', createdAt: '2026-09-10T15:00:00.000Z', isInference: true, ...over,
});

describe('person-model intent front door (ADR-100)', () => {
  it('recall shapes still win and keep their Phase-1 fields', () => {
    const intent = detectPersonModelIntent('How many times has Ella mentioned volleyball today?');
    expect(intent).toMatchObject({ kind: 'recall', personName: 'Ella', terms: 'volleyball', range: 'today' });
    expect(detectPersonModelIntent('What did Ella say about the school trip?')).toMatchObject({ kind: 'recall', personName: 'Ella' });
  });

  it('detects open-asks shapes with the person and the kind', () => {
    expect(detectOpenAsksIntent('What has Ella asked me?')).toEqual({ kind: 'asks', personName: 'Ella', askKind: 'ask' });
    expect(detectOpenAsksIntent('what did Sam ask me for')).toEqual({ kind: 'asks', personName: 'Sam', askKind: 'ask' });
    expect(detectOpenAsksIntent('What did Sam promise?')).toEqual({ kind: 'asks', personName: 'Sam', askKind: 'commitment' });
    expect(detectOpenAsksIntent('Any open asks from Ella?')).toEqual({ kind: 'asks', personName: 'Ella', askKind: 'any' });
    expect(detectOpenAsksIntent('show me open asks')).toEqual({ kind: 'asks', personName: '', askKind: 'any' });
    expect(detectOpenAsksIntent('What do I owe Ella?')).toEqual({ kind: 'asks', personName: 'Ella', askKind: 'ask' });
    expect(detectPersonModelIntent('What has Ella asked me?')).toMatchObject({ kind: 'asks' });
  });

  it('detects trend and connection shapes with their windows', () => {
    expect(detectTrendIntent('What has Ella been talking about lately?')).toEqual({ kind: 'trend', personName: 'Ella', weeks: 2 });
    expect(detectTrendIntent('what is Ella talking about this week')).toEqual({ kind: 'trend', personName: 'Ella', weeks: 1 });
    expect(detectTrendIntent('What does Sam talk about most this month?')).toEqual({ kind: 'trend', personName: 'Sam', weeks: 4 });
    expect(detectTrendIntent('what is everyone talking about')).toEqual({ kind: 'trend', personName: '', weeks: 2 });
    expect(detectConnectionIntent('What do Ella and Sam talk about?')).toEqual({ kind: 'connection', personA: 'Ella', personB: 'Sam' });
    expect(detectConnectionIntent('what connects Ella and Sam')).toEqual({ kind: 'connection', personA: 'Ella', personB: 'Sam' });
  });

  it('leaves ordinary chat to the model', () => {
    for (const msg of [
      'Build a weather app', 'what is the weather in Boston', 'what did you do today', 'what are people saying about the election on twitter',
      'what does the team want to do', 'remind me to call Sam', '',
    ]) {
      expect(detectPersonModelIntent(msg), msg).toBeNull();
    }
  });

  it('phrases open asks as OSHAL\'s read beside the verbatim quote', () => {
    const text = buildOpenAsksSpokenAnswer({ kind: 'asks', personName: 'Ella', askKind: 'ask' }, [ask(), ask({ askId: 'a2', kind: 'commitment', text: 'bring the cooler' })]);
    expect(text).toContain('Ella has 1 open item');
    expect(text).toContain('my read of what was said');
    expect(text).toContain('Ask: a ride to practice Thursday');
    expect(text).toContain('heard as "can you drive me to practice on Thursday?"');
    expect(text).not.toContain('bring the cooler');
    expect(buildOpenAsksSpokenAnswer({ kind: 'asks', personName: 'Ella', askKind: 'any' }, [ask(), ask({ askId: 'a2', kind: 'commitment', text: 'bring the cooler' })]))
      .toContain('Commitment: bring the cooler');
    expect(buildOpenAsksSpokenAnswer({ kind: 'asks', personName: 'Ella', askKind: 'ask' }, [])).toMatch(/Nothing open from Ella/);
    expect(buildOpenAsksSpokenAnswer({ kind: 'asks', personName: '', askKind: 'any' }, [])).toBe('Nothing open from anyone right now.');
  });

  it('phrases trends and connections from literal rows and refuses unresolved names', () => {
    const trend: TopicTrendResult = {
      personLabel: 'Ella', personResolved: true, weeks: 2,
      rows: [
        { weekStart: '2026-09-07', topic: 'volleyball', mentions: 5, personLabel: 'Ella' },
        { weekStart: '2026-09-07', topic: 'homework', mentions: 2, personLabel: 'Ella' },
        { weekStart: '2026-08-31', topic: 'volleyball', mentions: 3, personLabel: 'Ella' },
      ],
    };
    const text = buildTrendSpokenAnswer({ kind: 'trend', personName: 'Ella', weeks: 2 }, trend);
    expect(text).toContain('week of 2026-09-07: volleyball (5), homework (2)');
    expect(text).toContain('week of 2026-08-31: volleyball (3)');
    expect(buildTrendSpokenAnswer({ kind: 'trend', personName: 'Zed', weeks: 2 }, { personLabel: null, personResolved: false, weeks: 2, rows: [] }))
      .toContain('saved voice matching "Zed"');

    const conn = buildConnectionSpokenAnswer({ kind: 'connection', personA: 'Ella', personB: 'Sam' }, {
      labelA: 'Ella', labelB: 'Sam', resolved: true, topics: [{ topic: 'volleyball', daysA: 3, daysB: 1, lastObservedOn: '2026-09-10' }],
    });
    expect(conn).toContain('volleyball: Ella on 3 days, Sam on 1 day (last 2026-09-10)');
    expect(buildConnectionSpokenAnswer({ kind: 'connection', personA: 'Ella', personB: 'Zed' }, { labelA: 'Ella', labelB: null, resolved: false, topics: [] }))
      .toContain('"Zed"');
  });
});
