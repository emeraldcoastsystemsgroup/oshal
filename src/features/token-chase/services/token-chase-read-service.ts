/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Token Chase step 1: read-only service over captured per-call frames (ADR-046)
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Tail-replay inputs (ADR-046 §1/§8): surface the additive capture fields the forward-replay consumer needs — a frame's `pins` (per-tool-read pinned/unpinned classification) and `workspaceTree` (content-addressed manifest) now ride on TokenChaseFrameDetail, and readTreeObject() serves one content-addressed blob from <capture>/objects/<sha256> so the tail replay can restage the tree a frame saw. Both additive: pre-tail frames simply lack the fields and behave exactly as before.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | CKR-17 step 2: the inline workspace-root chain here resolves through resolveSharedWorkspaceRoot() like every other site. It read three of the six.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Workspace-bound provenance: expose captured tool schemas, workspace commit/store-version references and the bounded snapshot result used by the tail replay.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | End-of-run checkpoint (BACKLOG "Workspace-bound checkpoint and tail replay"): getFinal() reads the run's final.json (post-tool tree digest, final commit, store version, trailing pins) under the same owner scoping as frames, and a frame's recorded owner rides on TokenChaseFrameDetail.ownerSub so the tail replay can bind the accountable owner when it delegates to the bot node.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Bot-node tail executor inputs: getCaptureDir() hands the traversal-guarded capture directory to the on-node restore (private git repo + object store live there), and getStoreManifest() reads the owner-store manifest the lane wrote for one version (store-<version>.json — paths and ciphertext digests, never plaintext) under the run's owner scoping.
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Ownerless (system/internal) frames are admin-only. They were readable and replayable by every signed-in user and can carry persona prompts and other users' ticket content (operator decision 2026-10-05, from the 2026-10-04 cockpit route audit).
 */

import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createChildLogger } from '@/shared/logger';
import { resolveSharedWorkspaceRoot } from '@/shared/workspace-root';

const logger = createChildLogger({ module: 'token-chase-read-service' });
const CAPTURE_DIR = '.tokenchase';
const FRAME_FILE = /^frame-\d+\.json$/;
const FINAL_FILE = 'final.json';

/**
 * @description Access context for owner-scoped reads. A frame is visible when the caller is an
 * admin, the frame has no recorded owner (system/internal call), or the owner matches the caller.
 */
export interface TokenChaseAccess {
  callerSub: string | null;
  isAdmin: boolean;
}

/** @description One captured run (a task workspace that holds Token Chase frames). */
export interface TokenChaseRunSummary {
  runId: string;
  frameCount: number;
  modified: string;
}

/** @description A per-call frame reduced to the timeline-row fields (no large prompt/response bodies). */
export interface TokenChaseFrameSummary {
  seq: number;
  providerRequested: string | null;
  harnessFired: string | null;
  model: string | null;
  inputMessages: number | null;
  tools: string[];
  tokensIn: number | null;
  tokensOut: number | null;
  latencyMs: number | null;
  replayable: boolean;
  phase: string;
}

/** @description A frame with its full prompt, response, and sent history for the inspector pane. */
export interface TokenChaseFrameDetail extends TokenChaseFrameSummary {
  agentId: string | null;
  source: string | null;
  systemPrompt: string | null;
  responseContent: string | null;
  responseBlocks: unknown[];
  history: unknown[];
  /** Additive tail-replay input (ADR-046 §8): the per-tool-read pinned/unpinned classification the
   *  capture lane records, or undefined on pre-tail frames. Left as the raw recorded value — the
   *  tail-replay service normalizes it; consumers that don't need it ignore it. */
  pins?: unknown;
  /** Additive tail-replay input (ADR-046 §1): the content-addressed workspace-tree manifest the
   *  capture lane records for this frame, or undefined on pre-tail frames. Raw recorded value;
   *  the tail-replay service normalizes and restages it against readTreeObject(). */
  workspaceTree?: unknown;
  /** Full declared tool schemas captured for prompt/replay identity (not executable callbacks). */
  toolSchema: unknown[];
  /** Optional immutable workspace commit/ref supplied by the caller at capture time. */
  workspaceCommit: string | null;
  /** Optional encrypted owner-store snapshot ref; plaintext store bytes never enter a frame. */
  ownerStoreVersion: string | null;
  /** The accountable owner the capture recorded (null for a system/internal call). */
  ownerSub: string | null;
}

/**
 * @description The end-of-run checkpoint the capture lane writes as `final.json`: the workspace tree
 * and owner-store version AFTER the last tool ran, the final commit, and the trailing pins no frame
 * consumed. This is the baseline a no-edit tail replay compares its artifacts and store against.
 */
export interface TokenChaseRunFinal {
  taskId: string | null;
  outcome: string;
  turns: number | null;
  at: string | null;
  workspaceCommit: string | null;
  ownerStoreVersion: string | null;
  /** Whether an owner store was bound on the capturing node (false = no store, version is null honestly). */
  storeBound: boolean;
  /** The tree digest of the final manifest, or null when the checkpoint could not be taken. */
  treeSha: string | null;
  checkpointComplete: boolean;
  redactedPaths: string[];
  replayable: boolean;
  pins: unknown[];
  /** The raw recorded manifest (files + digest), for consumers that diff paths. */
  workspaceTree: unknown;
}

/**
 * @description Reads Token Chase frames that the bot-node capture lane writes to
 * `<workspaceDir>/.tokenchase/`. Read-only and side-effect free — it powers the debugger
 * view and never triggers replay or capture.
 */
export class TokenChaseReadService {
  private readonly workspaceRoot: string;

  /** @description Resolves the shared workspace root the same way the task explorer does. */
  constructor() {
    this.workspaceRoot = this.resolveWorkspaceRoot();
    logger.info({ workspaceRoot: this.workspaceRoot }, 'TokenChaseReadService initialized');
  }

  /**
   * @description Lists task workspaces that contain captured frames visible to the caller, newest first.
   * @param access - Owner-scoping context (caller sub + admin flag).
   * @returns Run summaries with frame counts and last-modified timestamps.
   */
  async listRuns(access: TokenChaseAccess): Promise<TokenChaseRunSummary[]> {
    if (!fsSync.existsSync(this.workspaceRoot)) return [];
    const entries = await fs.readdir(this.workspaceRoot, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory());
    const runs = await Promise.all(dirs.map((e) => this.summarizeRun(e.name, access)));
    return runs.filter((r): r is TokenChaseRunSummary => r !== null).sort((a, b) => b.modified.localeCompare(a.modified));
  }

  /**
   * @description Lists the ordered frame summaries for one run, filtered to frames the caller may see.
   * @param runId - The task/workspace folder name.
   * @param access - Owner-scoping context.
   * @returns Frame summaries sorted by call sequence.
   */
  async getFrames(runId: string, access: TokenChaseAccess): Promise<TokenChaseFrameSummary[]> {
    const dir = this.resolveCaptureDir(runId);
    if (!dir || !fsSync.existsSync(dir)) return [];
    const files = (await fs.readdir(dir)).filter((f) => FRAME_FILE.test(f));
    const frames = await Promise.all(files.map((f) => this.readFrame(path.join(dir, f))));
    return frames
      .filter((f): f is Record<string, unknown> => f !== null && this.isVisible(f, access))
      .map((f) => this.toSummary(f))
      .sort((a, b) => a.seq - b.seq);
  }

  /**
   * @description Reads one frame in full, including its sent history, if the caller may see it.
   * @param runId - The task/workspace folder name.
   * @param seq - The call sequence number.
   * @param access - Owner-scoping context.
   * @returns The full frame detail, or null when absent or not visible to the caller.
   */
  async getFrame(runId: string, seq: number, access: TokenChaseAccess): Promise<TokenChaseFrameDetail | null> {
    const dir = this.resolveCaptureDir(runId);
    if (!dir) return null;
    const base = path.join(dir, `frame-${String(seq).padStart(4, '0')}`);
    const frame = await this.readFrame(`${base}.json`);
    if (!frame || !this.isVisible(frame, access)) return null;
    const history = await this.readFrame(`${base}.history.json`);
    return { ...this.toSummary(frame), ...this.toDetail(frame), history: Array.isArray(history) ? history : [] };
  }

  /**
   * @description Reads the run's end-of-run checkpoint (final.json) if the caller may see the run.
   * @param runId - The task/workspace folder name.
   * @param access - Owner-scoping context (the record carries the owner the capture stamped).
   * @returns The checkpoint, or null when absent or not visible to the caller.
   */
  async getFinal(runId: string, access: TokenChaseAccess): Promise<TokenChaseRunFinal | null> {
    const dir = this.resolveCaptureDir(runId);
    if (!dir) return null;
    const record = await this.readFrame(path.join(dir, FINAL_FILE));
    if (!record || !this.isVisible(record, access)) return null;
    const checkpoint = (record.checkpoint as Record<string, unknown>) ?? {};
    const store = (record.ownerStore as Record<string, unknown>) ?? {};
    const tree = (record.workspaceTree as Record<string, unknown>) ?? {};
    return {
      taskId: (record.taskId as string) ?? null,
      outcome: (record.outcome as string) ?? 'unknown',
      turns: typeof record.turns === 'number' ? record.turns : null,
      at: (record.at as string) ?? null,
      workspaceCommit: (record.workspaceCommit as string) ?? null,
      ownerStoreVersion: (record.ownerStoreVersion as string) ?? null,
      storeBound: store.bound === true,
      treeSha: (checkpoint.treeSha as string) ?? (tree.treeSha as string) ?? null,
      checkpointComplete: checkpoint.complete === true,
      redactedPaths: Array.isArray(checkpoint.redactedPaths) ? (checkpoint.redactedPaths as string[]) : [],
      replayable: record.replayable !== false,
      pins: Array.isArray(record.pins) ? (record.pins as unknown[]) : [],
      workspaceTree: record.workspaceTree,
    };
  }

  /**
   * @description The traversal-guarded capture directory of a run, for the on-node restore that needs
   * the private checkpoint repository and object store beneath it. Null when the run has no capture dir.
   * @param runId - The task/workspace folder name.
   * @returns The absolute `.tokenchase` directory, or null.
   */
  getCaptureDir(runId: string): string | null {
    const dir = this.resolveCaptureDir(runId);
    return dir && fsSync.existsSync(dir) ? dir : null;
  }

  /**
   * @description Reads the owner-store manifest the capture lane wrote for one store version
   * (`store-<version>.json`: store-relative paths and ciphertext digests, never plaintext), when the
   * caller may see the run. The version is format-guarded so it can never name another file.
   * @param runId - The task/workspace folder name.
   * @param version - The 64-hex owner-store version a frame recorded.
   * @param access - Owner-scoping context.
   * @returns The parsed manifest, or null when absent, malformed or not visible.
   */
  async getStoreManifest(runId: string, version: string, access: TokenChaseAccess): Promise<Record<string, unknown> | null> {
    if (!/^[a-f0-9]{64}$/i.test(version)) return null;
    const dir = this.resolveCaptureDir(runId);
    if (!dir || !(await this.isRunVisible(dir, access))) return null;
    return this.readFrame(path.join(dir, `store-${version.toLowerCase()}.json`));
  }

  /** @description Whether the caller may see a run at all: decided by its first frame's recorded owner. */
  private async isRunVisible(dir: string, access: TokenChaseAccess): Promise<boolean> {
    try {
      const frameFiles = (await fs.readdir(dir)).filter((f) => FRAME_FILE.test(f)).sort();
      if (frameFiles.length === 0) return false;
      const first = await this.readFrame(path.join(dir, frameFiles[0]));
      return first !== null && this.isVisible(first, access);
    } catch (error) {
      logger.warn({ err: error, dir }, 'Failed to read Token Chase run for visibility');
      return false;
    }
  }

  /** @description Builds a run summary for one folder, or null if it has no caller-visible frames. */
  private async summarizeRun(name: string, access: TokenChaseAccess): Promise<TokenChaseRunSummary | null> {
    const dir = path.join(this.workspaceRoot, name, CAPTURE_DIR);
    try {
      const stat = await fs.stat(dir);
      if (!stat.isDirectory()) return null;
      const frameFiles = (await fs.readdir(dir)).filter((f) => FRAME_FILE.test(f));
      if (frameFiles.length === 0) return null;
      const first = await this.readFrame(path.join(dir, frameFiles[0]));
      if (!first || !this.isVisible(first, access)) return null; // Owner-scope at the run level.
      return { runId: name, frameCount: frameFiles.length, modified: stat.mtime.toISOString() };
    } catch {
      return null; // No .tokenchase dir for this workspace — not a captured run.
    }
  }

  /**
   * @description Whether a frame is visible to the caller: admins see all; otherwise the caller must
   * be the recorded owner. Frames with no recorded owner (system/internal calls) are admin-only:
   * they can carry persona prompts and other users' ticket content, so an ordinary user may neither
   * read nor replay them (operator decision 2026-10-05).
   */
  private isVisible(frame: Record<string, unknown>, access: TokenChaseAccess): boolean {
    if (access.isAdmin) return true;
    const owner = (frame.userSub as string) ?? null;
    return Boolean(owner) && owner === access.callerSub;
  }

  /** @description Parses a frame JSON file, returning null on read/parse failure. */
  private async readFrame(file: string): Promise<Record<string, unknown> | null> {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (error) {
      logger.warn({ err: error, file }, 'Failed to read Token Chase frame');
      return null;
    }
  }

  /** @description Reduces a parsed frame to its timeline-row summary fields. */
  private toSummary(frame: Record<string, unknown>): TokenChaseFrameSummary {
    const decision = (frame.decision as Record<string, unknown>) ?? {};
    const context = (frame.context as Record<string, unknown>) ?? {};
    const outcome = (frame.outcome as Record<string, unknown>) ?? {};
    return {
      seq: Number(frame.seq ?? 0),
      providerRequested: (decision.providerRequested as string) ?? null,
      harnessFired: (decision.harnessFired as string) ?? null,
      model: (decision.model as string) ?? null,
      inputMessages: (context.inputMessages as number) ?? null,
      tools: Array.isArray(context.tools) ? (context.tools as string[]) : [],
      tokensIn: (outcome.tokensIn as number) ?? null,
      tokensOut: (outcome.tokensOut as number) ?? null,
      latencyMs: (outcome.latencyMs as number) ?? null,
      replayable: frame.replayable !== false,
      phase: (frame.phase as string) ?? 'unknown',
    };
  }

  /** @description Extracts the heavy inspector-only fields (prompt, response, scoping) from a frame. */
  private toDetail(frame: Record<string, unknown>): Omit<TokenChaseFrameDetail, keyof TokenChaseFrameSummary | 'history'> {
    const context = (frame.context as Record<string, unknown>) ?? {};
    const response = (frame.response as Record<string, unknown>) ?? {};
    return {
      agentId: (frame.agentId as string) ?? null,
      source: (frame.source as string) ?? null,
      systemPrompt: (context.systemPrompt as string) ?? null,
      responseContent: (response.content as string) ?? null,
      responseBlocks: Array.isArray(response.blocks) ? (response.blocks as unknown[]) : [],
      toolSchema: Array.isArray(context.toolSchema) ? (context.toolSchema as unknown[]) : [],
      workspaceCommit: (context.workspaceCommit as string) ?? null,
      ownerStoreVersion: (context.ownerStoreVersion as string) ?? null,
      ownerSub: (frame.userSub as string) ?? null,
      // Additive tail-replay inputs — passed through raw (undefined on pre-tail frames).
      pins: frame.pins,
      workspaceTree: frame.workspaceTree,
    };
  }

  /**
   * @description Reads one content-addressed workspace-tree object for a run — the blob a frame's
   * `workspaceTree` manifest references by sha256, stored under `<capture>/objects/<sha256>`. The
   * tail-replay consumer uses it to restage the tree a frame saw. Returns null when the run/object is
   * absent, the sha256 is malformed, or the read fails. The sha256 is format-guarded and the resolved
   * path is confined to the objects directory, so a manifest entry can never traverse out of the store.
   * @param runId - The captured run (task workspace) id.
   * @param sha256 - The lowercase 64-hex content hash naming the object.
   * @returns The object bytes, or null when unavailable.
   */
  async readTreeObject(runId: string, sha256: string): Promise<Buffer | null> {
    if (!/^[a-f0-9]{64}$/i.test(sha256)) return null;
    const dir = this.resolveCaptureDir(runId);
    if (!dir) return null;
    const objectsDir = path.resolve(dir, 'objects');
    const file = path.resolve(objectsDir, sha256.toLowerCase());
    if (file !== path.join(objectsDir, sha256.toLowerCase())) return null;
    if (!file.startsWith(`${objectsDir}${path.sep}`)) return null;
    try {
      return await fs.readFile(file);
    } catch (error) {
      logger.warn({ err: error, runId, sha256 }, 'Failed to read Token Chase tree object');
      return null;
    }
  }

  /** @description Resolves and traversal-guards a run's capture directory under the workspace root. */
  private resolveCaptureDir(runId: string): string | null {
    const safe = String(runId).replaceAll(/[^a-zA-Z0-9-_]/g, '_');
    const dir = path.resolve(this.workspaceRoot, safe, CAPTURE_DIR);
    if (dir !== path.resolve(this.workspaceRoot, safe, CAPTURE_DIR)) return null;
    if (!dir.startsWith(`${path.resolve(this.workspaceRoot)}${path.sep}`)) return null;
    return dir;
  }

  /** @description Resolves the shared workspace root from env, matching the task-explorer convention. */
  private resolveWorkspaceRoot(): string {
    return resolveSharedWorkspaceRoot();
  }
}
