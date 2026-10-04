/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Mount actual controller/client/node replay routes over isolated frames, synthetic verified sessions and recorded provider/ownership/cost seams.
 */
import express, { type RequestHandler } from 'express';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';
import type { AppContext } from '@/app/composition/app-context';
import { createTokenChaseRoutes } from '@/app/routes/token-chase-routes';
import { registerBotNodeTokenChaseReplayRoute } from '@/app/bot-node-token-chase-replay-route';
import { authorizeBotNodeBeforeBody, authorizeBotNodeInternalCall } from '@/app/bot-node-request-auth';
import { clearPrivilegedIdentities, setPrivilegedIdentities } from '@/shared/middleware/privileged-identities';
import { getRequestIdentity } from '@/shared/services/database/request-identity';
import { getActiveRegistry } from '@/app/extensions/swarm/swarm-bot-registry';
import { BotNodeTailReplayClient, createRegistryEndpointResolver, type TailReplayNodeResponse } from '@/features/agent-management';
import type { CostTrackingService } from '@/features/operational-intelligence';

export const TOKEN_CHASE_FIXTURE_SECRET = 'fixture-machine-secret';
/** @description Synthetic authentication only; headers select an isolated fixture principal and never modify the production identity reader. */
const authenticate: RequestHandler = (req, res, next) => {
  const user = req.get('x-fixture-user') ?? 'member';
  if (!['member', 'operator', 'second', 'missing-issuer', 'other-issuer'].includes(user)) { res.sendStatus(401); return; }
  const sub = user === 'other-issuer' ? 'fixture-member' : `fixture-${user}`;
  const iss = user === 'missing-issuer' ? undefined : user === 'other-issuer' ? 'https://other.identity.test' : 'https://identity.example.test';
  Object.assign(req, { oidc: { isAuthenticated: () => true, user: { sub }, idTokenClaims: { sub, iss } } }); next();
};

/** @description Real captured-frame files exercise ownerless sharing and exact owner refusal through the production read service. */
async function writeFrames(root: string) {
  for (const [runId, userSub] of [['shared', undefined], ['own', 'fixture-member'], ['foreign', 'fixture-other']]) {
    const dir = path.join(root, runId!, '.tokenchase'); await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'frame-0001.json'), JSON.stringify({ seq: 1, phase: 'closed', userSub,
      agentId: 'fixture-worker', replayable: true, decision: { model: 'baseline', harnessFired: 'hosted' },
      outcome: { tokensIn: 100, tokensOut: 10 }, context: { systemPrompt: 'Answer exactly' }, response: { content: 'Stable answer' } }));
    await writeFile(path.join(dir, 'frame-0001.history.json'), JSON.stringify([{ role: 'user', content: 'Answer exactly' }]));
  }
}

/** @description Bind an isolated server to loopback; all fetches in this fixture target these owned ephemeral ports. */
async function listen(app: express.Express) {
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(done => server.once('listening', done));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

/** @description Actual protected ownership guard and provider route use recorded DB/provider/cost collaborators, without PostgreSQL or vendor traffic. */
async function createNode() {
  const query = vi.fn(async () => ({ rows: [] as Array<{ app: string; protected: boolean }> }));
  const generated = vi.fn(async (_history: unknown[], _options: Record<string, unknown>) => ({ content: 'Stable answer',
    usage: { inputTokens: 10, outputTokens: 5 }, cost: 0.001, model: 'node-model', provider: 'fixture-hosted' }));
  const currentProvider = vi.fn(() => ({ generateResponse: generated }));
  const variantProvider = vi.fn((_connection: { baseUrl: string; apiKey: string; model: string }) => ({ generateResponse: generated }));
  const costIdentities: unknown[] = [], recordCost = vi.fn(async (_event: Parameters<CostTrackingService['recordCost']>[0]) => { costIdentities.push(getRequestIdentity()); });
  const app = express(); app.use(authorizeBotNodeBeforeBody); app.use(express.json());
  registerBotNodeTokenChaseReplayRoute(app, { agentId: 'fixture-worker', authorize: authorizeBotNodeInternalCall,
    pool: { query } as never, activeLlm: () => ({ provider: 'fixture-hosted', model: 'node-model' }),
    currentProvider, variantProvider, costTrackingService: { recordCost } });
  return { ...await listen(app), query, generated, currentProvider, variantProvider, recordCost, costIdentities };
}

/** @description Recorded token-free hermetic restore seam; actual controller tail service and paid re-fire still use the production replay HTTP route. */
function isolatedTailRestore() {
  const result: TailReplayNodeResponse = { success: true, runId: 'shared', fromFrame: 1, agentId: 'fixture-worker', ownerSub: null,
    status: 'reproduced', restore: { source: 'none', workspaceCommit: null, filesRestored: 0, integrity: 'none', treeSha: null, warnings: [] },
    store: { bound: false, restored: false, files: 0, version: null, reason: null }, framesInTail: 1, frames: [], stoppedAtFrame: null, stopReason: null,
    toolCalls: 0, artifacts: { baselineTreeSha: null, replayTreeSha: null, reproduced: null, differingPaths: [], redactedPaths: [], complete: true, warnings: [] },
    storeVersion: { baseline: null, replay: null, reproduced: null, bound: false }, paidCalls: 0, costUsd: 0, durationMs: 0 };
  return vi.spyOn(BotNodeTailReplayClient.prototype, 'replayTail').mockResolvedValue(result);
}

/** @description Confines recursive fixture cleanup to the directly contained, prefix-owned temporary root after absolute resolution. */
async function cleanupFixtureRoot(root: string): Promise<void> {
  const target = path.resolve(root);
  if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('tc-spend-fixture-')) {
    throw new Error('Fixture cleanup target is outside the owned temporary root');
  }
  await rm(target, { recursive: true, force: true });
}

/** @description Mount production controller routes and the real HTTP BotNodeClient with a recorded endpoint-selection seam; global RLS middleware is deliberately absent. */
export async function tokenChaseSpendingFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tc-spend-fixture-'));
  vi.stubEnv('OSHAL_WORKSPACE_ROOT', root); vi.stubEnv('OSHAL_DB_GUC', 'off');
  vi.stubEnv('DEMO_MODE', 'true'); vi.stubEnv('OSHAL_OPERATOR_SUBS', 'fixture-operator'); vi.stubEnv('OSHAL_OPERATOR_EMAILS', '');
  vi.stubEnv('SWARM_SERVICE_SECRET', TOKEN_CHASE_FIXTURE_SECRET); vi.stubEnv('TOKEN_CHASE_AUTO_PROMOTE', 'false');
  vi.stubEnv('TOKEN_CHASE_ADMIN_SUBS', ''); vi.stubEnv('BOT_NAME', ''); vi.stubEnv('AGENT_ID', '');
  vi.stubEnv('CONFIG_OUTPUT_DIR', root); vi.stubEnv('OPENROUTER_API_KEY', 'fixture-shared-openrouter');
  clearPrivilegedIdentities(); setPrivilegedIdentities([{ sub: 'fixture-operator', email: null, role: 'admin' }]);
  await writeFrames(root); const node = await createNode();
  vi.mocked(createRegistryEndpointResolver).mockReturnValue(() => node.base);
  vi.mocked(getActiveRegistry).mockReturnValue([{ agentId: 'fixture-worker', name: 'fixture-worker', harnessType: 'hosted', container: 'fixture', port: 1 }] as never);
  const require = createRequire(import.meta.url);
  const { EncryptedConfigManager } = require('../../src/api/encrypted-config-manager.js');
  const secrets = vi.spyOn(EncryptedConfigManager.prototype, 'loadSecrets').mockReturnValue({ GROQ_API_KEY: 'fixture-framework-vendor' });
  const pool = { query: vi.fn(async () => ({ rows: [{ spend: 0 }] })) };
  const pushToBot = vi.fn(async () => ({ pushed: true, newVersion: 2 }));
  const ctx = { pool, swarm: { configSyncService: { pushToBot } } } as unknown as AppContext;
  const app = express(); app.use(express.json()); app.use('/api/token-chase', authenticate, createTokenChaseRoutes(root, ctx));
  const controller = await listen(app), tailRestore = isolatedTailRestore();
  return { node, secrets, pushToBot, root, tailRestore,
    call: (route: string, user = 'member', body?: unknown, headers: Record<string, string> = {}) => fetch(controller.base + '/api/token-chase' + route,
      { method: body === undefined ? 'GET' : 'POST', headers: { 'x-fixture-user': user, 'content-type': 'application/json', ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    nodeCall: (body: unknown, secret: string | null = TOKEN_CHASE_FIXTURE_SECRET) => fetch(node.base + '/api/token-chase/replay-call',
      { method: 'POST', headers: { 'content-type': 'application/json', ...(secret ? { 'x-service-secret': secret } : {}) }, body: JSON.stringify(body) }),
    close: async () => { for (const { server } of [node, controller]) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
      await cleanupFixtureRoot(root); clearPrivilegedIdentities(); vi.restoreAllMocks(); vi.unstubAllEnvs(); },
  };
}
