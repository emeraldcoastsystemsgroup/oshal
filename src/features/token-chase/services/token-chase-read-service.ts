/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Token Chase step 1: read-only service over captured per-call frames (ADR-046)
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Tail-replay inputs (ADR-046 §1/§8): surface the additive capture fields the forward-replay consumer needs — a frame's `pins` (per-tool-read pinned/unpinned classification) and `workspaceTree` (content-addressed manifest) now ride on TokenChaseFrameDetail, and readTreeObject() serves one content-addressed blob from <capture>/objects/<sha256> so the tail replay can restage the tree a frame saw. Both additive: pre-tail frames simply lack the fields and behave exactly as before.
 */

import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'token-chase-read-service' });
const CAPTURE_DIR = '.tokenchase';
const FRAME_FILE = /^frame-\d+\.json$/;

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
   * @description Whether a frame is visible to the caller: admins see all; frames with no recorded
   * owner (system/internal calls) are public to authenticated callers; otherwise owner must match.
   */
  private isVisible(frame: Record<string, unknown>, access: TokenChaseAccess): boolean {
    if (access.isAdmin) return true;
    const owner = (frame.userSub as string) ?? null;
    return !owner || owner === access.callerSub;
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
    const configured = process.env.SHARED_WORKSPACE_ROOT || process.env.CLINE_WORKSPACE_ROOT || process.env.WORKSPACE_ROOT;
    if (configured && configured.trim().length > 0) return path.resolve(configured);
    return fsSync.existsSync('/app/workspace') ? '/app/workspace' : path.resolve(process.cwd(), 'workspace-shared');
  }
}
