/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Dev Session Manager (ADR-077 Phase 2): drives a streamed, operator-approved self-edit session — open -> sandboxed agent (frames stream) -> apply -> verify -> await approval -> commit/discard. The browser instruction only ever becomes the sandboxed agent's ARGUMENT, never a host shell.
 */

import { randomUUID } from 'node:crypto';
import { createChildLogger } from '@/shared/logger';
import { DevSessionEngine, type DevSession } from './dev-session-engine';
import { DevSessionOrchestrator } from './dev-session-orchestrator';
import type { SandboxRunExtra } from './sandboxed-agent-runner';

const logger = createChildLogger({ module: 'dev-session-manager' });
const MAX_SESSIONS = 40;
const MAX_ACTIVE = 3;
const SESSION_MAX_AGE_MS = 30 * 60 * 1000;
const MAX_FRAMES = 2000;
const ACTIVE_STATES: DevSessionStatus[] = ['running', 'ready', 'committing'];

export type DevSessionStatus = 'running' | 'ready' | 'committing' | 'committed' | 'discarded' | 'error';

export interface DevSessionFrame {
  type: 'status' | 'session' | 'agent-output' | 'applied' | 'diff' | 'verify' | 'ready' | 'committed' | 'discarded' | 'error';
  ts: string;
  message?: string;
  data?: Record<string, unknown>;
}

export interface StartSpec {
  ownerSub: string | null;
  /** 'demo' = a fixed, safe deterministic edit (no LLM, no network). 'agent' = the real LLM agent. */
  mode: 'demo' | 'agent';
  /** For 'agent' mode: the natural-language instruction, passed as the agent's ARGUMENT (never a shell). */
  instruction?: string;
  label?: string;
}

interface SessionRecord {
  id: string;
  ownerSub: string | null;
  status: DevSessionStatus;
  session?: DevSession;
  frames: DevSessionFrame[];
  subscribers: Set<(frame: DevSessionFrame) => void>;
  verifyPassed: boolean;
  createdAt: string;
  abort: AbortController;
}

/**
 * Orchestrates streamed, operator-approved dev sessions for the Developer Console. One instance
 * per server process (host/sidecar where the repo + docker live). Commit is a separate,
 * verify-gated, owner-only approval — the manager never auto-commits and never touches main.
 */
export class DevSessionManager {
  private readonly engine: DevSessionEngine;
  private readonly orchestrator: DevSessionOrchestrator;
  private readonly records = new Map<string, SessionRecord>();

  constructor(engine: DevSessionEngine, orchestrator: DevSessionOrchestrator) {
    this.engine = engine;
    this.orchestrator = orchestrator;
    // Reaper: discard sessions abandoned in a non-terminal state past the max age so their
    // worktree + branch + container do not leak for the server's lifetime. Unref'd so it never
    // holds the process open.
    const reaper = setInterval(() => this.reap(), 60_000);
    if (typeof (reaper as { unref?: () => void }).unref === 'function') (reaper as { unref: () => void }).unref();
  }

  /**
   * @description Opens a session and runs the agentic edit asynchronously, streaming frames. The
   * agent COMMAND is built server-side from the mode — the caller's instruction is only ever an
   * argument to the sandboxed agent, so it can never become a host shell command.
   * @param spec - Owner, mode, and (for agent mode) the instruction.
   * @returns The new session id (subscribe to its stream for progress).
   */
  start(spec: StartSpec): { sessionId: string } {
    // Agent mode must NOT run with open egress: the sandbox holds the full repo (and, if
    // configured, creds), so a prompt-injected agent + open network could exfiltrate. Require an
    // explicit narrow provider-egress network; refuse otherwise (demo mode stays fully isolated).
    if (spec.mode === 'agent' && !(process.env.OSHAL_DEV_AGENT_NETWORK || '').trim()) {
      throw new Error('agent mode requires OSHAL_DEV_AGENT_NETWORK (a narrow provider-egress network) — refusing open egress');
    }
    const active = [...this.records.values()].filter((r) => ACTIVE_STATES.includes(r.status)).length;
    if (active >= MAX_ACTIVE) {
      throw new Error(`too many active dev sessions (${active}/${MAX_ACTIVE}) — commit or discard one first`);
    }
    this.prune();
    const id = randomUUID();
    const record: SessionRecord = {
      id, ownerSub: spec.ownerSub, status: 'running', frames: [], subscribers: new Set(),
      verifyPassed: false, createdAt: new Date().toISOString(), abort: new AbortController(),
    };
    this.records.set(id, record);
    void this.runLoop(record, spec);
    return { sessionId: id };
  }

  /**
   * @description Subscribes to a session's frames (replaying buffered ones first). Owner-only.
   * @param sessionId - The session.
   * @param ownerSub - The caller; must own the session.
   * @param onFrame - Frame callback.
   * @returns An unsubscribe function, or null if not found / not owned.
   */
  subscribe(sessionId: string, ownerSub: string | null, onFrame: (frame: DevSessionFrame) => void): (() => void) | null {
    const record = this.records.get(sessionId);
    if (!record || record.ownerSub !== ownerSub) return null;
    for (const frame of record.frames) onFrame(frame);
    record.subscribers.add(onFrame);
    return () => record.subscribers.delete(onFrame);
  }

  /**
   * @description Approves + commits a ready session (verify must have passed). Owner-only.
   * @param sessionId - The session.
   * @param ownerSub - The caller; must own the session.
   * @param message - Commit message.
   * @returns Commit result, or throws with a clear reason.
   */
  async commit(sessionId: string, ownerSub: string | null, message: string): Promise<{ sha: string; branch: string }> {
    const record = this.ownedReady(sessionId, ownerSub);
    record.status = 'committing';
    try {
      const result = this.engine.commit(record.session!, sanitizeMessage(message));
      record.status = 'committed';
      this.emit(record, { type: 'committed', message: 'Committed to the session branch.', data: { sha: result.sha, branch: result.branch } });
      this.engine.teardown(record.session!, { keepBranch: true });
      return result;
    } catch (error) {
      record.status = 'ready';
      throw error;
    }
  }

  /**
   * @description Discards a session (teardown, branch deleted). Owner-only.
   * @param sessionId - The session.
   * @param ownerSub - The caller; must own the session.
   */
  discard(sessionId: string, ownerSub: string | null): void {
    const record = this.records.get(sessionId);
    if (!record || record.ownerSub !== ownerSub) throw new Error('session not found');
    record.abort.abort(); // kill any in-flight sandbox container
    if (record.session && record.status !== 'committed') {
      try { this.engine.teardown(record.session); } catch { /* already gone */ }
    }
    record.status = 'discarded';
    this.emit(record, { type: 'discarded', message: 'Session discarded.' });
  }

  /** Discards non-terminal sessions abandoned past the max age (worktree/branch/container reaper). */
  private reap(): void {
    const now = Date.now();
    for (const record of this.records.values()) {
      if (!ACTIVE_STATES.includes(record.status)) continue;
      if (now - Date.parse(record.createdAt) < SESSION_MAX_AGE_MS) continue;
      record.abort.abort();
      if (record.session) { try { this.engine.teardown(record.session); } catch { /* best effort */ } }
      record.status = 'discarded';
      this.emit(record, { type: 'discarded', message: 'Session expired and was discarded.' });
      logger.info({ id: record.id }, 'reaped abandoned dev session');
    }
  }

  /** @description Lists the caller's sessions (summary only). */
  list(ownerSub: string | null): Array<{ id: string; status: DevSessionStatus; createdAt: string }> {
    return [...this.records.values()]
      .filter((r) => r.ownerSub === ownerSub)
      .map((r) => ({ id: r.id, status: r.status, createdAt: r.createdAt }));
  }

  /** The streamed lifecycle: open -> agent (frames) -> apply -> diff -> verify -> ready. */
  private async runLoop(record: SessionRecord, spec: StartSpec): Promise<void> {
    try {
      this.emit(record, { type: 'status', message: 'Opening an isolated session…' });
      const session = this.engine.create(spec.label ?? spec.mode);
      record.session = session;
      this.emit(record, { type: 'session', message: `Session ${session.id} on ${session.branch}`, data: { id: session.id, branch: session.branch } });

      const command = buildAgentCommand(spec);
      this.emit(record, { type: 'status', message: 'Running the agent in the sandbox…' });
      const edit = await this.orchestrator.runAgentEditStreaming(
        session, command,
        (chunk) => this.emit(record, { type: 'agent-output', data: { chunk } }),
        { runExtra: agentRunExtra(spec.mode), timeoutMs: 600_000 },
        record.abort.signal,
      );
      this.emit(record, { type: 'applied', message: `Applied ${edit.filesChanged.length} file(s).`, data: { filesChanged: edit.filesChanged, deleted: edit.deleted } });
      this.emit(record, { type: 'diff', data: { files: edit.diff.files, patch: edit.diff.patch.slice(0, 60_000), changed: edit.diff.changed } });

      this.emit(record, { type: 'status', message: 'Typechecking…' });
      const verify = await this.engine.verifyAsync(session);
      record.verifyPassed = verify.passed;
      this.emit(record, { type: 'verify', message: verify.passed ? 'Typecheck passed.' : 'Typecheck failed.', data: { passed: verify.passed, durationMs: verify.durationMs, output: verify.output.slice(-4000) } });

      record.status = 'ready';
      this.emit(record, { type: 'ready', message: verify.passed ? 'Ready for your review — approve to commit.' : 'Review the diff; typecheck failed so commit is blocked.', data: { canCommit: verify.passed && edit.diff.changed } });
    } catch (error) {
      record.status = 'error';
      logger.error({ err: error, id: record.id }, 'dev session run failed');
      this.emit(record, { type: 'error', message: error instanceof Error ? error.message : String(error) });
      if (record.session) { try { this.engine.teardown(record.session); } catch { /* best effort */ } }
    }
  }

  private ownedReady(sessionId: string, ownerSub: string | null): SessionRecord {
    const record = this.records.get(sessionId);
    if (!record || record.ownerSub !== ownerSub) throw new Error('session not found');
    if (record.status !== 'ready') throw new Error(`session is '${record.status}', not ready to commit`);
    if (!record.verifyPassed) throw new Error('refusing to commit: typecheck did not pass');
    return record;
  }

  private emit(record: SessionRecord, partial: Omit<DevSessionFrame, 'ts'>): void {
    const frame: DevSessionFrame = { ...partial, ts: new Date().toISOString() };
    record.frames.push(frame);
    if (record.frames.length > MAX_FRAMES) record.frames.splice(0, record.frames.length - MAX_FRAMES);
    for (const subscriber of record.subscribers) {
      try { subscriber(frame); } catch { /* a dead subscriber must not break the run */ }
    }
  }

  private prune(): void {
    if (this.records.size < MAX_SESSIONS) return;
    const oldest = [...this.records.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (oldest && ['committed', 'discarded', 'error'].includes(oldest.status)) this.records.delete(oldest.id);
  }
}

/** Builds the sandbox command server-side. The instruction is only ever the agent's final ARG. */
function buildAgentCommand(spec: StartSpec): string[] {
  if (spec.mode === 'demo') {
    return ['sh', '-c', 'printf "\\n<!-- dev-console demo edit: %s -->\\n" "$(date -u +%FT%TZ)" >> /work/README.md'];
  }
  const bin = (process.env.OSHAL_DEV_AGENT_BIN || 'claude').trim();
  const args = (process.env.OSHAL_DEV_AGENT_ARGS || '-p').split(' ').map((a) => a.trim()).filter(Boolean);
  return [bin, ...args, spec.instruction ?? ''];
}

/** Real-agent run needs its image + creds + egress; demo runs fully isolated (no network/creds). */
function agentRunExtra(mode: StartSpec['mode']): SandboxRunExtra | undefined {
  if (mode === 'demo') return undefined;
  const creds = (process.env.OSHAL_DEV_AGENT_CREDS || '').trim();
  // Network defaults to 'none' (fully isolated) — start() refuses agent mode unless the operator
  // has explicitly set a narrow provider-egress network, so open egress is never the default.
  return {
    image: (process.env.OSHAL_DEV_AGENT_IMAGE || 'any-bot:latest').trim(),
    network: (process.env.OSHAL_DEV_AGENT_NETWORK || 'none').trim(),
    roMounts: creds ? [{ host: creds, container: '/root/.claude' }] : [],
  };
}

function sanitizeMessage(message: string): string {
  const clean = (message || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
  return clean || 'dev-console: sandboxed agentic edit';
}
