/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added A2A mesh chat client: register + heartbeat + chat send + swarm/next poll over headscale-http
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Assert ownerSub (the node's signed-in userSub) at registration so the control plane binds this device to its user — session callers who don't own it are 403'd from enqueue/results (device-ownership binding, repo-audit 2026-07-05)
 */

import { randomUUID } from 'crypto';
import type { OshalChatConfig } from './config';
import { localCapabilities } from './local-tools';

/** Reply payload shape produced by the server-side chat bridge. */
export interface ChatReply {
  type: 'chat.reply';
  taskId: string;
  correlationId: string;
  success: boolean;
  text: string;
  error?: string;
}

/** Connection status surfaced to the UI. */
export interface MeshStatus {
  connected: boolean;
  clientId: string;
  agentId: string;
  lastError: string | null;
}

/** Callbacks the main process wires to the renderer. */
export interface MeshHandlers {
  onReply: (reply: ChatReply) => void;
  onStatus: (status: MeshStatus) => void;
}

const HEARTBEAT_MS = 10_000;
const POLL_MS = 1_500;

/** True when an error means the control plane has no record of this client. */
function isClientMissing(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /not found/i.test(message) || /\b40[04]\b/.test(message);
}

/**
 * @description Joins the OSHAL swarm as an A2A remote client and exchanges chat
 * turns with a bot: it registers, heartbeats, POSTs chat turns, and polls the
 * swarm-message queue for the bot's reply. Transport is plain HTTP to the
 * control-plane URL — which is a headscale tailnet address when the VPN is up.
 */
export class MeshChatClient {
  private readonly base: string;
  private readonly conversationTaskId: string;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private connected = false;

  constructor(
    private readonly config: OshalChatConfig,
    private readonly handlers: MeshHandlers,
  ) {
    this.base = `${config.controlPlaneUrl.replace(/\/+$/, '')}/api/remote-clients`;
    this.conversationTaskId = `remote-chat-${config.clientId}-${randomUUID().slice(0, 8)}`;
  }

  /**
   * @description Registers with the control plane and starts the heartbeat + poll loops.
   */
  async start(): Promise<void> {
    await this.register();
    await this.heartbeat();
    this.heartbeatTimer = setInterval(() => void this.heartbeat(), HEARTBEAT_MS);
    this.pollTimer = setInterval(() => void this.pollOnce(), POLL_MS);
    this.connected = true;
    this.emitStatus(null);
  }

  /**
   * @description Sends an offline heartbeat and tears down the loops.
   */
  async stop(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.heartbeatTimer = null;
    this.pollTimer = null;
    this.connected = false;
    try {
      await this.heartbeat('offline');
    } catch {
      // best-effort offline notice
    }
    this.emitStatus(null);
  }

  /**
   * @description Posts one chat turn; the reply arrives later on the poll loop.
   * @returns The taskId + correlationId the reply will carry.
   */
  async sendChat(text: string): Promise<{ taskId: string; correlationId: string }> {
    const correlationId = randomUUID();
    const body = {
      text,
      taskId: this.conversationTaskId,
      correlationId,
      agentId: this.config.targetAgentId || undefined,
      userSub: this.config.userSub || undefined,
    };
    const res = await this.fetchJson(`/${this.config.clientId}/chat`, 'POST', body);
    return {
      taskId: typeof res?.taskId === 'string' ? res.taskId : this.conversationTaskId,
      correlationId: typeof res?.correlationId === 'string' ? res.correlationId : correlationId,
    };
  }

  /**
   * @description Registers this client as an A2A mesh participant.
   */
  private async register(): Promise<void> {
    await this.fetchJson('/register', 'POST', {
      clientId: this.config.clientId,
      name: this.config.clientName,
      // Bind this device to its signed-in user: session callers on the control
      // plane can then enqueue tasks / read results ONLY when they own it (or
      // are an operator). Absent (no signed-in user configured) = unowned →
      // operator-only for session callers, fail-closed.
      ownerSub: this.config.userSub || undefined,
      transport: 'headscale-http',
      controlPlaneUrl: this.config.controlPlaneUrl,
      platform: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux',
      tailnetHostname: this.config.tailnetHostname || undefined,
      // Advertise the local tools the swarm may route here, but only when the
      // worker is enabled — otherwise this is a chat-only client. System-control
      // tools are advertised only when the user has opted in.
      capabilities: this.config.workerEnabled
        ? ['chat', ...localCapabilities({ allowSystemControl: this.config.allowSystemControl })]
        : ['chat'],
      tags: ['desktop', 'oshal-chat', ...(this.config.workerEnabled ? ['worker'] : [])],
    });
  }

  /**
   * @description Sends a heartbeat with the given status. If the control plane has
   * forgotten this client (it restarted or evicted us — the registry is in-memory),
   * the heartbeat 400s "not found"; we transparently re-register and retry so the
   * node self-heals instead of heartbeating into the void. Never throws (the interval
   * swallows the result), so a transient control-plane blip can't crash the process.
   */
  private async heartbeat(status: 'online' | 'offline' = 'online'): Promise<void> {
    const body = {
      clientId: this.config.clientId,
      status,
      controlPlaneReachable: true,
      mcpReady: true,
      toolCount: 0,
      lastSeenAt: new Date().toISOString(),
    };
    try {
      await this.fetchJson(`/${this.config.clientId}/heartbeat`, 'POST', body);
    } catch (error) {
      if (status === 'online' && isClientMissing(error)) {
        try {
          await this.register();
          await this.fetchJson(`/${this.config.clientId}/heartbeat`, 'POST', body);
          this.emitStatus(null);
          return;
        } catch (reRegisterError) {
          this.emitStatus(reRegisterError instanceof Error ? reRegisterError.message : 'heartbeat failed');
          return;
        }
      }
      // Offline heartbeats are best-effort; online failures surface to the UI.
      if (status === 'online') this.emitStatus(error instanceof Error ? error.message : 'heartbeat failed');
    }
  }

  /**
   * @description Claims one queued swarm message and forwards chat replies to the UI.
   */
  private async pollOnce(): Promise<void> {
    try {
      const res = await this.rawFetch(`/${this.config.clientId}/swarm/next`, 'GET');
      if (res.status === 204) {
        if (!this.connected) this.markConnected();
        return;
      }
      if (!res.ok) {
        this.emitStatus(`poll ${res.status}`);
        return;
      }
      this.markConnected();
      const data = (await res.json()) as { message?: { payload?: Record<string, unknown> } };
      const payload = data?.message?.payload;
      if (payload && payload.type === 'chat.reply') {
        this.handlers.onReply(payload as unknown as ChatReply);
      }
    } catch (error) {
      this.emitStatus(error instanceof Error ? error.message : 'poll failed');
    }
  }

  /**
   * @description Performs a JSON request and returns the parsed body (or null on 204).
   */
  private async fetchJson(path: string, method: string, body?: unknown): Promise<Record<string, any> | null> {
    const res = await this.rawFetch(path, method, body);
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`${method} ${path} → ${res.status} ${detail}`.trim());
    }
    if (res.status === 204) return null;
    return (await res.json()) as Record<string, any>;
  }

  /**
   * @description Low-level fetch with auth headers applied.
   */
  private rawFetch(path: string, method: string, body?: unknown): Promise<Response> {
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

  /**
   * @description Marks the connection healthy and clears any prior error.
   */
  private markConnected(): void {
    if (!this.connected) {
      this.connected = true;
      this.emitStatus(null);
    }
  }

  /**
   * @description Emits the current status to the UI.
   */
  private emitStatus(lastError: string | null): void {
    this.handlers.onStatus({
      connected: this.connected,
      clientId: this.config.clientId,
      agentId: this.config.targetAgentId || '(default chat agent)',
      lastError,
    });
  }
}
