/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Worker loop: this node pulls tasks the swarm assigned (GET /tasks/next), runs them locally via the allowlisted tool registry, and reports back (POST /tasks/:id/complete|fail). This is the "push in, pull out" half — the machine materially participates in the swarm.
 */

import { basename } from 'path';
import type { OshalChatConfig } from './config';
import { runLocalTool, localToolList, type ToolOutcome, type ToolGate } from './local-tools';
import { pullWorkspace, pushWorkspace, type WorkspaceMirror } from './workspace-sync';

const POLL_MS = 1_500;

/** Minimal shape of a claimed A2A task envelope (server-validated; intent is an MCP kind). */
interface ClaimedTask {
  taskId: string;
  correlationId: string;
  intent: string;
  input?: Record<string, unknown>;
  /** Shared task folder id (set when the swarm routes run-work here). */
  workspacePath?: string;
}

/** Per-task lifecycle events surfaced to the UI activity log. */
export interface WorkerEvent {
  taskId: string;
  /** Tool name (for mcp.call-tool) or the raw intent. */
  intent: string;
  phase: 'claimed' | 'completed' | 'failed';
  text?: string;
  error?: string;
}

/** A short label for the activity log — the tool name for a call, else the intent. */
function taskLabel(task: ClaimedTask): string {
  if (task.intent === 'mcp.call-tool') {
    const name = task.input?.name;
    return typeof name === 'string' && name ? name : 'mcp.call-tool';
  }
  return task.intent;
}

/** Resolves a claimed MCP task to a local-tool outcome. */
async function executeTask(task: ClaimedTask, gate: ToolGate): Promise<ToolOutcome> {
  const input = task.input || {};
  switch (task.intent) {
    case 'mcp.call-tool': {
      const name = typeof input.name === 'string' ? input.name : '';
      const args = (input.arguments as Record<string, unknown>) || input;
      return runLocalTool(name, args, gate);
    }
    case 'mcp.list-tools':
      return { success: true, text: '', output: { tools: localToolList(gate) } };
    case 'mcp.initialize':
    case 'mcp.shutdown':
    case 'status.sync':
      return { success: true, text: '', output: { ack: true, intent: task.intent } };
    default:
      return { success: false, text: '', output: {}, error: `Unsupported intent "${task.intent}"` };
  }
}

export interface WorkerHandlers {
  onEvent: (event: WorkerEvent) => void;
}

/**
 * @description Polls the control plane for tasks assigned to this client, runs
 * each one against the local tool registry, and posts the result back. Auth and
 * base URL mirror MeshChatClient so it rides the same remote-client surface.
 */
export class TaskWorker {
  private readonly base: string;
  private timer: NodeJS.Timeout | null = null;
  private draining = false;

  constructor(
    private readonly config: OshalChatConfig,
    private readonly handlers: WorkerHandlers,
  ) {
    this.base = `${config.controlPlaneUrl.replace(/\/+$/, '')}/api/remote-clients`;
  }

  /** Starts the pull loop. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), POLL_MS);
  }

  /** Stops the pull loop (a task already running is allowed to finish). */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Claims and runs at most one task per tick (serial — one local CLI at a time). */
  private async tick(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      const task = await this.claim();
      if (!task) return;
      const label = taskLabel(task);
      this.handlers.onEvent({ taskId: task.taskId, intent: label, phase: 'claimed' });

      // If the swarm assigned a shared task folder, pull ONLY that folder into a
      // local mirror and run the work there (so the node is a co-worker in the
      // same workspace as the rest of the swarm).
      let mirror: WorkspaceMirror | null = null;
      const folderId = task.workspacePath ? basename(task.workspacePath) : '';
      if (folderId) {
        try { mirror = await pullWorkspace(this.config, task.taskId, folderId); } catch { mirror = null; }
      }

      const gate: ToolGate = { allowSystemControl: this.config.allowSystemControl, workspaceDir: mirror?.dir };
      const outcome = await executeTask(task, gate);

      // Invariant: push the node's files BEFORE marking the task complete, so the
      // next round/bot never reads stale content. Additive — never deletes remote.
      if (mirror) {
        try { await pushWorkspace(this.config, task.taskId, mirror); } catch { /* best-effort */ }
      }

      await this.report(task, label, outcome);
    } catch {
      // A transient control-plane error just means we retry next tick.
    } finally {
      this.draining = false;
    }
  }

  /** GET /:clientId/tasks/next → a claimed task or null (204 = queue empty). */
  private async claim(): Promise<ClaimedTask | null> {
    const res = await this.fetch(`/${this.config.clientId}/tasks/next`, 'GET');
    if (res.status === 204 || !res.ok) return null;
    const data = (await res.json()) as { claimed?: boolean; task?: ClaimedTask | null };
    return data?.claimed && data.task ? data.task : null;
  }

  /** POSTs the outcome to the matching complete/fail endpoint. */
  private async report(task: ClaimedTask, label: string, outcome: ToolOutcome): Promise<void> {
    const path = `/${this.config.clientId}/tasks/${encodeURIComponent(task.taskId)}/${outcome.success ? 'complete' : 'fail'}`;
    const body = {
      correlationId: task.correlationId,
      toolName: label,
      output: outcome.output,
      error: outcome.success ? undefined : outcome.error,
    };
    await this.fetch(path, 'POST', body).catch(() => undefined);
    this.handlers.onEvent({
      taskId: task.taskId,
      intent: label,
      phase: outcome.success ? 'completed' : 'failed',
      text: outcome.text,
      error: outcome.success ? undefined : outcome.error,
    });
  }

  /** Low-level fetch with the remote-client auth headers applied. */
  private fetch(path: string, method: string, body?: unknown): Promise<Response> {
    return fetch(`${this.base}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        [this.config.authHeaderName]: this.config.sharedSecret,
        authorization: `Bearer ${this.config.sharedSecret}`,
      },
      body: body == null ? undefined : JSON.stringify(body),
    });
  }
}
