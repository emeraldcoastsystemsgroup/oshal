/**
 * CHANGE LOG
 * SEQ | AUTHOR | DESCRIPTION
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Serve actual Cockpit and swarm-bot chat modules over isolated synthetic HTTP for inherited-theme persistence regressions.
 */
import express from 'express';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startWorkspaceNavigationFixture } from './workspace-navigation';

/** @description Retain the real chat prepaint, DOM and controller; omit only its unrelated remote icon script. */
function chatRoutes(app: express.Application) {
  const root = process.cwd();
  const html = readFileSync(resolve(root, 'src/pages/swarmbot-chat/index.html'), 'utf8')
    .replace(/<script src="https:\/\/unpkg\.com\/[^\"]+"><\/script>/g, '');
  app.get('/swarmbot/chat', (_req, res) => res.type('html').send(html));
  app.use('/swarmbot/chat', express.static(resolve(root, 'src/pages/swarmbot-chat')));
  app.use('/swarmbot/shared', express.static(resolve(root, 'src/pages/shared')));
  app.use('/chat-assets', express.static(resolve(root, 'src/pages/chat/ui')));
  app.get('/api/agents/fixture-bot/profile', (_req, res) => res.json({ profile: {
    name: 'Synthetic theme bot', providerId: 'auto', themePreference: 'amber', status: 'active' } }));
  app.get('/api/fixture-task/messages', (_req, res) => res.json({ messages: [] }));
  app.get('/api/stream/fixture-task', (_req, res) => res.type('text/event-stream').send('event: fixture\ndata: {}\n\n'));
}

/** @description Start actual shell and actual chat with no authentication service, provider, database or live data.
 * @returns An ephemeral local fixture and explicit cleanup.
 */
export function startWorkspaceChatThemeFixture() { return startWorkspaceNavigationFixture(chatRoutes); }
