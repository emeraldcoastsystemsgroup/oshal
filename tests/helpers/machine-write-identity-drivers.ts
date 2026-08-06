/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted the machine-write HTTP driver infrastructure and the five final proof-debt drivers from the class-gate spec so both files remain below the repository code-line decomposition threshold.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Name deterministic test credentials as placeholders so the fail-closed repository secret scanner can distinguish fixtures from deployable secret material.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Prove CORE-05 live verification preserves one operator PAT owner across its loopback message request and into the owner-scoped chat-task write seam.
 */

import crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import http from 'node:http';
import express from 'express';
import { vi } from 'vitest';
import {
  getRequestIdentity,
  runWithRequestIdentity,
  type RequestIdentity,
} from '@/shared/services/database/request-identity';
import { A2A_TOKEN_PREFIX, ownerSubForA2aAgent } from '@/features/a2a-gateway';
import {
  RemoteTaskJournalService,
  type RemoteTaskOutboxPublisher,
  type SettleRemoteTaskInput,
  type SettleRemoteTaskOutcome,
} from '@/features/remote-client';
import { createA2aRpcHandler } from '@/app/routes/a2a-routes';
import { createRemoteClientRoutes } from '@/app/routes/remote-client-routes';
import { createCliTokenAuthMiddleware, generateCliToken } from '@/app/routes/cli-token-routes';
import { createLocalAuthRoutes } from '@/app/routes/local-auth-routes';
import { createInstallVerificationRoutes } from '@/app/routes/install-verification-routes';
import { createMessageRoutes } from '@/app/routes/message-routes';
import { authorizeBotNodeExecutionCall } from '@/app/bot-node-request-auth';
import { runBotNodeExecutionWithSystemIdentity } from '@/app/bot-node-request-identity';
import { getCaller, isOperator, serviceSecretOr } from '@/shared/middleware/authz';
import { InMemoryRemoteTaskJournalFixture } from './in-memory-remote-task-journal';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** What one owner-scoped operation saw at its database/cost boundary. */
export interface WriteObservation {
  /** AsyncLocalStorage identity in scope at the moment of the operation. */
  identity: RequestIdentity | undefined;
  /** Owner carried by the row or cost event, when the operation names one. */
  ownerValue?: string | null;
  /** Short label that makes a failing boundary immediately identifiable. */
  label: string;
}

/** One behavioral proof driver keyed by its machine-write inventory id. */
export type MachineWriteIdentityDriver = () => Promise<WriteObservation[]>;

/** A pg-shaped pool that records identity and owner parameters for matching SQL. */
export function capturingPool(
  observations: WriteObservation[],
  respond: (sql: string, params: unknown[]) => { rows: unknown[]; rowCount: number },
  interesting: RegExp,
  ownerParamIndex: number,
): { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }> } {
  return {
    query: async (sql: string, params: unknown[] = []) => {
      if (interesting.test(sql)) {
        observations.push({
          identity: getRequestIdentity(),
          ownerValue: (params[ownerParamIndex] as string | undefined) ?? null,
          label: sql.replace(/\s+/g, ' ').trim().slice(0, 60),
        });
      }
      return respond(sql, params);
    },
  };
}

/** Boots an Express router on an ephemeral loopback port. */
export async function serve(
  mount: string,
  router: express.Router,
): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use(mount, router);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export const SERVICE_USER_PLACEHOLDER = 'machine-write-service-user-placeholder';

/** Headers for a valid service credential and its optional separate user binding. */
export function serviceUserHeaders(sub?: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-service-secret': SERVICE_USER_PLACEHOLDER,
    ...(sub ? { 'x-oshal-user-sub': sub } : {}),
  };
}

/** Serves a user-bound router behind the same service-secret-or-session gate as production. */
export async function serveServiceUserRoute(
  mount: string,
  router: express.Router,
): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  const deny: express.RequestHandler = (_req, res) => { res.status(401).json({ error: 'unauthorized' }); };
  app.use(mount, serviceSecretOr(deny), router);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Proves a valid machine credential cannot proceed without its separate user binding. */
export async function assertMissingServiceOwnerRejected(url: string, init?: RequestInit): Promise<void> {
  const response = await fetch(url, { ...init, headers: serviceUserHeaders() });
  const body = await response.json() as { error?: string };
  if (response.status !== 403 || body.error !== 'trusted_service_user_sub_required') {
    throw new Error(`missing trusted service owner was not refused: HTTP ${response.status}`);
  }
}

/** Waits briefly for a deliberately detached production write to reach its capture seam. */
export async function waitForObservation(observations: WriteObservation[]): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (observations.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** In-memory journal variant that emits the real settlement outbox publisher over HTTP. */
class CostingRemoteTaskJournalFixture extends InMemoryRemoteTaskJournalFixture {
  private pendingSettlementTaskId: string | null = null;

  override async settle(input: SettleRemoteTaskInput): Promise<SettleRemoteTaskOutcome> {
    const outcome = await super.settle(input);
    if (outcome.kind === 'settled') this.pendingSettlementTaskId = input.result.taskId;
    return outcome;
  }

  override async deliverNextOutbox(publish: RemoteTaskOutboxPublisher): Promise<boolean> {
    const taskId = this.pendingSettlementTaskId;
    if (!taskId) return false;
    this.pendingSettlementTaskId = null;
    const task = this.tasks.get(taskId);
    if (!task?.terminalResult) throw new Error('settlement fixture lost its terminal task');
    await publish({
      outboxId: `identity-outbox-${taskId}`, taskId, clientId: task.clientId,
      ownerSub: task.ownerSub, eventId: 1, topic: 'remote-task.settlement',
      payload: { envelope: task.envelope, result: task.terminalResult },
      createdAt: new Date().toISOString(), deliveredAt: null,
    });
    return true;
  }
}

/** Fails a driver with the endpoint response body instead of an opaque status mismatch. */
async function requireHttpStatus(response: globalThis.Response, expected: number, label: string): Promise<void> {
  if (response.status === expected) return;
  throw new Error(`${label}: expected HTTP ${expected}, received ${response.status}: ${(await response.text()).slice(0, 300)}`);
}

/** Drives authenticated A2A message/send through real HTTP into ticket creation. */
async function driveA2aRpcIdentity(): Promise<WriteObservation[]> {
  const observations: WriteObservation[] = [];
  const token = `${A2A_TOKEN_PREFIX}${'a1'.repeat(24)}`;
  const ownerSub = ownerSubForA2aAgent('identity-driver-agent');
  const ticketService = {
    createTicket: async (input: { ownerSub?: string | null; title: string }) => {
      observations.push({ identity: getRequestIdentity(), ownerValue: input.ownerSub, label: 'A2A createTicket' });
      return { ticketId: 'a2a-identity-ticket', title: input.title, status: 'approved', metadata: {} };
    },
    getTicket: async () => null,
    updateStatus: async () => undefined,
  };
  const credentials = {
    authenticate: async (candidate: string) => candidate === token
      ? { agentId: 'identity-driver-agent', name: 'identity driver', scopes: ['message:send'] }
      : null,
  };
  const pool = { query: async () => ({ rows: [{ n: 0 }], rowCount: 1 }) };
  const router = express.Router();
  router.post('/', createA2aRpcHandler({
    pool: pool as never, ticketService: ticketService as never,
    messageStore: { getByTask: async () => [] }, credentials: credentials as never,
    env: { A2A_GATEWAY_ENABLED: 'true' } as NodeJS.ProcessEnv,
  }));
  const { url, close } = await serve('/api/a2a', router);
  try {
    const response = await fetch(`${url}/api/a2a`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'gate', method: 'message/send', params: {
        message: { role: 'user', parts: [{ kind: 'text', text: 'identity gate' }] },
      } }),
    });
    await requireHttpStatus(response, 200, 'A2A identity probe');
  } finally { await close(); }
  if (observations[0]?.ownerValue !== ownerSub) throw new Error('A2A ticket owner did not match authenticated agent');
  return observations;
}

/** Builds one owner-bound remote-client registration accepted by the production schema. */
function remoteIdentityRegistration(clientId: string, ownerSub: string): Record<string, unknown> {
  return {
    clientId, ownerSub, name: 'Machine identity driver', transport: 'http', platform: 'windows',
    controlPlaneUrl: 'http://127.0.0.1:35457', capabilities: ['mcp.call-tool'], tags: ['identity-gate'],
  };
}

/** Builds one durable leaf task whose completion includes metered LLM usage. */
function remoteIdentityTask(clientId: string, ownerSub: string): Record<string, unknown> {
  return {
    taskId: 'remote-identity-task', correlationId: 'remote-identity-ticket',
    fromAgentId: 'remote-identity-agent', toAgentId: clientId, intent: 'mcp.call-tool', userSub: ownerSub,
    input: { name: 'shell.exec', arguments: { command: 'whoami', model: 'identity-model' } },
    createdAt: new Date().toISOString(),
  };
}

/** Drives shared-secret remote settlement through the durable atomic cost publisher. */
async function driveRemoteClientIdentity(): Promise<WriteObservation[]> {
  const credentialPlaceholder = 'remote-client-identity-placeholder';
  const clientId = `identity-client-${crypto.randomUUID()}`;
  const ownerSub = 'auth0|remote-identity-owner';
  vi.stubEnv('REMOTE_CLIENT_SHARED_SECRET', credentialPlaceholder);
  vi.stubEnv('OSHAL_RATE_LIMIT_REMOTE_CLIENTS', 'off');
  const observations: WriteObservation[] = [];
  const taskJournalService = new RemoteTaskJournalService(new CostingRemoteTaskJournalFixture());
  const router = createRemoteClientRoutes({
    taskJournalService,
    workItemRepository: {
      findByExternalIdAnyProvider: async () => [],
      setExecutionOutput: async () => undefined,
      updateStatus: async () => undefined,
    },
    recordCostOnce: async (_outboxId, event) => {
      observations.push({ identity: getRequestIdentity(), ownerValue: event.ownerSub, label: 'remote cost settlement' });
      return true;
    },
  });
  const { url, close } = await serve('/api/remote-clients', router);
  const headers = { 'content-type': 'application/json', 'x-remote-client-key': credentialPlaceholder };
  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await requireHttpStatus(await fetch(`${url}/api/remote-clients/register`, {
      method: 'POST', headers, body: JSON.stringify(remoteIdentityRegistration(clientId, ownerSub)),
    }), 201, 'remote registration');
    await requireHttpStatus(await fetch(`${url}/api/remote-clients/${clientId}/tasks`, {
      method: 'POST', headers, body: JSON.stringify(remoteIdentityTask(clientId, ownerSub)),
    }), 201, 'remote task enqueue');
    await requireHttpStatus(await fetch(`${url}/api/remote-clients/${clientId}/tasks/next`, { headers }), 200, 'remote task claim');
    await requireHttpStatus(await fetch(`${url}/api/remote-clients/${clientId}/tasks/remote-identity-task/complete`, {
      method: 'POST', headers, body: JSON.stringify({ correlationId: 'remote-identity-ticket', output: {
        provider: 'openai-codex', usage: { inputTokens: 3, outputTokens: 2 }, cost: 0.01,
      } }),
    }), 200, 'remote task settlement');
  } finally { await close(); }
  return observations;
}

/** Drives actual bot-node machine auth and its import-safe production SYSTEM seam. */
async function driveBotNodeIdentity(): Promise<WriteObservation[]> {
  vi.stubEnv('SWARM_SERVICE_SECRET', SERVICE_USER_PLACEHOLDER);
  const observations: WriteObservation[] = [];
  const serverSource = fs.readFileSync(path.join(REPO_ROOT, 'src/app/bot-node-server.ts'), 'utf8');
  if (!serverSource.includes('runBotNodeExecutionWithSystemIdentity(() => executionHandler(envelope))')) {
    throw new Error('bot-node server no longer uses the tested system-identity execution seam');
  }
  const router = express.Router();
  router.post('/', authorizeBotNodeExecutionCall, async (req, res) => {
    await runBotNodeExecutionWithSystemIdentity(async () => {
      await Promise.resolve();
      observations.push({
        identity: getRequestIdentity(), ownerValue: req.body?.userSub ?? null, label: 'bot-node cost write seam',
      });
    });
    res.json({ success: true });
  });
  const { url, close } = await serve('/api/swarm-execute', router);
  try {
    await requireHttpStatus(await fetch(`${url}/api/swarm-execute`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    }), 401, 'bot-node missing-secret refusal');
    await requireHttpStatus(await fetch(`${url}/api/swarm-execute`, {
      method: 'POST', headers: serviceUserHeaders('auth0|bot-node-owner'), body: '{}',
    }), 200, 'bot-node identity probe');
  } finally { await close(); }
  return observations;
}

/** Drives a real Bearer PAT through its pre-identity lookup and telemetry write. */
async function driveCliTokenIdentity(): Promise<WriteObservation[]> {
  const observations: WriteObservation[] = [];
  const token = generateCliToken();
  const pool = {
    query: async (sql: string) => {
      if (/oshal_cli_tokens/i.test(sql)) {
        const label = /SELECT id, user_sub/i.test(sql) ? 'CLI token lookup' : 'CLI token last-used update';
        observations.push({ identity: getRequestIdentity(), ownerValue: 'auth0|cli-owner', label });
      }
      if (/SELECT id, user_sub/i.test(sql)) {
        return { rows: [{ id: 'cli-identity-token', user_sub: 'auth0|cli-owner', email: null, node_client_id: null, principal_issuer: null }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
  };
  const router = express.Router();
  router.use(createCliTokenAuthMiddleware(pool as never));
  router.get('/probe', (req, res) => {
    const sub = (req as { oidc?: { user?: { sub?: string } } }).oidc?.user?.sub;
    res.status(sub ? 200 : 401).json({ sub });
  });
  const { url, close } = await serve('/api/cli-auth', router);
  try {
    await requireHttpStatus(await fetch(`${url}/api/cli-auth/probe`, {
      headers: { authorization: `Bearer ${token}` },
    }), 200, 'CLI token identity probe');
    await waitForObservation(observations);
  } finally { await close(); }
  if (!observations.some((seen) => seen.label === 'CLI token lookup')) throw new Error('CLI PAT lookup was not observed');
  if (!observations.some((seen) => seen.label === 'CLI token last-used update')) throw new Error('CLI PAT telemetry was not observed');
  return observations;
}

/** Drives first-admin bootstrap through its real public route and SYSTEM store rail. */
async function driveLocalAuthIdentity(): Promise<WriteObservation[]> {
  vi.stubEnv('SESSION_SECRET', 'local-auth-identity-secret-at-least-thirty-two-characters');
  const observations: WriteObservation[] = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      if (!/INSERT INTO oshal_local_users/i.test(sql)) return { rows: [], rowCount: 0 };
      observations.push({ identity: getRequestIdentity(), ownerValue: params[3] as string, label: 'local user bootstrap' });
      return { rows: [{
        id: params[0], email: params[1], display_name: params[2], user_sub: params[3],
        status: 'active', token_version: 1, created_at: new Date().toISOString(),
      }], rowCount: 1 };
    },
  };
  const { url, close } = await serve('/', createLocalAuthRoutes(pool as never));
  try {
    await requireHttpStatus(await fetch(`${url}/api/local-auth/bootstrap`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'identity-driver@example.com', name: 'Identity Driver', password: 'correct horse battery staple' }),
    }), 201, 'local-auth bootstrap identity probe');
  } finally { await close(); }
  return observations;
}

const INSTALL_VERIFY_PAT = `oshal_pat_${'b'.repeat(48)}`;
const INSTALL_VERIFY_OWNER = 'auth0|install-verification-owner';

/** PostgreSQL seam for real PAT authentication plus the post-generation ledger read. */
function installVerificationPool() {
  return {
    query: async (sql: string) => {
      if (/SELECT id, user_sub/i.test(sql)) return { rows: [{
        id: 'install-verification-pat', user_sub: INSTALL_VERIFY_OWNER, email: 'operator@example.test',
        node_client_id: null, principal_issuer: null,
      }], rowCount: 1 };
      if (/FROM chat_tasks/i.test(sql)) return { rows: [{
        provider_id: 'identity-provider', total_input_tokens: 2, total_output_tokens: 1,
        total_cost: 0.001, total_requests: 1, usage_by_model: { 'identity-model': { requestCount: 1 } },
      }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
  };
}

/** Production-shaped PAT identity binding used on both sides of the verifier loopback call. */
const bindPatIdentity: express.RequestHandler = (req, _res, next) => {
  runWithRequestIdentity({ sub: getCaller(req).sub, isOperator: isOperator(req) }, () => next());
};

/** Minimal requiresAuth equivalent: the production PAT middleware must have established a user. */
const requirePatUser: express.RequestHandler = (req, res, next) => {
  if (getCaller(req).sub) { next(); return; }
  res.status(401).json({ error: 'unauthorized' });
};

/** Serve the ordinary message route and observe its owner-scoped orchestrator persistence seam. */
async function serveInstallVerificationTarget(observations: WriteObservation[]) {
  const pool = installVerificationPool();
  const ctx = {
    pool, taskStore: { get: async () => null }, ticketService: {},
    workspaceService: { resolveTaskOwner: async () => null },
    orchestrator: { processMessage: async (_taskId: string, _text: string, options: { userSub?: string }) => {
      observations.push({ identity: getRequestIdentity(), ownerValue: options.userSub, label: 'chat_tasks write seam' });
      return { success: true, response: 'OSHAL_LIVE_OK' };
    } },
  };
  const router = express.Router();
  router.use(createCliTokenAuthMiddleware(pool as never), bindPatIdentity, serviceSecretOr(requirePatUser));
  router.use(createMessageRoutes(ctx as never));
  return serve('/api', router);
}

/** Drive the PAT-only live verifier through its real second HTTP authentication boundary. */
async function driveInstallVerificationIdentity(): Promise<WriteObservation[]> {
  vi.stubEnv('OSHAL_OPERATOR_SUBS', INSTALL_VERIFY_OWNER);
  vi.stubEnv('OSHAL_NO_AI', 'false');
  const observations: WriteObservation[] = [];
  const target = await serveInstallVerificationTarget(observations);
  const pool = installVerificationPool();
  const router = express.Router();
  router.use(createCliTokenAuthMiddleware(pool as never), bindPatIdentity, serviceSecretOr(requirePatUser));
  router.use(createInstallVerificationRoutes(
    { pool } as never, { getApp: async () => null } as never,
    { apiBaseUrl: target.url, randomUUID: () => 'machine-write-identity' },
  ));
  const verifier = await serve('/api/install-verification', router);
  try {
    await requireHttpStatus(await fetch(`${verifier.url}/api/install-verification/live`, {
      method: 'POST', headers: { authorization: `Bearer ${INSTALL_VERIFY_PAT}`, 'content-type': 'application/json' }, body: '{}',
    }), 200, 'install live verification identity probe');
  } finally { await Promise.all([verifier.close(), target.close()]); }
  return observations;
}

/** Machine-write proofs extracted from the class-gate spec to keep it below the file cap. */
export const MACHINE_WRITE_IDENTITY_RESIDUAL_DRIVERS: Record<string, MachineWriteIdentityDriver> = {
  'a2a-rpc': driveA2aRpcIdentity,
  'remote-client-plane': driveRemoteClientIdentity,
  'bot-node-swarm-execute': driveBotNodeIdentity,
  'cli-token-auth': driveCliTokenIdentity,
  'local-auth': driveLocalAuthIdentity,
  'install-verification-live': driveInstallVerificationIdentity,
};
