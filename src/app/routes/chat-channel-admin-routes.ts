/**
 * Chat-channel operator routes — configure the deployment's Discord bot from the cockpit.
 *
 * Mounted at /api/channels/admin behind requiresAuth AND requiresOperator (the canonical gate in
 * @/shared/middleware/authz), so an anonymous caller gets 401 and a signed-in non-operator 403
 * before any handler runs. The token arrives in a POST body, is validated live against Discord,
 * stored encrypted with the connector-token cipher, and handed to the in-process Gateway; it is
 * never echoed in a response, a log line or an error message.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — GET (state), POST (validate + save + start) and DELETE (stop + forget) for the Discord bot, operator-only. Tonight's setup needed an .env edit, an api recreate and hand SQL; this is the one-card replacement. Errors are specific and machine-readable: token_required, token_malformed, token_invalid, discord_unreachable, plus the Gateway's own intent_missing / token_invalid problem in the state readback.
 *
 * @module chat-channel-admin-routes
 */

import { Router, type Request, type Response } from 'express';
import { createChildLogger } from '@/shared/logger';
import { getCaller } from '@/shared/middleware/authz';
import { encryptToken, decryptToken } from './connector-token-crypto';
import { DiscordTokenValidationError, type DiscordChannelConfig, type ProviderSecretCipher } from '@/features/chat-channels';

const logger = createChildLogger({ module: 'chat-channel-admin-routes' });

/** Minimal pool surface the cipher needs. */
interface QueryablePool {
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/**
 * @description The at-rest cipher for provider secrets: the SAME connector-token helper every
 * connector credential goes through, in its shared (deployment-level) key mode, because a
 * provider bot token belongs to the deployment rather than to one user.
 * @param pool - The app pool (unused by the shared-key path but required by the helper's contract).
 * @returns The cipher the settings store encrypts and decrypts with.
 */
export function createChannelSecretCipher(pool: QueryablePool): ProviderSecretCipher {
  return {
    encrypt: (plain) => encryptToken(pool, undefined, plain),
    decrypt: (blob) => decryptToken(pool, undefined, blob),
  };
}

/** A pasted token, or the reason it cannot even be sent to Discord. */
function readToken(body: unknown): { token: string } | { error: 'token_required' | 'token_malformed'; message: string } {
  const raw = (body as { token?: unknown } | null)?.token;
  const token = typeof raw === 'string' ? raw.trim() : '';
  if (!token) return { error: 'token_required', message: 'Paste the bot token from the Discord Developer Portal (Bot → Reset Token).' };
  if (!/^[A-Za-z0-9._-]{20,256}$/.test(token)) {
    return { error: 'token_malformed', message: 'That does not look like a Discord bot token. Copy the whole token from Bot → Reset Token; it has no spaces.' };
  }
  return { token };
}

/** Maps a validation failure to its status; anything else is a 500 with a generic message. */
function answerFailure(res: Response, err: unknown, what: string): void {
  if (err instanceof DiscordTokenValidationError) {
    logger.warn({ code: err.code }, `Discord ${what} refused`);
    res.status(err.code === 'token_invalid' ? 422 : 502).json({ error: err.code, message: err.message });
    return;
  }
  logger.error({ err, stack: (err as Error).stack }, `Discord ${what} failed`);
  res.status(500).json({ error: 'discord_setup_failed', message: 'The Discord bot could not be configured. Check the api log.' });
}

/**
 * @description Builds the operator router for the Discord bot. The caller mounts it behind the
 * auth and operator gates; nothing here re-checks them, so never mount it bare.
 * @param discord - The Discord configuration this deployment runs on.
 * @returns The configured Express router.
 */
export function createChatChannelAdminRoutes(discord: DiscordChannelConfig): Router {
  const router = Router();

  // GET /discord — configured/connected state, the bot's name, invite + DM links, any problem.
  // Waits for the boot precedence so the first read after an api start is the truth, not a blank.
  router.get('/discord', async (_req: Request, res: Response) => {
    await discord.ready();
    res.json(discord.describe());
  });

  // POST /discord { token } — validate live, store encrypted, start the Gateway now.
  router.post('/discord', async (req: Request, res: Response) => {
    const read = readToken(req.body);
    if ('error' in read) { res.status(400).json({ error: read.error, message: read.message }); return; }
    const operator = getCaller(req).sub ?? 'operator';
    try {
      const state = await discord.connect(read.token, operator);
      logger.info({ operator, state: state.connection.state, problem: state.connection.problem }, 'Discord bot saved from the cockpit');
      res.json(state);
    } catch (err) {
      answerFailure(res, err, 'token save');
    }
  });

  // DELETE /discord — stop the Gateway and forget the token (stays off across boots).
  router.delete('/discord', async (req: Request, res: Response) => {
    const operator = getCaller(req).sub ?? 'operator';
    try {
      res.json(await discord.disconnect(operator));
    } catch (err) {
      answerFailure(res, err, 'disconnect');
    }
  });

  return router;
}
