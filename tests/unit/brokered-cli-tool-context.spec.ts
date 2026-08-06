/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Explicit 20s timeout on the extraEnv round-trip test: it executes REAL connector CLIs through ToolRegistry (node child processes), and vitest's default 5s is borderline on this loaded shared workstation — it passed the 044a396 full-gate run, then timed out on the 06de7a2 run 40 minutes later (1/3681), with the afterEach EPERM on the temp dir as cascade from the orphaned child. Same machine-load reality the e2e gate already institutionalized retries for; the timeout was never a chosen assertion.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Pin exact owner propagation through ToolRegistry and fail-closed invalid subject or uncontained task cwd handling.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05: prove generic credential carriers are rejected before tool handlers and legacy connector subprocess execution remains disabled pending an audited broker.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Retire the remaining SmartThings and GCP raw subprocess carriers and prove they return the same broker denial without accepting model-owned identity.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const requireModule = createRequire(import.meta.url);
const ToolRegistry = requireModule('../../any-bot/server/services/ToolRegistry.js');
const walmartTools = requireModule('../../any-bot/server/services/tools/purchasing/walmartToolKit.js');
const uberTools = requireModule('../../any-bot/server/services/tools/eats/uberToolKit.js');
const smartThingsTools = requireModule('../../any-bot/server/services/tools/smart-home/smartthingsToolKit.js');
const gcpTools = requireModule('../../any-bot/server/services/tools/gcp/gcpToolKit.js');

describe('brokered connector tool execution context', () => {
  let root: string;
  let originalWorkspaceDir: string | undefined;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-brokered-tools-'));
    originalWorkspaceDir = process.env.WORKSPACE_DIR;
    process.env.WORKSPACE_DIR = root;
  });

  afterEach(() => {
    if (originalWorkspaceDir === undefined) delete process.env.WORKSPACE_DIR;
    else process.env.WORKSPACE_DIR = originalWorkspaceDir;
    fs.rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('passes handlers only the exact identity and rejects generic broker credentials', async () => {
    const registry = new ToolRegistry();
    const handler = vi.fn(async (_input: unknown, context: unknown) => context);
    registry.register({ name: 'capture-context', handler, requiresApproval: false });

    await expect(registry.execute('capture-context', {}, {
      taskWorkspace: root,
      extraEnv: {
        OSHAL_USER_SUB: '  owner-123  ',
        OSHAL_CRED_WALMART: 'walmart-token',
        PATH: '/attacker/bin',
        OSHAL_CRED_UNKNOWN: 'forbidden-token',
      },
    })).rejects.toMatchObject({ code: 'UNSCOPED_CREDENTIAL_CARRIER' });
    expect(handler).not.toHaveBeenCalled();

    const result = await registry.execute('capture-context', {}, {
      taskWorkspace: root,
      extraEnv: { OSHAL_USER_SUB: '  owner-123  ', PATH: '/attacker/bin' },
    });
    expect(result).toMatchObject({
      taskWorkspace: root,
      extraEnv: { OSHAL_USER_SUB: '  owner-123  ' },
    });
    expect((result as { extraEnv: Record<string, string> }).extraEnv).not.toHaveProperty('PATH');
    expect((result as { extraEnv: Record<string, string> }).extraEnv).not.toHaveProperty('OSHAL_CRED_UNKNOWN');
  });

  it('rejects malformed identities and task workspaces outside the configured roots', async () => {
    const registry = new ToolRegistry();
    registry.register({ name: 'capture-boundary', handler: async () => 'unexpected', requiresApproval: false });
    await expect(registry.execute('capture-boundary', {}, {
      taskWorkspace: root,
      extraEnv: { OSHAL_USER_SUB: 'owner\u0000alias' },
    })).rejects.toMatchObject({ code: 'INVALID_USER_SUBJECT' });
    await expect(registry.execute('capture-boundary', {}, {
      taskWorkspace: path.parse(root).root,
      extraEnv: { OSHAL_USER_SUB: 'owner-123' },
    })).rejects.toMatchObject({ code: 'UNSAFE_TASK_WORKSPACE' });
  });

  it('rejects request credentials before connector tool execution', async () => {
    const shoppingWorkspace = path.join(root, 'shopping-owner');
    const eatsWorkspace = path.join(root, 'eats-owner');
    fs.mkdirSync(shoppingWorkspace, { recursive: true });
    fs.mkdirSync(eatsWorkspace, { recursive: true });

    expect(fs.existsSync(path.join(shoppingWorkspace, '.oshal-cred-walmart'))).toBe(false);
    expect(fs.existsSync(path.join(eatsWorkspace, '.oshal-cred-uber'))).toBe(false);

    const registry = new ToolRegistry();
    registry.register({
      name: 'walmart-accounts',
      handler: walmartTools['walmart-accounts'],
      requiresApproval: false,
    });
    registry.register({
      name: 'uber-accounts',
      handler: uberTools['uber-accounts'],
      requiresApproval: false,
    });

    await expect(registry.execute(
      'walmart-accounts',
      { taskWorkspace: path.parse(root).root },
      {
        taskWorkspace: shoppingWorkspace,
        extraEnv: {
          OSHAL_USER_SUB: 'owner-123',
          OSHAL_CRED_WALMART: JSON.stringify({
            consumerId: 'sentinel-consumer',
            privateKeyPem: 'sentinel-private-key',
          }),
        },
      },
    )).rejects.toMatchObject({ code: 'UNSCOPED_CREDENTIAL_CARRIER' });
    await expect(registry.execute(
      'uber-accounts',
      { taskWorkspace: path.parse(root).root },
      {
        taskWorkspace: eatsWorkspace,
        extraEnv: {
          OSHAL_USER_SUB: 'owner-123',
          OSHAL_CRED_UBER: 'sentinel-affiliate',
        },
      },
    )).rejects.toMatchObject({ code: 'UNSCOPED_CREDENTIAL_CARRIER' });

    // The post-wrapper tool hop is env-only; it must not recreate credential files.
    expect(fs.existsSync(path.join(shoppingWorkspace, '.oshal-cred-walmart'))).toBe(false);
    expect(fs.existsSync(path.join(eatsWorkspace, '.oshal-cred-uber'))).toBe(false);
  });

  it('constructs no credential-bearing child environment', () => {
    const runner = requireModule('../../any-bot/server/services/tools/brokered-cli-runner.js');
    const priorWalmart = process.env.OSHAL_CRED_WALMART;
    const priorUber = process.env.OSHAL_CRED_UBER;
    process.env.OSHAL_CRED_WALMART = 'stale-walmart-owner';
    process.env.OSHAL_CRED_UBER = 'stale-uber-owner';
    try {
      const env = runner.trustedChildEnv({ OSHAL_CRED_UBER: 'current-uber-owner' });
      expect(env).not.toHaveProperty('OSHAL_CRED_WALMART');
      expect(env).not.toHaveProperty('OSHAL_CRED_UBER');
    } finally {
      if (priorWalmart === undefined) delete process.env.OSHAL_CRED_WALMART;
      else process.env.OSHAL_CRED_WALMART = priorWalmart;
      if (priorUber === undefined) delete process.env.OSHAL_CRED_UBER;
      else process.env.OSHAL_CRED_UBER = priorUber;
    }
  });

  it('returns a stable denial without spawning a connector subprocess', async () => {
    const runner = requireModule('../../any-bot/server/services/tools/brokered-cli-runner.js');
    await expect(runner.runBrokeredCli({
      script: 'oshal-walmart.js',
      args: ['accounts'],
      context: { taskWorkspace: root, extraEnv: { OSHAL_USER_SUB: 'owner-123' } },
      errorLabel: 'walmart',
    })).resolves.toEqual({
      error: 'connector_cli_disabled_pending_audited_broker',
      provider: 'walmart',
    });
  });

  it.each([
    ['smartthings', smartThingsTools['smartthings-accounts']],
    ['gcp', gcpTools['gcp-accounts']],
  ])('keeps %s behind the audited-broker boundary', async (provider, handler) => {
    await expect(handler(
      { userSub: 'model-selected-owner', label: 'model-selected-account' },
      { taskWorkspace: root, extraEnv: { OSHAL_USER_SUB: 'trusted-owner' } },
    )).resolves.toEqual({
      error: 'connector_cli_disabled_pending_audited_broker',
      provider,
    });
  });
});
