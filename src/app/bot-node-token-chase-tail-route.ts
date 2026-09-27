/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Bot-node tail executor (BACKLOG "Workspace-bound checkpoint and tail replay", ADR-046 §3): POST /api/token-chase/replay-tail, mounted from bot-node-server.ts behind the service-secret gate and the protected-bot transport check exactly like replay-call. On the accountable node it restores frame N's checkpoint commit into an isolated worktree (object restage for pre-commit frames) and the owner's store CIPHERTEXT into an isolated store root, walks frames N..end hermetically through tail-replay-runner.js (captured responses served, workspace tools re-executed, pinned reads verified, live tools refused), re-versions the restored store, and compares the resulting tree digest and store version with final.json. No provider is called (paidCalls stays 0 and is reported); the isolated roots are removed in a finally block. The replay root lives under the shared workspace root (TOKEN_CHASE_REPLAY_ROOT overrides) because the real file-tool handlers only accept a task workspace under the configured workspace roots.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Express, RequestHandler } from 'express';
import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { resolveSharedWorkspaceRoot } from '@/shared/workspace-root';
import {
  TokenChaseReadService,
  type OwnerStoreManifest,
  type OwnerStoreSnapshotter,
  type TokenChaseFrameDetail,
  type TokenChaseRunFinal,
} from '@/features/token-chase';
import type {
  TailReplayNodeArtifacts,
  TailReplayNodeFrame,
  TailReplayNodeRequest,
  TailReplayNodeResponse,
  TailReplayNodeRestore,
  TailReplayNodeStatus,
  TailReplayNodeStore,
  TailReplayNodeStoreVersion,
} from '@/features/agent-management';
import { assertBotNodeApplicationTransport } from './bot-node-application-authorization';

const logger = createChildLogger({ module: 'bot-node-token-chase-tail-route' });

/** @description The final-checkpoint shape the runner compares against (lifted off the read service's record). */
type RunnerFinal = { workspaceTree: unknown; pins: unknown[]; checkpoint: { treeSha: string | null; complete: boolean; redactedPaths: string[] } } | null;

/** @description The CommonJS hermetic runner's surface, typed here so the route stays honest about what it calls. */
interface HermeticTailRunner {
  restoreWorktree(input: { captureDir: string; frame: TokenChaseFrameDetail; targetDir: string; redact: (text: string) => string }): TailReplayNodeRestore;
  runHermeticTail(input: {
    captureDir: string; worktreeDir: string; frames: TokenChaseFrameDetail[]; final: RunnerFinal; redact: (text: string) => string;
  }): Promise<{ status: TailReplayNodeStatus; frames: TailReplayNodeFrame[]; stoppedAtFrame: number | null; stopReason: string | null; toolCalls: number; artifacts: TailReplayNodeArtifacts }>;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const tailRunner = require('../../any-bot/server/services/token-chase/tail-replay-runner') as HermeticTailRunner;
// The capture lane's scrubber: both sides of every digest must cover the same redacted bytes.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { tokenChase } = require('../../any-bot/server/services/token-chase/TokenChaseCapture') as { tokenChase: { redact(text: string): string } };

/** @description Construction dependencies for the bot-node tail executor route. */
export interface BotNodeTokenChaseTailRouteDeps {
  /** This bot's runtime agent id (reported as the accountable executor). */
  agentId: string;
  /** Shared-secret gate (authorizeBotNodeInternalCall on the real server). */
  authorize: RequestHandler;
  /** Trusted ownership pool for the protected-bot transport check (absent fails closed). */
  pool: Pick<Pool, 'query'> | null;
  /** The node's owner-store snapshotter (unbound when no store root is configured). */
  ownerStore: OwnerStoreSnapshotter;
  /** Frame reader; defaults to the shared-workspace read service. */
  reader?: TokenChaseReadService;
  /** Where isolated replay roots are minted; defaults to resolveTokenChaseReplayRoot(). */
  replayRoot?: string;
  /** Protected-bot transport check; defaults to assertBotNodeApplicationTransport(pool, agentId, agentId). */
  assertTransport?: (pool: Pick<Pool, 'query'> | null, agentId: string) => Promise<void>;
}

/**
 * @description Where a node mints isolated replay roots. TOKEN_CHASE_REPLAY_ROOT overrides; otherwise a
 * private folder under the shared workspace root, which is the only place the real file-tool handlers
 * accept a task workspace (their root guard reads the configured workspace roots).
 * @param env - The environment to read.
 * @returns The absolute replay root.
 */
export function resolveTokenChaseReplayRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.TOKEN_CHASE_REPLAY_ROOT;
  if (typeof override === 'string' && override.trim().length > 0) return path.resolve(override.trim());
  return path.join(resolveSharedWorkspaceRoot(), '.tokenchase-replays');
}

/**
 * @description Validates the request body: a run id, a non-negative start frame and the caller's access context.
 * @param body - The parsed JSON body.
 * @returns The typed request, or null when malformed.
 */
export function parseTailReplayNodeRequest(body: unknown): TailReplayNodeRequest | null {
  const raw = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const runId = typeof raw.runId === 'string' ? raw.runId.trim() : '';
  const fromFrame = Number.parseInt(String(raw.fromFrame), 10);
  const access = raw.access && typeof raw.access === 'object' ? (raw.access as Record<string, unknown>) : null;
  if (!runId || !Number.isInteger(fromFrame) || fromFrame < 0 || !access) return null;
  const callerSub = typeof access.callerSub === 'string' && access.callerSub.length > 0 ? access.callerSub : null;
  return { runId, fromFrame, access: { callerSub, isAdmin: access.isAdmin === true } };
}

/** @description The start frame, every caller-visible tail frame, the final checkpoint and the capture dir of a run. */
interface LoadedTail {
  start: TokenChaseFrameDetail;
  frames: TokenChaseFrameDetail[];
  final: TokenChaseRunFinal | null;
  captureDir: string;
}

/** @description Loads the tail under the caller's owner scoping; null when the start frame is absent or hidden. */
async function loadTail(reader: TokenChaseReadService, request: TailReplayNodeRequest): Promise<LoadedTail | null> {
  const { runId, fromFrame, access } = request;
  const start = await reader.getFrame(runId, fromFrame, access);
  const captureDir = reader.getCaptureDir(runId);
  if (!start || !captureDir) return null;
  const seqs = (await reader.getFrames(runId, access)).map((f) => f.seq).filter((seq) => seq >= fromFrame).sort((a, b) => a - b);
  const loaded = await Promise.all(seqs.map((seq) => (seq === fromFrame ? Promise.resolve(start) : reader.getFrame(runId, seq, access))));
  const frames = loaded.filter((frame): frame is TokenChaseFrameDetail => frame !== null);
  const final = await reader.getFinal(runId, access);
  return { start, frames, final, captureDir };
}

/** @description The shape the runner compares against, lifted off the read service's final record. */
function finalForRunner(final: TokenChaseRunFinal | null): RunnerFinal {
  if (!final) return null;
  return { workspaceTree: final.workspaceTree, pins: final.pins, checkpoint: { treeSha: final.treeSha, complete: final.checkpointComplete, redactedPaths: final.redactedPaths } };
}

/**
 * @description Restores the owner's store CIPHERTEXT into the isolated store root when the start frame
 * recorded a version and this node has the store bound. Every refusal is a named reason, never a throw.
 */
async function restoreStore(
  deps: BotNodeTokenChaseTailRouteDeps, reader: TokenChaseReadService, request: TailReplayNodeRequest,
  loaded: LoadedTail, storeRoot: string,
): Promise<TailReplayNodeStore> {
  const { start, captureDir } = loaded;
  const bound = deps.ownerStore.bound;
  const version = start.ownerStoreVersion;
  const refused = (reason: string): TailReplayNodeStore => ({ bound, restored: false, files: 0, version, reason });
  if (!version) return refused('the start frame recorded no owner-store version');
  if (!bound) return refused('no owner store configured on this node');
  if (!start.ownerSub) return refused('the start frame recorded no accountable owner');
  const manifest = await reader.getStoreManifest(request.runId, version, request.access);
  if (!manifest || !Array.isArray(manifest.files)) return refused('the owner-store manifest is missing from the capture');
  try {
    const result = deps.ownerStore.restore(manifest as unknown as OwnerStoreManifest, path.join(captureDir, 'store-objects'), storeRoot, start.ownerSub);
    return { bound, restored: true, files: result.restored, version: result.version, reason: null };
  } catch (err) {
    logger.error({ err, runId: request.runId, version }, 'Token Chase owner-store restore failed');
    return refused(`owner-store restore failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** @description Re-versions the restored store and compares it with final.json's version. */
function compareStore(
  deps: BotNodeTokenChaseTailRouteDeps, store: TailReplayNodeStore, storeRoot: string, ownerSub: string | null, final: TokenChaseRunFinal | null,
): TailReplayNodeStoreVersion {
  const baseline = final?.ownerStoreVersion ?? null;
  if (!store.restored || !ownerSub) return { baseline, replay: null, reproduced: null, bound: store.bound };
  const replay = deps.ownerStore.versionAt(storeRoot, ownerSub).version;
  return { baseline, replay, reproduced: baseline ? replay === baseline : null, bound: true };
}

/** @description A tail that reproduced its artifacts still diverged when the store version did not. */
function combineStatus(tail: TailReplayNodeStatus, storeVersion: TailReplayNodeStoreVersion): TailReplayNodeStatus {
  if (tail !== 'reproduced') return tail;
  return storeVersion.reproduced === false ? 'diverged' : 'reproduced';
}

/**
 * @description Executes the hermetic no-edit tail of a run on this node: restore, walk, compare, clean up.
 * @param deps - Route dependencies (owner store, reader, replay root).
 * @param request - The validated request.
 * @returns The node's verdict, or null when the start frame is absent / not visible to the caller.
 */
export async function executeTailReplayOnNode(
  deps: BotNodeTokenChaseTailRouteDeps, request: TailReplayNodeRequest,
): Promise<TailReplayNodeResponse | null> {
  const startedAt = Date.now();
  const reader = deps.reader ?? new TokenChaseReadService();
  const loaded = await loadTail(reader, request);
  if (!loaded) return null;
  const replayRoot = deps.replayRoot ?? resolveTokenChaseReplayRoot();
  fs.mkdirSync(replayRoot, { recursive: true });
  const isolated = fs.mkdtempSync(path.join(replayRoot, `${request.runId.replaceAll(/[^a-zA-Z0-9-_]/g, '_')}-from${request.fromFrame}-`));
  const worktreeDir = path.join(isolated, 'worktree');
  const storeRoot = path.join(isolated, 'store');
  try {
    const restore = tailRunner.restoreWorktree({ captureDir: loaded.captureDir, frame: loaded.start, targetDir: worktreeDir, redact: tokenChase.redact });
    const store = await restoreStore(deps, reader, request, loaded, storeRoot);
    const tail = await tailRunner.runHermeticTail({
      captureDir: loaded.captureDir, worktreeDir, frames: loaded.frames, final: finalForRunner(loaded.final), redact: tokenChase.redact,
    });
    const storeVersion = compareStore(deps, store, storeRoot, loaded.start.ownerSub, loaded.final);
    return {
      success: true, runId: request.runId, fromFrame: request.fromFrame, agentId: deps.agentId, ownerSub: loaded.start.ownerSub,
      status: combineStatus(tail.status, storeVersion),
      restore, store, framesInTail: loaded.frames.length, frames: tail.frames,
      stoppedAtFrame: tail.stoppedAtFrame, stopReason: tail.stopReason, toolCalls: tail.toolCalls,
      artifacts: tail.artifacts, storeVersion,
      paidCalls: 0, costUsd: 0, durationMs: Date.now() - startedAt,
    };
  } finally {
    try { fs.rmSync(isolated, { recursive: true, force: true }); } catch (err) { logger.warn({ err, isolated }, 'Token Chase tail replay isolated root cleanup failed'); }
  }
}

/**
 * @description Mounts POST `/api/token-chase/replay-tail` on the bot-node's Express app behind the shared
 * service-secret gate and the protected-bot transport check (same 403 as replay-call).
 * @param app - The bot-node Express app.
 * @param deps - Auth gate, agent id, ownership pool, owner store and optional seams.
 * @returns void
 */
export function registerBotNodeTokenChaseTailRoute(app: Express, deps: BotNodeTokenChaseTailRouteDeps): void {
  const assertTransport = deps.assertTransport ?? ((pool, agentId) => assertBotNodeApplicationTransport(pool, agentId, agentId));
  app.post('/api/token-chase/replay-tail', deps.authorize, async (req, res) => {
    const startedAt = Date.now();
    try { await assertTransport(deps.pool, deps.agentId); }
    catch { res.status(403).json({ success: false, error: 'authorization_replay_unavailable' }); return; }
    const request = parseTailReplayNodeRequest(req.body);
    if (!request) { res.status(400).json({ success: false, error: 'Body must include runId, a non-negative fromFrame and access' }); return; }
    try {
      const result = await executeTailReplayOnNode(deps, request);
      if (!result) { res.status(404).json({ success: false, error: 'Start frame not found' }); return; }
      logger.info({ runId: request.runId, fromFrame: request.fromFrame, status: result.status, stoppedAtFrame: result.stoppedAtFrame, durationMs: Date.now() - startedAt }, '/api/token-chase/replay-tail finished');
      res.json(result);
    } catch (err) {
      logger.error({ err, runId: request.runId, fromFrame: request.fromFrame, durationMs: Date.now() - startedAt }, '/api/token-chase/replay-tail failed');
      res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
}
