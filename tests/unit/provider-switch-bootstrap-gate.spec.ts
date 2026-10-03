/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove canonical dispatch waits for the first persisted provider-switch read, observes the saved Sales Gemini row instead of the registry Codex fallback, and propagates an initial read outage.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Lock production composition to the snapshot's independent fallback-order resolver so provider stamping cannot regress to reading only the provider-winning row.
 */

import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  gateRuntimeParamsResolverOnProviderSwitchSnapshot,
  installProviderSwitchSnapshot,
  installedProviderSwitchSnapshot,
  ProviderSwitchSnapshotNotReadyError,
  resolveInstalledProviderSwitch,
  setInstalledProviderSwitchSnapshot,
  trackProviderSwitchSnapshotInstallation,
} from '@/app/composition/provider-switch-runtime';
import type { ProviderSwitchRow } from '@/shared/llm-runtime';

const SALES_AGENT = '15000000-0000-0000-0000-000000000001';
const REGISTRY_CODEX = { harnessType: 'codex-cli', apiType: 'openai-codex' };

function salesRow(): ProviderSwitchRow {
  return {
    scopeId: SALES_AGENT,
    providerId: 'gemini',
    modelId: 'gemini-3.8-flash',
    updatedBy: 'operator',
    updatedAt: '2026-09-29T00:00:00.000Z',
  };
}

afterEach(() => {
  setInstalledProviderSwitchSnapshot(null, null);
  vi.unstubAllEnvs();
});

describe('provider-switch first-snapshot dispatch gate', () => {
  it('waits for the persisted row and resolves Sales Gemini rather than the registry Codex fallback', async () => {
    vi.stubEnv('OSHAL_PROVIDER_SWITCH_REFRESH_MS', '0');
    let release!: (rows: ProviderSwitchRow[]) => void;
    const source = { listAll: vi.fn(() => new Promise<ProviderSwitchRow[]>((resolve) => { release = resolve; })) };
    const installation = installProviderSwitchSnapshot(source, ['codex-cli', 'cline']);
    trackProviderSwitchSnapshotInstallation(installation);
    const underlying = vi.fn(async () => {
      const resolved = resolveInstalledProviderSwitch(SALES_AGENT, REGISTRY_CODEX);
      return resolved.providerId ? { providerId: resolved.providerId, model: resolved.modelId ?? undefined } : null;
    });
    const gated = gateRuntimeParamsResolverOnProviderSwitchSnapshot(underlying);

    const resolution = gated(SALES_AGENT);
    await Promise.resolve();
    expect(underlying).not.toHaveBeenCalled();

    release([salesRow()]);
    await expect(resolution).resolves.toEqual({ providerId: 'gemini', model: 'gemini-3.8-flash' });
    expect(underlying).toHaveBeenCalledWith(SALES_AGENT);
    (await installation).stop();
  });

  it('propagates a failed first read, then recovers on refresh without using the registry fallback', async () => {
    vi.stubEnv('OSHAL_PROVIDER_SWITCH_REFRESH_MS', '0');
    const outage = new Error('switch table temporarily unavailable');
    const source = {
      listAll: vi.fn()
        .mockRejectedValueOnce(outage)
        .mockResolvedValueOnce([salesRow()]),
    };
    const installation = installProviderSwitchSnapshot(source, ['codex-cli', 'cline']);
    trackProviderSwitchSnapshotInstallation(installation);
    const underlying = vi.fn(async () => {
      const resolved = resolveInstalledProviderSwitch(SALES_AGENT, REGISTRY_CODEX);
      return resolved.providerId ? { providerId: resolved.providerId, model: resolved.modelId ?? undefined } : null;
    });
    const gated = gateRuntimeParamsResolverOnProviderSwitchSnapshot(underlying);

    await expect(gated(SALES_AGENT)).rejects.toBeInstanceOf(ProviderSwitchSnapshotNotReadyError);
    expect(underlying).not.toHaveBeenCalled();

    const snapshot = installedProviderSwitchSnapshot();
    expect(snapshot).not.toBeNull();
    await snapshot!.refresh();
    await expect(gated(SALES_AGENT)).resolves.toEqual({
      providerId: 'gemini', model: 'gemini-3.8-flash',
    });
    snapshot!.stop();
  });

  it('wires the tracked boot promise and gated resolver into the two production composition seams', () => {
    const bootstrap = readFileSync('src/app/composition/server-bootstrap-tasks.ts', 'utf8');
    const swarm = readFileSync('src/app/extensions/swarm/index.ts', 'utf8');
    expect(bootstrap).toContain('trackProviderSwitchSnapshotInstallation(installation)');
    expect(swarm).toContain('gateRuntimeParamsResolverOnProviderSwitchSnapshot(baseRuntimeParamsResolver)');
    expect(swarm).toMatch(
      /createAgentConfigRuntimeParamsResolver\([\s\S]*?resolveInstalledProviderSwitch[\s\S]*?resolveInstalledProviderFallbackOrder,\s*\)/,
    );
  });
});
