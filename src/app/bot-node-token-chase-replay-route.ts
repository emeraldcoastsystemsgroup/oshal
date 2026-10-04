/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Extract the real tool-free replay route and record caller-bound costs without operator privileges or cross-caller task collisions.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Express, RequestHandler } from 'express';
import type { Pool } from 'pg';
import type { ReplayCallRequest } from '@/features/agent-management';
import type { CostTrackingService } from '@/features/operational-intelligence';
import { createChildLogger } from '@/shared/logger';
import { normalizePrincipalIssuer } from '@/shared/middleware/principal-issuer';
import { runWithRequestIdentity } from '@/shared/services/database/request-identity';
import { normalizeBotNodeUserSub } from './bot-node-request-scope';
import { assertBotNodeApplicationTransport } from './bot-node-application-authorization';

const logger = createChildLogger({ module: 'bot-node-token-chase-replay-route' });
type ReplayResponse = { content?: string; usage?: { inputTokens?: number; outputTokens?: number }; cost?: number; model?: string; provider?: string };
type ReplayProvider = { generateResponse(history: unknown[], options: Record<string, unknown>): Promise<ReplayResponse> };
type Producer = { sub: string; principalIssuer: string };

/** @description Dependencies wired to the existing node runtime; injectable providers never confer application authorization. */
export interface BotNodeTokenChaseReplayRouteDeps {
  agentId: string;
  authorize: RequestHandler;
  pool: Pick<Pool, 'query'> | null;
  activeLlm(): { provider: string; model: string };
  currentProvider(): ReplayProvider;
  variantProvider(connection: NonNullable<ReplayCallRequest['byoLlmConnection']>): ReplayProvider;
  costTrackingService: Pick<CostTrackingService, 'recordCost'>;
}

/** @description Validates producer metadata from the authenticated controller transport; it cannot grant protected-bot or operator authority. */
function producerOf(body: ReplayCallRequest): Producer | null {
  if (body.userSub === undefined && body.principalIssuer === undefined) return null;
  const sub = normalizeBotNodeUserSub(body.userSub);
  const principalIssuer = normalizePrincipalIssuer(body.principalIssuer);
  if (!sub || !principalIssuer) throw new Error('Replay producer identity incomplete');
  return { sub, principalIssuer };
}

/** @description Separates replay rollups by verified producer namespace without placing raw caller identifiers in task ids. */
function costTaskId(body: ReplayCallRequest, variant: boolean, producer: Producer | null): string {
  const base = `${body.taskId || 'token-chase'}::${variant ? 'replay-variant' : 'replay'}`;
  return producer ? `${base}::${createHash('sha256').update(JSON.stringify([producer.principalIssuer, producer.sub])).digest('hex')}` : base;
}

/** @description Removes only this module's directly contained, prefix-owned temporary workspace after resolving the absolute cleanup target. */
function cleanupReplayWorkspace(workspaceDir: string): void {
  const target = path.resolve(workspaceDir), intendedParent = path.resolve(os.tmpdir());
  if (path.dirname(target) !== intendedParent || !path.basename(target).startsWith('tc-replay-')) {
    throw new Error('Replay cleanup target is outside the owned temporary workspace');
  }
  fs.rmSync(target, { recursive: true, force: true });
}

/** @description Preserves the replay transport's zero-usage failure envelope for invalid history and provider errors. */
function replayFailure(live: { provider: string; model: string }, error: string, latencyMs = 0) {
  return { success: false, content: '', error, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    cost: 0, model: live.model, provider: live.provider, latencyMs };
}

/** @description Records real replay usage under a nonprivileged producer context; an operator's own replay remains owner-scoped. */
async function recordReplayCost(deps: BotNodeTokenChaseReplayRouteDeps, body: ReplayCallRequest, producer: Producer | null, variant: boolean, response: ReplayResponse, live: { provider: string; model: string }): Promise<void> {
  const record = () => deps.costTrackingService.recordCost({
    taskId: costTaskId(body, variant, producer), ownerSub: producer?.sub, agentId: deps.agentId,
    providerId: response.provider || live.provider, modelId: response.model || live.model,
    inputTokens: Number(response.usage?.inputTokens || 0), outputTokens: Number(response.usage?.outputTokens || 0),
    inputCost: 0, outputCost: 0, totalCost: Number(response.cost || 0), currency: 'USD', requestCount: 1,
  });
  await (producer ? runWithRequestIdentity({ ...producer, isOperator: false }, record) : record())
    .catch((err: unknown) => logger.error({ err }, 'Token Chase replay cost record failed'));
}

/** @description Runs exactly one tool-free provider call in an isolated temporary workspace, then removes that workspace. */
async function executeReplay(deps: BotNodeTokenChaseReplayRouteDeps, body: ReplayCallRequest, producer: Producer | null, live: { provider: string; model: string }) {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-replay-'));
  const startedAt = Date.now();
  const byo = body.byoLlmConnection;
  const variant = Boolean(byo?.baseUrl && byo.apiKey && byo.model);
  try {
    const provider = variant ? deps.variantProvider(byo!) : deps.currentProvider();
    const response = await provider.generateResponse(body.history, {
      systemPrompt: body.systemPrompt || undefined, tools: [], workspaceDir,
      source: 'token-chase-replay', agentId: deps.agentId, autoApprove: false,
      extraEnv: producer ? { OSHAL_USER_SUB: producer.sub } : undefined,
    });
    await recordReplayCost(deps, body, producer, variant, response, live);
    const inputTokens = Number(response.usage?.inputTokens || 0);
    const outputTokens = Number(response.usage?.outputTokens || 0);
    return { success: true, content: response.content || '', usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
      cost: Number(response.cost || 0), model: response.model || live.model, provider: response.provider || live.provider, latencyMs: Date.now() - startedAt };
  } finally {
    try { cleanupReplayWorkspace(workspaceDir); }
    catch (err) { logger.warn({ err, workspaceDir }, 'Token Chase replay workspace cleanup failed'); }
  }
}

/** @description Mounts the production replay endpoint behind existing machine authentication and protected-bot refusal before spending or recording costs. */
export function registerBotNodeTokenChaseReplayRoute(app: Express, deps: BotNodeTokenChaseReplayRouteDeps): void {
  app.post('/api/token-chase/replay-call', deps.authorize, async (req, res) => {
    try { await assertBotNodeApplicationTransport(deps.pool, deps.agentId, deps.agentId); }
    catch { res.status(403).json({ success: false, error: 'authorization_replay_unavailable' }); return; }
    const body = (req.body ?? {}) as ReplayCallRequest;
    let producer: Producer | null;
    try { producer = producerOf(body); }
    catch { res.status(400).json({ success: false, error: 'Replay producer identity incomplete' }); return; }
    const live = deps.activeLlm();
    if (!Array.isArray(body.history)) { res.status(400).json(replayFailure(live, 'Missing history[]')); return; }
    const startedAt = Date.now();
    try { res.json(await executeReplay(deps, body, producer, live)); }
    catch (err) {
      logger.error({ err, taskId: body.taskId, seq: body.seq }, '/api/token-chase/replay-call failed');
      res.status(500).json(replayFailure(live, err instanceof Error ? err.message : String(err), Date.now() - startedAt));
    }
  });
}
