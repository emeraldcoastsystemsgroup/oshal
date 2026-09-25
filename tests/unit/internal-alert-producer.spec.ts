/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Internal producer validation and immutable input guards; no database, transport or provider fixture is mistaken for live acceptance.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { EnvelopeStore, type InternalEventInput } from '@/features/alert-pipeline';
import { validateInternalEvent } from '@/features/alert-pipeline/services/internal-event-validation';

function input(): InternalEventInput {
  return { source: 'schema-drift', producerKey: 'test-occurrence', event: {
    fingerprint: 'shape-change', alertname: 'SchemaDrift', target: 'scratch', targetKind: null,
    severity: 'warning', severityNum: 3, status: 'firing', startedAt: new Date('2026-09-01'), endedAt: null,
    generatorUrl: '/data-model/', labels: { database: 'scratch' }, annotations: { summary: 'Policy dropped' },
    summary: 'Policy dropped', namespace: null, container: null, instance: null, job: null,
  } };
}

describe('normalized internal alert validation', () => {
  it('detaches maps and dates from producer-owned mutable input', () => {
    const original = input();
    const copied = validateInternalEvent(original);
    original.event.labels.database = 'changed';
    original.event.startedAt!.setFullYear(2030);
    expect(copied.event.labels.database).toBe('scratch');
    expect(copied.event.startedAt!.getUTCFullYear()).toBe(2026);
  });

  it.each([
    ['webhook source', (value: InternalEventInput) => { value.source = 'alertmanager'; }],
    ['metrics source', (value: InternalEventInput) => { value.source = 'prometheus'; }],
    ['unknown sentinel', (value: InternalEventInput) => { value.source = '__unknown__'; }],
    ['blank occurrence', (value: InternalEventInput) => { value.producerKey = ' '; }],
    ['blank identity', (value: InternalEventInput) => { value.event.target = ''; }],
    ['severity mismatch', (value: InternalEventInput) => { value.event.severityNum = 1; }],
    ['invalid date', (value: InternalEventInput) => { value.event.startedAt = new Date('invalid'); }],
    ['oversized summary', (value: InternalEventInput) => { value.event.summary = 'x'.repeat(501); }],
    ['oversized annotation', (value: InternalEventInput) => { value.event.annotations.description = 'x'.repeat(65_537); }],
    ['invalid map', (value: InternalEventInput) => { value.event.labels = [] as unknown as Record<string, string>; }],
    ['non-record map', (value: InternalEventInput) => { value.event.labels = new Date() as unknown as Record<string, string>; }],
    ['boxed severity', (value: InternalEventInput) => { value.event.severity = new String('warning') as unknown as string; }],
    ['non-string annotation', (value: InternalEventInput) => { value.event.annotations = { invalid: 1 } as unknown as Record<string, string>; }],
    ['NUL key', (value: InternalEventInput) => { value.producerKey = 'bad\0key'; }],
    ['excess byte size', (value: InternalEventInput) => { value.event.annotations = Object.fromEntries(Array.from({ length: 8 }, (_, n) => [`key${n}`, 'é'.repeat(32_768)])); }],
  ])('rejects %s before connecting', async (_name, change) => {
    const connect = vi.fn();
    const store = new EnvelopeStore({ connect } as unknown as Pool);
    const value = input();
    change(value);
    await expect(store.landInternalEvent(value)).rejects.toMatchObject({ code: 'ALERT_PRODUCER_INVALID' });
    expect(connect).not.toHaveBeenCalled();
  });
});
