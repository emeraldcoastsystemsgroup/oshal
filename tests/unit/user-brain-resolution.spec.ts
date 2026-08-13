/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for ADR-127 brain resolution. Pins the order that decides what every turn runs on — a saved preference first, the demo CLI default (Claude Code) next for a caller the carve covers, hosted rungs after — and the two invariants that keep the CLI shape safe: it is offered ONLY to a demo-mode operator, and a preference naming it degrades to a hosted rung rather than handing the node a selection it would refuse.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Codex-first fleet default: the demo-default expectations flip to openai-codex (DEMO_CLI_ORDER reordered by operator directive 2026-08-12); the saved-preference test now saves claude-code so it still proves preference-beats-default with a non-default value.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getUserLlmConnection = vi.fn();
const resolveUserLlmConnection = vi.fn();
const resolveLiveFreeTierConnection = vi.fn();
const demoKeysEnabled = vi.fn();
const query = vi.fn();

vi.mock('../../src/app/routes/byo-llm-routes', () => ({
  getUserLlmConnection: (...a: unknown[]) => getUserLlmConnection(...a),
  ANY_LLM_PROVIDER: 'any-llm',
}));

vi.mock('../../src/app/routes/free-tier-rotation', () => ({
  resolveUserLlmConnection: (...a: unknown[]) => resolveUserLlmConnection(...a),
  resolveLiveFreeTierConnection: (...a: unknown[]) => resolveLiveFreeTierConnection(...a),
}));

// The demo predicate is the REAL shared one (src/shared/deployment-mode); only DEMO_MODE is stubbed,
// so this spec exercises the same env parsing the bot node's preflight uses.
vi.mock('@/shared/deployment-mode', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/shared/deployment-mode')>();
  return { ...actual, demoModeEnabled: () => demoKeysEnabled() };
});

vi.mock('@/shared/services/database', () => ({
  runRuntimeSchemaBootstrap: async () => 'validated',
}));

import { cliBrainAvailable, resolveUserBrain } from '../../src/app/routes/user-brain-resolution';

const OPERATOR = 'operator-sub-1';
const GUEST = 'guest-sub-9';
const pool = { query: (...a: unknown[]) => query(...a) };
const HOSTED = { baseUrl: 'https://api.example/v1', apiKey: 'k', model: 'm' };

/** Make the preference read return a given saved row (or none). */
function savedPreference(preferred?: string, model?: string) {
  query.mockResolvedValue({ rows: preferred ? [{ preferred_provider: preferred, preferred_model: model ?? null }] : [] });
}

let savedSubs: string | undefined;

beforeEach(() => {
  savedSubs = process.env.OSHAL_OPERATOR_SUBS;
  process.env.OSHAL_OPERATOR_SUBS = OPERATOR;
  query.mockReset();
  getUserLlmConnection.mockReset().mockResolvedValue(null);
  resolveUserLlmConnection.mockReset().mockResolvedValue(undefined);
  resolveLiveFreeTierConnection.mockReset().mockResolvedValue(null);
  demoKeysEnabled.mockReset().mockReturnValue(true);
  savedPreference();
});

afterEach(() => {
  if (savedSubs === undefined) delete process.env.OSHAL_OPERATOR_SUBS;
  else process.env.OSHAL_OPERATOR_SUBS = savedSubs;
});

describe('who may be offered a CLI brain', () => {
  it('is the demo-mode operator, and nobody else', () => {
    expect(cliBrainAvailable(OPERATOR)).toBe(true);
    expect(cliBrainAvailable(GUEST)).toBe(false);
    expect(cliBrainAvailable('')).toBe(false);
    demoKeysEnabled.mockReturnValue(false);
    expect(cliBrainAvailable(OPERATOR)).toBe(false);
  });
});

describe('resolveUserBrain — the ladder', () => {
  it('defaults the demo operator to the Codex CLI (the swarm default, 2026-08-12)', async () => {
    expect(await resolveUserBrain(pool, OPERATOR)).toEqual({ kind: 'cli', providerId: 'openai-codex' });
  });

  it('honours a saved CLI preference over the default one', async () => {
    savedPreference('claude-code');
    expect(await resolveUserBrain(pool, OPERATOR)).toEqual({ kind: 'cli', providerId: 'claude-code' });
  });

  it('honours a saved own-endpoint preference over the demo CLI default', async () => {
    savedPreference('any-llm');
    getUserLlmConnection.mockResolvedValue(HOSTED);
    expect(await resolveUserBrain(pool, OPERATOR)).toEqual({
      kind: 'hosted', connection: { ...HOSTED, resolutionSource: 'explicit' },
    });
  });

  it('degrades a CLI preference the caller may not use, instead of offering it', async () => {
    savedPreference('claude-code');
    resolveUserLlmConnection.mockResolvedValue({ ...HOSTED, resolutionSource: 'free-tier' });
    const brain = await resolveUserBrain(pool, GUEST);
    expect(brain.kind).toBe('hosted');
  });

  it('degrades a named preference whose provider is not connected', async () => {
    savedPreference('any-llm');
    getUserLlmConnection.mockResolvedValue(null);
    resolveUserLlmConnection.mockResolvedValue({ ...HOSTED, resolutionSource: 'platform' });
    expect(await resolveUserBrain(pool, GUEST)).toEqual({
      kind: 'hosted', connection: { ...HOSTED, resolutionSource: 'platform' },
    });
  });

  it('never hands a non-operator a CLI brain, whatever they saved', async () => {
    for (const pref of ['claude-code', 'openai-codex']) {
      savedPreference(pref);
      expect((await resolveUserBrain(pool, GUEST)).kind).not.toBe('cli');
    }
  });

  it('leaves the hosted ladder to resolveUserLlmConnection rather than re-implementing it', async () => {
    demoKeysEnabled.mockReturnValue(false);
    resolveUserLlmConnection.mockResolvedValue({ ...HOSTED, resolutionSource: 'operator-key' });
    expect(await resolveUserBrain(pool, OPERATOR)).toEqual({
      kind: 'hosted', connection: { ...HOSTED, resolutionSource: 'operator-key' },
    });
    expect(resolveUserLlmConnection).toHaveBeenCalledWith(pool, OPERATOR);
  });

  it('reports none when nothing is usable, so the caller can be honest', async () => {
    demoKeysEnabled.mockReturnValue(false);
    expect(await resolveUserBrain(pool, GUEST)).toEqual({ kind: 'none' });
  });

  it('treats an unreadable preference row as auto rather than failing the turn', async () => {
    query.mockRejectedValue(new Error('permission denied'));
    expect(await resolveUserBrain(pool, OPERATOR)).toEqual({ kind: 'cli', providerId: 'openai-codex' });
  });

  it('treats a preference value this build no longer knows as auto', async () => {
    savedPreference('some-retired-provider');
    expect(await resolveUserBrain(pool, OPERATOR)).toEqual({ kind: 'cli', providerId: 'openai-codex' });
  });
});
