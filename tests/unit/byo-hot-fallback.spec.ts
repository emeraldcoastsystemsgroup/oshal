/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guards for the operator's HOT FALLBACK (operator decision 2026-09-22). The boundary crossed is real on both transports: the NODE path drives the real BotNodeClient against a loopback fake bot node (POST /api/swarm-execute + GET /api/health) through executeBotOrInline; the INLINE path drives the REAL TaskOrchestrator and the REAL hosted provider against a loopback BYO endpoint, with the vendor rung's transport faked at the fetch seam. The chain is the REAL ProviderSwitchSnapshot over an in-memory store and is re-ordered by the REAL PUT route. Readiness reads REAL login files in a temp dir. Cases: operator + explicit + 503 → fallback taken with the marker, one dispatch per rung, WARN logged, never the key; not ready → the clear error naming every rung and NO fallback call; a non-operator → the endpoint failure, the chain never walked; a 401 → no fallback; a threaded operator-key lane → one attempt; the CONFIGURED chain beats the default and a PUT re-orders it with no restart; a not-ready rung is skipped with its reason; a failed rung is followed by the next once; an unreachable node makes every rung not-ready; the inline path answers INSIDE one turn (one saved user message, one cost row on the rung); the cockpit router carries the marker and answers 503 BYO_FALLBACK_NOT_READY when nothing was ready; the probe stores no token and marks an expired login not-ready.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Closed a readiness hole the mutation run found: on the INLINE path the only not-ready rung under test was a CLI login, which a second guard (no in-process lane) would have skipped anyway — so removing the planner's readiness check stayed green. A HOSTED rung whose key IS present but whose lane is COOLING after a mid-turn failure is the case where only the probe's verdict stands between the rung and a billed call; it is now asserted to be skipped with its reason and never called.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | The Settings read had no guard at all: GET /api/settings/llm-default — the route this change extends rather than adding a second status endpoint — was covered by nothing in tests/, so the whole hotFallback block could be deleted and every spec stayed green. The real router now answers a real request: the configured chain and its source, each rung's readiness (a lapsed Claude login reads not-ready with its reason), the gate verdict, the PUT that re-orders it, and no key or token anywhere in the payload.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Two gaps an adversarial verifier found. (a) "No fallback on a non-retryable failure" was guarded only on the NODE transport: deleting `!classified.retry ||` from hot-fallback-chain-provider.sendRequest left every case green, so an operator's 401 or 400 on the chosen endpoint could have been made to spend a billed call on a rung. The inline case now proves the rung rode into the turn READY and was still never called, for a 401 and a 400. (b) The walk itself is bounded per TURN, not per model call: a primary that walls, is walked over and walls again on a later sendRequest of the same turn must not start a second walk, and a rung that answered stays the provider — both asserted directly against the decorator whose lifetime is the turn.
 */

import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import express, { type NextFunction, type Request, type Response } from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const logSpies = vi.hoisted(() => {
  const spy = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn(), child: (): unknown => spy };
  return spy;
});
vi.mock('@/shared/logger', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/shared/logger')>(),
  createChildLogger: () => logSpies,
}));
vi.mock('@/features/chat-orchestration', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/chat-orchestration')>();
  return {
    ...actual,
    resolveProjectManagerTicketExecutionContext: vi.fn(async (_deps: unknown, input: { requestedTaskId: string; source: string }) => ({
      taskId: input.requestedTaskId, source: input.source, ticketCreated: false, ticketId: null, ticketStatus: null, ticketTitle: null, ticketContext: undefined,
    })),
  };
});
const ladder = vi.hoisted(() => ({ resolve: vi.fn<() => Promise<unknown>>(async () => undefined) }));
vi.mock('@/app/routes/free-tier-rotation', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/app/routes/free-tier-rotation')>(),
  resolveUserLlmConnection: (..._args: unknown[]) => ladder.resolve(),
}));
vi.mock('@/features/cost-governance', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/features/cost-governance')>(),
  BudgetService: class { async checkBudget(): Promise<{ allowed: boolean }> { return { allowed: true }; } },
}));

import { LLMService, type LLMResponse, type SendRequestOptions } from '../../src/features/llm-provider/services/llm-service';
import { TaskOrchestrator, type TaskOrchestratorDeps } from '../../src/features/chat-orchestration/services/task-orchestrator';
import { BotNodeClient, ProviderSwitchSnapshot, type ProviderSwitchStore, type BotNodeRequest } from '../../src/features/agent-management';
import { executeBotOrInline } from '../../src/app/routes/inline-bot-execution';
import { ByoFallbackUnavailableError, DEFAULT_HOT_FALLBACK_CHAIN, resolveHotFallbackChain } from '../../src/app/routes/byo-hot-fallback';
import { probeRungReadiness, resetFallbackReadinessForTesting, fallbackReadinessSnapshot } from '../../src/app/routes/fallback-rail-readiness';
import { createProviderSwitchRoutes } from '../../src/app/extensions/swarm/routes/provider-switch-routes';
import { setInstalledProviderSwitchSnapshot } from '../../src/app/composition/provider-switch-runtime';
import { resetSameEndpointRetryPlanWarningsForTesting } from '../../src/features/llm-provider/services/same-endpoint-retry';
import { HotFallbackChainProvider } from '../../src/features/llm-provider/services/hot-fallback-chain-provider';
import { coolOperatorKeyLane, resetOperatorLaneCooldownsForTesting } from '../../src/app/routes/free-tier-rotation';
import { OPENAI_COMPAT_LANES } from '../../src/app/routes/openai-compat-lanes';
import { FLEET_DEFAULT_SWITCH_ID, type ProviderSwitchCatalog, type ProviderSwitchRow } from '../../src/shared/llm-runtime';
import type { AppContext } from '../../src/app/composition/app-context';

const OPERATOR = 'operator-sub-hot-fallback';
const GUEST = 'someone-else-sub';
const AGENT = 'a0000000-0000-4000-8000-0000000000f1';
const BYO_KEY = 'sk-explicit-endpoint-key-never-logged';
const GEMINI_KEY = 'test-gemini-key-never-logged';
const HIGH_DEMAND = 'This model is currently experiencing high demand. Please try again later.';
const BYO_ENDPOINT = { baseUrl: 'https://byo.example.test/v1', apiKey: BYO_KEY, model: 'gemini-3.8-flash' };
const TASK_ID = 'f2b7a9d0-0000-4000-8000-00000000c0de';

/** Every id the platform can run, hand-built as the api validates against (same shape as provider-fallback-chain.spec). */
const CATALOG: ProviderSwitchCatalog = {
  harnessTypes: ['cline', 'codex-cli', 'claude-code', 'gemini-cli', 'antigravity-cli', 'a2a', 'noop'],
  clineApiProviders: ['gemini', 'openrouter', 'anthropic'],
};

// ── Login files the readiness probe reads (a temp dir, never the real home) ──────────────────────
let tempDir = '';
const codexPath = () => path.join(tempDir, 'codex-auth.json');
const claudePath = () => path.join(tempDir, 'claude-credentials.json');
const antigravityPath = () => path.join(tempDir, 'antigravity-oauth-token');

/** A JWT-shaped token with an `exp` claim; not a real token, built here so no literal exists. */
function jwtWithExp(expiresAtMs: number): string {
  const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64({ exp: Math.floor(expiresAtMs / 1000) })}.sig`;
}
function writeCodexLogin(expiresAtMs: number): void {
  fs.writeFileSync(codexPath(), JSON.stringify({ tokens: { access_token: jwtWithExp(expiresAtMs) }, last_refresh: new Date().toISOString() }));
}
function writeClaudeLogin(expiresAtMs: number): void {
  fs.writeFileSync(claudePath(), JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-access-token', refreshToken: 'fixture-refresh', expiresAt: expiresAtMs } }));
}
function removeLogin(file: string): void { if (fs.existsSync(file)) fs.unlinkSync(file); }

// ── The loopback fake bot node ───────────────────────────────────────────────────────────────────
interface NodeCall { providerId?: string; byoLlmConnection?: unknown; byoLlmResolutionSource?: unknown; agentId?: string }
const nodeCalls: NodeCall[] = [];
let nodeHealth = 200;
let byoAnswer: () => { status: number; body: unknown } = () => ({ status: 200, body: { success: false, error: `byo-hosted endpoint byo.example.test returned HTTP 503: ${HIGH_DEMAND}` } });
const rungAnswers = new Map<string, () => { status: number; body: unknown }>();
function nodeSuccess(providerId: string): { status: number; body: unknown } {
  return { status: 200, body: { success: true, response: `answered-by-${providerId}`, usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }, cost: 0.001, model: `${providerId}-model`, provider: providerId, durationMs: 5 } };
}
let nodeUrl = '';
const nodeServer = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/api/health') { res.writeHead(nodeHealth, { 'content-type': 'application/json' }); res.end('{"ok":true}'); return; }
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) as NodeCall : {};
    nodeCalls.push(body);
    const answer = body.byoLlmConnection
      ? byoAnswer()
      : (rungAnswers.get(String(body.providerId)) ?? (() => nodeSuccess(String(body.providerId))))();
    res.writeHead(answer.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(answer.body));
  });
});

// ── The loopback BYO endpoint (the inline path's explicit endpoint) ──────────────────────────────
const byoRequests: Array<{ authorization?: string }> = [];
let byoScript: Array<{ status: number; payload: unknown }> = [];
let byoFallback: { status: number; payload: unknown } = { status: 503, payload: HIGH_DEMAND };
let byoBaseUrl = '';
const byoServer = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    byoRequests.push({ authorization: req.headers.authorization });
    const next = byoScript.shift() ?? byoFallback;
    res.writeHead(next.status, { 'content-type': 'application/json' });
    res.end(typeof next.payload === 'string' ? next.payload : JSON.stringify(next.payload));
  });
});
function textCompletion(text: string): Record<string, unknown> {
  return { choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 }, model: 'stub-model' };
}

// ── The vendor rung's transport, faked at the fetch seam (the lane's base URL is fixed) ──────────
const geminiCalls: Array<{ url: string; authorization: string | null; model: unknown }> = [];
let geminiAnswer: () => { status: number; body: unknown } = () => ({ status: 200, body: textCompletion('answered-by-gemini') });
const realFetch = globalThis.fetch;
const geminiCompletions = `${OPENAI_COMPAT_LANES.gemini.baseUrl}/chat/completions`;

// ── The chain: the REAL snapshot over an in-memory store ─────────────────────────────────────────
function memoryStore(): { store: ProviderSwitchStore; rows: Map<string, ProviderSwitchRow> } {
  const rows = new Map<string, ProviderSwitchRow>();
  const store = {
    listAll: async () => Array.from(rows.values()),
    get: async (scopeId: string) => rows.get(scopeId) ?? null,
    upsert: async (scopeId: string, providerId: string, modelId: string | null, updatedBy: string, fallbackOrder?: readonly string[] | null) => {
      const previous = rows.get(scopeId);
      const row: ProviderSwitchRow = { scopeId, providerId, modelId, updatedBy, updatedAt: new Date().toISOString(), fallbackOrder: fallbackOrder === undefined ? (previous?.fallbackOrder ?? null) : (fallbackOrder ? [...fallbackOrder] : null) };
      rows.set(scopeId, row);
      return row;
    },
    remove: async (scopeId: string) => rows.delete(scopeId),
  } as unknown as ProviderSwitchStore;
  return { store, rows };
}
let store: ProviderSwitchStore;
let snapshot: ProviderSwitchSnapshot;
async function installChain(fleetRow?: { providerId: string; fallbackOrder: string[] | null }): Promise<void> {
  ({ store } = memoryStore());
  if (fleetRow) await store.upsert(FLEET_DEFAULT_SWITCH_ID, fleetRow.providerId, null, OPERATOR, fleetRow.fallbackOrder);
  snapshot = new ProviderSwitchSnapshot(store, CATALOG);
  await snapshot.refresh();
  setInstalledProviderSwitchSnapshot(snapshot, CATALOG);
}

// ── The node-path turn ───────────────────────────────────────────────────────────────────────────
function nodeClient(): BotNodeClient {
  const client = new BotNodeClient(() => nodeUrl);
  Object.defineProperty(client, 'hasEndpoint', { value: () => true });
  return client;
}
function nodeRequest(overrides: Partial<BotNodeRequest> = {}): BotNodeRequest {
  return {
    text: 'hi', taskId: 't-node', workspaceFolderId: 't-node', agentId: AGENT, agenticMode: true, direct: true,
    userSub: OPERATOR, byoLlmConnection: { ...BYO_ENDPOINT }, byoLlmResolutionSource: 'explicit', ...overrides,
  };
}
const nodeCtx = { pool: null, orchestrator: { processMessage: vi.fn() } } as unknown as AppContext;
function nodeDispatchesByProvider(): Array<string | undefined> { return nodeCalls.filter((c) => !c.byoLlmConnection).map((c) => c.providerId); }
function warnLines(): string[] { return logSpies.warn.mock.calls.map((call) => String(call[1] ?? call[0])); }
function everyLogArg(): string { return JSON.stringify(logSpies.warn.mock.calls) + JSON.stringify(logSpies.info.mock.calls); }

// ── The inline-path turn: the REAL orchestrator ──────────────────────────────────────────────────
class RotationProvider extends LLMService {
  constructor() { super('rotation-lane', {}); }
  async sendRequest(_o: SendRequestOptions): Promise<LLMResponse> { return { content: [{ type: 'text', text: 'ROTATED' }], usage: { inputTokens: 1, outputTokens: 1 }, model: 'rotation-model' }; }
}
function buildOrchestrator() {
  const saved: Array<Record<string, any>> = [];
  const tasks = new Map<string, Record<string, any>>();
  const recordInlineTurn = vi.fn(async () => {});
  const broadcastError = vi.fn();
  const getProvider = vi.fn(() => new RotationProvider());
  const deps = {
    taskStore: {
      create: async (input: Record<string, any>) => { tasks.set(String(input.taskId), { ...input }); return { ...input }; },
      get: async (taskId: string) => tasks.get(taskId) ?? null,
      updateStatus: async () => {}, incrementMessageCount: async () => {}, incrementTurnCount: async () => {}, recordUsage: vi.fn(async () => {}),
    },
    messageStore: { save: async (input: Record<string, any>) => { saved.push(input); return { ...input, messageId: `m-${saved.length}` }; }, getRecent: async () => [...saved] },
    streamManager: { associateTaskWithSession: () => {}, broadcastTaskUpdate: () => {}, broadcastMessage: () => {}, broadcastError },
    getProvider, getTools: async () => [], executeTool: async () => 'ok', getSystemPrompt: async () => 'SYSTEM',
    costLedger: { recordInlineTurn },
  } as unknown as TaskOrchestratorDeps;
  return { orchestrator: new TaskOrchestrator(deps), getProvider, userMessages: () => saved.filter((m) => m.role === 'user').length, broadcastError, recordInlineTurn };
}
const inlineOnly = { hasEndpoint: () => false, execute: vi.fn(), healthCheck: async () => false } as unknown as BotNodeClient;
function inlineRequest(overrides: Partial<BotNodeRequest> = {}): BotNodeRequest {
  return {
    text: 'hi', taskId: 't-inline', workspaceFolderId: 't-inline', agentId: 'inline-agent', agenticMode: true, direct: true,
    userSub: OPERATOR, byoLlmConnection: { baseUrl: byoBaseUrl, apiKey: BYO_KEY, model: 'user-model' }, byoLlmResolutionSource: 'explicit', ...overrides,
  };
}

/** A real registry agent that is controller-inline on a CLI harness and unscoped. */
async function pickCliHarnessAgentId(): Promise<string> {
  const { getActiveRegistry } = await import('../../src/app/extensions/swarm/swarm-bot-registry');
  const entry = getActiveRegistry().find((bot) => {
    const roles = (bot as { accessRoles?: string[] }).accessRoles;
    return Boolean(bot.agentId) && bot.harnessType === 'codex-cli' && (!roles || roles.length === 0)
      && bot.container === 'oshal-api' && !(bot as { requiresOwnNode?: boolean }).requiresOwnNode;
  });
  if (!entry?.agentId) throw new Error('no open inline codex-cli registry bot found');
  return entry.agentId;
}
const servers: Array<{ close: (cb: () => void) => void }> = [];
async function bootSendMessageApp(orchestrator: TaskOrchestrator): Promise<string> {
  const { createMessageRoutes } = await import('../../src/app/routes/message-routes');
  const ctx = {
    taskStore: { get: async () => null, incrementMessageCount: async () => undefined, incrementTurnCount: async () => undefined },
    workspaceService: { resolveTaskOwner: async () => null }, ticketService: {}, pool: {}, orchestrator, messageStore: { save: async () => ({}) },
  } as unknown as Parameters<typeof createMessageRoutes>[0];
  const app = express();
  app.use(express.json());
  app.use(((req: Request, _res: Response, next: NextFunction) => {
    const sub = req.header('x-test-sub');
    if (sub) (req as Request & { oidc?: unknown }).oidc = { isAuthenticated: () => true, user: { sub, email: `${sub}@example.test` } };
    next();
  }));
  app.use('/api', createMessageRoutes(ctx));
  const server = app.listen(0);
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
}
async function bootSwitchRoutes(): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as typeof req & { oidc?: unknown }).oidc = { isAuthenticated: () => true, user: { sub: OPERATOR } }; next(); });
  app.use('/api/agents', createProviderSwitchRoutes({ store, snapshot: () => snapshot, catalog: () => CATALOG }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/agents/provider-switch/fleet-default`;
}

const ENV_KEYS = ['DEMO_MODE', 'OSHAL_OPERATOR_SUBS', 'CODEX_AUTH_SOURCE_PATH', 'CLAUDE_CODE_CREDENTIALS_PATH', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
  'OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'OSHAL_OPERATOR_LLM_MODEL', 'OSHAL_PROVIDER_FALLBACK_ORDER', 'OSHAL_HOT_FALLBACK_PROBE_INTERVAL_MS',
  'OSHAL_BYO_RETRY_BASE_DELAY_MS', 'OSHAL_BYO_RETRY_MAX_ATTEMPTS', 'OSHAL_EXECUTE_ENTITLEMENT', 'OSHAL_LLM_BUDGETS', 'SWARM_SERVICE_SECRET',
  'OSHAL_DELEGATION_SIGNING_KID', 'OSHAL_DELEGATION_SIGNING_PRIVATE_KEY', 'BOT_NODE_DISPATCH_TIMEOUT_MS'];
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-hot-fallback-'));
  await new Promise<void>((resolve) => nodeServer.listen(0, '127.0.0.1', resolve));
  nodeUrl = `http://127.0.0.1:${(nodeServer.address() as AddressInfo).port}`;
  await new Promise<void>((resolve) => byoServer.listen(0, '127.0.0.1', resolve));
  byoBaseUrl = `http://127.0.0.1:${(byoServer.address() as AddressInfo).port}/v1`;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === geminiCompletions) {
      const headers = new Headers(init?.headers);
      geminiCalls.push({ url, authorization: headers.get('authorization'), model: init?.body ? (JSON.parse(String(init.body)) as { model?: unknown }).model : undefined });
      const answer = geminiAnswer();
      return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'content-type': 'application/json' } });
    }
    return realFetch(input, init);
  }) as typeof fetch;
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await new Promise<void>((resolve) => nodeServer.close(() => resolve()));
  await new Promise<void>((resolve) => byoServer.close(() => resolve()));
  fs.rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(async () => {
  for (const key of ENV_KEYS) { savedEnv[key] = process.env[key]; delete process.env[key]; }
  process.env.DEMO_MODE = 'true';
  process.env.OSHAL_OPERATOR_SUBS = OPERATOR;
  process.env.CODEX_AUTH_SOURCE_PATH = codexPath();
  process.env.CLAUDE_CODE_CREDENTIALS_PATH = claudePath();
  process.env.GEMINI_API_KEY = GEMINI_KEY;
  process.env.OSHAL_EXECUTE_ENTITLEMENT = 'off';
  process.env.OSHAL_BYO_RETRY_BASE_DELAY_MS = '0';
  process.env.OSHAL_HOT_FALLBACK_PROBE_INTERVAL_MS = '0';
  process.env.BOT_NODE_DISPATCH_TIMEOUT_MS = '10000';
  writeCodexLogin(Date.now() + 3_600_000);
  writeClaudeLogin(Date.now() + 3_600_000);
  nodeCalls.length = 0; nodeHealth = 200; rungAnswers.clear();
  byoAnswer = () => ({ status: 200, body: { success: false, error: `byo-hosted endpoint byo.example.test returned HTTP 503: ${HIGH_DEMAND}` } });
  byoRequests.length = 0; byoScript = []; byoFallback = { status: 503, payload: HIGH_DEMAND };
  geminiCalls.length = 0; geminiAnswer = () => ({ status: 200, body: textCompletion('answered-by-gemini') });
  ladder.resolve.mockReset(); ladder.resolve.mockImplementation(async () => undefined);
  logSpies.warn.mockClear(); logSpies.info.mockClear();
  resetFallbackReadinessForTesting();
  resetSameEndpointRetryPlanWarningsForTesting();
  resetOperatorLaneCooldownsForTesting();
  await installChain();
});

afterEach(async () => {
  setInstalledProviderSwitchSnapshot(null, null);
  for (const key of ENV_KEYS) { if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key]; }
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  servers.length = 0;
});

describe('the NODE path — executeBotOrInline over the real BotNodeClient against a loopback bot node', () => {
  it('operator + explicit endpoint + a 503 wall → the first READY rung answers, once, with the marker, and the WARN line never carries the key', async () => {
    const result = await executeBotOrInline(nodeCtx, nodeClient(), AGENT, nodeRequest());

    expect(result.response).toBe('answered-by-openai-codex');
    expect(result.brainFallback).toMatchObject({
      reason: 'byo_exhausted', providerUsed: 'openai-codex', rung: 1, chainSource: 'default', attempts: 1, failure: 'capacity',
      failedEndpoint: { host: 'byo.example.test', model: 'gemini-3.8-flash' },
    });
    expect(resolveHotFallbackChain(AGENT).order).toEqual([...DEFAULT_HOT_FALLBACK_CHAIN]);
    // Exactly two dispatches: the chosen endpoint once, then the rung once — stamped as the provider, endpoint stripped.
    expect(nodeCalls).toHaveLength(2);
    expect(nodeCalls[0].byoLlmConnection).toBeDefined();
    expect(nodeCalls[1]).toMatchObject({ providerId: 'openai-codex' });
    expect(nodeCalls[1].byoLlmConnection).toBeUndefined();
    // The controller-side source never travels to a node, on either dispatch.
    expect(nodeCalls.every((c) => c.byoLlmResolutionSource === undefined)).toBe(true);
    // Logged at WARN with the identity, the attempts, the reason and the rung — and never the key.
    expect(warnLines().some((line) => line.includes('answered by a fallback rung'))).toBe(true);
    const switchLine = logSpies.warn.mock.calls.find((call) => String(call[1]).includes('answered by a fallback rung'))!;
    expect(switchLine[0]).toMatchObject({ host: 'byo.example.test', model: 'gemini-3.8-flash', attempts: 1, reason: 'capacity', rung: 1, providerUsed: 'openai-codex' });
    expect(everyLogArg()).not.toContain(BYO_KEY);
  });

  it('operator + no rung ready (Codex login expired, no Claude login) → the clear error names every rung, and NO fallback dispatch is made', async () => {
    writeCodexLogin(Date.now() - 60_000);
    removeLogin(claudePath());

    await expect(executeBotOrInline(nodeCtx, nodeClient(), AGENT, nodeRequest())).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(ByoFallbackUnavailableError);
      const e = err as ByoFallbackUnavailableError;
      expect(e.code).toBe('BYO_FALLBACK_NOT_READY');
      expect(e.message).toContain('byo.example.test, gemini-3.8-flash');
      expect(e.message).toContain('refused 1 attempt (capacity)');
      expect(e.message).toContain('openai-codex — Codex login expired at');
      expect(e.message).toContain('claude-code — no Claude Code login file');
      expect(e.message).not.toContain(BYO_KEY);
      expect(e.rungs.map((r) => [r.providerId, r.ready])).toEqual([['openai-codex', false], ['claude-code', false]]);
      return true;
    });
    expect(nodeCalls).toHaveLength(1);
    expect(nodeDispatchesByProvider()).toEqual([]);
  });

  it('a NON-operator with an explicit endpoint gets the endpoint failure — the chain is never walked, nothing else is dispatched', async () => {
    await expect(executeBotOrInline(nodeCtx, nodeClient(), AGENT, nodeRequest({ userSub: GUEST }))).rejects.toThrow(/503/);
    expect(nodeCalls).toHaveLength(1);
    expect(warnLines().some((line) => line.includes('hot fallback'))).toBe(false);
  });

  it('DEMO_MODE off makes the operator an ordinary caller — no fallback', async () => {
    delete process.env.DEMO_MODE;
    await expect(executeBotOrInline(nodeCtx, nodeClient(), AGENT, nodeRequest())).rejects.toThrow(/503/);
    expect(nodeCalls).toHaveLength(1);
  });

  it('a 401 on the chosen endpoint is not a capacity problem — no fallback', async () => {
    byoAnswer = () => ({ status: 200, body: { success: false, error: 'byo-hosted endpoint byo.example.test returned HTTP 401: invalid api key' } });
    await expect(executeBotOrInline(nodeCtx, nodeClient(), AGENT, nodeRequest())).rejects.toThrow(/401/);
    expect(nodeCalls).toHaveLength(1);
  });

  it('a threaded connection the ladder chose (operator-key) is not explicit — no retry, no fallback', async () => {
    await expect(executeBotOrInline(nodeCtx, nodeClient(), AGENT, nodeRequest({ byoLlmResolutionSource: 'operator-key' }))).rejects.toThrow(/503/);
    expect(nodeCalls).toHaveLength(1);
  });

  it('the CONFIGURED chain (the fleet row, as on the box) is honoured over the default, and a PUT re-orders it with no restart', async () => {
    // The operator box on 2026-09-22: fleet-default provider claude-code, fallback_order {gemini, openrouter}.
    await installChain({ providerId: 'claude-code', fallbackOrder: ['gemini', 'openrouter'] });
    expect(resolveHotFallbackChain(AGENT)).toMatchObject({ order: ['gemini', 'openrouter'], source: 'fleet-default' });

    const first = await executeBotOrInline(nodeCtx, nodeClient(), AGENT, nodeRequest());
    expect(first.brainFallback).toMatchObject({ providerUsed: 'gemini', rung: 1, chainSource: 'fleet-default' });
    expect(nodeDispatchesByProvider()).toEqual(['gemini']);

    // The exact PUT the operator uses — the real route over the same store the snapshot reads.
    const put = await fetch(await bootSwitchRoutes(), {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ providerId: 'claude-code', fallbackOrder: ['openai-codex', 'gemini'] }),
    });
    expect(put.status).toBe(200);
    expect((await put.json() as { fleetDefault: ProviderSwitchRow }).fleetDefault.fallbackOrder).toEqual(['openai-codex', 'gemini']);

    nodeCalls.length = 0;
    const second = await executeBotOrInline(nodeCtx, nodeClient(), AGENT, nodeRequest({ taskId: 't-node-2', workspaceFolderId: 't-node-2' }));
    expect(second.brainFallback).toMatchObject({ providerUsed: 'openai-codex', rung: 1, chainSource: 'fleet-default' });
    expect(nodeDispatchesByProvider()).toEqual(['openai-codex']);
  });

  it('a rung the probe marks NOT READY is skipped with its reason — never dispatched — and the next ready rung answers as rung 2', async () => {
    await installChain({ providerId: 'gemini', fallbackOrder: ['claude-code', 'openai-codex'] });
    removeLogin(claudePath());

    const result = await executeBotOrInline(nodeCtx, nodeClient(), AGENT, nodeRequest());

    expect(result.brainFallback).toMatchObject({ providerUsed: 'openai-codex', rung: 2 });
    expect(nodeDispatchesByProvider()).toEqual(['openai-codex']);
    const skipped = logSpies.warn.mock.calls.find((call) => String(call[1]).includes('rung is not ready'))!;
    expect(skipped[0]).toMatchObject({ providerId: 'claude-code', rung: 1 });
    expect(String((skipped[0] as { reason: string }).reason)).toContain('no Claude Code login file');
  });

  it('a rung that FAILS is followed by the next rung, once each — never retried within a rung', async () => {
    await installChain({ providerId: 'claude-code', fallbackOrder: ['openai-codex', 'gemini'] });
    rungAnswers.set('openai-codex', () => ({ status: 200, body: { success: false, error: 'codex: You have hit your usage limit' } }));

    const result = await executeBotOrInline(nodeCtx, nodeClient(), AGENT, nodeRequest());

    expect(result.brainFallback).toMatchObject({ providerUsed: 'gemini', rung: 2 });
    expect(nodeDispatchesByProvider()).toEqual(['openai-codex', 'gemini']);
  });

  it('an unreachable bot node makes every rung not-ready — nothing is dispatched to it', async () => {
    nodeHealth = 503;
    await expect(executeBotOrInline(nodeCtx, nodeClient(), AGENT, nodeRequest())).rejects.toThrow(/did not answer its health check/);
    expect(nodeDispatchesByProvider()).toEqual([]);
  });

  it('a deliberately EMPTY configured chain means no failover — the honest error, not the default', async () => {
    await installChain({ providerId: 'claude-code', fallbackOrder: [] });
    await expect(executeBotOrInline(nodeCtx, nodeClient(), AGENT, nodeRequest())).rejects.toThrow(/no fallback rung is configured/);
    expect(nodeCalls).toHaveLength(1);
  });
});

describe('the INLINE path — the REAL orchestrator, a loopback endpoint, and the rung switch INSIDE one turn', () => {
  it('operator + explicit + 503 ×3 → the gemini rung answers at the model call: one saved user message, one cost row on the rung, the marker on the response', async () => {
    await installChain({ providerId: 'claude-code', fallbackOrder: ['gemini', 'openai-codex'] });
    const { orchestrator, getProvider, userMessages, broadcastError, recordInlineTurn } = buildOrchestrator();

    const result = await executeBotOrInline({ orchestrator } as unknown as AppContext, inlineOnly, 'inline-agent', inlineRequest());

    expect(result.response).toBe('answered-by-gemini');
    expect(result.provider).toBe('gemini');
    expect(result.brainFallback).toMatchObject({ providerUsed: 'gemini', rung: 1, chainSource: 'fleet-default', attempts: 3, failure: 'capacity', failedEndpoint: { model: 'user-model' } });
    // The chosen endpoint got its full retry, on the same key, before any rung was tried.
    expect(byoRequests).toHaveLength(3);
    expect(byoRequests.every((r) => r.authorization === `Bearer ${BYO_KEY}`)).toBe(true);
    // The rung ran on the DEPLOYMENT's key, once; the user's key never went to the vendor.
    expect(geminiCalls).toHaveLength(1);
    expect(geminiCalls[0].authorization).toBe(`Bearer ${GEMINI_KEY}`);
    expect(geminiCalls[0].model).toBe(OPENAI_COMPAT_LANES.gemini.defaultModel);
    // ONE turn: one saved user message, no error broadcast, one cost row — under the rung.
    expect(userMessages()).toBe(1);
    expect(broadcastError).not.toHaveBeenCalled();
    expect(recordInlineTurn).toHaveBeenCalledTimes(1);
    const events = recordInlineTurn.mock.calls[0][0] as Array<{ providerId: string; modelId: string }>;
    expect(events.every((e) => e.providerId === `byo-hosted:${OPENAI_COMPAT_LANES.gemini.defaultModel}`)).toBe(true);
    expect(getProvider).not.toHaveBeenCalled();
    expect(everyLogArg()).not.toContain(BYO_KEY);
    expect(everyLogArg()).not.toContain(GEMINI_KEY);
  });

  it('a CLI rung cannot serve an inline turn and says so; with no hosted rung ready the clear error surfaces — still one saved user message', async () => {
    delete process.env.GEMINI_API_KEY;
    const { orchestrator, userMessages, broadcastError } = buildOrchestrator();

    await expect(executeBotOrInline({ orchestrator } as unknown as AppContext, inlineOnly, 'inline-agent', inlineRequest())).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(ByoFallbackUnavailableError);
      const message = (err as Error).message;
      expect(message).toContain('refused 3 attempts (capacity)');
      expect(message).toContain('openai-codex — openai-codex is a CLI login; it can serve a turn only on a bot node');
      expect(message).toContain('claude-code — claude-code is a CLI login');
      return true;
    });
    expect(byoRequests).toHaveLength(3);
    expect(geminiCalls).toHaveLength(0);
    expect(userMessages()).toBe(1);
    expect(broadcastError).toHaveBeenCalledTimes(1);
  });

  it('a HOSTED rung whose key is present but whose lane is COOLING reads not-ready and is never spent on', async () => {
    // The key is there, so nothing but the readiness verdict stands between this rung and a call
    // the vendor would bill. A lane cooling after a mid-turn failure is exactly the rung that must
    // not be taken twice — the inline planner has to obey the probe, not just the key's presence.
    await installChain({ providerId: 'claude-code', fallbackOrder: ['gemini'] });
    expect(coolOperatorKeyLane(OPENAI_COMPAT_LANES.gemini.baseUrl)).toBe('gemini');
    const { orchestrator } = buildOrchestrator();

    await expect(executeBotOrInline({ orchestrator } as unknown as AppContext, inlineOnly, 'inline-agent', inlineRequest())).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(ByoFallbackUnavailableError);
      expect((err as Error).message).toContain('gemini — gemini lane is cooling after a mid-turn failure');
      return true;
    });
    expect(process.env.GEMINI_API_KEY).toBe(GEMINI_KEY);
    expect(geminiCalls).toHaveLength(0);
  });

  it('a 401 and a 400 on the chosen endpoint never reach a rung — the READY rung rides into the turn and is still not spent on (the inline twin of the node 401 case)', async () => {
    // Requirement E on the INLINE transport. The rungs ARE planned and ARE handed to the chain
    // provider (the planned line below proves gemini rode in ready), so the only thing standing
    // between an operator's authorization/request failure and a billed vendor call is the
    // non-retryable classification in hot-fallback-chain-provider.sendRequest. Deleting
    // `!classified.retry ||` there answers both of these turns from gemini instead.
    for (const status of [401, 400] as const) {
      await installChain({ providerId: 'claude-code', fallbackOrder: ['gemini'] });
      byoRequests.length = 0; geminiCalls.length = 0; logSpies.info.mockClear();
      byoFallback = { status, payload: `refused with ${status}` };
      const { orchestrator } = buildOrchestrator();

      await expect(executeBotOrInline({ orchestrator } as unknown as AppContext, inlineOnly, 'inline-agent',
        inlineRequest({ taskId: `t-inline-${status}`, workspaceFolderId: `t-inline-${status}` })))
        .rejects.toSatisfy((err: unknown) => {
          expect((err as Error).message).toContain(String(status));
          expect(err).not.toBeInstanceOf(ByoFallbackUnavailableError);
          return true;
        });

      const planned = logSpies.info.mock.calls.find((call) => String(call[1]).includes('planned for an explicit operator turn'))!;
      expect((planned[0] as { ready: string[] }).ready).toEqual(['gemini']);
      // One attempt on the chosen endpoint (not a capacity wall, so no replay either) and the rung
      // — whose key is present and whose lane is warm — is never called.
      expect(byoRequests).toHaveLength(1);
      expect(geminiCalls).toHaveLength(0);
    }
  });

  it('a NON-operator on the inline path gets the endpoint failure after its retry — no rung is planned, the vendor is never called', async () => {
    await installChain({ providerId: 'claude-code', fallbackOrder: ['gemini'] });
    const { orchestrator } = buildOrchestrator();
    await expect(executeBotOrInline({ orchestrator } as unknown as AppContext, inlineOnly, 'inline-agent', inlineRequest({ userSub: GUEST })))
      .rejects.toThrow(/Inline bot execution failed.*503/);
    expect(byoRequests).toHaveLength(3);
    expect(geminiCalls).toHaveLength(0);
  });
});

describe('the cockpit chat path — POST /api/send-message over the REAL router', () => {
  it('the operator\'s explicit endpoint exhausted → the rung answers and the JSON carries brainFallback', async () => {
    await installChain({ providerId: 'claude-code', fallbackOrder: ['gemini'] });
    const agentId = await pickCliHarnessAgentId();
    ladder.resolve.mockImplementation(async () => ({ baseUrl: byoBaseUrl, apiKey: BYO_KEY, model: 'user-model', resolutionSource: 'explicit' }));
    const { orchestrator, userMessages } = buildOrchestrator();
    const base = await bootSendMessageApp(orchestrator);

    const res = await fetch(`${base}/send-message`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-test-sub': OPERATOR },
      body: JSON.stringify({ taskId: TASK_ID, text: 'hello', agentId }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; response: string; brainFallback?: { providerUsed: string; attempts: number } };
    expect(body.success).toBe(true);
    expect(body.response).toBe('answered-by-gemini');
    expect(body.brainFallback).toMatchObject({ providerUsed: 'gemini', attempts: 3, reason: 'byo_exhausted' });
    expect(byoRequests).toHaveLength(3);
    expect(geminiCalls).toHaveLength(1);
    expect(userMessages()).toBe(1);
  });

  it('the operator\'s explicit endpoint exhausted with nothing ready → 503 BYO_FALLBACK_NOT_READY whose error names the rungs', async () => {
    delete process.env.GEMINI_API_KEY;
    const agentId = await pickCliHarnessAgentId();
    ladder.resolve.mockImplementation(async () => ({ baseUrl: byoBaseUrl, apiKey: BYO_KEY, model: 'user-model', resolutionSource: 'explicit' }));
    const { orchestrator } = buildOrchestrator();
    const base = await bootSendMessageApp(orchestrator);

    const res = await fetch(`${base}/send-message`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-test-sub': OPERATOR },
      body: JSON.stringify({ taskId: TASK_ID, text: 'hello', agentId }),
    });

    expect(res.status).toBe(503);
    const body = await res.json() as { success: boolean; error: string; code: string };
    expect(body.code).toBe('BYO_FALLBACK_NOT_READY');
    expect(body.error).toContain('refused 3 attempts (capacity)');
    expect(body.error).toContain('only on a bot node');
    expect(body.error).not.toContain(BYO_KEY);
    expect(geminiCalls).toHaveLength(0);
  });
});

describe('the readiness probe — stored status without a token, expiry honoured', () => {
  it('admits Antigravity only on a node after a vendor login is pushed', async () => {
    const prior = process.env.ANTIGRAVITY_OAUTH_TOKEN_PATH;
    try {
      process.env.ANTIGRAVITY_OAUTH_TOKEN_PATH = antigravityPath();
      const unproved = await probeRungReadiness({ providerId: 'antigravity-cli', transport: 'node', catalog: CATALOG });
      expect(unproved).toMatchObject({ kind: 'cli-login', ready: false });
      expect(unproved.reason).toContain('no pushed Antigravity login');

      fs.writeFileSync(antigravityPath(), JSON.stringify({
        token: { access_token: 'fixture-access', refresh_token: 'fixture-refresh' },
        auth_method: 'oauth-personal', id_token: 'fixture-id',
      }));
      const proved = await probeRungReadiness({ providerId: 'antigravity-cli', transport: 'node', catalog: CATALOG });
      const inline = await probeRungReadiness({ providerId: 'antigravity-cli', transport: 'inline', catalog: CATALOG });
      expect(proved).toMatchObject({ kind: 'cli-login', ready: true });
      expect(inline).toMatchObject({ kind: 'cli-login', ready: false });
      expect(inline.reason).toContain('only on a bot node');
    } finally {
      if (prior === undefined) delete process.env.ANTIGRAVITY_OAUTH_TOKEN_PATH;
      else process.env.ANTIGRAVITY_OAUTH_TOKEN_PATH = prior;
    }
  });

  it('reads each rung\'s login or key, marks an expired login not-ready, and the stored status carries no token', async () => {
    writeCodexLogin(Date.now() - 1_000);
    const claudeExpiry = Date.now() + 7_200_000;
    writeClaudeLogin(claudeExpiry);
    delete process.env.OPENROUTER_API_KEY;

    const codex = await probeRungReadiness({ providerId: 'openai-codex', transport: 'node', catalog: CATALOG });
    const claude = await probeRungReadiness({ providerId: 'claude-code', transport: 'node', catalog: CATALOG });
    const gemini = await probeRungReadiness({ providerId: 'gemini', transport: 'node', catalog: CATALOG });
    const openrouter = await probeRungReadiness({ providerId: 'openrouter', transport: 'node', catalog: CATALOG });
    const unknown = await probeRungReadiness({ providerId: 'not-a-provider', transport: 'node', catalog: CATALOG });

    expect(codex).toMatchObject({ kind: 'cli-login', ready: false });
    expect(codex.reason).toContain('Codex login expired');
    expect(claude).toMatchObject({ kind: 'cli-login', ready: true, expiresAt: claudeExpiry });
    expect(gemini).toMatchObject({ kind: 'hosted-key', ready: true });
    expect(openrouter).toMatchObject({ kind: 'hosted-key', ready: false });
    expect(openrouter.reason).toContain('OPENROUTER_API_KEY');
    expect(unknown).toMatchObject({ kind: 'unrunnable', ready: false });

    const stored = JSON.stringify(fallbackReadinessSnapshot(['openai-codex', 'claude-code', 'gemini']).rungs);
    expect(stored).not.toContain('fixture-access-token');
    expect(stored).not.toContain(GEMINI_KEY);
    expect(stored).not.toContain('.sig');
  });

  it('on the inline transport a CLI login rung is never ready, and a hosted rung needs an in-process lane', async () => {
    const codex = await probeRungReadiness({ providerId: 'openai-codex', transport: 'inline', catalog: CATALOG });
    const anthropic = await probeRungReadiness({ providerId: 'anthropic', transport: 'inline', catalog: CATALOG });
    const gemini = await probeRungReadiness({ providerId: 'gemini', transport: 'inline', catalog: CATALOG });
    expect(codex.ready).toBe(false);
    expect(codex.reason).toContain('only on a bot node');
    expect(anthropic.ready).toBe(false);
    expect(anthropic.reason).toContain('no in-process hosted lane');
    expect(gemini.ready).toBe(true);
  });

  it('the EXISTING Settings brain route reports the chain and each rung\'s readiness — same route, no token in the payload', async () => {
    // Readiness is shown on the route the AI-Providers card already reads, not a second status
    // endpoint. The fallback block is also fail-soft: the card must still render the preference.
    await installChain({ providerId: 'claude-code', fallbackOrder: ['gemini', 'claude-code'] });
    writeClaudeLogin(Date.now() - 1_000);
    const { createLlmPreferenceRoutes } = await import('../../src/app/routes/llm-preference-routes');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as typeof req & { oidc?: unknown }).oidc = { isAuthenticated: () => true, user: { sub: OPERATOR } }; next(); });
    app.use('/api/settings/llm-default', createLlmPreferenceRoutes({ pool: { query: async () => ({ rows: [] }) } } as unknown as AppContext));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    servers.push(server);

    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/settings/llm-default?refresh=1`);
    expect(res.status).toBe(200);
    const raw = await res.text();
    const body = JSON.parse(raw) as { preference: unknown; hotFallback: { chain: { order: string[]; source: string }; rungs: Array<{ providerId: string; ready: boolean; reason: string }>; gate: { demoMode: boolean; operator: boolean; available: boolean }; setWith: { method: string; path: string } } };

    expect(body.preference).toBeTruthy();
    expect(body.hotFallback.chain).toMatchObject({ order: ['gemini', 'claude-code'], source: 'fleet-default' });
    expect(body.hotFallback.gate).toEqual({ demoMode: true, operator: true, available: true });
    expect(body.hotFallback.rungs.find((r) => r.providerId === 'gemini')?.ready).toBe(true);
    const claude = body.hotFallback.rungs.find((r) => r.providerId === 'claude-code');
    expect(claude?.ready).toBe(false);
    expect(claude?.reason).toContain('Claude Code login expired');
    expect(body.hotFallback.setWith).toMatchObject({ method: 'PUT', path: '/api/agents/provider-switch/fleet-default' });
    // The whole payload, not just the rungs: no key, no token, ever.
    expect(raw).not.toContain(GEMINI_KEY);
    expect(raw).not.toContain('fixture-access-token');
  });
});

describe('the chain is walked ONCE PER TURN — the decorator\'s lifetime is the orchestrator turn', () => {
  /** A provider whose scripted answers make it wall, recover, then wall again across model calls. */
  class ScriptedProvider extends LLMService {
    readonly calls: string[] = [];

    constructor(name: string, private readonly script: Array<'wall' | 'ok'>) { super(name, {}); }

    async sendRequest(_o: SendRequestOptions): Promise<LLMResponse> {
      this.calls.push(this.getProviderName());
      const next = this.script.shift() ?? 'wall';
      if (next === 'wall') throw new Error(`byo-hosted endpoint scripted.test returned HTTP 503: ${HIGH_DEMAND}`);
      return { content: [{ type: 'text', text: `answered-by-${this.getProviderName()}` }], usage: { inputTokens: 1, outputTokens: 1 }, model: `${this.getProviderName()}-model` };
    }
  }

  it('a primary that walls, is walked over, then walls again on a later model call does NOT start a second walk — each rung is spent on once per TURN, not once per model call', async () => {
    // TaskOrchestrator.resolveProvider builds this decorator once per processMessage, so one
    // instance IS one turn and an agentic loop makes up to 25 sendRequest calls through it. Before
    // the walked flag the guard below read 2 rung calls for one turn: the chain was re-walked on
    // the second wall and a rung that had already failed was billed again.
    const primary = new ScriptedProvider('primary', ['wall', 'wall']);
    const rung = new ScriptedProvider('gemini', ['wall', 'ok']);
    const chain = new HotFallbackChainProvider(primary, { agentId: AGENT, baseUrl: 'https://scripted.test/v1', model: 'user-model' }, [
      { providerId: 'gemini', rung: 1, chainSource: 'fleet-default', provider: rung, model: 'gemini-model' },
    ]);
    const options = { messages: [], systemPrompt: 'SYSTEM' } as unknown as SendRequestOptions;

    // Model call 1: the primary walls, the one rung is tried once and fails too.
    await expect(chain.sendRequest(options)).rejects.toThrow(/tried once each and all failed/);
    expect(rung.calls).toHaveLength(1);

    // Model call 2 of the SAME turn: the primary walls again. The chain is already walked.
    await expect(chain.sendRequest(options)).rejects.toThrow(/503/);
    expect(rung.calls).toHaveLength(1);
    expect(primary.calls).toHaveLength(2);
    expect(chain.brainFallback).toBeNull();
  });

  it('a rung that ANSWERED stays the provider for the rest of the turn — the primary is never consulted again', async () => {
    const primary = new ScriptedProvider('primary', ['wall']);
    const rung = new ScriptedProvider('gemini', ['ok', 'ok', 'ok']);
    const chain = new HotFallbackChainProvider(primary, { agentId: AGENT, baseUrl: 'https://scripted.test/v1', model: 'user-model' }, [
      { providerId: 'gemini', rung: 1, chainSource: 'fleet-default', provider: rung, model: 'gemini-model' },
    ]);
    const options = { messages: [], systemPrompt: 'SYSTEM' } as unknown as SendRequestOptions;

    for (let modelCall = 0; modelCall < 3; modelCall += 1) {
      expect((await chain.sendRequest(options)).content[0]).toMatchObject({ text: 'answered-by-gemini' });
    }
    expect(primary.calls).toHaveLength(1);
    expect(rung.calls).toHaveLength(3);
    expect(chain.brainFallback).toMatchObject({ providerUsed: 'gemini', rung: 1, chainSource: 'fleet-default' });
  });
});
