/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Exercise the real Apply CLI against temporary SQLite stores, proving exact-subject mapping, bounded task provenance, contained confirmation evidence, and applied-state downgrade protection.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Guard explicit-source parsing and monotonic confirmation provenance across repeated applied callbacks.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Prove malformed scope files fail before the Apply CLI opens a user database.
 * 4 | maintainer@emeraldcoastsystemsgroup.com | Prove posting claims are atomic leases and the bounded reaper releases only legacy/expired claims outside the controller's exact live allowlist.
 * 5 | maintainer@emeraldcoastsystemsgroup.com | Prove every claim, release, and outcome requires the exact PostgreSQL Apply V2 run id and claim token, including replay/mismatch refusal.
 */

import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = path.resolve(process.cwd(), 'scripts', 'oshal-apply.js');
const SUBJECT = ' Tenant|Exact Subject ';
const TASK_ID = 'apply-11111111-2222-4333-8444-555555555555';
const RUN_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const CLAIM_TOKEN = 'ffffffff-1111-4222-8333-444444444444';
const RUN_BINDING = ['--run-id', RUN_ID, '--claim-token', CLAIM_TOKEN];
const roots: string[] = [];

function segmentFor(userSub: string): string {
  return `u-${Buffer.from(userSub, 'utf8').toString('hex')}`;
}

function installTestMapper(appDir: string): void {
  const modulePath = path.join(appDir, 'lib', 'user-store-path.js');
  fs.mkdirSync(path.dirname(modulePath), { recursive: true });
  fs.writeFileSync(modulePath, `'use strict';
const fs = require('fs');
const path = require('path');
function resolveContainedPath(root, ...segments) {
  const absoluteRoot = path.resolve(root);
  const candidate = path.resolve(absoluteRoot, ...segments);
  const relative = path.relative(absoluteRoot, candidate);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('escaped');
  return candidate;
}
function resolveUserStoreLayout(root, tenant, userSub) {
  const tenantDir = resolveContainedPath(root, tenant);
  const userSegment = 'u-' + Buffer.from(userSub, 'utf8').toString('hex');
  const userDir = resolveContainedPath(tenantDir, userSegment);
  fs.mkdirSync(userDir, { recursive: true });
  return { tenantDir, userDir, userSegment, userDb: resolveContainedPath(userDir, 'user-' + userSegment + '.db') };
}
module.exports = { resolveContainedPath, resolveUserStoreLayout };
`, 'utf8');
}

function seedStore(root: string, userSub = SUBJECT): { appDir: string; userDir: string; userDb: string } {
  const appDir = path.join(root, 'career-package');
  installTestMapper(appDir);
  const tenantDir = path.join(root, 'store', 'default');
  const segment = segmentFor(userSub);
  const userDir = path.join(tenantDir, segment);
  const userDb = path.join(userDir, `user-${segment}.db`);
  fs.mkdirSync(userDir, { recursive: true });
  new Database(path.join(tenantDir, 'corpus.db')).close();
  const db = new Database(userDb);
  db.exec(`CREATE TABLE user_signals (
    posting_id INTEGER PRIMARY KEY, status TEXT, applied_at TEXT, notes TEXT
  )`);
  db.close();
  return { appDir, userDir, userDb };
}

function runCli(root: string, appDir: string, args: string[], userSub?: string) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    JOBHUNTER_APP_DIR: appDir,
    JOBHUNTER_STORE_ROOT: path.join(root, 'store'),
    OSHAL_TENANT: 'default',
  };
  if (userSub !== undefined) env.OSHAL_USER_SUB = userSub;
  else delete env.OSHAL_USER_SUB;
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: root, env, encoding: 'utf8', windowsHide: true,
  });
}

function readSignal(userDb: string, postingId: number): Record<string, unknown> {
  const db = new Database(userDb, { readonly: true });
  try { return db.prepare('SELECT * FROM user_signals WHERE posting_id=?').get(postingId) as Record<string, unknown>; }
  finally { db.close(); }
}

/** Seed and claim one generated posting through the real CLI's exact durable binding. */
function claimPosting(
  root: string,
  appDir: string,
  userDb: string,
  postingId: number,
  userSub = SUBJECT,
): void {
  const db = new Database(userDb);
  try {
    db.prepare('INSERT INTO user_signals (posting_id,status) VALUES (?,?)').run(postingId, 'generated');
  } finally { db.close(); }
  const claimed = runCli(root, appDir, [
    'queue', 'claim', String(postingId), ...RUN_BINDING,
  ], userSub);
  expect(claimed.status, claimed.stderr).toBe(0);
  expect(JSON.parse(claimed.stdout.trim())).toMatchObject({
    ok: true, posting_id: postingId, claimed: true, apply_run_id: RUN_ID,
  });
}

beforeEach(() => {
  roots.push(fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-apply-provenance-')));
});

afterEach(() => {
  const root = roots.pop();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe('oshal-apply queue record provenance', () => {
  it('claims atomically and reaps only legacy or expired non-live claims', () => {
    const root = roots.at(-1)!;
    const { appDir, userDb } = seedStore(root);
    const db = new Database(userDb);
    db.prepare('INSERT INTO user_signals (posting_id,status) VALUES (?,?)').run(50, 'generated');
    db.close();

    const first = runCli(root, appDir, ['queue', 'claim', '50', ...RUN_BINDING], SUBJECT);
    const second = runCli(root, appDir, ['queue', 'claim', '50',
      '--run-id', 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
      '--claim-token', '11111111-2222-4333-8444-555555555555'], SUBJECT);
    expect(first.status, first.stderr).toBe(0);
    expect(JSON.parse(first.stdout.trim())).toMatchObject({
      ok: true, posting_id: 50, claimed: true, apply_run_id: RUN_ID,
    });
    expect(JSON.parse(second.stdout.trim())).toMatchObject({
      ok: false, posting_id: 50, claimed: false,
    });
    expect(readSignal(userDb, 50)).toMatchObject({ apply_active: 0 });
    expect(Number(readSignal(userDb, 50).apply_claimed_at)).toBeGreaterThan(0);

    const seeded = new Database(userDb);
    const insert = seeded.prepare(`INSERT INTO user_signals
      (posting_id,status,applied_at,apply_active,apply_claimed_at) VALUES (?,?,?,?,?)`);
    const old = Date.now() - 120_000;
    insert.run(51, 'deferred', null, 0, null); // legacy claim: timestamp predates the lease field
    insert.run(52, 'deferred', null, 0, old);  // expired and not live
    insert.run(53, 'deferred', null, 0, old);  // expired but exact controller-owned live run
    insert.run(54, 'generated', null, 0, Date.now()); // fresh claim
    insert.run(55, 'applied', '2026-08-05T00:00:00Z', 0, old); // terminal: never requeue
    seeded.close();

    const reaped = runCli(root, appDir, [
      'queue', 'reap', '--older-ms', '60000', '--live', '53',
    ], SUBJECT);
    expect(reaped.status, reaped.stderr).toBe(0);
    expect(JSON.parse(reaped.stdout.trim())).toMatchObject({
      ok: true, before: 5, released: 2, after: 3, protected_live: 1,
      older_ms: 60_000,
    });
    expect(readSignal(userDb, 51)).toMatchObject({
      status: 'generated', apply_active: 1, apply_claimed_at: null,
    });
    expect(readSignal(userDb, 52)).toMatchObject({
      status: 'generated', apply_active: 1, apply_claimed_at: null,
    });
    expect(readSignal(userDb, 53)).toMatchObject({ status: 'deferred', apply_active: 0 });
    expect(readSignal(userDb, 54)).toMatchObject({ status: 'generated', apply_active: 0 });
    expect(readSignal(userDb, 55)).toMatchObject({ status: 'applied', apply_active: 0 });
  });

  it('preserves the exact subject and records task-bound worker provenance', () => {
    const root = roots.at(-1)!;
    const { appDir, userDb } = seedStore(root);
    claimPosting(root, appDir, userDb, 42);
    const run = runCli(root, appDir, [
      'queue', 'record', '42', 'applied', '--note', 'worker observed submit',
      '--source', 'worker-reported', '--task', TASK_ID,
      ...RUN_BINDING,
    ], SUBJECT);
    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout.trim())).toMatchObject({
      ok: true, posting_id: 42, status: 'applied',
      application_source: 'worker-reported', application_task_id: TASK_ID,
      confirmation_verified: false,
    });
    expect(readSignal(userDb, 42)).toMatchObject({
      status: 'applied', notes: 'worker observed submit',
      application_source: 'worker-reported', application_task_id: TASK_ID,
      apply_run_id: RUN_ID, apply_claim_token: null,
    });
  });

  it('does not reinterpret the first flag as a positional note', () => {
    const root = roots.at(-1)!;
    const { appDir, userDb } = seedStore(root);
    claimPosting(root, appDir, userDb, 41);
    const run = runCli(root, appDir, [
      'queue', 'record', '41', 'applied', '--source', 'worker-reported', '--task', TASK_ID,
      ...RUN_BINDING,
    ], SUBJECT);
    expect(run.status, run.stderr).toBe(0);
    expect(readSignal(userDb, 41)).toMatchObject({ notes: null, application_source: 'worker-reported' });
  });

  it('accepts verified provenance only for a link-free file inside the exact user store', () => {
    const root = roots.at(-1)!;
    const { appDir, userDir, userDb } = seedStore(root);
    claimPosting(root, appDir, userDb, 43);
    const proof = path.join(userDir, 'applications', 'confirmation.png');
    fs.mkdirSync(path.dirname(proof), { recursive: true });
    fs.writeFileSync(proof, 'proof', 'utf8');
    const accepted = runCli(root, appDir, [
      'queue', 'record', '43', 'applied', '--source', 'verified-submission',
      '--task', TASK_ID, '--confirmation', proof, ...RUN_BINDING,
    ], SUBJECT);
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(JSON.parse(accepted.stdout.trim())).toMatchObject({ confirmation_verified: true });
    expect(readSignal(userDb, 43)).toMatchObject({
      application_source: 'verified-submission', confirmation_path: fs.realpathSync.native(proof),
    });

    const outside = path.join(root, 'outside.png');
    fs.writeFileSync(outside, 'not proof', 'utf8');
    claimPosting(root, appDir, userDb, 44);
    const rejected = runCli(root, appDir, [
      'queue', 'record', '44', 'applied', '--source', 'verified-submission',
      '--task', TASK_ID, '--confirmation', outside, ...RUN_BINDING,
    ], SUBJECT);
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain('requires a contained, link-free confirmation file');
    expect(readSignal(userDb, 44)).toMatchObject({
      status: 'generated', apply_run_id: RUN_ID, apply_claim_token: CLAIM_TOKEN,
    });
  });

  it('reads a scope-file subject byte-for-byte and refuses to downgrade applied provenance', () => {
    const root = roots.at(-1)!;
    const { appDir, userDb } = seedStore(root);
    claimPosting(root, appDir, userDb, 45);
    fs.writeFileSync(path.join(root, '.oshal-user-sub'), SUBJECT, 'utf8');
    execFileSync(process.execPath, [SCRIPT, 'queue', 'record', '45', 'applied',
      '--source', 'worker-reported', '--task', TASK_ID, ...RUN_BINDING], {
      cwd: root,
      env: { ...process.env, JOBHUNTER_APP_DIR: appDir,
        JOBHUNTER_STORE_ROOT: path.join(root, 'store'), OSHAL_TENANT: 'default', OSHAL_USER_SUB: '' },
      windowsHide: true,
    });
    const deferred = runCli(root, appDir, [
      'queue', 'record', '45', 'deferred', '--note', 'late retry',
      '--source', 'worker-reported', '--task', TASK_ID, ...RUN_BINDING,
    ]);
    expect(JSON.parse(deferred.stdout.trim())).toMatchObject({ ok: false, status: 'applied' });
    expect(readSignal(userDb, 45)).toMatchObject({
      status: 'applied', application_source: 'worker-reported', application_task_id: TASK_ID,
    });
  });

  it('never downgrades confirmation-backed provenance on a later worker report', () => {
    const root = roots.at(-1)!;
    const { appDir, userDir, userDb } = seedStore(root);
    claimPosting(root, appDir, userDb, 48);
    const proof = path.join(userDir, 'applications', 'confirmation-strong.png');
    fs.mkdirSync(path.dirname(proof), { recursive: true });
    fs.writeFileSync(proof, 'proof', 'utf8');
    const verifiedTask = 'apply-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    expect(runCli(root, appDir, [
      'queue', 'record', '48', 'applied', '--source', 'verified-submission',
      '--task', verifiedTask, '--confirmation', proof, ...RUN_BINDING,
    ], SUBJECT).status).toBe(0);
    expect(runCli(root, appDir, [
      'queue', 'record', '48', 'applied', '--source', 'worker-reported', '--task', TASK_ID,
      ...RUN_BINDING,
    ], SUBJECT).status).toBe(0);
    expect(readSignal(userDb, 48)).toMatchObject({
      application_source: 'verified-submission', application_task_id: verifiedTask,
      confirmation_path: fs.realpathSync.native(proof),
    });
  });

  it('rejects malformed task ids, unsafe posting ids, and oversized notes before writing', () => {
    const root = roots.at(-1)!;
    const { appDir, userDb } = seedStore(root);
    const cases = [
      ['queue', 'record', '0', 'applied', '--source', 'worker-reported', '--task', TASK_ID, ...RUN_BINDING],
      ['queue', 'record', '46', 'applied', '--task', TASK_ID, ...RUN_BINDING],
      ['queue', 'record', '46', 'applied', '--source', 'worker-reported', ...RUN_BINDING],
      ['queue', 'record', '46', 'applied', '--source', 'worker-reported', '--task', 'apply-not-a-uuid', ...RUN_BINDING],
      ['queue', 'record', '47', 'applied', '--note', 'x'.repeat(2001), '--task', TASK_ID, ...RUN_BINDING],
    ];
    for (const args of cases) expect(runCli(root, appDir, args, SUBJECT).status).not.toBe(0);
    const db = new Database(userDb, { readonly: true });
    try { expect(db.prepare('SELECT COUNT(*) AS count FROM user_signals').get()).toEqual({ count: 0 }); }
    finally { db.close(); }
  });

  it('rejects a control-bearing scope file instead of normalizing it', () => {
    const root = roots.at(-1)!;
    const { appDir, userDb } = seedStore(root);
    fs.writeFileSync(path.join(root, '.oshal-user-sub'), `${SUBJECT}\n`, 'utf8');
    const run = runCli(root, appDir, [
      'queue', 'record', '49', 'applied', '--source', 'worker-reported', '--task', TASK_ID,
      ...RUN_BINDING,
    ]);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('control-free');
    const db = new Database(userDb, { readonly: true });
    try { expect(db.prepare('SELECT COUNT(*) AS count FROM user_signals').get()).toEqual({ count: 0 }); }
    finally { db.close(); }
  });
});
