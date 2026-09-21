/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The nightly backup diagnostic, executed against a PostgreSQL this file starts and destroys, in the shapes the 2026-09-12 incident produced: a dump cancelled by lock contention, a restore that errors part-way, a deployment holding the lock, a deployment that takes the lock mid-run, a scratch name that is not one the diagnostic minted, and the orphan scratch databases a killed run leaves behind. Every case asserts the same thing from a different direction - that no accepted backup evidence comes out of it - because "the diagnostic passed" was exactly what the incident produced off a partial restore. It runs a real pg_dump and a real psql through docker exec; nothing about the round trip is doubled, because the round trip is the boundary that failed.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  backupProofAccepted,
  isDroppableThrowaway,
  runBackupRestoreProof,
  type BackupRestoreProof,
} from '../../scripts/evidence/backup-restore-proof';
import { DisposablePostgres } from '../helpers/disposable-postgres';

const SERVER = new DisposablePostgres({ purpose: 'backup-restore-proof', memory: '384m' });
/** A deploy lock path that does not exist, for the cases that are not about the lock. */
let idleLockRoot = '';
/** A directory that DOES exist, standing in for a deploy holding the lock. */
let heldLockRoot = '';

/** @description The check with this id. @param proof A finished proof. @param id Check id. @returns The check row. */
function checkOf(proof: BackupRestoreProof, id: string) {
  const row = proof.checks.find(item => item.id === id);
  if (!row) throw new Error(`proof carries no check "${id}"`);
  return row;
}

/** @description Run statements against one database on the fixture server. @param database Database name. @param statements SQL to run in order. @returns Nothing. */
async function inDatabase(database: string, statements: string[]): Promise<void> {
  const client = new Client({ ...SERVER.connection, database });
  await client.connect();
  try { for (const sql of statements) await client.query(sql); } finally { await client.end(); }
}

/** @description Create a database on the fixture server and populate it. @param name Database name. @param statements Schema and data. @returns Nothing. */
async function createSource(name: string, statements: string[]): Promise<void> {
  await SERVER.pool.query(`CREATE DATABASE ${name}`);
  if (statements.length) await inDatabase(name, statements);
}

/** @description Every non-template database on the fixture server. @returns Their names. */
async function databaseNames(): Promise<string[]> {
  const result = await SERVER.pool.query<{ datname: string }>('select datname from pg_database where not datistemplate');
  return result.rows.map(row => row.datname);
}

/** @description Count rows in one table of one database. @param database Database name. @param table Table name. @returns The row count. */
async function rowCount(database: string, table: string): Promise<number> {
  const client = new Client({ ...SERVER.connection, database });
  await client.connect();
  try {
    const result = await client.query<{ count: string }>(`select count(*)::text as count from ${table}`);
    return Number(result.rows[0].count);
  } finally { await client.end(); }
}

/** @description Options every case shares, pointed at one source database. @param database The source. @returns Proof options. */
function optionsFor(database: string) {
  return {
    target: { container: SERVER.containerName, user: SERVER.connection.user, database, password: SERVER.connection.password },
    deployLockPath: join(idleLockRoot, 'lock'),
    statementTimeoutMs: 30_000,
    lockTimeoutMs: 1_000,
    maxRuntimeMs: 90_000,
    pollMs: 500,
  };
}

beforeAll(async () => {
  await SERVER.start();
  const root = mkdtempSync(join(tmpdir(), 'oshal-backup-proof-'));
  idleLockRoot = join(root, 'idle');
  heldLockRoot = join(root, 'held');
  mkdirSync(idleLockRoot, { recursive: true });
  mkdirSync(join(heldLockRoot, 'lock'), { recursive: true });
}, 300_000);

afterAll(async () => {
  await SERVER.stop();
  for (const root of [idleLockRoot, heldLockRoot]) {
    if (root) rmSync(join(root, '..'), { recursive: true, force: true });
  }
}, 120_000);

describe('nightly backup diagnostic — a round trip that only passes when it really completed', () => {
  it('accepts a clean round trip, compares every table, and leaves the source alone', async () => {
    await createSource('src_clean', [
      'CREATE TABLE agents (id int primary key, name text)',
      "INSERT INTO agents SELECT g, 'agent-' || g FROM generate_series(1, 7) g",
      'CREATE TABLE work_items (id int primary key, agent_id int)',
      'INSERT INTO work_items SELECT g, (g % 7) + 1 FROM generate_series(1, 41) g',
    ]);
    const proof = await runBackupRestoreProof(optionsFor('src_clean'));
    expect(proof.checks.filter(item => !item.passed)).toEqual([]);
    expect(backupProofAccepted(proof)).toBe(true);
    expect(proof.before).toEqual({ 'public.agents': 7, 'public.work_items': 41 });
    expect(proof.after).toEqual(proof.before);
    expect(await databaseNames()).toContain('src_clean');
    expect(await databaseNames()).not.toContain(proof.throwaway);
    expect(await rowCount('src_clean', 'agents')).toBe(7);
  }, 300_000);

  it('refuses a restore that errors part-way, even though the sentinel table came back whole', async () => {
    // pg_dump emits a CHECK constraint inline in CREATE TABLE, and restores table data in name
    // order, so aa_early's rows are loaded while zz_late is still empty and the constraint raises.
    // agents restores cleanly first — which is exactly how a partial restore used to pass.
    await createSource('src_restore_error', [
      'CREATE TABLE agents (id int primary key)',
      'INSERT INTO agents SELECT g FROM generate_series(1, 5) g',
      'CREATE TABLE zz_late (id int primary key)',
      'CREATE FUNCTION zz_late_has_rows(v int) RETURNS boolean LANGUAGE sql AS $$ SELECT EXISTS (SELECT 1 FROM zz_late) $$',
      'CREATE TABLE aa_early (id int primary key, CONSTRAINT needs_zz CHECK (zz_late_has_rows(id)))',
      'INSERT INTO zz_late VALUES (1)',
      'INSERT INTO aa_early VALUES (1)',
    ]);
    const proof = await runBackupRestoreProof(optionsFor('src_restore_error'));
    expect(checkOf(proof, 'dump-succeeded').passed).toBe(true);
    expect(checkOf(proof, 'restore-succeeded').passed).toBe(false);
    expect(checkOf(proof, 'restore-succeeded').evidence).toMatch(/needs_zz|check constraint|ERROR/i);
    expect(backupProofAccepted(proof)).toBe(false);
    expect(await databaseNames()).not.toContain(proof.throwaway);
    expect(await rowCount('src_restore_error', 'agents')).toBe(5);
  }, 300_000);

  it('gives up on a dump another session is blocking instead of waiting on it', async () => {
    await createSource('src_locked', [
      'CREATE TABLE agents (id int primary key)',
      'INSERT INTO agents SELECT g FROM generate_series(1, 3) g',
    ]);
    const blocker = new Client({ ...SERVER.connection, database: 'src_locked' });
    await blocker.connect();
    await blocker.query('BEGIN');
    await blocker.query('LOCK TABLE agents IN ACCESS EXCLUSIVE MODE');
    const startedAt = Date.now();
    let proof: BackupRestoreProof;
    try {
      proof = await runBackupRestoreProof(optionsFor('src_locked'));
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      await blocker.end().catch(() => undefined);
    }
    const elapsed = Date.now() - startedAt;
    expect(checkOf(proof, 'dump-succeeded').passed).toBe(false);
    expect(checkOf(proof, 'dump-complete').passed).toBe(false);
    expect(backupProofAccepted(proof)).toBe(false);
    // The bound is the point: an unbounded pg_dump waits for the lock forever, which is how a
    // deployment ends up blocked behind this diagnostic.
    expect(elapsed).toBeLessThan(30_000);
    expect(await databaseNames()).not.toContain(proof.throwaway);
    expect(await rowCount('src_locked', 'agents')).toBe(3);
  }, 300_000);

  it('never starts while a deployment holds the lock, and creates nothing when it refuses', async () => {
    await createSource('src_deploy_held', ['CREATE TABLE agents (id int primary key)']);
    const before = await databaseNames();
    const proof = await runBackupRestoreProof({ ...optionsFor('src_deploy_held'), deployLockPath: join(heldLockRoot, 'lock') });
    expect(checkOf(proof, 'deploy-idle').passed).toBe(false);
    expect(checkOf(proof, 'deploy-idle').evidence).toContain('a deploy is in flight');
    expect(backupProofAccepted(proof)).toBe(false);
    // Nothing was attempted, so nothing may read as passed.
    expect(proof.checks.every(item => !item.passed)).toBe(true);
    expect(await databaseNames()).toEqual(before);
  }, 300_000);

  it('lets go of the database when a deployment takes the lock mid-run', async () => {
    await createSource('src_deploy_midrun', [
      'CREATE TABLE agents (id int primary key)',
      'INSERT INTO agents SELECT g FROM generate_series(1, 4) g',
    ]);
    const blocker = new Client({ ...SERVER.connection, database: 'src_deploy_midrun' });
    await blocker.connect();
    await blocker.query('BEGIN');
    await blocker.query('LOCK TABLE agents IN ACCESS EXCLUSIVE MODE');
    const lateLock = join(heldLockRoot, 'late-lock');
    const startedAt = Date.now();
    let proof: BackupRestoreProof;
    try {
      // A long lock_timeout means only the watcher can end this run.
      const running = runBackupRestoreProof({ ...optionsFor('src_deploy_midrun'), deployLockPath: lateLock, lockTimeoutMs: 60_000 });
      await new Promise(resolve => setTimeout(resolve, 1_500));
      mkdirSync(lateLock, { recursive: true });
      proof = await running;
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      await blocker.end().catch(() => undefined);
      rmSync(lateLock, { recursive: true, force: true });
    }
    const elapsed = Date.now() - startedAt;
    expect(proof.abortedReason).toContain('deployment');
    expect(checkOf(proof, 'deploy-idle').passed).toBe(false);
    expect(checkOf(proof, 'dump-succeeded').passed).toBe(false);
    expect(backupProofAccepted(proof)).toBe(false);
    expect(elapsed).toBeLessThan(30_000);
    expect(await databaseNames()).not.toContain(proof.throwaway);
  }, 300_000);

  it('refuses a scratch name it did not mint, so cleanup can never reach the source database', async () => {
    await createSource('src_name_guard', [
      'CREATE TABLE agents (id int primary key)',
      'INSERT INTO agents SELECT g FROM generate_series(1, 6) g',
    ]);
    const proof = await runBackupRestoreProof({ ...optionsFor('src_name_guard'), throwawayName: 'src_name_guard' });
    expect(checkOf(proof, 'throwaway-dropped').passed).toBe(false);
    expect(checkOf(proof, 'throwaway-dropped').evidence).toContain('not a minted throwaway name');
    expect(backupProofAccepted(proof)).toBe(false);
    expect(await databaseNames()).toContain('src_name_guard');
    expect(await rowCount('src_name_guard', 'agents')).toBe(6);
    expect(isDroppableThrowaway('src_name_guard', 'src_name_guard')).toBe(false);
    expect(isDroppableThrowaway('oshal_restore_smoke_1786005613325', 'oshal')).toBe(true);
  }, 300_000);

  it('sweeps the scratch databases an earlier killed run left behind', async () => {
    await createSource('src_sweep', [
      'CREATE TABLE agents (id int primary key)',
      'INSERT INTO agents SELECT g FROM generate_series(1, 2) g',
    ]);
    // The three orphans measured on the dev box were named by the old `Date.now()` scheme.
    await SERVER.pool.query('CREATE DATABASE oshal_restore_smoke_1786005613325');
    expect(await databaseNames()).toContain('oshal_restore_smoke_1786005613325');
    const proof = await runBackupRestoreProof(optionsFor('src_sweep'));
    expect(proof.sweptOrphans).toContain('oshal_restore_smoke_1786005613325');
    expect(checkOf(proof, 'no-orphan-databases').passed).toBe(true);
    expect(backupProofAccepted(proof)).toBe(true);
    expect(await databaseNames()).not.toContain('oshal_restore_smoke_1786005613325');
    expect(await databaseNames()).toContain('src_sweep');
  }, 300_000);
});
