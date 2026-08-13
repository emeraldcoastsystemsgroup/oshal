/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the ADR-129 amendment-2 dynamic bot runtime. The defect: the create-and-start path (an app package or the Bot Forge contributing a bot that needs its own node) was hard-wired to docker compose, so on a cluster it could only fail and roll the creation back — an installed app could never bring its bot with it, which defeats the store model. Pins: the factory drives a substrate-agnostic launcher (compose behavior unchanged, k8s launcher used in-pod), rollback removes the runtime on the SAME substrate, the k8s manifest matches the chart's bot shape (entrypoint/shared env/workspace/DNS-parity Service name), and the two security invariants — a caller can never choose the image, and a non-DNS-1123 name never reaches an API path. The manifest is additionally validated against the REAL Kubernetes API (server dry-run) by scripts/validate-dynamic-bot-manifest.mjs; a mock-only assertion is not closure for that boundary.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('@/shared/logger', () => ({
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  ComposeBotRuntimeLauncher,
  BOT_NAME_PATTERN,
  isRunningInKubernetes,
} from '../../src/features/agent-management/services/bot-runtime-launcher';
import {
  buildBotDeployment,
  buildBotService,
  KubernetesBotRuntimeLauncher,
} from '../../src/features/agent-management/services/kubernetes-bot-launcher';

const SPEC = {
  agentName: 'invoice-bot',
  agentId: 'a0000000-0000-0000-0000-0000000000ff',
  capabilities: 'invoice-parsing,ledger-sync',
};

describe('bot runtime launcher — substrate seam', () => {
  it('compose launcher registers the service then starts it (existing behavior)', async () => {
    const calls: string[] = [];
    const dynamicCompose = {
      upsertService: vi.fn(() => { calls.push('upsert'); return { success: true }; }),
      removeService: vi.fn(() => { calls.push('remove'); return { success: true }; }),
    } as any;
    const spawner = {
      startBot: vi.fn(async () => { calls.push('start'); return { success: true }; }),
      stopBot: vi.fn(async () => { calls.push('stop'); return { success: true }; }),
    } as any;

    const launcher = new ComposeBotRuntimeLauncher(dynamicCompose, spawner);
    const res = await launcher.launch(SPEC);

    expect(res).toEqual({ success: true, runtime: 'compose' });
    // Order is load-bearing: starting before the overlay exists starts nothing.
    expect(calls).toEqual(['upsert', 'start']);
    expect(dynamicCompose.upsertService).toHaveBeenCalledWith(
      expect.objectContaining({ agentName: SPEC.agentName, agentId: SPEC.agentId }),
    );
  });

  it('a failed container start reports failure rather than a phantom success', async () => {
    const launcher = new ComposeBotRuntimeLauncher(
      { upsertService: () => ({ success: true }) } as any,
      { startBot: async () => ({ success: false, error: 'no such image' }) } as any,
    );
    expect(await launcher.launch(SPEC)).toEqual({
      success: false, runtime: 'compose', error: 'no such image',
    });
  });

  it('a throwing stop still cleans the overlay (rollback must not depend on stop)', async () => {
    // Regression: remove() awaited stopBot(...).catch(), so a spawner whose stop
    // THREW synchronously (or lacked the method) propagated out and skipped
    // removeService entirely — leaving a dynamic compose entry for a deleted
    // agent. On the rollback path the container usually does not exist, which is
    // exactly when this fires.
    const removeService = vi.fn(() => ({ success: true }));
    const launcher = new ComposeBotRuntimeLauncher(
      { removeService } as any,
      { stopBot: () => { throw new Error('no such service'); } } as any,
    );
    const res = await launcher.remove(SPEC.agentName);
    expect(removeService).toHaveBeenCalledWith(SPEC.agentName);
    expect(res.success).toBe(true);
  });

  it('detects the cluster from the kubelet-injected env, not a config flag', () => {
    const prior = process.env.KUBERNETES_SERVICE_HOST;
    try {
      delete process.env.KUBERNETES_SERVICE_HOST;
      expect(isRunningInKubernetes()).toBe(false);
      process.env.KUBERNETES_SERVICE_HOST = '10.96.0.1';
      expect(isRunningInKubernetes()).toBe(true);
    } finally {
      if (prior === undefined) delete process.env.KUBERNETES_SERVICE_HOST;
      else process.env.KUBERNETES_SERVICE_HOST = prior;
    }
  });
});

describe('kubernetes bot manifest — chart parity', () => {
  const dep = buildBotDeployment(SPEC, 'oshal', 'ghcr.io/owner/oshal-bot:latest') as any;
  const container = dep.spec.template.spec.containers[0];
  const envOf = (k: string) => container.env.find((e: any) => e.name === k)?.value;

  it('runs the bot entrypoint, not the image default CMD', () => {
    // The image's default CMD boots the CONTROLLER — a bot pod without this
    // crash-loops on a missing SESSION_SECRET (the 0.1.3 chart fix).
    expect(container.args.join(' ')).toContain('bot-entrypoint.sh');
    expect(envOf('BOT_RUNTIME')).toBe('bot-node');
  });

  it('carries the identity the controller routes on', () => {
    expect(envOf('BOT_NAME')).toBe(SPEC.agentName);
    expect(envOf('AGENT_ID')).toBe(SPEC.agentId);
    expect(envOf('AGENT_CAPABILITIES')).toBe(SPEC.capabilities);
    expect(envOf('BOT_PERSONA_FILE')).toBe(`/app/ai-lab/bot-personas/${SPEC.agentName}.yaml`);
  });

  it('inherits the same shared env and workspace as a chart-declared bot', () => {
    expect(container.envFrom).toEqual([
      { configMapRef: { name: 'oshal-shared-env' } },
      { secretRef: { name: 'oshal-bot-env', optional: true } },
    ]);
    const mounts = container.volumeMounts.map((m: any) => m.mountPath);
    expect(mounts).toContain('/app/workspace-shared');
    const workspace = dep.spec.template.spec.volumes.find((v: any) => v.name === 'workspace');
    expect(workspace.persistentVolumeClaim.claimName).toBe('oshal-workspace');
  });

  it('a persona from an installed package is honored (packages live in the workspace)', () => {
    const pkgPersona = '/app/workspace-shared/deployed-apps/billing/personas/invoice-bot.yaml';
    const d = buildBotDeployment({ ...SPEC, personaFile: pkgPersona }, 'oshal', 'img') as any;
    expect(d.spec.template.spec.containers[0].env.find((e: any) => e.name === 'BOT_PERSONA_FILE').value)
      .toBe(pkgPersona);
  });

  it('Service name equals the bot name — that IS the DNS the controller dials', () => {
    const svc = buildBotService(SPEC.agentName, 'oshal') as any;
    expect(svc.metadata.name).toBe(SPEC.agentName);
    expect(svc.spec.selector['app.kubernetes.io/name']).toBe(SPEC.agentName);
    expect(svc.spec.ports[0].port).toBe(5000);
  });

  it('labels the runtime as controller-created so helm never adopts or deletes it', () => {
    expect(dep.metadata.labels['oshal.io/dynamic']).toBe('true');
  });
});

describe('kubernetes bot launcher — security invariants', () => {
  const access = { host: '10.96.0.1', port: '443', token: 't', namespace: 'oshal' } as any;

  it('uses the platform image; a caller cannot choose what runs', () => {
    const launcher = new KubernetesBotRuntimeLauncher(access, 'ghcr.io/owner/oshal-bot:pinned');
    // The launch spec has no image field at all — that is the invariant. If one is
    // ever added, this build call must keep ignoring it.
    const dep = buildBotDeployment(
      { ...SPEC, extraEnv: { X: '1' } } as any,
      'oshal',
      (launcher as any).image,
    ) as any;
    expect(dep.spec.template.spec.containers[0].image).toBe('ghcr.io/owner/oshal-bot:pinned');
    expect(Object.keys(SPEC as Record<string, unknown>)).not.toContain('image');
  });

  it('refuses a name that is not a DNS-1123 label (it lands in an API path)', async () => {
    const launcher = new KubernetesBotRuntimeLauncher(access, 'img');
    for (const bad of ['../../secrets', 'Bad_Name', 'a'.repeat(64), 'x/y', '-lead']) {
      expect(BOT_NAME_PATTERN.test(bad)).toBe(false);
      const res = await launcher.launch({ ...SPEC, agentName: bad });
      expect(res.success).toBe(false);
      expect(res.error).toContain('invalid bot name');
      const removal = await launcher.remove(bad);
      expect(removal.success).toBe(false);
    }
  });

  it('accepts ordinary bot slugs', () => {
    for (const ok of ['invoice-bot', 'career-hunter-node', 'b1', 'a'.repeat(63)]) {
      expect(BOT_NAME_PATTERN.test(ok)).toBe(true);
    }
  });
});
