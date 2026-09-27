/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — the operator-level Discord configuration: which token the Gateway runs on and what the cockpit may say about it. Precedence at boot is the saved settings row (enabled: its decrypted token; disabled: nothing, even with an env token), then the DISCORD_BOT_TOKEN env seed. connect() validates a pasted token live, stores it encrypted, and starts the Gateway at once; disconnect() stops it and forgets the token. describe() is what both the operator card and the per-user card read: configured state, the bot's name and id, the invite and DM links, the Message Content intent flag, and the live connection state with any named problem. The token itself never leaves this object except into the Gateway IDENTIFY and the reply sender.
 */

import { createChildLogger } from '@/shared/logger';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';
import { DISCORD_CHANNEL_PROVIDER, getDiscordBotToken } from './discord-channel-adapter';
import { discordDmUrl, discordInviteUrl, validateDiscordBotToken, type DiscordBotIdentity, type DiscordIdentityOptions } from './discord-bot-identity';
import type { ChannelProviderSettingsStore } from './channel-provider-settings';
import type { DiscordGatewaySupervisor, DiscordSupervisorStatus, DiscordTokenSource } from './discord-gateway-supervisor';

const logger = createChildLogger({ module: 'discord-channel-config' });

/** How long connect() waits for READY or a refusal before answering with whatever state it has. */
const SETTLE_TIMEOUT_MS = 4_000;

/** Everything a cockpit card may know about the deployment's Discord bot. Never the token. */
export interface DiscordChannelState {
  /** True when a token is active (the Gateway is running or was started with it). */
  configured: boolean;
  source: DiscordTokenSource | null;
  bot: { userId: string; username: string; applicationId: string | null; applicationName: string | null } | null;
  /** True/false when Discord reported the application flags; null when unknown (env seed not yet described). */
  messageContentIntent: boolean | null;
  /** The "Add the bot to your server" URL; null until the application id is known. */
  inviteUrl: string | null;
  /** The bot's profile link, from which a person opens the DM; null until the bot user id is known. */
  dmUrl: string | null;
  connection: DiscordSupervisorStatus;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** The seams the config takes: env, identity validation and its API base. */
export interface DiscordChannelConfigOptions {
  env?: NodeJS.ProcessEnv;
  validate?: (token: string, options?: DiscordIdentityOptions) => Promise<DiscordBotIdentity>;
  identity?: DiscordIdentityOptions;
  /** A spec's token; when set it wins over the store and the env and is never persisted. */
  seamToken?: string | null;
}

/** Reads the identity fields back out of a saved metadata object. */
function identityFromMetadata(metadata: Record<string, unknown>): DiscordBotIdentity | null {
  const botUserId = typeof metadata.botUserId === 'string' ? metadata.botUserId : '';
  const applicationId = typeof metadata.applicationId === 'string' ? metadata.applicationId : '';
  if (!botUserId || !applicationId) return null;
  return {
    botUserId,
    botUsername: typeof metadata.botUsername === 'string' ? metadata.botUsername : `bot-${botUserId}`,
    applicationId,
    applicationName: typeof metadata.applicationName === 'string' ? metadata.applicationName : '',
    messageContentIntent: metadata.messageContentIntent === true,
  };
}

/**
 * @description The Discord provider's operator-level configuration and its live listener.
 */
export class DiscordChannelConfig {
  private readonly store: ChannelProviderSettingsStore;
  private readonly supervisor: DiscordGatewaySupervisor;
  private readonly options: DiscordChannelConfigOptions;
  private identity: DiscordBotIdentity | null = null;
  private updatedAt: string | null = null;
  private updatedBy: string | null = null;
  private booted: Promise<void> | null = null;

  constructor(store: ChannelProviderSettingsStore, supervisor: DiscordGatewaySupervisor, options: DiscordChannelConfigOptions = {}) {
    this.store = store;
    this.supervisor = supervisor;
    this.options = options;
  }

  /**
   * @description Applies the boot precedence (seam, saved row, env seed) and starts the Gateway
   * when a token is active. Never throws: a store failure is logged and the env seed still applies.
   * Runs once; every read and write on this object waits for it through ready(), so a token saved
   * while the boot read is still in flight is never overridden by that read's answer.
   * @returns Resolves when the precedence has been applied.
   */
  boot(): Promise<void> {
    if (!this.booted) this.booted = this.applyBootPrecedence();
    return this.booted;
  }

  /** @description Resolves once boot() has applied the precedence (immediately when boot() never ran). */
  ready(): Promise<void> {
    return this.booted ?? Promise.resolve();
  }

  private async applyBootPrecedence(): Promise<void> {
    if (this.options.seamToken) { this.supervisor.start(this.options.seamToken, 'seam'); return; }
    let row: Awaited<ReturnType<ChannelProviderSettingsStore['read']>> = null;
    let secret: string | null = null;
    try {
      row = await runWithSystemIdentity(() => this.store.read(DISCORD_CHANNEL_PROVIDER));
      if (row?.enabled) secret = await runWithSystemIdentity(() => this.store.readSecret(DISCORD_CHANNEL_PROVIDER));
    } catch (err) {
      logger.error({ err, stack: (err as Error).stack }, 'Discord provider settings could not be read at boot; falling back to the env seed');
    }
    if (row) {
      this.updatedAt = row.updatedAt;
      this.updatedBy = row.updatedBy;
      this.identity = identityFromMetadata(row.metadata);
      if (!row.enabled) { logger.info('Discord provider is disabled by operator settings; the env seed is ignored'); return; }
      if (secret) { this.supervisor.start(secret, 'database'); return; }
    }
    const seed = getDiscordBotToken(this.options.env ?? process.env);
    if (!seed) return;
    this.supervisor.start(seed, 'env');
    void this.describeSeed(seed);
  }

  /** Best-effort identity for an env-seeded token, so the card can name the bot and build the links. */
  private async describeSeed(token: string): Promise<void> {
    try {
      this.identity = await (this.options.validate ?? validateDiscordBotToken)(token, this.options.identity);
    } catch (err) {
      logger.warn({ err }, 'the env-seeded Discord token could not be described; the Gateway status will say whether it works');
    }
  }

  /** @description True when a token is active for replies and link minting. */
  isConfigured(): boolean {
    return this.supervisor.token() !== null;
  }

  /** @description The token replies are sent with, or null when unconfigured. */
  activeToken(): string | null {
    return this.supervisor.token();
  }

  /** @description The state both cockpit cards read. Never includes the token. */
  describe(): DiscordChannelState {
    const connection = this.supervisor.status();
    const userId = this.identity?.botUserId ?? connection.botUserId;
    const username = this.identity?.botUsername ?? connection.botUsername;
    const applicationId = this.identity?.applicationId ?? null;
    return {
      configured: this.isConfigured(),
      source: connection.source,
      bot: userId ? { userId, username: username ?? `bot-${userId}`, applicationId, applicationName: this.identity?.applicationName ?? null } : null,
      messageContentIntent: this.identity ? this.identity.messageContentIntent : null,
      inviteUrl: applicationId ? discordInviteUrl(applicationId) : null,
      dmUrl: userId ? discordDmUrl(userId) : null,
      connection,
      updatedAt: this.updatedAt,
      updatedBy: this.updatedBy,
    };
  }

  /**
   * @description Validates a pasted token live, stores it encrypted, and starts the Gateway with it.
   * @param token - The pasted bot token.
   * @param updatedBy - The operator's sub.
   * @returns The state after the Gateway settled (READY, a refusal, or the wait timeout).
   * @throws DiscordTokenValidationError when Discord rejects the token or cannot be reached.
   */
  async connect(token: string, updatedBy: string): Promise<DiscordChannelState> {
    await this.ready();
    const identity = await (this.options.validate ?? validateDiscordBotToken)(token, this.options.identity);
    const saved = await this.store.save(DISCORD_CHANNEL_PROVIDER, token, { ...identity }, updatedBy);
    this.identity = identity;
    this.updatedAt = saved.updatedAt;
    this.updatedBy = saved.updatedBy;
    this.supervisor.start(token, 'database');
    await this.supervisor.settle(SETTLE_TIMEOUT_MS);
    logger.info({ updatedBy, botUserId: identity.botUserId, state: this.supervisor.status().state }, 'Discord bot connected from operator settings');
    return this.describe();
  }

  /**
   * @description Stops the Gateway and forgets the token; the provider stays disabled across boots.
   * @param updatedBy - The operator's sub.
   * @returns The state after the stop.
   */
  async disconnect(updatedBy: string): Promise<DiscordChannelState> {
    await this.ready();
    const saved = await this.store.disable(DISCORD_CHANNEL_PROVIDER, updatedBy);
    this.supervisor.stop();
    this.identity = null;
    this.updatedAt = saved.updatedAt;
    this.updatedBy = saved.updatedBy;
    logger.info({ updatedBy }, 'Discord bot disconnected from operator settings');
    return this.describe();
  }
}
