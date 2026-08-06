/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted import-safe bot-node Claude Code auth target routes and placed both status and import behind strict machine authentication without exposing host credential paths.
 */

import { existsSync } from 'node:fs';
import type { Application, RequestHandler } from 'express';
import { authorizeBotNodeInternalCall } from './bot-node-request-auth';

export interface BotNodeClaudeAuthRouteOptions {
  agentId: string;
  botName: string;
  authorize?: RequestHandler;
  oauthFilePath?: string;
  fileExists?: (filePath: string) => boolean;
}

/**
 * @description Register the machine-only Claude Code credential propagation targets used by
 * the controller. The import endpoint is deliberately a read-only mount acknowledgement;
 * neither response reveals the host/container credential path.
 * @param app - Express application receiving the two target routes.
 * @param options - Runtime identity, strict authorizer, and import-safe filesystem seams.
 */
export function registerBotNodeClaudeAuthRoutes(
  app: Application,
  options: BotNodeClaudeAuthRouteOptions,
): void {
  const authorize = options.authorize ?? authorizeBotNodeInternalCall;
  const oauthFilePath = options.oauthFilePath ?? '/root/.claude/.credentials.json';
  const fileExists = options.fileExists ?? ((filePath: string) => {
    try { return existsSync(filePath); } catch { return false; }
  });
  const oauthFileExists = (): boolean => fileExists(oauthFilePath);

  app.get('/api/claude-code/auth/status', authorize, (_req, res) => {
    const present = oauthFileExists();
    res.json({
      success: true,
      authenticated: present,
      source: present ? 'mounted-oauth-file' : 'none',
      botName: options.botName,
      agentId: options.agentId,
    });
  });

  app.post('/api/claude-code/auth/import', authorize, (_req, res) => {
    res.json({
      success: true,
      imported: false,
      reason: 'OAuth file is mounted read-only; propagation is a no-op on this bot node',
      filePresent: oauthFileExists(),
    });
  });
}
