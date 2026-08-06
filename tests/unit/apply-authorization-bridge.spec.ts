/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                     | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove the kernel dynamically loads only the
 *   installed Career package decision reader and validates its strict result shape. Missing modules,
 *   malformed results, and reader failures remain unavailable; the exact subject is unchanged.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Pool } from 'pg';
import { readCareerAutoSubmitAuthorization } from '@/app/apply-authorization-bridge';

const root = mkdtempSync(join(tmpdir(), 'apply-authorization-bridge-'));
const modulePath = join(root, 'deployed-apps', 'career-hunter', 'lib', 'apply-authorization.js');
const previousWorkspaceRoot = process.env.CLINE_WORKSPACE_ROOT;

beforeAll(() => {
  mkdirSync(dirname(modulePath), { recursive: true });
  writeFileSync(modulePath, [
    "'use strict';",
    'module.exports.readAutoSubmitAuthorization = async (pool, userSub) => pool.read(userSub);',
  ].join('\n'));
  process.env.CLINE_WORKSPACE_ROOT = root;
});

afterAll(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.CLINE_WORKSPACE_ROOT;
  else process.env.CLINE_WORKSPACE_ROOT = previousWorkspaceRoot;
  rmSync(root, { recursive: true, force: true });
});

function poolReturning(read: (userSub: string) => unknown): Pool {
  return { read } as unknown as Pool;
}

describe('installed Career auto-submit authorization bridge', () => {
  it('returns the strict enabled decision and preserves the exact subject', async () => {
    const seen: string[] = [];
    const decision = await readCareerAutoSubmitAuthorization(poolReturning((subject) => {
      seen.push(subject);
      return { authorized: true, reason: 'enabled' };
    }), ' Tenant|Exact Subject ');
    expect(decision).toEqual({ authorized: true, reason: 'enabled' });
    expect(seen).toEqual([' Tenant|Exact Subject ']);
  });

  it('maps malformed or throwing package results to unavailable', async () => {
    await expect(readCareerAutoSubmitAuthorization(poolReturning(() => ({
      authorized: true, reason: 'model-approved',
    })), 'user-a')).resolves.toEqual({ authorized: false, reason: 'unavailable' });
    await expect(readCareerAutoSubmitAuthorization(poolReturning(() => {
      throw new Error('reader failed');
    }), 'user-a')).resolves.toEqual({ authorized: false, reason: 'unavailable' });
  });
});
