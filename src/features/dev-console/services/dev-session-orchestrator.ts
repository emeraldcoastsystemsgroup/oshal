/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Dev Session Orchestrator (ADR-077 Phase 2): composes the sandboxed agent runner + the dev session engine into one governed agentic-edit step (sandbox edit -> extract -> apply -> reviewable diff). Commit stays a separate, verify-gated, operator-approved step on the engine.
 */

import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import path from 'node:path';
import { createChildLogger } from '@/shared/logger';
import { DevSessionEngine, type DevSession, type DevSessionDiff } from './dev-session-engine';
import { SandboxedAgentRunner, type SandboxRunExtra } from './sandboxed-agent-runner';

const logger = createChildLogger({ module: 'dev-session-orchestrator' });
const IGNORED = new Set(['.git', 'node_modules', '.tokenchase']);

export interface AgentEditResult {
  agentExitCode: number | null;
  agentOutput: string;
  /** Worktree-relative paths the agent's edits touched (applied to the governed worktree). */
  filesChanged: string[];
  /** Files the agent deleted in the sandbox (REPORTED for review; not auto-applied in this slice). */
  deleted: string[];
  /** Binary files the agent changed (reported, not applied — the change set is text-only). */
  skippedBinary: string[];
  /** The reviewable diff after applying the agent's edits to the worktree. */
  diff: DevSessionDiff;
}

export interface AgentEditOptions {
  timeoutMs?: number;
  /** Real-agent config: read-only creds mount, provider-egress network, and the agent image. */
  runExtra?: SandboxRunExtra;
}

/**
 * Ties the two red-team-hardened cores together into the governed self-edit loop:
 *  1. seed a throwaway sandbox scratch from the session worktree (minus .git/node_modules),
 *  2. run the agent command INSIDE the locked-down container (it can only touch /work — no host
 *     .git/refs, no creds unless a ro mount is given, no network unless a narrow egress is given),
 *  3. extract its edits as a text-only change set and apply them to the governed worktree,
 *  4. return the reviewable diff.
 * Commit remains a SEPARATE, verify-gated, operator-approved step on the DevSessionEngine — the
 * orchestrator never commits and never touches main.
 */
export class DevSessionOrchestrator {
  /**
   * @param engine - The governed dev session engine (worktree/apply/verify/commit).
   * @param runner - The sandboxed agent runner (locked-down container execution).
   * @param scratchRoot - Where sandbox scratch dirs are created (Docker-mountable; outside the repo).
   */
  constructor(
    private readonly engine: DevSessionEngine,
    private readonly runner: SandboxedAgentRunner,
    private readonly scratchRoot: string,
  ) {}

  /**
   * @description Runs one governed agentic edit against a session and returns the reviewable diff.
   * Does NOT verify or commit — the operator reviews, runs `engine.verify`, and approves a commit.
   * @param session - The active dev session.
   * @param agentCommand - The command to run inside the sandbox (e.g. ['claude','-p', instruction] or a deterministic transform).
   * @param options - Timeout + real-agent run config (creds ro mount, egress network, image).
   * @returns What the agent changed + the resulting worktree diff.
   */
  runAgentEdit(session: DevSession, agentCommand: string[], options: AgentEditOptions = {}): AgentEditResult {
    const scratch = path.join(this.scratchRoot, session.id);
    rmSync(scratch, { recursive: true, force: true });
    mkdirSync(scratch, { recursive: true });
    try {
      this.seedScratch(session, scratch);
      const before = this.runner.snapshot(scratch);
      const run = this.runner.run(scratch, agentCommand, options.timeoutMs ?? 900_000, options.runExtra);
      const changeSet = this.runner.extractChangeSet(scratch, before);
      const filesChanged = this.engine.applyChangeSet(session, changeSet.edits);
      logger.info(
        { id: session.id, filesChanged: filesChanged.length, deleted: changeSet.deleted.length, agentExit: run.exitCode },
        'agent edit applied to session worktree',
      );
      return {
        agentExitCode: run.exitCode,
        agentOutput: run.output,
        filesChanged,
        deleted: changeSet.deleted,
        skippedBinary: changeSet.skippedBinary,
        diff: this.engine.diff(session),
      };
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  /**
   * @description Streaming variant of runAgentEdit: emits the agent's output chunks via `onOutput`
   * AS THEY ARRIVE (the live thought-chain), then applies the resulting change set and returns the
   * reviewable diff. Same isolation + governance as runAgentEdit.
   * @param session - The active dev session.
   * @param agentCommand - The command to run inside the sandbox.
   * @param onOutput - Called with each agent output chunk as it streams.
   * @param options - Timeout + real-agent run config.
   * @returns What the agent changed + the resulting worktree diff.
   */
  async runAgentEditStreaming(
    session: DevSession,
    agentCommand: string[],
    onOutput: (chunk: string) => void,
    options: AgentEditOptions = {},
    signal?: AbortSignal,
  ): Promise<AgentEditResult> {
    const scratch = path.join(this.scratchRoot, session.id);
    rmSync(scratch, { recursive: true, force: true });
    mkdirSync(scratch, { recursive: true });
    try {
      await this.seedScratchAsync(session, scratch);
      const before = this.runner.snapshot(scratch);
      const run = await this.runner.runStreaming(scratch, agentCommand, onOutput, options.timeoutMs ?? 900_000, options.runExtra, signal);
      const changeSet = this.runner.extractChangeSet(scratch, before);
      const filesChanged = this.engine.applyChangeSet(session, changeSet.edits);
      logger.info({ id: session.id, filesChanged: filesChanged.length, agentExit: run.exitCode }, 'streamed agent edit applied');
      return {
        agentExitCode: run.exitCode,
        agentOutput: run.output,
        filesChanged,
        deleted: changeSet.deleted,
        skippedBinary: changeSet.skippedBinary,
        diff: this.engine.diff(session),
      };
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  /** Copies the worktree's files (minus .git/node_modules/.tokenchase) into the sandbox scratch. */
  private seedScratch(session: DevSession, scratch: string): void {
    cpSync(session.worktreePath, scratch, { recursive: true, filter: (src) => this.seedFilter(session, src) });
  }

  /** Async seed (fs.promises.cp) — used by the streaming path so a full-repo copy never blocks the loop. */
  private async seedScratchAsync(session: DevSession, scratch: string): Promise<void> {
    await cp(session.worktreePath, scratch, { recursive: true, filter: (src) => this.seedFilter(session, src) });
  }

  private seedFilter(session: DevSession, src: string): boolean {
    const rel = path.relative(session.worktreePath, src);
    return rel === '' || !rel.split(path.sep).some((seg) => IGNORED.has(seg));
  }
}
