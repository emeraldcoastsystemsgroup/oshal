/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Controller-side registry of composed bot personas for protected node turns. A protected direct turn (direct:true, agenticMode:false) on a bot node receives no persona of its own: the node's direct path sends a generic system prompt, so a package bot such as the Scene Studio director answered without its identity or voice. swarm-apps activation composes each bot's persona from its owning package (identity, personality, screened perspective) and registers it here keyed by application then agentId; BotNodeClient reads it when it prepares a protected dispatch and puts it inside the signed body. Lives in shared/ so the writer (features/swarm-apps) and the reader (features/agent-management) reach it top-down, the same shape as skill-profiles. The node never holds this registry.
 */

import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'protected-bot-personas' });

/**
 * @description Upper bound, in UTF-8 bytes, of one composed bot persona. The controller refuses to
 * register a longer persona and the node refuses a longer carrier, so the bound is the same on both
 * sides of the signed hop. It is a hard refusal, never a truncation: a cut persona could end inside
 * a sentence that changes its meaning.
 */
export const MAX_BOT_PERSONA_BYTES = 16_384;

/**
 * @description The trusted-configuration source label the node files a carried persona under,
 * rendered as `[trusted-config source="bot-persona"]` in the TRUSTED CONFIGURATION section.
 */
export const BOT_PERSONA_TRUSTED_SOURCE = 'bot-persona';

/**
 * Keyed by application so a re-activation replaces the whole set and a deactivation drops it in one
 * delete. The inner key is the agentId, so the same agentId declared by two applications resolves to
 * each application's own text: the protected binding names the application that owns the dispatch.
 */
const BY_APP = new Map<string, ReadonlyMap<string, string>>();

/**
 * @description Register (or replace) one application's composed bot personas. Called from
 * swarm-app activation after the personas were composed and validated. An empty map retracts the
 * application's entry, so a reload that removes every persona leaves nothing stale behind. Only
 * agentIds are logged: the persona text is prompt content and never enters a log line.
 * @param app - The installed application name (the protected binding's `app`).
 * @param personas - agentId to composed persona text.
 * @returns Nothing; the registry is updated in place.
 */
export function registerAppBotPersonas(app: string, personas: ReadonlyMap<string, string>): void {
  if (personas.size === 0) {
    unregisterAppBotPersonas(app);
    return;
  }
  BY_APP.set(app, new Map(personas));
  logger.info({ app, agentIds: [...personas.keys()] }, 'Registered app bot personas');
}

/**
 * @description Retract one application's bot personas (deactivate, uninstall, failed composition).
 * Idempotent: an application that never registered one is a no-op.
 * @param app - The application whose personas to drop.
 * @returns Nothing; the registry is updated in place.
 */
export function unregisterAppBotPersonas(app: string): void {
  if (BY_APP.delete(app)) logger.info({ app }, 'Retracted app bot personas');
}

/**
 * @description The composed persona of one bot within the application that owns a protected
 * dispatch. The caller passes the application and agentId of the controller's own prepared binding,
 * never a value from the request, so a request cannot select another application's persona.
 * @param app - The owning application from the prepared protected binding.
 * @param agentId - The target bot from the same binding.
 * @returns The persona text, or null when the application registered none for that bot.
 */
export function resolveBotPersonaByApp(app: string, agentId: string): string | null {
  return BY_APP.get(app)?.get(agentId) ?? null;
}
