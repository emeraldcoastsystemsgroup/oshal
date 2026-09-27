/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — live validation of a pasted Discord bot token before it is stored: GET /users/@me names the bot user, GET /oauth2/applications/@me names the application and carries the flags that say whether the Message Content privileged intent is switched on in the Developer Portal. An operator therefore learns "token invalid" or "intent off" at paste time, in the cockpit, instead of from a Gateway close code in a container log. Also the two URLs the cockpit hands a person: the "add the bot to your server" invite built from the application id, and the direct DM link built from the bot user id.
 */

import { createChildLogger } from '@/shared/logger';
import { DISCORD_API_BASE } from './discord-channel-adapter';

const logger = createChildLogger({ module: 'discord-bot-identity' });

/** Application flag: the Message Content privileged intent is granted (verified apps). */
export const DISCORD_FLAG_MESSAGE_CONTENT = 1 << 18;
/** Application flag: the Message Content intent is switched on for an unverified app (<100 servers). */
export const DISCORD_FLAG_MESSAGE_CONTENT_LIMITED = 1 << 19;
/** The permission set the invite asks for: Send Messages only. A DM needs nothing more. */
export const DISCORD_INVITE_PERMISSIONS = 2048;

/** What Discord reported for a bot token. Nothing here is secret; it is shown in the cockpit. */
export interface DiscordBotIdentity {
  botUserId: string;
  botUsername: string;
  applicationId: string;
  applicationName: string;
  /** True when either Message Content flag is set on the application. */
  messageContentIntent: boolean;
}

/** Why a token could not be validated: the token itself, or Discord could not be reached. */
export type DiscordTokenValidationCode = 'token_invalid' | 'discord_unreachable';

/** A validation failure with a machine-readable code the route maps to a status. */
export class DiscordTokenValidationError extends Error {
  readonly code: DiscordTokenValidationCode;
  constructor(code: DiscordTokenValidationCode, message: string) {
    super(message);
    this.name = 'DiscordTokenValidationError';
    this.code = code;
  }
}

/** The seams a spec replaces: the API base (a local fake Discord) and fetch. */
export interface DiscordIdentityOptions {
  apiBase?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** One authenticated GET against the Discord API; a 401/403 means the token is not a bot token. */
async function discordGet(path: string, token: string, options: DiscordIdentityOptions): Promise<Record<string, unknown>> {
  const base = (options.apiBase ?? DISCORD_API_BASE).replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${base}${path}`, {
      headers: { Authorization: `Bot ${token}` },
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    });
  } catch (err) {
    logger.error({ err, stack: (err as Error).stack, path }, 'Discord API unreachable while validating a bot token');
    throw new DiscordTokenValidationError('discord_unreachable', `Discord could not be reached (${path}).`);
  }
  if (response.status === 401 || response.status === 403) {
    logger.warn({ path, status: response.status }, 'Discord rejected the bot token');
    throw new DiscordTokenValidationError('token_invalid', 'Discord rejected this token. Reset the token under Bot in the Developer Portal and paste the new one.');
  }
  if (!response.ok) {
    logger.error({ path, status: response.status }, 'Discord API answered an unexpected status while validating a bot token');
    throw new DiscordTokenValidationError('discord_unreachable', `Discord answered HTTP ${response.status} (${path}).`);
  }
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object') {
    throw new DiscordTokenValidationError('discord_unreachable', `Discord answered without a JSON body (${path}).`);
  }
  return body;
}

/** A Discord snowflake as Discord returns it, or an empty string when the field is missing. */
function snowflake(value: unknown): string {
  return typeof value === 'string' && /^\d{5,30}$/.test(value.trim()) ? value.trim() : '';
}

/**
 * @description Validates a Discord bot token live against Discord and describes the bot it
 * belongs to. The token is used only as the Authorization header of the two reads and is never
 * logged or returned.
 * @param token - The pasted bot token.
 * @param options - API base / fetch seams for a local fake Discord.
 * @returns The bot user, its application, and whether the Message Content intent is on.
 * @throws DiscordTokenValidationError with `token_invalid` or `discord_unreachable`.
 */
export async function validateDiscordBotToken(token: string, options: DiscordIdentityOptions = {}): Promise<DiscordBotIdentity> {
  const me = await discordGet('/users/@me', token, options);
  const botUserId = snowflake(me.id);
  if (!botUserId || me.bot !== true) {
    logger.warn('the token authenticated a Discord account that is not a bot user');
    throw new DiscordTokenValidationError('token_invalid', 'This token does not belong to a Discord bot user. Copy the token from Bot → Reset Token, not from OAuth2.');
  }
  const app = await discordGet('/oauth2/applications/@me', token, options);
  const applicationId = snowflake(app.id);
  if (!applicationId) {
    throw new DiscordTokenValidationError('discord_unreachable', 'Discord did not report an application id for this bot.');
  }
  const flags = Number(app.flags ?? 0);
  const identity: DiscordBotIdentity = {
    botUserId,
    botUsername: typeof me.username === 'string' && me.username.trim() ? me.username.trim() : `bot-${botUserId}`,
    applicationId,
    applicationName: typeof app.name === 'string' && app.name.trim() ? app.name.trim() : '',
    messageContentIntent: Number.isFinite(flags) && (flags & (DISCORD_FLAG_MESSAGE_CONTENT | DISCORD_FLAG_MESSAGE_CONTENT_LIMITED)) !== 0,
  };
  logger.info({ botUserId, applicationId, messageContentIntent: identity.messageContentIntent }, 'Discord bot token validated');
  return identity;
}

/**
 * @description The "Add the bot to your server" URL for an application: the OAuth2 bot scope with
 * Send Messages only. A person who only wants DMs does not need to add the bot anywhere, but the
 * invite is the one-click way to make the bot visible in their Discord.
 * @param applicationId - The Discord application id reported for the token.
 * @returns The invite URL.
 */
export function discordInviteUrl(applicationId: string): string {
  return `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(applicationId)}&permissions=${DISCORD_INVITE_PERMISSIONS}&scope=bot`;
}

/**
 * @description The direct link that opens the bot's profile in Discord, from which "Message" opens
 * the DM the link code is sent in.
 * @param botUserId - The bot's user id.
 * @returns The profile URL.
 */
export function discordDmUrl(botUserId: string): string {
  return `https://discord.com/users/${encodeURIComponent(botUserId)}`;
}
