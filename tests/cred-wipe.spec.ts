/**
 * Credential wipe-on-completion — privileged-runtime hygiene (ADR-040 first slice).
 *
 * Proves the shared user-scoping helper writes the per-request cred/scoping files and that
 * wipeUserScoping removes ALL of them — so a provided short-lived token never lingers in a
 * task workspace after the task ("issue → use → wipe").
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — unit test for applyUserScoping write + wipeUserScoping teardown (any-bot user-scoping.js).
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  CRED_FILES,
  acquireUserScoping,
  applyUserScoping,
  wipeUserScoping,
} = require('../any-bot/server/services/codebase/user-scoping');

const SCOPING_FILES = [...Object.values(CRED_FILES), '.oshal-user-sub', '.oshal-user-key'] as string[];

test('applyUserScoping writes the per-request files, wipeUserScoping removes them all', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-wipe-'));
  try {
    applyUserScoping(dir, { OSHAL_USER_SUB: 'user-1', OSHAL_CRED_GOOGLE: 'tok-g', OSHAL_CRED_TWITTER: 'tok-t' });
    // written
    expect(fs.existsSync(path.join(dir, '.oshal-cred-google'))).toBe(true);
    expect(fs.existsSync(path.join(dir, '.oshal-cred-twitter'))).toBe(true);
    expect(fs.existsSync(path.join(dir, '.oshal-user-sub'))).toBe(true);
    expect(fs.existsSync(path.join(dir, '.oshal-user-key'))).toBe(true);

    wipeUserScoping(dir);
    // every per-request file gone — no lingering credential
    for (const f of SCOPING_FILES) {
      expect(fs.existsSync(path.join(dir, f))).toBe(false);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('wipeUserScoping is a safe no-op on a clean workspace', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-wipe-clean-'));
  try {
    expect(() => wipeUserScoping(dir)).not.toThrow();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('shopping and Eats receive only their strictly allowed broker credential', () => {
  const shoppingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-shopping-scope-'));
  const eatsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-eats-scope-'));
  try {
    const shoppingEnv = applyUserScoping(shoppingDir, {
      OSHAL_CRED_WALMART: 'walmart-owner-token',
      PATH: '/attacker/bin',
      OSHAL_CRED_UNKNOWN: 'forbidden-token',
    });
    expect(shoppingEnv).toEqual({ OSHAL_CRED_WALMART: 'walmart-owner-token' });
    expect(fs.readFileSync(path.join(shoppingDir, '.oshal-cred-walmart'), 'utf8')).toBe('walmart-owner-token');
    expect(fs.existsSync(path.join(shoppingDir, '.oshal-cred-uber'))).toBe(false);

    const eatsEnv = applyUserScoping(eatsDir, { OSHAL_CRED_UBER: 'uber-owner-token' });
    expect(eatsEnv).toEqual({ OSHAL_CRED_UBER: 'uber-owner-token' });
    expect(fs.readFileSync(path.join(eatsDir, '.oshal-cred-uber'), 'utf8')).toBe('uber-owner-token');
    expect(fs.existsSync(path.join(eatsDir, '.oshal-cred-walmart'))).toBe(false);

    if (process.platform !== 'win32') {
      expect(fs.statSync(path.join(shoppingDir, '.oshal-cred-walmart')).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.join(eatsDir, '.oshal-cred-uber')).mode & 0o777).toBe(0o600);
    }
  } finally {
    fs.rmSync(shoppingDir, { recursive: true, force: true });
    fs.rmSync(eatsDir, { recursive: true, force: true });
  }
});

test('concurrent workspace leases serialize and cannot clobber or wipe the next invocation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-concurrent-scope-'));
  try {
    const shopping = await acquireUserScoping(dir, { OSHAL_CRED_WALMART: 'walmart-owner-token' });
    let eatsAcquired = false;
    const eatsPromise = acquireUserScoping(dir, { OSHAL_CRED_UBER: 'uber-owner-token' }).then((scope: unknown) => {
      eatsAcquired = true;
      return scope as { env: Record<string, string>; release: () => void };
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(eatsAcquired).toBe(false);
    expect(fs.existsSync(path.join(dir, '.oshal-cred-walmart'))).toBe(true);
    expect(fs.existsSync(path.join(dir, '.oshal-cred-uber'))).toBe(false);

    shopping.release();
    const eats = await eatsPromise;
    expect(eats.env).toEqual({ OSHAL_CRED_UBER: 'uber-owner-token' });
    expect(fs.existsSync(path.join(dir, '.oshal-cred-walmart'))).toBe(false);
    expect(fs.readFileSync(path.join(dir, '.oshal-cred-uber'), 'utf8')).toBe('uber-owner-token');

    // An old invocation's idempotent cleanup cannot delete the active request's file.
    shopping.release();
    expect(fs.existsSync(path.join(dir, '.oshal-cred-uber'))).toBe(true);
    eats.release();
    expect(fs.existsSync(path.join(dir, '.oshal-cred-uber'))).toBe(false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
