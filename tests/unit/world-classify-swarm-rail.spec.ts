/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for world classify on the swarm's accounted rail (operator decisions 2026-09-21 "the principle of one" and 2026-10-02 "operator identity"; found dead live 2026-10-02: no model-classified world item since 2026-08-06, ~55 "claude-code unattended execution is disabled" warns per pulse). In-process and mock-only: the chokepoint module is a recorder here; the signed hop itself is crossed by world-classify-delegation.spec.ts. Pins the owner rule (explicit subject; the sole operator on a DEMO box; never guessed) and the verified issuer (explicit; the single active directory record; never guessed); the dispatch (owned, issuer-carrying, direct + agentic so the node runs it host-tools-only, the instruction on the pattern channel for a node and leading the text for an inline bot, stamped with the bot's canonical provider record unless an explicit one is configured); the refusals (a CLI with no tool-less mode, no provider record, unknown bot, incomplete turn, the call ceiling); registration (only with an owner, and with a verified issuer when the hop is signed); the boot and per-fire wiring; and that news-fetcher constructs no model provider of its own.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Second review: the provider set is an allow-list (every id outside it, catalog ids included, is refused); the stamp always carries an empty fallback chain; an inline classify bot, a bot with an auto-executable tool grant, and an explicit model that differs from the canonical one are refused before dispatch; the owner is re-resolved on its TTL and a principal disabled later stops the next chunk; an operator-asserted issuer is reported as such.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// The two controller-local CLI providers the old news-fetcher constructed at import. If the feature
// module ever reaches for them again, these recorders go red before any chunk is classified.
const cliConstructed: string[] = [];
vi.mock('@/features/llm-provider/services/claude-code-cli-provider', () => ({
  ClaudeCodeCliProvider: class { constructor() { cliConstructed.push('claude-code'); } },
}));
vi.mock('@/features/llm-provider/services/codex-cli-provider', () => ({
  CodexHarnessProvider: class { constructor() { cliConstructed.push('codex'); } },
}));

// The chokepoint as a recorder: no case injects `deps.execute`, so the provider's DEFAULT seam is what runs.
const execute = vi.fn();
vi.mock('@/app/routes/inline-bot-execution', () => ({
  executeBotOrInline: (...args: unknown[]) => execute(...args),
}));

const registry = () => [
  { agentId: 'a0000000-0000-0000-0000-000000000099', name: 'general-bot', port: 3099, container: 'general-bot', role: 'general/fallback', capabilities: [] },
  { agentId: 'a0000000-0000-0000-0000-000000000020', name: 'research-bot', port: 3020, container: 'research-bot', role: 'localhost/worker', capabilities: [] },
  { name: 'no-id-bot', port: 1, container: 'no-id-bot', role: 'x', capabilities: [] },
] as never;
const ctx = { pool: { query: async () => ({ rows: [] }) } } as never;
const OWNER = 'operator-sub-1';
const ISSUER = 'https://identity.oshal.example.com';
const CANON = { providerId: 'antigravity-cli', model: 'gemini-3.8-flash-low', configVersion: 7, providerConfigRequired: true, fallbackOrder: ['openai-codex'] };
const env = (values: Record<string, string>) => values as unknown as NodeJS.ProcessEnv;
/** A node client double: where the bot runs and whether the hop is signed. */
const client = (over: { onNode?: boolean; signed?: boolean } = {}) =>
  ({ hasEndpoint: () => over.onNode ?? true, isDelegationEnforced: () => over.signed ?? true }) as never;

type Provider = typeof import('@/app/world-classify-provider');
let P: Provider;
type Fetcher = typeof import('@/features/world-data/news-fetcher');
let analyzeBatch: Fetcher['analyzeBatch'];
let configureWorldClassify: Fetcher['configureWorldClassify'];
let worldClassifyConfigured: Fetcher['worldClassifyConfigured'];
let currentRequestIdentity: typeof import('@/shared/services/database/request-identity')['getRequestIdentity'];
const canonicalStamp = vi.fn();
const grantedTools = vi.fn();

// Loaded once: the provider module pulls a wide module graph (seconds), like the Jarvis specs.
beforeAll(async () => {
  P = await import('@/app/world-classify-provider');
  ({ analyzeBatch, configureWorldClassify, worldClassifyConfigured } = await import('@/features/world-data/news-fetcher'));
  ({ getRequestIdentity: currentRequestIdentity } = await import('@/shared/services/database/request-identity'));
}, 60_000);

beforeEach(() => {
  execute.mockReset();
  execute.mockResolvedValue({ success: true, response: '[{"i":0,"s":0.4,"e":[{"n":"NVIDIA","t":"org"}],"ev":{"t":"earnings","i":0.7}}]', provider: 'antigravity-cli', model: 'gemini-3.8-flash-low' });
  canonicalStamp.mockReset();
  canonicalStamp.mockResolvedValue(CANON);
  grantedTools.mockReset();
  grantedTools.mockResolvedValue([]);
  configureWorldClassify([]);
});
afterEach(() => { vi.unstubAllEnvs(); });

const items = (n: number) => Array.from({ length: n }, (_, i) => ({ title: `Item ${i}`, description: 'A test description.', outlet: 'Test Wire', link: '', pubDate: '' }));
const opts = (over: Record<string, unknown> = {}) => ({ botName: 'general-bot', callTimeoutMs: 120_000, ...over });
const owner = (issuer: string | null = ISSUER): { sub: string; issuer: string | null; issuerSource: 'verified-principal' | 'none' } =>
  ({ sub: OWNER, issuer, issuerSource: issuer ? 'verified-principal' : 'none' });
const provider = (over: { options?: Record<string, unknown>; deps?: Record<string, unknown>; issuer?: string | null; env?: Record<string, string> } = {}) =>
  P.createWorldClassifyProvider(ctx, owner(over.issuer === undefined ? ISSUER : over.issuer), opts(over.options) as never,
    { registry, botClient: client(), canonicalStamp, grantedTools, ...over.deps } as never, env(over.env ?? { WORLD_CLASSIFY_OWNER_SUB: OWNER, WORLD_CLASSIFY_OWNER_ISSUER: ISSUER }));
const sent = (call = 0) => execute.mock.calls[call] as [unknown, unknown, string, Record<string, unknown>];

describe('whose work world classification is', () => {
  it('an explicit WORLD_CLASSIFY_OWNER_SUB wins, demo or not, and over the sole operator', () => {
    expect(P.worldClassifyOwnerSub(env({ WORLD_CLASSIFY_OWNER_SUB: ' owner-x ', DEMO_MODE: 'false', OSHAL_OPERATOR_SUBS: 'a,b' }))).toBe('owner-x');
    expect(P.worldClassifyOwnerSub(env({ WORLD_CLASSIFY_OWNER_SUB: 'owner-x', DEMO_MODE: 'true', OSHAL_OPERATOR_SUBS: OWNER }))).toBe('owner-x');
  });

  it('on a DEMO box with exactly one configured operator, that operator is the owner; otherwise nobody is guessed', () => {
    expect(P.worldClassifyOwnerSub(env({ DEMO_MODE: 'true', OSHAL_OPERATOR_SUBS: ` ${OWNER} ` }))).toBe(OWNER);
    expect(P.worldClassifyOwnerSub(env({ DEMO_MODE: 'true', OSHAL_OPERATOR_SUBS: 'a,b' }))).toBeUndefined();
    expect(P.worldClassifyOwnerSub(env({ DEMO_MODE: 'true' }))).toBeUndefined();
    expect(P.worldClassifyOwnerSub(env({ DEMO_MODE: 'false', OSHAL_OPERATOR_SUBS: OWNER }))).toBeUndefined();
    expect(P.worldClassifyOwnerSub(env({ OSHAL_OPERATOR_SUBS: OWNER }))).toBeUndefined();
  });

  it('the verified issuer is the single active directory record — never a guess; an env issuer is operator-asserted unless the directory holds it', async () => {
    const demo = { DEMO_MODE: 'true', OSHAL_OPERATOR_SUBS: OWNER };
    const one = async () => ['https://accounts.example.com'];
    expect(await P.resolveWorldClassifyOwner(ctx, env(demo), { verifiedIssuers: one })).toEqual({ sub: OWNER, issuer: 'https://accounts.example.com', issuerSource: 'verified-principal' });
    expect(await P.resolveWorldClassifyOwner(ctx, env(demo), { verifiedIssuers: async () => ['https://a.example.com', 'https://b.example.com'] })).toEqual({ sub: OWNER, issuer: null, issuerSource: 'none' });
    expect(await P.resolveWorldClassifyOwner(ctx, env(demo), { verifiedIssuers: async () => [] })).toEqual({ sub: OWNER, issuer: null, issuerSource: 'none' });
    expect(await P.resolveWorldClassifyOwner(ctx, env(demo), { verifiedIssuers: async () => { throw new Error('directory down'); } })).toEqual({ sub: OWNER, issuer: null, issuerSource: 'none' });
    expect(await P.resolveWorldClassifyOwner(ctx, env({ ...demo, WORLD_CLASSIFY_OWNER_ISSUER: ` ${ISSUER} ` }), { verifiedIssuers: one })).toEqual({ sub: OWNER, issuer: ISSUER, issuerSource: 'operator-asserted' });
    expect(await P.resolveWorldClassifyOwner(ctx, env({ ...demo, WORLD_CLASSIFY_OWNER_ISSUER: ISSUER }), { verifiedIssuers: async () => [ISSUER] })).toEqual({ sub: OWNER, issuer: ISSUER, issuerSource: 'verified-principal' });
    expect(await P.resolveWorldClassifyOwner(ctx, env({ DEMO_MODE: 'true' }), { verifiedIssuers: one })).toBeUndefined();
  });

  it('reads the directory through its store when no seam is given: only ACTIVE records for that exact subject count', async () => {
    const rows = [
      { issuer: 'https://accounts.example.com', user_sub: OWNER, provider: 'google', email: null, email_verified: true, display_name: null, canonical_local_sub: null, status: 'active', first_seen_at: '2026-09-11', last_seen_at: '2026-10-01' },
      { issuer: 'https://old.example.com', user_sub: OWNER, provider: 'x', email: null, email_verified: true, display_name: null, canonical_local_sub: null, status: 'disabled', first_seen_at: '2026-01-01', last_seen_at: '2026-01-02' },
      { issuer: 'https://other.example.com', user_sub: 'someone-else', provider: 'x', email: null, email_verified: true, display_name: null, canonical_local_sub: null, status: 'active', first_seen_at: '2026-01-01', last_seen_at: '2026-01-02' },
    ];
    const withDirectory = { pool: { query: async () => ({ rows }) } } as never;
    expect(await P.resolveWorldClassifyOwner(withDirectory, env({ DEMO_MODE: 'true', OSHAL_OPERATOR_SUBS: OWNER }))).toEqual({ sub: OWNER, issuer: 'https://accounts.example.com', issuerSource: 'verified-principal' });
  });

  it('options: the default bot and call ceiling; the retired WORLD_CLASSIFY_PROVIDERS list selects nothing', () => {
    expect(P.worldClassifyOptions(env({ WORLD_CLASSIFY_PROVIDERS: 'claude,codex' }))).toEqual({ botName: P.WORLD_CLASSIFY_DEFAULT_BOT, callTimeoutMs: 120_000 });
    expect(P.worldClassifyOptions(env({ WORLD_CLASSIFY_CALL_TIMEOUT_MS: '45000' })).callTimeoutMs).toBe(45_000);
    expect(P.worldClassifyOptions(env({ WORLD_CLASSIFY_CALL_TIMEOUT_MS: '5' })).callTimeoutMs).toBe(120_000);
  });
});

describe('the classify dispatch: one owned, tool-less, chain-less turn per chunk through the chokepoint', () => {
  it('owner + verified issuer, direct + agentic, the instruction on the pattern channel, the canonical record with NO fallback chain', async () => {
    let identityDuringCall: unknown;
    execute.mockImplementationOnce(async () => { identityDuringCall = currentRequestIdentity(); return { success: true, response: '[{"i":0,"s":0.4}]' }; });
    const p = provider();
    expect(p.name).toBe('swarm:general-bot');
    const out = await p.complete('Subject: NVIDIA\nItems:\n0. Nvidia beats estimates', 'Return ONLY a MINIFIED JSON array');
    expect(out.text).toBe('[{"i":0,"s":0.4}]');
    expect(execute).toHaveBeenCalledTimes(1);
    const [calledCtx, , agentId, request] = sent();
    expect(calledCtx).toBe(ctx);
    expect(agentId).toBe('a0000000-0000-0000-0000-000000000099');
    // Interactive shape: the node marks direct turns host-tools-only, and only the agentic loop honours the marker.
    expect(request).toMatchObject({ agentId, direct: true, agenticMode: true, userSub: OWNER, principalIssuer: ISSUER });
    // The fetched items never share a channel with the instruction that says they are data.
    expect(request.pattern).toBe('Return ONLY a MINIFIED JSON array');
    expect(request.text).toBe('Subject: NVIDIA\nItems:\n0. Nvidia beats estimates');
    expect(String(request.taskId)).toMatch(/^world-classify-[0-9a-f-]{36}$/);
    expect(request.workspaceFolderId).toBe(request.taskId);
    // The classify bot's canonical record (the swarm default), not the owner's personal brain — and never its chain.
    expect(canonicalStamp).toHaveBeenCalledWith(agentId);
    expect(request).toMatchObject({ providerId: 'antigravity-cli', model: 'gemini-3.8-flash-low', configVersion: 7, providerConfigRequired: true, fallbackOrder: [] });
    expect(request.byoLlmConnection).toBeUndefined();
    expect(identityDuringCall).toMatchObject({ sub: OWNER, principalIssuer: ISSUER, isOperator: false });
  });

  it('a bot with no node of its own is refused: an inline turn would run the owner\'s brain with the instruction in the untrusted text', async () => {
    await expect(provider({ deps: { botClient: client({ onNode: false }) } }).complete('the items', 'the instruction')).rejects.toThrow('no node of its own');
    expect(execute).not.toHaveBeenCalled();
  });

  it('a bot that holds any auto-executable tool grant is refused', async () => {
    grantedTools.mockResolvedValueOnce(['web_fetch']);
    await expect(provider().complete('p', 's')).rejects.toThrow('auto-executable tool grants (web_fetch)');
    expect(execute).not.toHaveBeenCalled();
  });

  it('WORLD_CLASSIFY_BOT picks another registered bot; an explicit admissible provider is the stamp and the canonical record is not consulted', async () => {
    const options = P.worldClassifyOptions(env({ WORLD_CLASSIFY_BOT: 'research-bot', WORLD_CLASSIFY_PROVIDER_ID: 'antigravity-cli' }));
    await P.createWorldClassifyProvider(ctx, owner(), options, { registry, botClient: client(), canonicalStamp, grantedTools } as never).complete('prompt');
    const [, , agentId, request] = sent();
    expect(agentId).toBe('a0000000-0000-0000-0000-000000000020');
    expect(request).toMatchObject({ providerId: 'antigravity-cli', fallbackOrder: [], userSub: OWNER });
    expect(request.model).toBeUndefined();
    expect(request.providerConfigRequired).toBeUndefined();
    expect(canonicalStamp).not.toHaveBeenCalled();
  });

  it('an explicit model is admitted only when it is the node\'s model', async () => {
    await provider({ options: { providerId: 'antigravity-cli', model: 'gemini-3.8-flash-low' } }).complete('p');
    expect(sent()[3]).toMatchObject({ providerId: 'antigravity-cli', model: 'gemini-3.8-flash-low' });
    await expect(provider({ options: { providerId: 'antigravity-cli', model: 'gemini-3.8-pro' } }).complete('p')).rejects.toThrow('runs its boot model');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('without an issuer (an unsigned hop) the owner still rides, with no issuer field', async () => {
    await provider({ issuer: null, deps: { botClient: client({ signed: false }) }, env: { WORLD_CLASSIFY_OWNER_SUB: OWNER } }).complete('p');
    const [, , , request] = sent();
    expect(request.userSub).toBe(OWNER);
    expect('principalIssuer' in request).toBe(false);
  });

  it.each([['claude-code'], ['openai-codex'], ['codex-cli'], ['gemini-cli'], ['cline'], ['openai'], ['gemini'], ['anthropic'], ['openrouter']])(
    'refuses %s: only a runtime that holds no tools on a host-tools-only turn may classify fetched text', async (providerId) => {
      canonicalStamp.mockResolvedValue({ providerId, providerConfigRequired: true });
      await expect(provider().complete('p', 's')).rejects.toThrow('not an admissible classify provider');
      await expect(provider({ options: { providerId } }).complete('p', 's')).rejects.toThrow('not an admissible classify provider');
      expect(execute).not.toHaveBeenCalled();
    });

  it('a record that names no provider is refused: nothing is dispatched unstamped', async () => {
    canonicalStamp.mockResolvedValue({ providerConfigRequired: true });
    await expect(provider().complete('p')).rejects.toThrow('no provider record');
    expect(execute).not.toHaveBeenCalled();
  });

  it('an unregistered bot, a bot without an id, or an incomplete turn throws (the chunk falls back to lexicon upstream)', async () => {
    await expect(provider({ options: { botName: 'ghost-bot' } }).complete('p')).rejects.toThrow('not in the active registry');
    await expect(provider({ options: { botName: 'no-id-bot' } }).complete('p')).rejects.toThrow('not in the active registry');
    expect(execute).not.toHaveBeenCalled();
    execute.mockResolvedValueOnce({ success: false, response: '' });
    await expect(provider().complete('p')).rejects.toThrow('did not complete');
  });

  it('a turn that outlives the call ceiling is abandoned', async () => {
    execute.mockImplementationOnce(() => new Promise(() => { /* never settles */ }));
    await expect(provider({ options: { callTimeoutMs: 30 } }).complete('p')).rejects.toThrow(/exceeded 30ms/);
  });

  it('the owner is re-resolved on its TTL: a principal disabled later stops the next chunk, and a new sign-in is picked up', async () => {
    let clock = 1_000_000;
    const issuers = vi.fn(async () => [ISSUER]);
    const p = P.createWorldClassifyProvider(ctx, owner(), opts() as never,
      { registry, botClient: client({ signed: true }), canonicalStamp, grantedTools, verifiedIssuers: issuers, now: () => clock } as never,
      env({ WORLD_CLASSIFY_OWNER_SUB: OWNER }));
    await p.complete('p');
    expect(issuers).not.toHaveBeenCalled();           // inside the TTL: the registered owner is reused
    clock += 61_000;
    issuers.mockResolvedValueOnce([]);                // the directory row was disabled meanwhile
    await expect(p.complete('p')).rejects.toThrow('no longer has a single verified issuer');
    expect(execute).toHaveBeenCalledTimes(1);
    clock += 61_000;                                  // signed in again
    await p.complete('p');
    expect(sent(1)[3]).toMatchObject({ userSub: OWNER, principalIssuer: ISSUER });
  });
});

describe('registration: the rail exists only with an owner, and with a verified issuer when the hop is signed', () => {
  const demo = { DEMO_MODE: 'true', OSHAL_OPERATOR_SUBS: OWNER };

  it('no owner → nothing registered, nothing dispatched; analyzeBatch answers lexicon-shaped rows', async () => {
    expect(await P.registerWorldClassifyRail(ctx, env({}), { registry, botClient: client(), canonicalStamp, grantedTools } as never)).toBe('no-owner');
    expect(worldClassifyConfigured()).toBe(false);
    const out = await analyzeBatch(items(3), 'NVIDIA');
    expect(out.every((r) => r.s === null && r.entities.length === 0 && r.event === null)).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it('a signed hop and no verified issuer → nothing registered (the refused dispatch is never attempted)', async () => {
    const deps = { registry, botClient: client({ signed: true }), canonicalStamp, grantedTools, verifiedIssuers: async () => [] };
    expect(await P.registerWorldClassifyRail(ctx, env(demo), deps as never)).toBe('no-verified-issuer');
    expect(worldClassifyConfigured()).toBe(false);
    await analyzeBatch(items(2), 'NVIDIA');
    expect(execute).not.toHaveBeenCalled();
  });

  it('an unsigned hop needs no issuer; a signed hop with one verified issuer registers and analyzeBatch reaches the rail', async () => {
    const unsigned = { registry, botClient: client({ signed: false }), canonicalStamp, grantedTools, verifiedIssuers: async () => [] };
    expect(await P.registerWorldClassifyRail(ctx, env(demo), unsigned as never)).toBe('registered');
    const signed = { registry, botClient: client({ signed: true }), canonicalStamp, grantedTools, verifiedIssuers: async () => [ISSUER] };
    expect(await P.registerWorldClassifyRail(ctx, env(demo), signed as never)).toBe('registered');
    expect(worldClassifyConfigured()).toBe(true);
    const out = await analyzeBatch(items(3), 'NVIDIA');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(sent()[3]).toMatchObject({ userSub: OWNER, principalIssuer: ISSUER, agenticMode: true, direct: true, fallbackOrder: [] });
    expect(out[0]).toEqual({ s: 0.4, entities: [{ name: 'NVIDIA', type: 'org' }], event: { type: 'earnings', intensity: 0.7 } });
  });
});

describe('wiring: boot and every world fire make sure the rail is registered', () => {
  it('server.ts registers at boot and the dispatcher on each fire', () => {
    const read = (file: string) => readFileSync(path.join(process.cwd(), file), 'utf8');
    expect(read('src/app/server.ts')).toMatch(/void ensureWorldClassifyRail\(ctx\);/);
    expect(read('src/app/world-schedule-dispatch.ts')).toMatch(/await ensureWorldClassifyRail\(ctx\);/);
  });

  it('ensureWorldClassifyRail registers from the process environment through the default seams', async () => {
    vi.stubEnv('WORLD_CLASSIFY_OWNER_SUB', OWNER);
    vi.stubEnv('WORLD_CLASSIFY_OWNER_ISSUER', ISSUER);
    expect(worldClassifyConfigured()).toBe(false);
    await P.ensureWorldClassifyRail(ctx);
    expect(worldClassifyConfigured()).toBe(true);
  });
});

describe('news-fetcher owns no model provider', () => {
  it('constructs no controller-local CLI provider — at import or on a classify call', async () => {
    // Behavioural: the old module built both providers at import time (the recorders above would have fired).
    expect(cliConstructed).toEqual([]);
    await analyzeBatch(items(2), 'NVIDIA');
    expect(cliConstructed).toEqual([]);
    // And textual, as a second lock on the same door: no llm-provider import at all.
    const source = readFileSync(path.join(process.cwd(), 'src/features/world-data/news-fetcher.ts'), 'utf8');
    expect(source).not.toMatch(/features\/llm-provider|ClaudeCodeCliProvider|CodexHarnessProvider/);
  });
});
