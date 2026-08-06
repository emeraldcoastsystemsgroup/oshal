/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Prove Profile Studio stages bounded contained assets for a registered remote node before state transition, keeps hostile subjects/capabilities/source paths out of prompts, and rolls back missing-asset or enqueue failure workspaces.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Keep secure staging and rollback cases in bounded test groups without weakening coverage.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Keep the hostile exact-subject fixture control-free so it is valid across both callback and A2A envelope boundaries.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Preserve the generic non-enumerating browser-authorization refusal when Profile Studio's pre-staging selector finds no eligible owned worker.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { LinkedInProfilePlan } from '@/features/profile-studio';

const hoisted = vi.hoisted(() => ({
  state: {
    workspaceRoot: '',
    dispatchInput: null as Record<string, unknown> | null,
    dispatchResult: { ok: true, clientId: 'desktop-a' } as Record<string, unknown>,
    clientAvailable: true,
    folderFor: (id: string) => id,
  },
  beginDispatch: vi.fn(async () => 4 as number | null),
  failDispatch: vi.fn(async () => true),
}));

vi.mock('@/shared/logger', () => ({
  createChildLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
}));
vi.mock('@/app/routes/remote-client-routes', () => ({
  taskWorkspaceFolder: (id: string) => hoisted.state.folderFor(id),
}));
vi.mock('@/app/browser-task-dispatch', () => ({
  pickApplyClient: () => hoisted.state.clientAvailable ? ({
    clientId: 'desktop-a', agentId: 'desktop-agent', ownerSub: 'ignored-by-fixture',
    status: 'online', healthy: true, capabilities: ['codex.exec', 'browser_control'],
    tags: ['browser_pilot_consent'], taskQueueDepth: 0,
    controlPlaneUrl: 'https://registered-controller.example/reachable/base',
  }) : null,
  dispatchBrowserTask: async (input: Record<string, unknown>) => {
    hoisted.state.dispatchInput = input;
    return { ...hoisted.state.dispatchResult, taskId: input.taskId };
  },
}));

import { dispatchProfileUpdate } from '@/app/profile-studio-dispatch';

let fixtureRoot = '';
let assetRoot = '';
let workspaceRoot = '';
let priorFleetSecret: string | undefined;

beforeEach(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'profile-dispatch-security-'));
  assetRoot = join(fixtureRoot, 'user-assets');
  workspaceRoot = join(fixtureRoot, 'task-workspaces');
  mkdirSync(join(assetRoot, 'profile-studio'), { recursive: true });
  mkdirSync(workspaceRoot, { recursive: true });
  hoisted.state.folderFor = (id: string) => join(workspaceRoot, id);
  hoisted.state.dispatchInput = null;
  hoisted.state.dispatchResult = { ok: true, clientId: 'desktop-a' };
  hoisted.state.clientAvailable = true;
  hoisted.beginDispatch.mockReset();
  hoisted.beginDispatch.mockResolvedValue(4);
  hoisted.failDispatch.mockReset();
  hoisted.failDispatch.mockResolvedValue(true);
  priorFleetSecret = process.env.SWARM_SERVICE_SECRET;
  process.env.SWARM_SERVICE_SECRET = 'fleet-secret-must-stay-out';
});

afterEach(() => {
  if (priorFleetSecret === undefined) delete process.env.SWARM_SERVICE_SECRET;
  else process.env.SWARM_SERVICE_SECRET = priorFleetSecret;
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('Profile Studio secure remote dispatch', () => {
  it('returns the generic authorization refusal without staging when no eligible worker exists', async () => {
    hoisted.state.clientAvailable = false;
    const result = await dispatchProfileUpdate(dispatchInput(plan('owner')));
    expect(result).toEqual({ ok: false, error: 'No authorized browser-control worker is available.' });
    expect(hoisted.beginDispatch).not.toHaveBeenCalled();
    expect(hoisted.state.dispatchInput).toBeNull();
  });

  it('stages relative assets and keeps all authority out of model-visible arguments', async () => {
    const photo = join(assetRoot, 'profile-studio', 'photo.png');
    const resume = join(assetRoot, 'profile-studio', 'Featured_Resume.pdf');
    writeFileSync(photo, pngBytes());
    writeFileSync(resume, Buffer.from('%PDF-1.7\nfixture'));
    const subject = ` auth0|'; Write-Output $env:SWARM_SERVICE_SECRET # `;
    const result = await dispatchProfileUpdate(dispatchInput(plan(subject, { photoPath: photo, resumePath: resume })));
    expect(result.ok).toBe(true);
    expect(hoisted.beginDispatch).toHaveBeenCalledOnce();
    expect(hoisted.beginDispatch.mock.calls[0][0]).toBe(subject);
    const input = hoisted.state.dispatchInput as any;
    const folder = join(workspaceRoot, input.workspacePath);
    expect(readFileSync(join(folder, 'profile-photo.png'))).toEqual(pngBytes());
    expect(readFileSync(join(folder, 'featured-resume.pdf'), 'utf8')).toContain('%PDF-1.7');
    const prompt = String(input.prompt);
    expect(prompt).toContain('./profile-photo.png');
    expect(prompt).toContain('./featured-resume.pdf');
    expect(prompt).not.toContain(assetRoot);
    expect(prompt).not.toContain(subject);
    expect(prompt).not.toContain('fleet-secret-must-stay-out');
    expect(prompt).not.toContain('Invoke-RestMethod');
    expect(input.completionCallback.url).toBe('https://registered-controller.example/api/profile-studio/ingest');
    expect(input.completionCallback.context.userSub).toBe(subject);
    expect(input.completionCallback.context.generation).toBe(4);
    expect(input.completionCallback.context.clientId).toBe('desktop-a');
    expect(prompt).not.toContain(input.completionCallback.capability);
    if (process.platform !== 'win32') expect(statSync(folder).mode & 0o777).toBe(0o700);
  });
});

describe('Profile Studio secure dispatch rollback', () => {
  it('fails before state transition and removes the workspace for missing or escaping assets', async () => {
    const missing = join(assetRoot, 'profile-studio', 'missing.png');
    expect((await dispatchProfileUpdate(dispatchInput(plan('owner', { photoPath: missing })))).ok).toBe(false);
    expect(hoisted.beginDispatch).not.toHaveBeenCalled();
    expect(hoisted.state.dispatchInput).toBeNull();
    expect(readdirSync(workspaceRoot)).toEqual([]);

    const outside = join(fixtureRoot, 'outside.png');
    writeFileSync(outside, pngBytes());
    expect((await dispatchProfileUpdate(dispatchInput(plan('owner', { photoPath: outside })))).ok).toBe(false);
    expect(hoisted.beginDispatch).not.toHaveBeenCalled();
    expect(readdirSync(workspaceRoot)).toEqual([]);
  });

  it('revokes the exact generation and cleans staged bytes when durable enqueue fails', async () => {
    const photo = join(assetRoot, 'profile-studio', 'photo.png');
    writeFileSync(photo, pngBytes());
    hoisted.state.dispatchResult = { ok: false, error: 'journal unavailable' };
    const result = await dispatchProfileUpdate(dispatchInput(plan('owner', { photoPath: photo })));
    expect(result.ok).toBe(false);
    const taskId = (hoisted.state.dispatchInput as any).taskId;
    expect(hoisted.failDispatch).toHaveBeenCalledWith('owner', 4, taskId, 'desktop-a', 'journal unavailable');
    expect(readdirSync(workspaceRoot)).toEqual([]);
  });
});

/** Build the complete approved domain plan with optional asset overrides. */
function plan(userSub: string, overrides: Partial<LinkedInProfilePlan> = {}): LinkedInProfilePlan {
  return {
    id: 7, userSub, headline: 'Platform leader', about: 'I ship systems.', skills: ['SRE'],
    customUrl: 'profile-owner', backgroundImagePath: null, photoPath: null, resumePath: null,
    state: 'approved', dispatchTaskId: null, dispatchClientId: null, dispatchGeneration: 3,
    resultNote: null, createdAt: '2026-08-05T00:00:00Z', updatedAt: '2026-08-05T00:00:00Z',
    ...overrides,
  };
}

/** Build the controller dispatch input around the stateful store fixture. */
function dispatchInput(value: LinkedInProfilePlan) {
  return {
    plan: value, assetRoot,
    store: { beginDispatch: hoisted.beginDispatch, failDispatch: hoisted.failDispatch },
  };
}

/** Return a small byte-valid PNG fixture. */
function pngBytes(): Buffer {
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from('fixture')]);
}
