/**
 * Governance per-resource audit-emitter tests (additive).
 *
 * Proves the safety contract of emitAuditEvent: it NEVER throws into the request path.
 *  - A pool whose query() rejects (DB down) -> emit returns false, no throw.
 *  - Invalid event shapes (missing/empty action or resourceType, null event) -> returns false,
 *    never throws, never inserts.
 *  - A valid event against a fake pool -> returns true and issues an INSERT with the right params.
 *  - queryAuditEvents builds a parameterized WHERE from the filter.
 *
 * Uses an in-memory fake Pool (only .query is exercised) so the tests are DB-free and unit-fast.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — unit tests for the opt-in audit emitter.
 */
import { test, expect } from '@playwright/test';
import type { Pool } from 'pg';
import { emitAuditEvent, queryAuditEvents, type AuditEvent } from '@/features/governance/audit/audit-emit';

interface Call { sql: string; params: unknown[]; }

/** Minimal Pool stub: records queries, returns empty rows. DDL (CREATE/INDEX) is a no-op success. */
function fakePool(): { pool: Pool; calls: Call[] } {
  const calls: Call[] = [];
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params: params ?? [] });
      return { rows: [] as unknown[], rowCount: 0 };
    },
  } as unknown as Pool;
  return { pool, calls };
}

/** Pool whose query always rejects (simulates DB outage). */
function failingPool(): Pool {
  return { query: async () => { throw new Error('db down'); } } as unknown as Pool;
}

const VALID: AuditEvent = {
  actorSub: 'user-1',
  action: 'ticket.read',
  resourceType: 'ticket',
  resourceId: 't-123',
  decision: 'allow',
  metadata: { route: '/api/tickets/t-123' },
};

test('emitAuditEvent returns false and never throws when the DB is down', async () => {
  const ok = await emitAuditEvent(failingPool(), VALID);
  expect(ok).toBe(false);
});

test('emitAuditEvent never throws on bad input and does not insert', async () => {
  const bad: unknown[] = [
    null,
    undefined,
    {},
    { action: '', resourceType: 'ticket' },
    { action: 'x', resourceType: '' },
    { action: 'ticket.read' }, // missing resourceType
    { resourceType: 'ticket' }, // missing action
    { action: 123, resourceType: 'ticket' }, // wrong type
  ];
  for (const ev of bad) {
    const { pool, calls } = fakePool();
    let result: boolean | undefined;
    let threw = false;
    try { result = await emitAuditEvent(pool, ev as AuditEvent); } catch { threw = true; }
    expect(threw).toBe(false);
    expect(result).toBe(false);
    const inserts = calls.filter((c) => /INSERT INTO access_audit_log/i.test(c.sql));
    expect(inserts.length).toBe(0);
  }
});

test('emitAuditEvent writes a parameterized INSERT for a valid event', async () => {
  const { pool, calls } = fakePool();
  const ok = await emitAuditEvent(pool, VALID);
  expect(ok).toBe(true);

  const insert = calls.find((c) => /INSERT INTO access_audit_log/i.test(c.sql));
  expect(insert).toBeTruthy();
  // actor_sub, action, resource_type, resource_id, decision, metadata(json)
  expect(insert!.params[0]).toBe('user-1');
  expect(insert!.params[1]).toBe('ticket.read');
  expect(insert!.params[2]).toBe('ticket');
  expect(insert!.params[3]).toBe('t-123');
  expect(insert!.params[4]).toBe('allow');
  expect(String(insert!.params[5])).toContain('/api/tickets/t-123');
});

test('emitAuditEvent self-heals the schema (CREATE TABLE IF NOT EXISTS) before inserting', async () => {
  const { pool, calls } = fakePool();
  await emitAuditEvent(pool, VALID);
  expect(calls.some((c) => /CREATE TABLE IF NOT EXISTS access_audit_log/i.test(c.sql))).toBe(true);
});

test('emitAuditEvent defaults decision to "info" and accepts null actor/metadata', async () => {
  const { pool, calls } = fakePool();
  const ok = await emitAuditEvent(pool, { actorSub: null, action: 'collection.list', resourceType: 'ticket' });
  expect(ok).toBe(true);
  const insert = calls.find((c) => /INSERT INTO access_audit_log/i.test(c.sql))!;
  expect(insert.params[0]).toBe(null);   // actor_sub
  expect(insert.params[3]).toBe(null);   // resource_id
  expect(insert.params[4]).toBe('info'); // decision default
  expect(insert.params[5]).toBe(null);   // metadata
});

test('queryAuditEvents builds a parameterized WHERE from the filter', async () => {
  const { pool, calls } = fakePool();
  await queryAuditEvents(pool, { actorSub: 'user-1', action: 'ticket.read', limit: 50 });
  const select = calls.find((c) => /SELECT[\s\S]*FROM access_audit_log/i.test(c.sql))!;
  expect(select.sql).toContain('WHERE');
  expect(select.sql).toContain('actor_sub = $1');
  expect(select.sql).toContain('action = $2');
  expect(select.params).toEqual(['user-1', 'ticket.read']);
});

test('queryAuditEvents with no filter selects without a WHERE clause', async () => {
  const { pool, calls } = fakePool();
  await queryAuditEvents(pool, {});
  const select = calls.find((c) => /SELECT[\s\S]*FROM access_audit_log/i.test(c.sql))!;
  expect(select.sql).not.toContain('WHERE');
  expect(select.params).toEqual([]);
});
