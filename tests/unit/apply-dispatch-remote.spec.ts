/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard remote packet staging and dispatch.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Guard collision-resistant task ids, bounded
 *   regular/data files, public HTTP(S) job targets, prompt/data separation, and exact workspace
 *   cleanup. Callback credentials and sensitive task values must remain outside model arguments.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Model an explicitly browser-capable and browser-pilot-consented remote worker under the hardened shared selector.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Keep success, input-refusal, and rollback behavior groups below the repository function-length limit.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Prove the remote task binds its exact worker through the Apply V2 ledger before capability issuance and enqueue.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';

const hoisted = vi.hoisted(() => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-dispatch-spec-'));
  const resumeSrc = path.join(base, 'src-Resume.pdf');
  fs.writeFileSync(resumeSrc, '%PDF-1.4 unit-test resume');
  const promptModule = path.join(base, 'fixture-apply-prompt.js');
  fs.writeFileSync(promptModule,
    "module.exports = { buildApplyPrompt: (_input, opts) => " +
    "`Use ./Resume_ATS.pdf, ./job.json, and ./profile.json. Cover: ${opts.hasCover}. Return one JSON object.` };",
  );
  process.env.APPLY_PROMPT_MODULE = promptModule;
  const enqueued: Array<{ clientId: string; env: Record<string, any> }> = [];
  const state = { depth: 0, failEnqueue: false };
  const capabilities = { issued: [] as Array<Record<string, unknown>>, revoked: [] as string[] };
  return { base, resumeSrc, enqueued, state, capabilities, queueDepth: () => state.depth, folderFor: (id: string) => path.join(base, id) };
});

vi.mock('@/app/routes/remote-client-routes', () => ({
  remoteClientRegistry: {
    listClients: () => [{
      clientId: 'oshal-chat-0ce849b6-8b95-4cf5-9223-ce22d638f1c9',
      status: 'online', healthy: true, ownerSub: 'example-user-sub',
      capabilities: ['codex.exec', 'browser_control'], tags: ['browser_pilot_consent'],
      controlPlaneUrl: 'http://203.0.113.10:35457',
      taskQueueDepth: hoisted.queueDepth(),
    }],
    enqueueTask: (clientId: string, env: Record<string, any>) => {
      if (hoisted.state.failEnqueue) throw new Error('durable enqueue unavailable');
      hoisted.enqueued.push({ clientId, env });
      return { taskId: env.taskId };
    },
  },
  taskWorkspaceFolder: (id: string) => hoisted.folderFor(id),
}));

vi.mock('@/app/apply-task-capability', () => ({
  issueApplyCapability: async (_pool: unknown, binding: Record<string, unknown>) => {
    hoisted.capabilities.issued.push(binding);
    return { token: 'C'.repeat(43), generation: 7, expiresAt: '2026-08-05T22:00:00.000Z' };
  },
  revokeApplyCapability: async (_pool: unknown, taskId: string) => { hoisted.capabilities.revoked.push(taskId); },
}));

vi.mock('@/app/apply-run-ledger', () => ({
  bindApplyRunDispatch: async (_pool: unknown, runId: string, taskId: string, clientId: string) => ({
    runId, taskId, workerClientId: clientId, state: 'queued_to_worker',
  }),
  transitionApplyRun: async () => ({ state: 'failed' }),
}));

import { dispatchApply, removeApplyWorkspace, type ApplyDispatchInput } from '@/app/apply-dispatch';
import { promises as fsp } from 'node:fs';

const DEPS = { pool: {} as Pool };

function baseInput(): ApplyDispatchInput {
  return {
    applyRunId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    timeoutAt: new Date('2030-08-06T08:30:00.000Z'),
    ticketId: '1986677e-82de-4239-a8c3-c238e727d5d5',
    settleTicket: true,
    finalSubmitAuthorized: false,
    userSub: 'example-user-sub',
    postingId: 1147705,
    job: { title: 'Senior SE', company: 'Two Six Technologies', url: 'https://203.0.113.25/2six', location: 'Remote, US' },
    profile: { name: 'oshal maintainers', phone: '+15551234567', authorized: 'Yes' },
    packet: { resumePdf: hoisted.resumeSrc, coverPdf: null, workdayAutofill: null },
  };
}

function applyDirs(): string[] {
  return readdirSync(hoisted.base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('apply-'))
    .map((entry) => entry.name);
}

beforeEach(() => {
  hoisted.enqueued.length = 0;
  hoisted.state.depth = 0;
  hoisted.state.failEnqueue = false;
  hoisted.capabilities.issued.length = 0;
  hoisted.capabilities.revoked.length = 0;
});

afterAll(async () => {
  await fsp.rm(hoisted.base, { recursive: true, force: true }).catch(() => undefined);
});

describe('remote-box apply dispatch', () => {
  it('stages bounded data separately and sends no sensitive values in model arguments', async () => {
    const input = baseInput();
    const result = await dispatchApply(input, DEPS);

    expect(result.ok).toBe(true);
    expect(hoisted.enqueued).toHaveLength(1);
    const { env } = hoisted.enqueued[0];
    const folder = hoisted.folderFor(env.taskId);
    expect(env.taskId).toMatch(/^apply-[0-9a-f-]{36}$/i);
    expect(env.workspacePath).toBe(env.taskId);
    expect(existsSync(join(folder, 'Resume_ATS.pdf'))).toBe(true);
    expect(JSON.parse(await fsp.readFile(join(folder, 'job.json'), 'utf8'))).toMatchObject(input.job);
    expect(JSON.parse(await fsp.readFile(join(folder, 'profile.json'), 'utf8'))).toEqual(input.profile);

    const prompt = String(env.input.arguments.prompt);
    expect(prompt).toContain('./Resume_ATS.pdf');
    expect(prompt).toContain('./job.json');
    for (const secret of [input.ticketId, input.userSub, input.job.url, '203.0.113.10:35457']) {
      expect(prompt).not.toContain(secret);
    }
    expect(env.completionCallback).toMatchObject({
      kind: 'trusted-http-json-v1', capability: 'C'.repeat(43),
      url: 'http://203.0.113.10:35457/api/apply/ingest',
      context: { workflow: 'apply', generation: 7 },
    });
    expect(JSON.stringify(env.input.arguments)).not.toContain('C'.repeat(43));
    expect(hoisted.capabilities.issued[0]).toMatchObject({ taskId: env.taskId, userSub: input.userSub, clientId: env.toAgentId });
    await removeApplyWorkspace(env.taskId);
    expect(existsSync(folder)).toBe(false);
  });

  it('uses unique random workspace ids for repeated dispatches', async () => {
    const first = await dispatchApply(baseInput(), DEPS);
    const second = await dispatchApply(baseInput(), DEPS);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(first.taskId).not.toBe(second.taskId);
    await Promise.all([removeApplyWorkspace(first.taskId!), removeApplyWorkspace(second.taskId!)]);
  });
});

describe('remote-box apply dispatch — bounded input and worker refusal', () => {
  it('rejects private/non-HTTP job targets before staging or enqueue', async () => {
    const before = applyDirs();
    const input = baseInput();
    input.job.url = 'http://169.254.169.254/latest/meta-data';
    const result = await dispatchApply(input, DEPS);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/public HTTP/i);
    expect(hoisted.enqueued).toHaveLength(0);
    expect(applyDirs()).toEqual(before);
  });

  it('removes partial staging when the resume is absent or JSON exceeds its cap', async () => {
    const before = applyDirs().length;
    const missing = baseInput();
    missing.packet.resumePdf = join(hoisted.base, 'does-not-exist.pdf');
    expect((await dispatchApply(missing, DEPS)).ok).toBe(false);

    const oversized = baseInput();
    oversized.profile = { value: 'x'.repeat(600 * 1024) };
    expect((await dispatchApply(oversized, DEPS)).ok).toBe(false);
    expect(hoisted.enqueued).toHaveLength(0);
    expect(applyDirs()).toHaveLength(before);
  });

  it('refuses a worker that stopped draining and removes its staged packet', async () => {
    const before = applyDirs().length;
    hoisted.state.depth = 1;
    expect((await dispatchApply(baseInput(), DEPS)).ok).toBe(false);
    expect(hoisted.enqueued).toHaveLength(0);
    expect(applyDirs()).toHaveLength(before);
  });
});

describe('remote-box apply dispatch — rollback and dependency refusal', () => {
  it('revokes the minted capability and removes staging when durable enqueue fails', async () => {
    const before = applyDirs().length;
    hoisted.state.failEnqueue = true;
    const result = await dispatchApply(baseInput(), DEPS);
    expect(result.ok).toBe(false);
    expect(hoisted.capabilities.issued).toHaveLength(1);
    expect(hoisted.capabilities.revoked).toEqual([hoisted.capabilities.issued[0].taskId]);
    expect(applyDirs()).toHaveLength(before);
  });

  it('defers and cleans staging when the Career Hunter prompt module is absent', async () => {
    const saved = { module: process.env.APPLY_PROMPT_MODULE, workspace: process.env.CLINE_WORKSPACE_ROOT, store: process.env.OSHAL_STORE_DIR };
    process.env.APPLY_PROMPT_MODULE = join(hoisted.base, 'no-such-module.js');
    process.env.CLINE_WORKSPACE_ROOT = hoisted.base;
    delete process.env.OSHAL_STORE_DIR;
    const before = applyDirs().length;
    try {
      const result = await dispatchApply(baseInput(), DEPS);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/apply module is not installed/i);
      expect(hoisted.enqueued).toHaveLength(0);
      expect(applyDirs()).toHaveLength(before);
    } finally {
      process.env.APPLY_PROMPT_MODULE = saved.module;
      if (saved.workspace === undefined) delete process.env.CLINE_WORKSPACE_ROOT; else process.env.CLINE_WORKSPACE_ROOT = saved.workspace;
      if (saved.store === undefined) delete process.env.OSHAL_STORE_DIR; else process.env.OSHAL_STORE_DIR = saved.store;
    }
  });
});
