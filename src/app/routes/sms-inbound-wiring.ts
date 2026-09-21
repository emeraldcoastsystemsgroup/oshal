/**
 * Inbound SMS wiring — the production dependencies behind the caller-scoped inbound sink.
 *
 * `sms-inbound-dispatch.ts` owns the decision (whose message is this, does it reach a swarm) with
 * every collaborator injected, so it can be proven against a real Postgres without a bot node or a
 * Twilio account. This module is the other half: the concrete collaborators. It is kept separate so
 * the heavy app machinery (bot client, inline execution, the connector-backed Twilio operation) is
 * not pulled into that module's specs, and so `server.ts` gains one line rather than a block.
 *
 * The reply leg is the SEC-05 fixed server operation `sendUserTwilioSms` — the credential is
 * decrypted inside it, under the owner's identity, and never enters a model-visible context. A user
 * with no connected Twilio account simply gets no reply (logged); their message still runs.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — createWiredSmsInboundRoutes: ChannelLinkService over the app pool as the identity store, the accountable Jarvis bot as the dispatch, and the per-user fixed Twilio SMS operation as the reply rail.
 *
 * @module sms-inbound-wiring
 */

import type { Router } from 'express';
import { createChildLogger } from '@/shared/logger';
import type { AppContext } from '@/app/composition/app-context';
import { BotNodeClient, createRegistryEndpointResolver } from '@/features/agent-management';
import { ChannelLinkService } from '@/features/chat-channels';
import { executeBotOrInline } from './inline-bot-execution';
import { resolveUserLlmConnection } from './free-tier-rotation';
import { JARVIS_AGENT_ID } from './jarvis-orchestrator';
import { createSmsInboundSink } from './sms-inbound-dispatch';
import { createSmsInboundRoutes } from './sms-inbound-routes';
import { sendUserTwilioSms } from './twilio-sms-operation';

const logger = createChildLogger({ module: 'sms-inbound-wiring' });

const botClient = new BotNodeClient(createRegistryEndpointResolver());

/**
 * @description Build the inbound-SMS router with its production sink: a linked number's text runs
 * on the accountable Jarvis bot as that user, and the answer returns over their own connected
 * Twilio account. Mount at /api/sms — the route still self-guards with the Twilio signature.
 * @param ctx - App context (Postgres pool for the identity store, connectors, and cost capture).
 * @returns The configured router.
 */
export function createWiredSmsInboundRoutes(ctx: AppContext): Router {
  const links = new ChannelLinkService(ctx.pool as never);
  void links.ensureSchema();

  return createSmsInboundRoutes({
    onInboundSms: createSmsInboundSink({
      links,
      /** Runs inside the owner's identity (the sink enters it) — cost lands on their Jarvis turn. */
      async dispatch(userSub, threadKey, text) {
        const byoLlmConnection = await resolveUserLlmConnection(ctx.pool, userSub);
        const result = await executeBotOrInline(ctx, botClient, JARVIS_AGENT_ID, {
          text,
          taskId: threadKey,
          workspaceFolderId: threadKey,
          agentId: JARVIS_AGENT_ID,
          agenticMode: true,
          direct: true,
          userSub,
          byoLlmConnection,
        });
        return String(result.response || '').trim();
      },
      /** The owner's OWN Twilio account carries the answer; no connected account = no reply. */
      async reply(userSub, to, body) {
        const sent = await sendUserTwilioSms(ctx.pool, userSub, to, body);
        if (!sent.delivered) logger.warn({ userSub, error: sent.error }, 'inbound SMS reply not delivered');
        return { delivered: sent.delivered, ...(sent.error ? { error: sent.error } : {}) };
      },
    }),
  });
}
