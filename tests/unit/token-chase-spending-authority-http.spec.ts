/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Actual mounted replay spending routes preserve sharing/BYO/free work while enforcing operator lending, verified caller attribution and node machine/protection boundaries.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Ownerless frames are admin-only (operator decision 2026-10-05): an ordinary member is refused reading or replaying the shared run and the operator is admitted; ordinary-caller spending cases run on the caller-owned run, the issuer-less tail restore on a run that caller owns, and cost rollups are separated across two issuers of one caller plus the operator.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';

vi.mock('@/features/agent-management', async importOriginal => ({ ...await importOriginal<typeof import('@/features/agent-management')>(),
  createRegistryEndpointResolver: vi.fn() }));
vi.mock('@/app/extensions/swarm/swarm-bot-registry', () => ({ getActiveRegistry: vi.fn() }));
vi.mock('@/app/routes/provider-routes', () => ({ listConfiguredProviders: vi.fn(() => ({ activeProvider: 'openai', providers: [
  { id: 'openai', label: 'Current hosted', selectedModel: 'current-model' },
  { id: 'groq', label: 'Framework Groq', selectedModel: 'paid-model' },
  { id: 'openrouter', label: 'OpenRouter', selectedModel: 'paid-model' },
] })) }));
vi.mock('@/app/routes/connector-tenancy', async importOriginal => ({ ...await importOriginal<typeof import('@/app/routes/connector-tenancy')>(), accessibleConnections: vi.fn(async () => []) }));
vi.mock('@/app/routes/byo-llm-routes', async importOriginal => ({ ...await importOriginal<typeof import('@/app/routes/byo-llm-routes')>(),
  getUserLlmConnection: vi.fn(async (_pool: unknown, sub: string, options?: { connectionId?: string }) => options?.connectionId === 'own-byo'
    ? { baseUrl: 'https://own.example.test/v1', apiKey: `fixture-owned-${sub}`, model: 'owner-model' } : null),
  buildAnyLlmListEntry: vi.fn(() => ({ connections: [] })) }));
vi.mock('@/app/routes/free-tier-rotation', async importOriginal => ({ ...await importOriginal<typeof import('@/app/routes/free-tier-rotation')>(),
  resolveUserLlmConnection: vi.fn(async (_pool: unknown, sub: string) => ({ baseUrl: 'https://own.example.test/v1', apiKey: `fixture-owned-${sub}`, model: 'owner-model' })),
  resolveLiveFreeTierConnection: vi.fn(async () => null), listFreeTierConnections: vi.fn(async () => []),
  freeTierRuntimeSnapshot: vi.fn(() => ({ configured: true, verdict: 'available', lastLiveModel: 'fixture:free' })),
  platformFreeConnection: vi.fn(async () => ({ baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'fixture-shared-openrouter', model: 'fixture:free' })) }));
vi.mock('@/features/cost-governance', async importOriginal => ({ ...await importOriginal<typeof import('@/features/cost-governance')>(),
  BudgetService: class { async checkBudget() { return { allowed: true }; } } }));
vi.mock('@/features/token-chase', async importOriginal => ({ ...await importOriginal<typeof import('@/features/token-chase')>(),
  listRunObservations: vi.fn(async () => []), listActivePromotions: vi.fn(async () => new Map()),
  recordOptimizerObservation: vi.fn(async () => undefined),
  assessVariantQuality: vi.fn(async () => ({ mode: 'lexical-fallback', score: 100 })),
  promoteFrameWinner: vi.fn(async (_pool: unknown, _sub: string, input: Record<string, unknown>) => ({ ...input, promotionId: 'fixture-promotion' })) }));

import { getActiveRegistry } from '@/app/extensions/swarm/swarm-bot-registry';
import { resolveUserLlmConnection, platformFreeConnection } from '@/app/routes/free-tier-rotation';
import { getUserLlmConnection } from '@/app/routes/byo-llm-routes';
import { listRunObservations, promoteFrameWinner } from '@/features/token-chase';
import type { DebuggerObservation } from '@/features/token-chase';
import { tokenChaseSpendingFixture } from '../fixtures/token-chase-spending-authority';

let fixture: Awaited<ReturnType<typeof tokenChaseSpendingFixture>>;
beforeEach(async () => { vi.clearAllMocks(); vi.mocked(listRunObservations).mockResolvedValue([]); fixture = await tokenChaseSpendingFixture(); });
afterEach(async () => { await fixture?.close(); });
const VARIANT = '/runs/shared/frames/1/variant';
/** The caller-owned run: ordinary users replay only frames they own (ownerless frames are admin-only). */
const VARIANT_OWN = '/runs/own/frames/1/variant';
const NODE_BODY = { history: [], systemPrompt: null, taskId: 'shared', userSub: 'fixture-member', principalIssuer: 'https://identity.example.test' };

/** @description Switch only the fixture registry's harness classification, without loading credentials or a vendor binary. */
function cliHarness() { vi.mocked(getActiveRegistry).mockReturnValue([{ agentId: 'fixture-worker', name: 'fixture-worker', harnessType: 'codex-cli' }] as never); }

/** @description A recorded caller-owned, LLM-graded winner; the corpus persistence collaborator remains a qualified seam. */
function winner(): DebuggerObservation {
  return { seq: 1, createdAt: null, baselineProvider: 'openai', baselineModel: 'baseline', baselineCostUsd: 0.1,
    variantProvider: 'framework:groq', variantModel: 'paid-model', variantCostUsd: 0.01, costDeltaUsd: 0.09,
    latencyMs: null, accuracy: 1, equivalent: true, tier: 'equivalent-cheaper', status: 'ok', queryType: null,
    harness: null, judgeScore: 95, judgeMode: 'llm' };
}

describe('Token Chase verified spending authority through real controller/client/node HTTP', () => {
  it.each([VARIANT, '/runs/shared/savings'])('refuses forged paid framework selection at %s before secrets or dispatch', async route => {
    const response = await fixture.call(route, 'member', { connectionId: 'framework:groq', userSub: 'fixture-operator', isOperator: true }, { 'x-user-sub': 'fixture-operator' });
    expect(response.status).toBe(404); expect(fixture.secrets).not.toHaveBeenCalled(); expect(fixture.node.generated).not.toHaveBeenCalled();
  });

  it('offers paid framework lanes only under the existing operator-plus-demo contract with DB GUC off', async () => {
    const member = await fixture.call('/connections'); expect(member.status).toBe(200);
    expect(JSON.stringify(await member.json())).not.toContain('framework:groq'); expect(fixture.secrets).not.toHaveBeenCalled();
    const operator = await fixture.call('/connections', 'operator'); expect(operator.status).toBe(200);
    expect(JSON.stringify(await operator.json())).toContain('framework:groq'); expect(fixture.secrets).toHaveBeenCalledTimes(1);
    const replay = await fixture.call(VARIANT, 'operator', { connectionId: 'framework:groq' }); expect(replay.status).toBe(200);
    expect(fixture.node.variantProvider).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'fixture-framework-vendor', model: 'paid-model' }));
    expect(fixture.node.costIdentities[0]).toMatchObject({ sub: 'fixture-operator', isOperator: false });
  });

  it('refuses operator vendor lending when demo posture is off', async () => {
    vi.stubEnv('DEMO_MODE', 'false'); expect((await fixture.call(VARIANT, 'operator', { connectionId: 'framework:groq' })).status).toBe(404);
    expect(fixture.secrets).not.toHaveBeenCalled(); expect(fixture.node.generated).not.toHaveBeenCalled();
  });

  it.each(['own-byo', 'free:auto', 'framework:openrouter'])('preserves ordinary %s without reading paid framework secrets', async connectionId => {
    const response = await fixture.call(VARIANT_OWN, 'member', { connectionId }); expect(response.status).toBe(200);
    expect(fixture.node.variantProvider).toHaveBeenCalledTimes(1); expect(fixture.secrets).not.toHaveBeenCalled();
    expect(fixture.node.recordCost).toHaveBeenCalledWith(expect.objectContaining({ ownerSub: 'fixture-member' }));
    if (connectionId === 'own-byo') expect(getUserLlmConnection).toHaveBeenCalledWith(expect.anything(), 'fixture-member', { connectionId: 'own-byo' });
    else expect(fixture.node.variantProvider).toHaveBeenCalledWith(expect.objectContaining({ model: 'fixture:free' }));
  });

  it('refuses an unavailable shared free lane without paid/default fallback', async () => {
    vi.mocked(platformFreeConnection).mockResolvedValueOnce(null);
    expect((await fixture.call(VARIANT_OWN, 'member', { connectionId: 'framework:openrouter' })).status).toBe(404);
    expect(fixture.node.generated).not.toHaveBeenCalled(); expect(fixture.secrets).not.toHaveBeenCalled();
  });

  it('keeps ownerless frames admin-only, own frames readable and foreign-owned replay refused', async () => {
    expect((await fixture.call('/runs/shared/frames/1')).status).toBe(404);
    expect((await fixture.call('/runs/shared/replay', 'member', { fromFrame: 1 })).status).toBe(404);
    expect((await fixture.call('/runs/shared/frames/1', 'operator')).status).toBe(200);
    expect((await fixture.call('/runs/own/frames/1')).status).toBe(200);
    expect((await fixture.call('/runs/foreign/frames/1')).status).toBe(404);
    expect((await fixture.call('/runs/foreign/replay', 'member', { fromFrame: 1 })).status).toBe(404);
    expect(fixture.node.generated).not.toHaveBeenCalled();
  });

  it('preserves current hosted replay and overwrites forged body/header identity with verified caller and issuer', async () => {
    const response = await fixture.call('/runs/own/replay', 'member', { fromFrame: 1, userSub: 'fixture-operator', principalIssuer: 'https://forged.test', isOperator: true }, { 'x-user-sub': 'fixture-operator' });
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ replay: { status: 'deterministic' } });
    expect(fixture.node.currentProvider).toHaveBeenCalledTimes(1); expect(fixture.node.variantProvider).not.toHaveBeenCalled();
    expect(fixture.node.generated).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ extraEnv: { OSHAL_USER_SUB: 'fixture-member' }, tools: [], autoApprove: false }));
    expect(fixture.node.costIdentities).toEqual([{ sub: 'fixture-member', principalIssuer: 'https://identity.example.test', isOperator: false }]);
  });

  it.each(['/runs/shared/replay', VARIANT, '/runs/shared/savings', '/runs/shared/tail-replay'])('requires a verified issuer before spend at %s even with body/header substitutes', async route => {
    expect((await fixture.call(route, 'missing-issuer', { fromFrame: 1, refire: true, connectionId: 'own-byo', principalIssuer: 'https://forged.test' }, { 'x-principal-issuer': 'https://forged.test' })).status).toBe(401);
    expect(fixture.node.generated).not.toHaveBeenCalled(); expect(fixture.secrets).not.toHaveBeenCalled();
  });

  it('resolves a normal CLI replay through the caller hosted ladder before actual dispatch', async () => {
    cliHarness(); const response = await fixture.call('/runs/own/replay', 'member', { fromFrame: 1 }); expect(response.status).toBe(200);
    expect(resolveUserLlmConnection).toHaveBeenCalledWith(expect.anything(), 'fixture-member');
    expect(fixture.node.variantProvider).toHaveBeenCalledWith({ baseUrl: 'https://own.example.test/v1', apiKey: 'fixture-owned-fixture-member', model: 'owner-model' });
  });

  it('refuses CLI resolver failure before node dispatch instead of falling to the deployment default', async () => {
    cliHarness(); vi.mocked(resolveUserLlmConnection).mockRejectedValueOnce(new Error('fixture ladder down'));
    const response = await fixture.call('/runs/own/replay', 'member', { fromFrame: 1 }); expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ replay: { status: 'replay-error' } });
    expect(fixture.node.currentProvider).not.toHaveBeenCalled(); expect(fixture.node.generated).not.toHaveBeenCalled();
  });

  it('routes an operator current CLI replay through the ordinary hosted ladder when demo posture is off', async () => {
    cliHarness(); vi.stubEnv('DEMO_MODE', 'false');
    expect((await fixture.call('/runs/shared/replay', 'operator', { fromFrame: 1 })).status).toBe(200);
    expect(fixture.node.currentProvider).not.toHaveBeenCalled(); expect(resolveUserLlmConnection).toHaveBeenCalledWith(expect.anything(), 'fixture-operator');
    expect(fixture.node.variantProvider).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'fixture-owned-fixture-operator' }));
  });

  it('keeps the exact demo operator CLI current lane and passes its subject to the existing spawn boundary', async () => {
    cliHarness(); expect((await fixture.call('/runs/shared/replay', 'operator', { fromFrame: 1 })).status).toBe(200);
    expect(fixture.node.currentProvider).toHaveBeenCalledTimes(1); expect(resolveUserLlmConnection).not.toHaveBeenCalled();
    expect(fixture.node.generated).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ extraEnv: { OSHAL_USER_SUB: 'fixture-operator' } }));
  });

  it('keeps the token-free tail restore available without an issuer and binds optional re-fire spend to the verified caller', async () => {
    const restore = await fixture.call('/runs/issuerless/tail-replay', 'missing-issuer', { fromFrame: 1 });
    expect(restore.status).toBe(200); expect(await restore.json()).toMatchObject({ tailReplay: { paidCalls: 0, refire: null } });
    expect(fixture.node.generated).not.toHaveBeenCalled();
    const refire = await fixture.call('/runs/own/tail-replay', 'member', { fromFrame: 1, refire: true });
    expect(refire.status).toBe(200); expect(await refire.json()).toMatchObject({ tailReplay: { paidCalls: 1 } });
    expect(fixture.node.recordCost).toHaveBeenCalledWith(expect.objectContaining({ ownerSub: 'fixture-member' }));
    expect(fixture.tailRestore).toHaveBeenCalledWith('fixture-worker', expect.objectContaining({ access: { callerSub: 'fixture-member', isAdmin: false } }));
  });

  it('keeps normal own-BYO savings replay caller-bound through the real optimizer loop', async () => {
    const response = await fixture.call('/runs/own/savings', 'member', { connectionId: 'own-byo' }); expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ frames: 1 }); expect(fixture.node.variantProvider).toHaveBeenCalledTimes(1);
    expect(fixture.node.costIdentities).toEqual([{ sub: 'fixture-member', principalIssuer: 'https://identity.example.test', isOperator: false }]);
  });

  it('separates replay cost rollups across callers and verified issuers without raw principal identifiers', async () => {
    for (const user of ['member', 'other-issuer']) expect((await fixture.call('/runs/own/replay', user, { fromFrame: 1 })).status).toBe(200);
    expect((await fixture.call('/runs/shared/replay', 'operator', { fromFrame: 1 })).status).toBe(200);
    const ids = fixture.node.recordCost.mock.calls.map(call => (call[0] as { taskId: string }).taskId);
    expect(new Set(ids).size).toBe(3); for (const id of ids) expect(id).toMatch(/^(own|shared)::replay::[a-f0-9]{64}$/);
    expect(fixture.node.costIdentities).toEqual(expect.arrayContaining([{ sub: 'fixture-member', principalIssuer: 'https://other.identity.test', isOperator: false }]));
  });

  it('refuses ordinary shared bot promotion before corpus reads or writes and preserves ordinary own promotion', async () => {
    const route = '/runs/shared/frames/1/promote';
    expect((await fixture.call(route, 'member', { applyToBotConfig: true, minQuality: 'bad', operator: true })).status).toBe(403);
    expect(listRunObservations).not.toHaveBeenCalled(); expect(promoteFrameWinner).not.toHaveBeenCalled(); expect(fixture.pushToBot).not.toHaveBeenCalled();
    expect((await fixture.call(route, 'member', {})).status).toBe(404);
    expect(listRunObservations).toHaveBeenCalledWith(expect.anything(), 'fixture-member', 'shared', 1);
  });

  it('persists ordinary caller promotion without pushing shared config and permits the operator apply path', async () => {
    vi.mocked(listRunObservations).mockResolvedValue([winner()]);
    const own = await fixture.call('/runs/own/frames/1/promote', 'member', {}); expect(own.status).toBe(200);
    expect(promoteFrameWinner).toHaveBeenCalledWith(expect.anything(), 'fixture-member', expect.objectContaining({ runId: 'own', seq: 1 }));
    expect(fixture.pushToBot).not.toHaveBeenCalled();
    const apply = await fixture.call('/runs/shared/frames/1/promote', 'operator', { applyToBotConfig: true }); expect(apply.status).toBe(200);
    expect(await apply.json()).toMatchObject({ botConfig: { applied: true, newVersion: 2 } });
    expect(fixture.pushToBot).toHaveBeenCalledWith('fixture-worker', { providerId: 'groq', modelId: 'paid-model' });
  });

  it.each([null, 'wrong-fixture-secret'])('refuses node machine auth %s before ownership/provider/body validation', async secret => {
    expect((await fixture.nodeCall(NODE_BODY, secret)).status).toBe(401); expect(fixture.node.query).not.toHaveBeenCalled(); expect(fixture.node.generated).not.toHaveBeenCalled();
  });

  it('keeps protected-bot replay unavailable despite producer/operator body claims', async () => {
    fixture.node.query.mockResolvedValue({ rows: [{ app: 'fixture-protected', protected: true }] });
    expect((await fixture.nodeCall({ ...NODE_BODY, userSub: 'fixture-operator', isOperator: true })).status).toBe(403);
    expect(fixture.node.generated).not.toHaveBeenCalled(); expect(fixture.node.recordCost).not.toHaveBeenCalled();
  });

  it('rejects incomplete producer metadata before provider selection', async () => {
    expect((await fixture.nodeCall({ history: [], userSub: 'fixture-member' })).status).toBe(400);
    expect(fixture.node.currentProvider).not.toHaveBeenCalled(); expect(fixture.node.generated).not.toHaveBeenCalled();
  });

  it('refuses unauthenticated malformed JSON before the body parser and preserves the missing-history zero-usage envelope', async () => {
    const malformed = await fetch(fixture.node.base + '/api/token-chase/replay-call', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
    expect(malformed.status).toBe(401); expect(fixture.node.query).not.toHaveBeenCalled();
    const missing = await fixture.nodeCall({ ...NODE_BODY, history: undefined }); expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ success: false, content: '', error: 'Missing history[]', cost: 0,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, model: 'node-model', provider: 'fixture-hosted', latencyMs: 0 });
    expect(fixture.node.generated).not.toHaveBeenCalled();
  });

  it('preserves provider-error zero usage and removes the confined replay workspace', async () => {
    fixture.node.generated.mockRejectedValueOnce(new Error('fixture provider refusal'));
    const response = await fixture.nodeCall(NODE_BODY); expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ success: false, error: 'fixture provider refusal', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, cost: 0 });
    const workspace = String(fixture.node.generated.mock.calls[0][1].workspaceDir);
    expect(existsSync(workspace)).toBe(false); expect(fixture.node.recordCost).not.toHaveBeenCalled();
  });
});
