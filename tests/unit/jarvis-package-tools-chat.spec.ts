/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove actual Jarvis ask/poll proposals reach current package execution without private history or stream leakage.
 */
import express, { type RequestHandler } from 'express';
import type { Server } from 'node:http';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const model = vi.hoisted(() => vi.fn());
vi.mock('@/app/routes/inline-bot-execution', () => ({ executeBotOrInline: model }));
vi.mock('@/app/routes/user-brain-resolution', () => ({ resolveUserBrain: async () => ({ kind: 'cli', providerId: 'fixture' }), isRetryableCliBrainFailure: () => false }));
vi.mock('@/app/routes/connector-token-broker', () => ({ resolveBotCreds: async () => ({}) }));
vi.mock('@/features/user-model', () => ({ withHavenContext: async (_pool: unknown, _sub: string, text: string) => text, learnFromExchange: async () => {} }));
vi.mock('@/shared/services/database', () => ({ createOptionalPostgresPool: () => null, ensureConversationStoreSchema: async () => {},
  runRuntimeSchemaBootstrap: async () => {}, buildOwnerRlsPolicyStatements: () => [] }));
vi.mock('@/shared/logger', () => ({ createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
import { InMemoryTaskStore } from '@/entities/task';
import { InMemoryMessageStore } from '@/entities/message';
import { createJarvisRoutes, purgeJarvisAskJobsForOwner } from '@/app/routes/jarvis-routes';
import { createJarvisPackageToolService } from '@/app/composition/jarvis-package-tool-wiring';
import { ToolExecutorService } from '@/features/chat-orchestration/services/tool-executor-service';
import { FollowupQuestionSignal } from '@/features/chat-orchestration/services/followup-question-signal';
import { runWithApplicationAuthorizationActor } from '@/shared/application-authorization-context';
import type { AppContext } from '@/app/composition/app-context';
import { PackageToolsFixture, toolAlice } from '../fixtures/package-tools';

let fixture: PackageToolsFixture, server: Server, base: string, ctx: AppContext;
let history: InMemoryMessageStore, stream: unknown[], queries: unknown[], createTicket: ReturnType<typeof vi.fn>;
const fence = '```oshal:package-tool\n{"toolName":"package_read","input":{}}\n```';
const sessionId = 'jarvis-package-session';
beforeEach(async () => {
  vi.stubEnv('APP_PACKAGE_DYNAMIC_ROUTES', 'true'); fixture = new PackageToolsFixture(); await fixture.mount(); await fixture.grant();
  stream = []; queries = []; history = new InMemoryMessageStore(); createTicket = vi.fn(); model.mockReset(); model.mockResolvedValue({ response: fence });
  ctx = { applicationAuthorization: fixture.runtime, taskStore: new InMemoryTaskStore(), messageStore: history,
    pool: { query: async (...input: unknown[]) => { queries.push(input); return { rows: [], rowCount: 0 }; } },
    streamManager: { broadcastToolExecution: (...args: unknown[]) => { stream.push(args); } }, dynamicToolExecutorRegistry: fixture.descriptors,
    toolRegistryService: { getToolByName: async (name: string) => ({ name, enabled: true, defaultAuthMode: 'auto', description: 'Read fixture records', displayName: 'Fixture records', routingTags: ['customer lookup'], tags: ['records'] }) },
    ticketService: { listTickets: async () => [], openChatTicket: async () => ({ ticketId: 'fixture-chat' }), createTicket, updateStatus: async () => {} },
  } as unknown as AppContext;
  const app = express(); app.use(express.json());
  const auth: RequestHandler = (req, res, next) => {
    if (req.get('x-fixture-user') !== 'alice') { res.sendStatus(401); return; }
    (req as any).oidc = { user: { sub: toolAlice.sub, iss: toolAlice.issuer }, isAuthenticated: () => true }; next();
  };
  app.use('/api/jarvis', auth, createJarvisRoutes(ctx, process.cwd(), undefined, createJarvisPackageToolService(ctx, fixture.registry)));
  server = await new Promise<Server>(done => { const listening = app.listen(0, '127.0.0.1', () => done(listening)); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  purgeJarvisAskJobsForOwner(toolAlice.sub); server?.closeAllConnections();
  if (server) await new Promise<void>(done => server.close(() => done()));
  await fixture.close(); vi.unstubAllEnvs();
});
function call(path: string, body?: unknown) {
  return fetch(base + '/api/jarvis' + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-fixture-user': 'alice', 'content-type': 'application/json', 'x-oshal-package-tool': '1', origin: base },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function ask() {
  const response = await call('/ask', { message: 'Show my fixture records', sessionId }); expect(response.status).toBe(202);
  const { jobId } = await response.json(); let result: any;
  await expect.poll(async () => { result = await (await call('/ask/result?jobId=' + jobId)).json(); return result.status; }).not.toBe('pending');
  return { result, jobId };
}

it('puts current tools in the real prompt and executes the returned proposal without persisting private output', async () => {
  const { result, jobId } = await ask(); expect(result.status).toBe('done'); expect(result.packageToolProposal.toolName).toBe('package_read');
  expect(model.mock.calls[0][3].text).toContain('APPLICATION TOOL PROPOSALS'); expect(fixture.results).toBe(0);
  expect(model.mock.calls[0][3].text).toContain('customer lookup');
  const response = await call('/package-tools/execute', { proposalId: result.packageToolProposal.id });
  expect(response.status).toBe(200); expect((await response.json()).result.count).toBe(3);
  expect((await (await call('/ask/result?jobId=' + jobId)).json()).packageToolProposal).toBeUndefined();
  expect((await call('/package-tools/result', { proposalId: result.packageToolProposal.id })).status).toBe(410);
  const stored = JSON.stringify({ history: await history.getByTask(sessionId), queries, stream });
  expect(stored).not.toContain('"count":3'); expect(stored).not.toContain('principalIssuer');
  expect(model).toHaveBeenCalledTimes(1); expect(createTicket).not.toHaveBeenCalled();
});
it('drops revoked pending proposals from actual polling and refuses execution', async () => {
  const { result, jobId } = await ask(); await fixture.grant({ action: 'revoke' });
  expect((await (await call('/ask/result?jobId=' + jobId)).json()).packageToolProposal).toBeUndefined();
  expect((await call('/package-tools/execute', { proposalId: result.packageToolProposal.id })).status).toBe(403); expect(fixture.results).toBe(0);
});
it.each(['plan', 'handoff', 'surface', 'artifact'])('rejects a package proposal mixed with %s before any dispatch', async kind => {
  model.mockResolvedValue({ response: fence + '\n```oshal:' + kind + '\n{"steps":[{"app":"one"},{"app":"two"}]}\n```' });
  const { result } = await ask(); expect(result.packageToolProposal).toBeUndefined(); expect(result.dispatched).toEqual([]);
  expect(createTicket).not.toHaveBeenCalled(); expect(fixture.results).toBe(0); expect(result.answer).not.toContain('```');
});
it.each(['error', 'followup'])('keeps private package inputs and %s payloads off the legacy chat stream', async kind => {
  fixture.wait = async () => { throw kind === 'error' ? new Error('PRIVATE_FAILURE_SENTINEL') : new FollowupQuestionSignal('PRIVATE_FAILURE_SENTINEL'); };
  const executor = new ToolExecutorService({ streamManager: ctx.streamManager, dynamicToolExecutorRegistry: fixture.descriptors });
  await expect(runWithApplicationAuthorizationActor(toolAlice, () => executor.executeTool(sessionId, 'package_read', { privateField: 'PRIVATE_INPUT_SENTINEL' }, undefined, toolAlice.sub))).rejects.toThrow('PRIVATE_FAILURE_SENTINEL');
  expect(JSON.stringify(stream)).not.toContain('PRIVATE_');
  if (kind === 'error') expect(JSON.stringify(stream)).toContain('Package tool execution failed');
});
