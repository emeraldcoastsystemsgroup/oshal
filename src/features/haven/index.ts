/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Created the haven feature barrel (FSD deep-import burn-down): surfaces the Haven persona service and the home-context service consumers were reaching via deep paths.
 */

/**
 * @description Public surface for the haven feature slice (Jarvis / home model).
 */

export { HavenPersonaService, type HavenChatMessage } from './haven-persona-service';
export { HomeContextService, HAVEN_DEFAULT_HOUSEHOLD_ID } from './home-context-service';
