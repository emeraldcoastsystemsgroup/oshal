/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the storyboard image default following the swarm default (ADR-130 amendment 2026-10-02). Pins the mapping through the REAL resolver: in demo mode the fleet-default harness picks the rail (antigravity-cli -> antigravity-cli, openai-codex and codex-cli -> codex-cli); a harness with no image rail (claude-code, cline, gemini-cli) fails closed with "the swarm default <harness> cannot make images; set STORYBOARD_IMAGE_PROVIDER" and never reaches a paid provider; an explicit STORYBOARD_IMAGE_PROVIDER always wins; the non-demo default stays codex; no fleet row (or no reader) keeps codex-cli; a switch that has not loaded, or a reader that throws, fails closed; a non-operator caller of the antigravity default is refused as not configured with no fallback. The boot reader is the REAL readFleetDefaultHarness over the REAL ProviderSwitchSnapshot (an in-memory store is the only double): a fleet-default write followed by the snapshot's own refresh moves the image rail with no re-registration and no restart.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  registerStoryboardSwarmDefaultReader,
  selectStoryboardImageProvider,
  type StoryboardSwarmDefault,
} from '../../src/features/video-generation/services/storyboard-image-default';
import { resolveStoryboardImageProvider } from '../../src/features/video-generation/services/storyboard-image-providers';
import { registerCliStoryboardImageExecutor } from '../../src/features/video-generation/services/storyboard-cli-image-executor';
import { readFleetDefaultHarness } from '../../src/app/storyboard-cli-image-wiring';
import { setInstalledProviderSwitchSnapshot } from '../../src/app/composition/provider-switch-runtime';
import { ProviderSwitchSnapshot } from '../../src/features/agent-management/services/provider-switch-snapshot';
import type { ProviderSwitchRow } from '../../src/shared/llm-runtime';

const OPERATOR = 'operator-sub-1';
const ENV_KEYS = ['STORYBOARD_IMAGE_PROVIDER', 'DEMO_MODE', 'OSHAL_OPERATOR_SUBS'] as const;
const CATALOG = { harnessTypes: ['codex-cli', 'antigravity-cli', 'claude-code', 'cline', 'gemini-cli'], clineApiProviders: ['gemini'] };

const fleet = (harness: string | null, loaded = true): void => {
  registerStoryboardSwarmDefaultReader((): StoryboardSwarmDefault => ({ loaded, harness }));
};
const refusal = (promise: Promise<unknown>): Promise<Error | null> => promise.then(() => null, (e: Error) => e);

/** The fleet-default row store the real snapshot reads; the only double in the reader case. */
function memoryRows(): { rows: Map<string, ProviderSwitchRow>; source: { listAll(): Promise<ProviderSwitchRow[]> } } {
  const rows = new Map<string, ProviderSwitchRow>();
  return { rows, source: { listAll: async () => Array.from(rows.values()) } };
}
const fleetRow = (providerId: string): ProviderSwitchRow => ({ scopeId: 'fleet-default', providerId, modelId: null, updatedBy: OPERATOR, updatedAt: new Date().toISOString() });

describe('storyboard image default follows the swarm default (ADR-130, 2026-10-02)', () => {
  const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    delete process.env.STORYBOARD_IMAGE_PROVIDER;
    process.env.DEMO_MODE = 'true';
    process.env.OSHAL_OPERATOR_SUBS = OPERATOR;
    registerStoryboardSwarmDefaultReader(null);
    registerCliStoryboardImageExecutor(async () => ({ success: false, responseText: '', error: 'never called here' }));
    setInstalledProviderSwitchSnapshot(null);
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      const v = savedEnv[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    registerStoryboardSwarmDefaultReader(null);
    registerCliStoryboardImageExecutor(null);
    setInstalledProviderSwitchSnapshot(null);
  });

  it('antigravity-cli as the swarm default resolves the antigravity-cli rail for the operator', async () => {
    fleet('antigravity-cli');
    expect(selectStoryboardImageProvider()).toEqual({ ok: true, id: 'antigravity-cli', source: 'swarm-default', swarmDefault: 'antigravity-cli' });
    const provider = await resolveStoryboardImageProvider({ userSub: OPERATOR });
    expect(provider.id).toBe('antigravity-cli');
    expect(provider.costClass).toBe('free');
  });

  it.each(['openai-codex', 'codex-cli', 'OpenAI-Codex'])('%s as the swarm default resolves codex-cli', async (harness) => {
    fleet(harness);
    expect((await resolveStoryboardImageProvider({ userSub: OPERATOR })).id).toBe('codex-cli');
  });

  it.each(['claude-code', 'cline', 'gemini-cli', 'gemini'])('%s as the swarm default fails closed and names the override', async (harness) => {
    fleet(harness);
    const err = await refusal(resolveStoryboardImageProvider({ userSub: OPERATOR }));
    expect(err?.message).toContain(`the swarm default ${harness} cannot make images; set STORYBOARD_IMAGE_PROVIDER`);
    expect(err?.message).toContain('Refusing to fall back to a paid provider');
  });

  it('an explicit STORYBOARD_IMAGE_PROVIDER wins over every swarm default, including one that cannot make images', async () => {
    fleet('claude-code');
    process.env.STORYBOARD_IMAGE_PROVIDER = 'codex-cli';
    expect((await resolveStoryboardImageProvider({ userSub: OPERATOR })).id).toBe('codex-cli');
    fleet('antigravity-cli');
    process.env.STORYBOARD_IMAGE_PROVIDER = 'comfyui';
    expect(selectStoryboardImageProvider()).toMatchObject({ ok: true, id: 'comfyui', source: 'explicit' });
  });

  it('outside demo mode the default stays codex whatever the swarm default is', () => {
    delete process.env.DEMO_MODE;
    fleet('antigravity-cli');
    expect(selectStoryboardImageProvider()).toEqual({ ok: true, id: 'codex', source: 'platform-default', swarmDefault: null });
  });

  it('no fleet-default row, or no reader at all, keeps the ADR-130 codex-cli default', () => {
    expect(selectStoryboardImageProvider()).toMatchObject({ ok: true, id: 'codex-cli', source: 'demo-default' });
    fleet(null);
    expect(selectStoryboardImageProvider()).toMatchObject({ ok: true, id: 'codex-cli', source: 'demo-default' });
  });

  it('a switch that has not loaded, or a reader that throws, fails closed', async () => {
    fleet(null, false);
    expect((await refusal(resolveStoryboardImageProvider({ userSub: OPERATOR })))?.message).toMatch(/the swarm default is not known yet.*set STORYBOARD_IMAGE_PROVIDER/);
    registerStoryboardSwarmDefaultReader(() => { throw new Error('snapshot exploded'); });
    expect(selectStoryboardImageProvider()).toMatchObject({ ok: false });
  });

  it('a non-operator caller of the antigravity default is refused as not configured, with no fallback', async () => {
    fleet('antigravity-cli');
    const err = await refusal(resolveStoryboardImageProvider({ userSub: 'someone-else' }));
    expect(err?.message).toMatch(/storyboard image provider 'antigravity-cli' is not configured/);
    expect(err?.message).toMatch(/Refusing to fall back/);
  });

  it('the boot reader follows the real switch snapshot: a fleet write moves the rail at the next refresh, no restart', async () => {
    registerStoryboardSwarmDefaultReader(readFleetDefaultHarness);
    expect(selectStoryboardImageProvider(), 'no switch store in this process').toMatchObject({ ok: true, id: 'codex-cli', source: 'demo-default' });

    const { rows, source } = memoryRows();
    const snapshot = new ProviderSwitchSnapshot(source, CATALOG);
    setInstalledProviderSwitchSnapshot(snapshot, CATALOG);
    expect(selectStoryboardImageProvider(), 'installed but not read yet').toMatchObject({ ok: false });

    rows.set('fleet-default', fleetRow('antigravity-cli'));
    await snapshot.refresh();
    expect(selectStoryboardImageProvider()).toEqual({ ok: true, id: 'antigravity-cli', source: 'swarm-default', swarmDefault: 'antigravity-cli' });

    rows.set('fleet-default', fleetRow('openai-codex'));
    expect(selectStoryboardImageProvider(), 'before the refresh the last read stands').toMatchObject({ id: 'antigravity-cli' });
    await snapshot.refresh();
    expect(selectStoryboardImageProvider()).toMatchObject({ ok: true, id: 'codex-cli', swarmDefault: 'openai-codex' });

    rows.set('fleet-default', fleetRow('claude-code'));
    await snapshot.refresh();
    expect(selectStoryboardImageProvider()).toMatchObject({ ok: false, swarmDefault: 'claude-code' });

    rows.delete('fleet-default');
    await snapshot.refresh();
    expect(selectStoryboardImageProvider()).toMatchObject({ ok: true, id: 'codex-cli', source: 'demo-default' });
  });
});
