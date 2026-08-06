/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Add source-level database-contract guards for fixed claims, immutable events, 30-day tombstones, pending-only replay, retention safety, RLS, and the deliberate absence of an in-memory authority.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Guard durable owner bindings, owner-aware claim predicates, shared client locks, and atomic outbox cost receipts.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = read('scripts/migrations/115-durable-remote-task-journal.sql');
const runtimeSchema = read('src/shared/services/database/remote-task-journal-schema.ts');
const repository = read('src/features/remote-client/services/postgres-remote-task-journal-repository.ts');

function read(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8');
}

describe('durable remote-task journal schema contract', () => {
  it('binds a task to one client and permits one active claim per client', () => {
    expect(migration).toMatch(/task_id TEXT PRIMARY KEY/);
    expect(migration).toMatch(/claimed_by_client_id = client_id/);
    expect(migration).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uq_remote_task_one_active_per_client[\s\S]*WHERE status = 'claimed'/);
    expect(repository).toMatch(/pg_advisory_xact_lock\(hashtextextended\('remote-task-client:'/);
    expect(repository).toMatch(/owner_sub IS NOT DISTINCT FROM \$2[\s\S]*status = 'queued'/);
    expect(repository).toMatch(/owner_sub IS NOT DISTINCT FROM \$3[\s\S]*status = 'queued'/);
  });

  it('persists owner binding and cost-effect dedupe receipts', () => {
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS remote_task_journal_client_owners/);
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS remote_task_cost_receipts/);
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS remote_task_cost_receipts \([\s\S]*outbox_id UUID PRIMARY KEY/);
    expect(runtimeSchema).toContain('remote_task_journal_client_owners');
    expect(runtimeSchema).toContain('remote_task_cost_receipts');
  });

  it('contains no lease, expiry, or automatic reassignment column in the task table', () => {
    const taskTable = migration.match(/CREATE TABLE IF NOT EXISTS remote_task_journal_tasks \([\s\S]*?\n\);/)?.[0] ?? '';
    expect(taskTable).not.toMatch(/lease|claim_expires|reassign/i);
    expect(taskTable).toMatch(/claimed_at TIMESTAMPTZ/);
  });

  it('retains first settlement as a 30-day terminal tombstone', () => {
    expect(repository).toMatch(/REMOTE_TASK_TOMBSTONE_DAYS/);
    expect(repository).toMatch(/WHERE task_id = \$1 AND claimed_by_client_id = \$2 AND status = 'claimed'/);
    expect(repository).toMatch(/current\.status === 'completed' \|\| current\.status === 'failed'/);
    expect(migration).toMatch(/tombstone_expires_at TIMESTAMPTZ/);
  });

  it('enforces append-only events while allowing aggregate retention cleanup', () => {
    expect(migration).toMatch(/remote task journal events are append-only/);
    expect(migration).toMatch(/TG_OP = 'UPDATE' OR pg_trigger_depth\(\) = 1/);
    expect(migration).toMatch(/ON DELETE CASCADE/);
    expect(repository).not.toMatch(/UPDATE remote_task_journal_events/);
  });

  it('replays only undelivered outbox rows and retains tombstones with pending side effects', () => {
    expect(repository).toMatch(/FROM remote_task_journal_outbox[\s\S]*WHERE delivered_at IS NULL[\s\S]*FOR UPDATE SKIP LOCKED/);
    expect(repository).toMatch(/SET delivered_at = NOW\(\)[\s\S]*delivered_at IS NULL/);
    expect(repository).toMatch(/NOT EXISTS \([\s\S]*outbox\.delivered_at IS NULL/);
    expect(migration).toMatch(/outbox_id UUID PRIMARY KEY/);
  });

  it('applies owner-or-operator RLS to tasks, events, and outbox in both schema paths', () => {
    for (const table of [
      'remote_task_journal_client_owners',
      'remote_task_journal_tasks',
      'remote_task_journal_events',
      'remote_task_journal_outbox',
      'remote_task_cost_receipts',
    ]) {
      expect(migration).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
      expect(runtimeSchema).toContain(`buildOwnerRlsPolicyStatements('${table}', 'owner_sub')`);
    }
  });

  it('keeps PostgreSQL authoritative with no in-memory fallback path', () => {
    expect(repository).not.toMatch(/InMemory|fallbackStore|persistentMode/);
    expect(repository).toMatch(/constructor\([\s\S]*private readonly pool: Pool/);
  });
});
