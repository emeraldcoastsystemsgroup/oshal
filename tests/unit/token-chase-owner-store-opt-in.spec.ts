/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Regression guard for the Token Chase owner-store opt-in. Core #849 bound the snapshotter to PI_STORE_ROOT / JOBHUNTER_STORE_ROOT whenever either was set, so every captured turn on a node holding a vault hashed and copied that owner's whole store into the task's .tokenchase/store-objects (a jarvis bot held its event loop 2+ minutes per ask). Proves over the REAL wiring (readOwnerStoreConfig -> createOwnerStoreSnapshotter -> tokenChase.configureOwnerStore, the REAL capture lane in a child process with TOKEN_CHASE_CAPTURE=true, a REAL exact-subject vault): with a vault root set and no opt-in, the snapshotter is unbound, the frame and final.json record ownerStoreVersion null / ownerStore.bound false, and NO store-objects or store manifest is written; with TOKEN_CHASE_OWNER_STORE_SNAPSHOT=on the same run copies the ciphertext (the positive control that shows this harness detects copying).
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { isOwnerStoreSnapshotEnabled, readOwnerStoreConfig } from '../../src/features/token-chase/services/owner-store-snapshot';
import { ensureExactSubjectStoreDirectory } from '../../src/shared/security/exact-subject-store';
import { encryptField } from '../../src/features/personal-data/vault-crypto';

const OWNER = 'auth0|token-chase-opt-in-owner';
const TENANT = 'default';
const SECRET = 'token-chase-owner-store-opt-in-secret-01';
const REPO_ROOT = path.resolve('.');
const CAPTURE = path.join(REPO_ROOT, 'any-bot/server/services/token-chase/TokenChaseCapture.js');
const SNAPSHOT = path.join(REPO_ROOT, 'src/features/token-chase/services/owner-store-snapshot.ts');
const STORE_ENV_KEYS = ['TOKEN_CHASE_OWNER_STORE_SNAPSHOT', 'TOKEN_CHASE_STORE_ROOT', 'PI_STORE_ROOT', 'JOBHUNTER_STORE_ROOT', 'PI_TENANT'];
const roots: string[] = [];

beforeAll(() => { process.env.SESSION_SECRET = SECRET; });
afterEach(() => { for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }); });

/** A fresh temp directory removed after the case. */
function tempRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

/** Seeds a real exact-subject vault with one AES-256-GCM field, the layout the Personal Data Vault writes. */
function seedVault(storeRoot: string): void {
  const subject = ensureExactSubjectStoreDirectory(storeRoot, TENANT, OWNER);
  fs.mkdirSync(path.join(subject.subjectDir, 'vault'), { recursive: true });
  fs.writeFileSync(path.join(subject.subjectDir, 'vault', 'entities.enc'), encryptField(OWNER, 'a vault entry')!, 'utf8');
}

/**
 * Boots the capture lane the way bot-node-server.ts does (snapshotter from readOwnerStoreConfig over
 * the process env, installed through configureOwnerStore), then captures one frame and final.json.
 */
function captureRun(workspace: string, storeEnv: Record<string, string>): { bound: boolean } {
  const script = `
    const { createOwnerStoreSnapshotter, readOwnerStoreConfig } = require(${JSON.stringify(SNAPSHOT)});
    const { tokenChase } = require(${JSON.stringify(CAPTURE)});
    const ownerStore = createOwnerStoreSnapshotter(readOwnerStoreConfig());
    tokenChase.configureOwnerStore(ownerStore);
    const root = ${JSON.stringify(workspace)};
    (async () => {
      const h = tokenChase.beginFrame({ taskId: 'task-opt-in', seq: 1, agentId: 'bot-1', workspaceDir: root, providerName: 'p', systemPrompt: 's', history: [], tools: [], userSub: ${JSON.stringify(OWNER)} });
      await tokenChase.flush();
      tokenChase.endFrame(h, { provider: 'p', model: 'm', content: 'done', contentBlocks: [] });
      tokenChase.finishRun({ taskId: 'task-opt-in', workspaceDir: root, userSub: ${JSON.stringify(OWNER)}, turns: 1, outcome: 'completed', pins: [] });
      await tokenChase.flush();
      process.stdout.write('TC_OPT_IN ' + JSON.stringify({ bound: ownerStore.bound }) + '\\n');
    })();
  `;
  const env: NodeJS.ProcessEnv = { ...process.env, TOKEN_CHASE_CAPTURE: 'true', SESSION_SECRET: SECRET };
  for (const key of STORE_ENV_KEYS) delete env[key];
  const out = execFileSync(process.execPath, ['--require', 'tsx/cjs', '-e', script], {
    cwd: REPO_ROOT, env: { ...env, ...storeEnv }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000,
  });
  const line = out.split(/\r?\n/).find((l) => l.startsWith('TC_OPT_IN '));
  if (!line) throw new Error(`capture child reported nothing:\n${out.slice(-2000)}`);
  return JSON.parse(line.slice('TC_OPT_IN '.length));
}

/** Reads one capture file of the run as JSON. */
function readCapture(workspace: string, file: string): any {
  return JSON.parse(fs.readFileSync(path.join(workspace, '.tokenchase', file), 'utf8'));
}

describe('Token Chase owner-store snapshot is explicit opt-in', () => {
  it('never binds from a vault root alone; binds only when TOKEN_CHASE_OWNER_STORE_SNAPSHOT is on', () => {
    expect(readOwnerStoreConfig({ PI_STORE_ROOT: '/home/user/vaults' }).storeRoot).toBeNull();
    expect(readOwnerStoreConfig({ JOBHUNTER_STORE_ROOT: '/home/user/career' }).storeRoot).toBeNull();
    expect(readOwnerStoreConfig({ TOKEN_CHASE_STORE_ROOT: '/home/user/tc' }).storeRoot).toBeNull();
    expect(readOwnerStoreConfig({ TOKEN_CHASE_OWNER_STORE_SNAPSHOT: 'off', PI_STORE_ROOT: '/home/user/vaults' }).storeRoot).toBeNull();
    expect(readOwnerStoreConfig({ TOKEN_CHASE_OWNER_STORE_SNAPSHOT: 'yes', PI_STORE_ROOT: '/home/user/vaults' }).storeRoot).toBeNull();
    expect(readOwnerStoreConfig({ TOKEN_CHASE_OWNER_STORE_SNAPSHOT: '', TOKEN_CHASE_STORE_ROOT: '', PI_STORE_ROOT: '/home/user/vaults' }).storeRoot).toBeNull();

    expect(isOwnerStoreSnapshotEnabled({})).toBe(false);
    expect(isOwnerStoreSnapshotEnabled({ TOKEN_CHASE_OWNER_STORE_SNAPSHOT: ' ON ' })).toBe(true);
    expect(readOwnerStoreConfig({ TOKEN_CHASE_OWNER_STORE_SNAPSHOT: 'on', PI_STORE_ROOT: '/home/user/vaults' }).storeRoot).toBe('/home/user/vaults');
    expect(readOwnerStoreConfig({ TOKEN_CHASE_OWNER_STORE_SNAPSHOT: 'true', JOBHUNTER_STORE_ROOT: '/home/user/career' }).storeRoot).toBe('/home/user/career');
    expect(readOwnerStoreConfig({ TOKEN_CHASE_OWNER_STORE_SNAPSHOT: 'on', TOKEN_CHASE_STORE_ROOT: '/home/user/tc', PI_STORE_ROOT: '/home/user/vaults' }).storeRoot).toBe('/home/user/tc');
    // Opted in with no root anywhere: still unbound, never a fabricated location.
    expect(readOwnerStoreConfig({ TOKEN_CHASE_OWNER_STORE_SNAPSHOT: 'on' }).storeRoot).toBeNull();
  });

  it('with PI_STORE_ROOT set and no opt-in, a captured run records bound:false and writes NO store objects', () => {
    const storeRoot = tempRoot('tc-optin-vault-');
    seedVault(storeRoot);
    const workspace = tempRoot('tc-optin-ws-');
    fs.writeFileSync(path.join(workspace, 'a.txt'), 'a');

    const report = captureRun(workspace, { PI_STORE_ROOT: storeRoot, JOBHUNTER_STORE_ROOT: storeRoot });

    expect(report.bound).toBe(false);
    const frame = readCapture(workspace, 'frame-0001.json');
    const final = readCapture(workspace, 'final.json');
    expect(frame.context.ownerStoreVersion).toBeNull();
    expect(frame.ownerStore).toMatchObject({ bound: false, version: null, manifest: null });
    expect(final.ownerStoreVersion).toBeNull();
    expect(final.ownerStore.bound).toBe(false);
    const dir = path.join(workspace, '.tokenchase');
    expect(fs.existsSync(path.join(dir, 'store-objects'))).toBe(false);
    expect(fs.readdirSync(dir).filter((name) => name.startsWith('store-'))).toEqual([]);
    // The workspace checkpoint still ran: only the store copy is off.
    expect(frame.context.workspaceCommit).toMatch(/^[0-9a-f]{40}$/);
  }, 90_000);

  it('with TOKEN_CHASE_OWNER_STORE_SNAPSHOT=on the same run versions the store and copies its ciphertext', () => {
    const storeRoot = tempRoot('tc-optin-vault-');
    seedVault(storeRoot);
    const workspace = tempRoot('tc-optin-ws-');

    const report = captureRun(workspace, { PI_STORE_ROOT: storeRoot, TOKEN_CHASE_OWNER_STORE_SNAPSHOT: 'on' });

    expect(report.bound).toBe(true);
    const frame = readCapture(workspace, 'frame-0001.json');
    expect(frame.context.ownerStoreVersion).toMatch(/^[0-9a-f]{64}$/);
    expect(frame.ownerStore).toMatchObject({ bound: true, complete: true });
    const objects = fs.readdirSync(path.join(workspace, '.tokenchase', 'store-objects'));
    expect(objects).toHaveLength(1);
    expect(readCapture(workspace, 'final.json').ownerStoreVersion).toBe(frame.context.ownerStoreVersion);
  }, 90_000);
});
