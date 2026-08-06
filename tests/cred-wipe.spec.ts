/**
 * Model-workspace credential isolation — privileged-runtime hygiene.
 *
 * Proves the shared any-bot scoping helper publishes only exact owner identity markers.
 * Connector credentials are ignored and never become child environment values or workspace
 * files; invocation-owned identity markers are removed safely when the lease ends.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial credential wipe coverage.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05: replace credential-file expectations with strict no-credential-env/file isolation and exact identity lease cleanup.
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  SCOPING_FILES,
  acquireUserScoping,
  applyUserScoping,
  wipeUserScoping,
} = require('../any-bot/server/services/codebase/user-scoping');

const CREDENTIAL_FILES = [
  '.oshal-cred-google',
  '.oshal-cred-twitter',
  '.oshal-cred-walmart',
  '.oshal-cred-uber',
];

test('publishes exact identity only and wipe removes invocation-owned identity files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-scope-'));
  try {
    const env = applyUserScoping(dir, {
      OSHAL_USER_SUB: 'Owner-Exact',
      OSHAL_CRED_GOOGLE: 'must-not-leak',
      OSHAL_CRED_TWITTER: 'must-not-leak-either',
    });
    expect(env.OSHAL_USER_SUB).toBe('Owner-Exact');
    expect(env.OSHAL_USER_KEY).toMatch(/^[a-f0-9]{32}$/);
    expect(env).not.toHaveProperty('OSHAL_CRED_GOOGLE');
    expect(env).not.toHaveProperty('OSHAL_CRED_TWITTER');
    expect(fs.readFileSync(path.join(dir, '.oshal-user-sub'), 'utf8')).toBe('Owner-Exact');
    for (const file of CREDENTIAL_FILES) expect(fs.existsSync(path.join(dir, file))).toBe(false);

    wipeUserScoping(dir);
    for (const file of SCOPING_FILES as string[]) expect(fs.existsSync(path.join(dir, file))).toBe(false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('credentials without an owner produce no environment or workspace files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-no-owner-scope-'));
  try {
    expect(applyUserScoping(dir, { OSHAL_CRED_WALMART: 'must-not-leak' })).toEqual({});
    for (const file of [...CREDENTIAL_FILES, ...(SCOPING_FILES as string[])]) {
      expect(fs.existsSync(path.join(dir, file))).toBe(false);
    }
    expect(() => wipeUserScoping(dir)).not.toThrow();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('workspace identity leases serialize and stale cleanup cannot remove the next owner marker', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-concurrent-scope-'));
  try {
    const first = await acquireUserScoping(dir, { OSHAL_USER_SUB: 'owner-one', OSHAL_CRED_GOOGLE: 'ignored' });
    let secondAcquired = false;
    const secondPromise = acquireUserScoping(dir, { OSHAL_USER_SUB: 'owner-two', OSHAL_CRED_UBER: 'ignored' })
      .then((scope: { env: Record<string, string>; release: () => void }) => {
        secondAcquired = true;
        return scope;
      });
    await new Promise((resolve) => setImmediate(resolve));

    expect(secondAcquired).toBe(false);
    expect(fs.readFileSync(path.join(dir, '.oshal-user-sub'), 'utf8')).toBe('owner-one');
    first.release();

    const second = await secondPromise;
    expect(second.env.OSHAL_USER_SUB).toBe('owner-two');
    expect(second.env).not.toHaveProperty('OSHAL_CRED_UBER');
    expect(fs.readFileSync(path.join(dir, '.oshal-user-sub'), 'utf8')).toBe('owner-two');
    first.release();
    expect(fs.readFileSync(path.join(dir, '.oshal-user-sub'), 'utf8')).toBe('owner-two');
    second.release();
    expect(fs.existsSync(path.join(dir, '.oshal-user-sub'))).toBe(false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
