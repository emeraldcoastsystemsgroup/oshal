/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove Apply confirmation retention accepts only bounded single-link PNG/JPEG files from the exact task workspace and copies them into the exact Career owner store.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-confirmation-'));
const workspaceRoot = path.join(root, 'workspaces');
const storeRoot = path.join(root, 'store');
const mapperPath = path.join(root, 'user-store-path.js');
const savedWorkspaceRoot = process.env.SHARED_WORKSPACE_ROOT;
const savedMapper = process.env.JOBHUNTER_USER_STORE_MODULE;
const savedStoreRoot = process.env.JOBHUNTER_STORE_ROOT;
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

let persistApplyConfirmationArtifact: typeof import('@/app/apply-confirmation-artifact').persistApplyConfirmationArtifact;

/** Install a side-effect-free mapper that resolves only an already-created exact owner directory. */
function installMapper(): void {
  fs.writeFileSync(mapperPath, `'use strict';
const fs = require('fs');
const path = require('path');
function findUserStoreLayout(root, tenant, userSub) {
  const userSegment = 'u-' + Buffer.from(userSub, 'utf8').toString('hex');
  const tenantDir = path.resolve(root, tenant);
  const userDir = path.resolve(tenantDir, userSegment);
  if (!fs.existsSync(userDir)) return null;
  return { tenantDir, userDir, userSegment, userDb: path.join(userDir, 'user-' + userSegment + '.db') };
}
module.exports = { findUserStoreLayout };
`, 'utf8');
}

/** Create the exact task and owner directories used by one test. */
function seed(taskId: string, userSub = 'Owner|Exact'): { workspace: string; userDir: string } {
  const workspace = path.join(workspaceRoot, taskId);
  const segment = `u-${Buffer.from(userSub, 'utf8').toString('hex')}`;
  const userDir = path.join(storeRoot, 'default', segment);
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(path.join(userDir, 'applications'), { recursive: true });
  fs.writeFileSync(path.join(userDir, `user-${segment}.db`), 'fixture');
  return { workspace, userDir };
}

beforeAll(async () => {
  installMapper();
  process.env.SHARED_WORKSPACE_ROOT = workspaceRoot;
  process.env.JOBHUNTER_USER_STORE_MODULE = mapperPath;
  process.env.JOBHUNTER_STORE_ROOT = storeRoot;
  vi.resetModules();
  ({ persistApplyConfirmationArtifact } = await import('@/app/apply-confirmation-artifact'));
});

afterAll(() => {
  if (savedWorkspaceRoot === undefined) delete process.env.SHARED_WORKSPACE_ROOT;
  else process.env.SHARED_WORKSPACE_ROOT = savedWorkspaceRoot;
  if (savedMapper === undefined) delete process.env.JOBHUNTER_USER_STORE_MODULE;
  else process.env.JOBHUNTER_USER_STORE_MODULE = savedMapper;
  if (savedStoreRoot === undefined) delete process.env.JOBHUNTER_STORE_ROOT;
  else process.env.JOBHUNTER_STORE_ROOT = savedStoreRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('Apply confirmation artifact retention', () => {
  it('retains a valid direct-child PNG under the exact owner store', () => {
    const taskId = 'apply-11111111-1111-4111-8111-111111111111';
    const { workspace, userDir } = seed(taskId);
    fs.writeFileSync(path.join(workspace, 'confirmation.png'), PNG);

    const retained = persistApplyConfirmationArtifact('Owner|Exact', taskId, 'confirmation.png');

    expect(retained).toBe(path.join(userDir, 'applications', 'confirmations', `${taskId}.png`));
    expect(fs.readFileSync(retained as string)).toEqual(PNG);
    expect(fs.lstatSync(retained as string).nlink).toBe(1);
  });

  it('refuses traversal, non-images, oversized files, and multi-link sources', () => {
    const taskId = 'apply-22222222-2222-4222-8222-222222222222';
    const { workspace } = seed(taskId);
    fs.writeFileSync(path.join(workspace, 'not-image.png'), 'not an image');
    fs.writeFileSync(path.join(workspace, 'large.png'), PNG);
    fs.truncateSync(path.join(workspace, 'large.png'), 8 * 1024 * 1024 + 1);
    fs.writeFileSync(path.join(workspace, 'linked.png'), PNG);
    fs.linkSync(path.join(workspace, 'linked.png'), path.join(workspace, 'second-link.png'));

    expect(persistApplyConfirmationArtifact('Owner|Exact', taskId, '../confirmation.png')).toBeNull();
    expect(persistApplyConfirmationArtifact('Owner|Exact', taskId, 'not-image.png')).toBeNull();
    expect(persistApplyConfirmationArtifact('Owner|Exact', taskId, 'large.png')).toBeNull();
    expect(persistApplyConfirmationArtifact('Owner|Exact', taskId, 'linked.png')).toBeNull();
  });

  it('fails closed for a missing owner store or noncanonical task id', () => {
    const taskId = 'apply-33333333-3333-4333-8333-333333333333';
    const { workspace } = seed(taskId);
    fs.writeFileSync(path.join(workspace, 'confirmation.png'), PNG);
    expect(persistApplyConfirmationArtifact('Missing Owner', taskId, 'confirmation.png')).toBeNull();
    expect(persistApplyConfirmationArtifact('Owner|Exact', 'apply-not-a-uuid', 'confirmation.png')).toBeNull();
  });
});
