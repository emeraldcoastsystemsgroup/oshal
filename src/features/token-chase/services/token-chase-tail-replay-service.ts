/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Token Chase tail-replay consumer (ADR-046 §1/§8, the "Still Proposed" forward-only tail replay): from a chosen frame N, restage the workspace tree as-of that frame from its content-addressed snapshot, then replay frames N..end each on the accountable bot node (replayCall), determinism-gate each replayed frame against its capture, and STOP at the first divergence reporting WHICH frame + why. Pinned tool-reads are served from the captured history (they ride in the sent prompt); unpinned reads fall through with an explicit per-frame warning. Frames captured before the pins/workspaceTree fields landed still single-replay unchanged (backward compat).
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createChildLogger } from '@/shared/logger';
import { BotNodeClient, createRegistryEndpointResolver } from '@/features/agent-management';
import {
  TokenChaseReadService,
  type TokenChaseAccess,
  type TokenChaseFrameDetail,
} from './token-chase-read-service';
import { assessDeterminism, type DeterminismVerdict } from './determinism-verdict';
import type { ReplayStatus } from './token-chase-replay-service';

const logger = createChildLogger({ module: 'token-chase-tail-replay-service' });

/** @description The per-frame outcome status inside a tail replay — the single-call determinism
 *  verdict widened with the tail's stop pre-conditions (reuses the step-2 status union). */
export type TailFrameStatus = ReplayStatus;

/** @description The freshly re-fired response's accountable metrics, echoed back per replayed frame. */
export interface TailReplayCallResponse {
  success: boolean;
  content: string;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  cost: number;
  model: string | null;
  provider: string | null;
  latencyMs: number;
  error?: string;
}

/** @description The narrow bot-node contract the tail replay depends on — re-fire one captured prompt
 *  on the accountable node, never the controller. The real BotNodeClient satisfies it structurally. */
export interface TailReplayer {
  hasEndpoint(agentId: string): boolean;
  replayCall(
    agentId: string,
    request: { history: unknown[]; systemPrompt: string | null; taskId?: string; seq?: number },
  ): Promise<TailReplayCallResponse>;
}

/** @description The narrow frame-store contract the tail replay reads — ordered frame summaries, one
 *  full frame (incl. pins/workspaceTree/history), and one content-addressed tree object. */
export interface TailFrameSource {
  getFrames(runId: string, access: TokenChaseAccess): Promise<Array<{ seq: number }>>;
  getFrame(runId: string, seq: number, access: TokenChaseAccess): Promise<TokenChaseFrameDetail | null>;
  readTreeObject(runId: string, sha256: string): Promise<Buffer | null>;
}

/** @description One normalized workspace-tree manifest entry: a relative path bound to a content hash. */
interface TreeEntry {
  path: string;
  sha256: string;
}

/** @description The result of restaging frame N's workspace tree into an isolated replay root. */
export interface RestageResult {
  /** True when frame N carried a (non-empty) workspaceTree manifest to restage. */
  attempted: boolean;
  /** The isolated directory the tree was materialized into (null when nothing was restaged). */
  root: string | null;
  filesStaged: number;
  filesTotal: number;
  /** `ok` = every manifest object staged + hash-verified; `partial` = some missing/mismatched; `none` = nothing to stage. */
  integrity: 'ok' | 'partial' | 'none';
  warnings: string[];
}

/** @description The outcome of replaying one frame in the tail: its determinism verdict + any warnings. */
export interface TailFrameOutcome {
  seq: number;
  status: TailFrameStatus;
  verdict: DeterminismVerdict | null;
  reason: string | null;
  warnings: string[];
  pinnedReads: number;
  unpinnedReads: number;
  replay: { model: string | null; provider: string | null; tokensOut: number | null; costUsd: number | null; latencyMs: number | null } | null;
}

/** @description The overall tail-replay disposition. */
export type TailReplayStatus = 'completed' | 'stopped' | 'empty';

/** @description The full result of a forward tail replay from a chosen frame. */
export interface TailReplayResult {
  runId: string;
  fromFrame: number;
  status: TailReplayStatus;
  restage: RestageResult;
  framesInTail: number;
  outcomes: TailFrameOutcome[];
  /** The frame the tail stopped at (divergence / unreplayable), or null when it ran to the end. */
  stoppedAtFrame: number | null;
  stopReason: string | null;
  totalCostUsd: number;
}

/** @description Options for a tail replay (mainly the restage root, overridable for tests/isolation). */
export interface TailReplayOptions {
  /** Root under which each replay restages frame N's tree; defaults to an OS-temp subtree so a restage
   *  never writes into the live workspace volume. Env override: TOKEN_CHASE_REPLAY_ROOT. */
  replayRoot?: string;
}

/** @description Statuses that faithfully reproduced the baseline and let the tail continue forward. */
const CONTINUE_STATUSES: ReadonlySet<TailFrameStatus> = new Set(['deterministic', 'equivalent']);

/**
 * @description The Token Chase forward-only TAIL replay (ADR-046 §1/§8 — the piece the ADR marks
 * "Still Proposed"). Given a run and a start frame N it (1) restages the workspace tree the frame saw
 * from its content-addressed snapshot into an isolated root, then (2) replays frames N..end, each on
 * the bot node that produced it — never the controller — grading every replayed frame against its
 * captured baseline and STOPPING at the first divergence with the offending frame + reason. Pinned
 * tool-reads are served from the captured history (their content is already in the sent prompt);
 * unpinned reads fall through with an explicit per-frame warning. Frames captured before the
 * pins/workspaceTree fields existed simply single-replay unchanged.
 */
export class TokenChaseTailReplayService {
  private readonly reader: TailFrameSource;
  private readonly botClient: TailReplayer;
  private readonly replayRoot: string;

  /**
   * @description Builds the tail-replay service over a frame source and the swarm→bot HTTP client.
   * @param reader - Frame store (ordered frames + full frame + tree objects). Defaults to the read service.
   * @param botClient - Client that re-fires a captured prompt on the owning bot node. Defaults to a
   *   registry-resolved BotNodeClient so every replay lands on a real, cost-tracked node.
   * @param options - Optional restage root override (else TOKEN_CHASE_REPLAY_ROOT / OS temp).
   */
  constructor(reader?: TailFrameSource, botClient?: TailReplayer, options: TailReplayOptions = {}) {
    this.reader = reader ?? new TokenChaseReadService();
    this.botClient = botClient ?? new BotNodeClient(createRegistryEndpointResolver());
    this.replayRoot =
      options.replayRoot ??
      (process.env.TOKEN_CHASE_REPLAY_ROOT && process.env.TOKEN_CHASE_REPLAY_ROOT.trim().length > 0
        ? path.resolve(process.env.TOKEN_CHASE_REPLAY_ROOT)
        : path.join(os.tmpdir(), 'oshal-token-chase-replays'));
  }

  /**
   * @description Runs a forward tail replay from frame `fromFrame` to the end of the run.
   * @param runId - The captured run (task workspace) id.
   * @param fromFrame - The frame to restage-from and start replaying at (inclusive).
   * @param access - Owner-scoping context; a caller may only replay frames they can read.
   * @returns The tail-replay result, or null when the start frame is absent / not visible to the caller.
   */
  async replayForward(runId: string, fromFrame: number, access: TokenChaseAccess): Promise<TailReplayResult | null> {
    const start = await this.reader.getFrame(runId, fromFrame, access);
    if (!start) return null;

    const tail = (await this.reader.getFrames(runId, access))
      .map((f) => f.seq)
      .filter((seq) => seq >= fromFrame)
      .sort((a, b) => a - b);

    const restage = await this.restageTree(runId, fromFrame, start);
    logger.info({ runId, fromFrame, tailFrames: tail.length, restaged: restage.attempted }, 'Tail replay starting');

    const outcomes: TailFrameOutcome[] = [];
    let totalCostUsd = 0;
    let stoppedAtFrame: number | null = null;
    let stopReason: string | null = null;

    for (const seq of tail) {
      const frame = seq === fromFrame ? start : await this.reader.getFrame(runId, seq, access);
      const outcome = await this.replayOneFrame(runId, seq, frame);
      outcomes.push(outcome);
      totalCostUsd += outcome.replay?.costUsd ?? 0;
      if (!CONTINUE_STATUSES.has(outcome.status)) {
        stoppedAtFrame = seq;
        stopReason = outcome.reason ?? `Frame ${seq} graded ${outcome.status} — tail cannot continue forward.`;
        logger.info({ runId, seq, status: outcome.status }, 'Tail replay stopped');
        break;
      }
    }

    const status: TailReplayStatus = tail.length === 0 ? 'empty' : stoppedAtFrame !== null ? 'stopped' : 'completed';
    return { runId, fromFrame, status, restage, framesInTail: tail.length, outcomes, stoppedAtFrame, stopReason, totalCostUsd };
  }

  /**
   * @description Replays one frame and grades it against its captured baseline. Excludes frames that
   * cannot be a controlled experiment (in flight, no reachable node) before spending tokens; classifies
   * the frame's pinned/unpinned reads into per-frame warnings; and re-fires the exact captured prompt on
   * the owning node, grading determinism.
   * @param runId - The run id (for the replay call's taskId).
   * @param seq - The frame sequence being replayed.
   * @param frame - The full captured frame, or null when it became unreadable.
   * @returns The per-frame outcome (status drives whether the tail continues).
   */
  private async replayOneFrame(runId: string, seq: number, frame: TokenChaseFrameDetail | null): Promise<TailFrameOutcome> {
    const { pinnedReads, unpinnedReads, warnings } = classifyPins(frame?.pins);
    const base: TailFrameOutcome = { seq, status: 'replay-error', verdict: null, reason: null, warnings, pinnedReads, unpinnedReads, replay: null };

    if (!frame) return { ...base, reason: `Frame ${seq} became unreadable during the tail.` };
    if (frame.phase === 'open' || frame.responseContent == null) {
      return { ...base, status: 'open-frame', reason: `Frame ${seq} is still in flight — no baseline to grade; tail stops.` };
    }
    if (frame.replayable === false) {
      base.warnings.push('Frame is flagged non-replayable (a live side-effect read) — tail fidelity past it is not guaranteed.');
      return { ...base, status: 'non-replayable', reason: `Frame ${seq} depends on a live/unpinned read — excluded from the tail.` };
    }
    if (!frame.agentId || !this.botClient.hasEndpoint(frame.agentId)) {
      return { ...base, status: 'no-endpoint', reason: `No reachable bot node for agent ${frame.agentId ?? '(unknown)'} — replay must run on an accountable node.` };
    }

    try {
      const res = await this.botClient.replayCall(frame.agentId, { history: frame.history, systemPrompt: frame.systemPrompt, taskId: runId, seq });
      if (!res.success) return { ...base, reason: res.error ?? `Bot node replay of frame ${seq} returned an error.` };
      const verdict = assessDeterminism(frame.responseContent, res.content);
      return {
        ...base,
        status: verdict.status,
        verdict,
        reason: verdict.status === 'divergent' ? `Frame ${seq} diverged from baseline (similarity ${verdict.similarity}).` : null,
        replay: { model: res.model, provider: res.provider, tokensOut: res.usage.outputTokens, costUsd: res.cost, latencyMs: res.latencyMs },
      };
    } catch (error) {
      logger.error({ err: error, runId, seq }, 'Tail frame replay failed');
      return { ...base, reason: error instanceof Error ? error.message : `Replay dispatch failed for frame ${seq}.` };
    }
  }

  /**
   * @description Restages frame N's workspace tree from its content-addressed snapshot into a fresh,
   * isolated root (never the live workspace). Each object is read from the run's store, hash-verified,
   * and written at its manifest path. Frames without a workspaceTree restage nothing (backward compat).
   * @param runId - The run id (resolves the object store).
   * @param fromFrame - The start frame (names the restage directory).
   * @param frame - The full start frame carrying the (optional) workspaceTree manifest.
   * @returns The restage result (attempted flag, root, staged counts, integrity, warnings).
   */
  private async restageTree(runId: string, fromFrame: number, frame: TokenChaseFrameDetail): Promise<RestageResult> {
    const entries = normalizeWorkspaceTree(frame.workspaceTree);
    if (entries.length === 0) return { attempted: false, root: null, filesStaged: 0, filesTotal: 0, integrity: 'none', warnings: [] };

    const safeRun = String(runId).replaceAll(/[^a-zA-Z0-9-_]/g, '_');
    const root = path.join(this.replayRoot, `${safeRun}-from${fromFrame}-${Date.now()}`);
    const warnings: string[] = [];
    let staged = 0;

    await fs.mkdir(root, { recursive: true });
    for (const entry of entries) {
      const staged1 = await this.stageOne(runId, root, entry, warnings);
      if (staged1) staged += 1;
    }

    const integrity: RestageResult['integrity'] = staged === entries.length ? 'ok' : 'partial';
    logger.info({ runId, fromFrame, root, staged, total: entries.length, integrity }, 'Restaged workspace tree');
    return { attempted: true, root, filesStaged: staged, filesTotal: entries.length, integrity, warnings };
  }

  /**
   * @description Stages one manifest object under the restage root: path-guards the destination, reads
   * the content-addressed blob, verifies its sha256, and writes it. Records a warning (never throws) on
   * any per-file failure so a single bad object degrades restage integrity to `partial` rather than aborting.
   * @param runId - The run id (resolves the object store).
   * @param root - The restage root the file is written under.
   * @param entry - The manifest entry (relative path + content hash).
   * @param warnings - The restage warning list to append per-file problems to.
   * @returns True when the object was staged and hash-verified, else false.
   */
  private async stageOne(runId: string, root: string, entry: TreeEntry, warnings: string[]): Promise<boolean> {
    const dest = path.resolve(root, entry.path);
    if (dest !== path.join(root, entry.path) || !dest.startsWith(`${root}${path.sep}`)) {
      warnings.push(`Skipped unsafe manifest path: ${entry.path}`);
      return false;
    }
    const bytes = await this.reader.readTreeObject(runId, entry.sha256);
    if (!bytes) {
      warnings.push(`Missing tree object ${entry.sha256} for ${entry.path} — restage is partial.`);
      return false;
    }
    const actual = crypto.createHash('sha256').update(bytes).digest('hex');
    if (actual !== entry.sha256.toLowerCase()) {
      warnings.push(`Object hash mismatch for ${entry.path} (manifest ${entry.sha256}, actual ${actual}) — skipped.`);
      return false;
    }
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, bytes);
    return true;
  }
}

/**
 * @description Normalizes a frame's recorded `pins` into pinned/unpinned counts + per-unpinned warnings.
 * Tolerant of the recorded shape: an array of read records where each is pinned unless it explicitly says
 * otherwise (`pinned:false`, `status:'unpinned'`, or `unpinned:true`). Non-array/absent pins yield zeroes
 * (a pre-tail frame simply has no pin signal — it still replays).
 * @param raw - The raw `pins` value off the frame.
 * @returns Counts and the human-readable per-frame warnings for any unpinned reads.
 */
function classifyPins(raw: unknown): { pinnedReads: number; unpinnedReads: number; warnings: string[] } {
  if (!Array.isArray(raw)) return { pinnedReads: 0, unpinnedReads: 0, warnings: [] };
  let pinnedReads = 0;
  let unpinnedReads = 0;
  const warnings: string[] = [];
  for (const item of raw) {
    const rec = (item ?? {}) as Record<string, unknown>;
    const unpinned = rec.pinned === false || rec.status === 'unpinned' || rec.unpinned === true;
    if (unpinned) {
      unpinnedReads += 1;
      const label = String(rec.tool ?? rec.target ?? rec.path ?? 'read');
      warnings.push(`Unpinned read (${label}) fell through — its captured content is not served; this frame's replay may drift.`);
    } else {
      pinnedReads += 1;
    }
  }
  return { pinnedReads, unpinnedReads, warnings };
}

/**
 * @description Normalizes a frame's recorded `workspaceTree` manifest into a list of `{path, sha256}`
 * entries the restager can materialize. Tolerant of the recorded shape: accepts `{files:[...]}`,
 * `{entries:[...]}`, a bare array, or a plain `{ path: sha256 }` map. Entries missing a path or a valid
 * 64-hex sha256, or with an absolute / traversing path, are dropped. Absent/malformed → empty list.
 * @param raw - The raw `workspaceTree` value off the frame.
 * @returns The validated, safe manifest entries (possibly empty).
 */
function normalizeWorkspaceTree(raw: unknown): TreeEntry[] {
  const rows = collectTreeRows(raw);
  const out: TreeEntry[] = [];
  for (const row of rows) {
    const rel = typeof row.path === 'string' ? row.path.trim() : '';
    const sha = typeof row.sha256 === 'string' ? row.sha256.trim().toLowerCase() : '';
    if (!rel || !/^[a-f0-9]{64}$/.test(sha)) continue;
    if (path.isAbsolute(rel) || rel.split(/[/\\]/).includes('..')) continue;
    out.push({ path: rel, sha256: sha });
  }
  return out;
}

/**
 * @description Collects raw {path, sha256}-ish rows from any of the accepted workspaceTree shapes.
 * @param raw - The raw `workspaceTree` value.
 * @returns Loosely-typed rows for {@link normalizeWorkspaceTree} to validate.
 */
function collectTreeRows(raw: unknown): Array<{ path?: unknown; sha256?: unknown }> {
  if (Array.isArray(raw)) return raw as Array<{ path?: unknown; sha256?: unknown }>;
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    const list = obj.files ?? obj.entries;
    if (Array.isArray(list)) return list as Array<{ path?: unknown; sha256?: unknown }>;
    // Plain map form: { "<path>": "<sha256>" }.
    return Object.entries(obj)
      .filter(([, v]) => typeof v === 'string')
      .map(([k, v]) => ({ path: k, sha256: v }));
  }
  return [];
}
