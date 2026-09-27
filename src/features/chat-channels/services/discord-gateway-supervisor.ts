/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — one in-process owner of the Discord Gateway listener, so a token saved from the cockpit starts (or restarts) the Gateway immediately and a disconnect stops it, without an api container recreate. Holds the token the running listener identified with, which is also the token replies are sent with, so what is connected and what answers are always the same credential. settle() lets the save route wait briefly for READY or a named refusal so the cockpit shows the true outcome of a paste rather than "connecting".
 */

import { createChildLogger } from '@/shared/logger';
import {
  startDiscordGateway,
  type DiscordGatewayHandle,
  type DiscordGatewayOptions,
  type DiscordGatewayStatus,
  type InboundDiscordMessage,
} from './discord-channel-adapter';

const logger = createChildLogger({ module: 'discord-gateway-supervisor' });

/** Where the active token came from: the operator's saved settings, the env seed, or a spec seam. */
export type DiscordTokenSource = 'database' | 'env' | 'seam';

/** The Gateway status plus whether a listener is running and which token source it identified with. */
export interface DiscordSupervisorStatus extends DiscordGatewayStatus {
  running: boolean;
  source: DiscordTokenSource | null;
}

/** A status the settle wait treats as final: READY arrived, Discord refused for a named reason, or the listener stopped. */
function isSettled(status: DiscordGatewayStatus): boolean {
  return status.state === 'connected' || status.problem !== null || status.state === 'stopped';
}

/**
 * @description Owns at most one Discord Gateway listener at a time. start() replaces any running
 * listener; stop() ends it. The token is held only here and in the listener's IDENTIFY.
 */
export class DiscordGatewaySupervisor {
  private readonly onMessage: (message: InboundDiscordMessage) => void | Promise<void>;
  private readonly baseOptions: DiscordGatewayOptions;
  private handle: DiscordGatewayHandle | null = null;
  private activeToken: string | null = null;
  private source: DiscordTokenSource | null = null;
  private waiters: Array<(status: DiscordGatewayStatus) => void> = [];

  /**
   * @param onMessage - Receives each DM the running listener delivers.
   * @param baseOptions - Socket/URL/reconnect seams applied to every listener this supervisor starts.
   */
  constructor(onMessage: (message: InboundDiscordMessage) => void | Promise<void>, baseOptions: DiscordGatewayOptions = {}) {
    this.onMessage = onMessage;
    this.baseOptions = baseOptions;
  }

  /**
   * @description Starts a listener with `token`, stopping any running one first.
   * @param token - The bot token to IDENTIFY with (never logged).
   * @param source - Where the token came from, for the status readback.
   */
  start(token: string, source: DiscordTokenSource): void {
    this.stop();
    logger.info({ source }, 'starting the Discord Gateway listener');
    this.activeToken = token;
    this.source = source;
    this.handle = startDiscordGateway(this.onMessage, {
      ...this.baseOptions,
      token,
      onStatus: (status) => this.observe(status),
    });
  }

  /** @description Stops the running listener, if any, and forgets its token. */
  stop(): void {
    if (this.handle) {
      logger.info({ source: this.source }, 'stopping the Discord Gateway listener');
      this.handle.stop();
    }
    this.handle = null;
    this.activeToken = null;
    this.source = null;
  }

  /** @description The token the running listener identified with (for replies), or null. */
  token(): string | null {
    return this.activeToken;
  }

  /** @description The listener's status plus running flag and token source. */
  status(): DiscordSupervisorStatus {
    const status = this.handle?.status() ?? { state: 'stopped', lastCloseCode: null, problem: null, connectedAt: null, botUserId: null, botUsername: null };
    return { ...status, running: this.handle !== null && status.state !== 'stopped', source: this.source };
  }

  /**
   * @description Waits until the listener reaches READY, a named refusal, or stops — or until the
   * timeout — and returns the status then. Never throws; a timeout answers the current status.
   * @param timeoutMs - How long to wait.
   * @returns The status at settlement or timeout.
   */
  settle(timeoutMs: number): Promise<DiscordSupervisorStatus> {
    const current = this.status();
    if (!this.handle || isSettled(current)) return Promise.resolve(current);
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.waiters = this.waiters.filter((w) => w !== waiter); resolve(this.status()); }, timeoutMs);
      timer.unref();
      const waiter = (status: DiscordGatewayStatus) => {
        if (!isSettled(status)) return;
        clearTimeout(timer);
        this.waiters = this.waiters.filter((w) => w !== waiter);
        resolve(this.status());
      };
      this.waiters.push(waiter);
    });
  }

  private observe(status: DiscordGatewayStatus): void {
    this.baseOptions.onStatus?.(status);
    for (const waiter of [...this.waiters]) waiter(status);
  }
}
