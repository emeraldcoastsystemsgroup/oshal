/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from server.ts (1000-line cap decomposition): standalone HTML serving helpers + UI asset / engineering-page directory resolution. Verbatim moves — this module MUST stay flat in src/app/ so the __dirname-relative path candidates keep resolving to the same locations as before.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | /applications opts into guestWelcome: the app-store preview surface welcomes anonymous visitors through the /guest demo landing (?next= deep link back) instead of bouncing them to Google OAuth.
 */

import express from 'express';
import fs from 'fs';
import path from 'path';
import { createChildLogger } from '@/shared/logger';
import type { UiSurfacePageDefinition } from './routes/ui-surface-routes';

const logger = createChildLogger({ module: 'server-ui-assets' });

/**
 * @description Resolves the first existing path from a candidate list.
 * Falls back to the last candidate to preserve deterministic behavior
 * when none exist (useful for logging and predictable failures).
 *
 * @param candidates - Ordered list of absolute paths to probe.
 * @returns First existing path, or the last candidate when no path exists.
 */
export function resolveExistingPath(candidates: string[]): string {
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return candidates[candidates.length - 1];
}

/**
 * @description Reads and sends a standalone HTML file with explicit logging.
 * This avoids opaque sendFile 404s and gives the standalone chat route
 * deterministic behavior in both local and containerized runtime layouts.
 *
 * @param res - Express response object
 * @param filePath - Absolute path to the HTML file
 * @param routePath - Route being served for logging context
 */
export function sendHtmlResponse(res: express.Response, filePath: string, routePath: string): void {
  logger.info({ routePath, filePath }, 'Serving standalone HTML file');

  try {
    const html = fs.readFileSync(filePath, 'utf8');
    // Always serve interactive HTML pages uncached so popup/layout updates appear immediately.
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.type('html').send(html);
  } catch (error) {
    logger.error({ err: error, routePath, filePath }, 'Failed to read standalone HTML file');
    res.status(500).send('Failed to load HTML page');
  }
}

/**
 * @description Reads a UTF-8 text file and returns an empty string when missing.
 * Logs failures but does not throw, so optional patch files can be appended safely.
 *
 * @param filePath - Absolute path to the text file
 * @returns File contents as UTF-8 string or empty string when not available
 */
export function readOptionalTextFile(filePath: string): string {
  try {
    if (!fs.existsSync(filePath)) {
      return '';
    }
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    logger.error({ err: error, filePath }, 'Failed to read optional text file');
    return '';
  }
}

/**
 * @description Resolved filesystem locations for the standalone UI assets server.ts serves
 * (api HTML surfaces, chat standalone bundle, auth patch scripts, fonts, shared CSS).
 */
export interface UiAssetPaths {
  apiDir: string;
  distBundleDir: string;
  chatStandaloneFile: string;
  chatAssetsDir: string;
  uiLogicFile: string;
  uiProviderFieldsFile: string;
  uiProviderModelsFile: string;
  uiOpenAiCodexPatchFile: string;
  uiClaudeCodeAuthPatchFile: string;
  codiconFontsDir: string;
  sharedUiCssDir: string;
  sharedUiJsDir: string;
}

/**
 * @description Resolves every standalone UI asset path server.ts mounts, logging the result
 * for boot diagnostics. App surface HTML (social-workspace, storage, email, presentations,
 * home, …) ships VERBATIM in src/api — it is never compiled into dist/api. A stale/partial
 * dist/api (e.g. a leftover Docker layer holding only the 8 public pages) must NOT win here,
 * or every app surface 404s "Page not found". Resolve the COMPLETE src/api FIRST —
 * `../../src/api` is /app/src/api in the image (`COPY src/api/`) and the repo src/api in dev —
 * and only fall back to the compiled-adjacent dir.
 *
 * @returns Resolved UI asset paths (same resolution order server.ts used inline).
 */
export function resolveUiAssetPaths(): UiAssetPaths {
  const apiDir = resolveExistingPath([
    path.resolve(__dirname, '../../src/api'),
    path.resolve(process.cwd(), 'src/api'),
    path.resolve(__dirname, '../api'),
  ]);
  const distBundleDir = resolveExistingPath([
    path.resolve(__dirname, '../api/dist'),
    path.resolve(process.cwd(), 'src/api/dist'),
  ]);
  const chatStandaloneFile = resolveExistingPath([
    path.resolve(__dirname, '../pages/chat/ui/chat-standalone.html'),
    path.resolve(process.cwd(), 'src/pages/chat/ui/chat-standalone.html'),
    path.resolve(__dirname, '../api/chat-standalone.html'),
    path.resolve(process.cwd(), 'src/api/chat-standalone.html'),
  ]);
  const chatAssetsDir = resolveExistingPath([
    path.resolve(__dirname, '../pages/chat/ui'),
    path.resolve(process.cwd(), 'src/pages/chat/ui'),
  ]);
  const uiLogicFile = resolveExistingPath([
    path.resolve(__dirname, '../api/ui-logic.js'),
    path.resolve(process.cwd(), 'src/api/ui-logic.js'),
  ]);
  // Provider catalog data extracted from ui-logic.js (1000-code-line cap). src/api is not
  // statically mounted, so these MUST be concatenated into GET /ui-logic.js — the pages'
  // single <script src="ui-logic.js"> tag stays the whole delivery contract.
  const uiProviderFieldsFile = resolveExistingPath([
    path.resolve(__dirname, '../api/ui-provider-fields.js'),
    path.resolve(process.cwd(), 'src/api/ui-provider-fields.js'),
  ]);
  const uiProviderModelsFile = resolveExistingPath([
    path.resolve(__dirname, '../api/ui-provider-models.js'),
    path.resolve(process.cwd(), 'src/api/ui-provider-models.js'),
  ]);
  const uiOpenAiCodexPatchFile = resolveExistingPath([
    path.resolve(__dirname, '../api/ui-openai-codex-oauth.mjs'),
    path.resolve(process.cwd(), 'src/api/ui-openai-codex-oauth.mjs'),
  ]);
  const uiClaudeCodeAuthPatchFile = resolveExistingPath([
    path.resolve(__dirname, '../api/ui-claude-code-auth.mjs'),
    path.resolve(process.cwd(), 'src/api/ui-claude-code-auth.mjs'),
  ]);
  // B4: Codicon fonts served from @vscode/codicons npm package instead of legacy any-bot/ui-enhanced
  const codiconFontsDir = resolveExistingPath([
    path.resolve(__dirname, '../../node_modules/@vscode/codicons/dist'),
    path.resolve(process.cwd(), 'node_modules/@vscode/codicons/dist'),
  ]);
  const sharedUiCssDir = resolveExistingPath([
    path.resolve(__dirname, '../shared/ui/css'),
    path.resolve(process.cwd(), 'src/shared/ui/css'),
  ]);
  // Shared surface JS (surface-theme.js) — the theme bootstrap every standalone surface loads.
  const sharedUiJsDir = resolveExistingPath([
    path.resolve(__dirname, '../shared/ui/js'),
    path.resolve(process.cwd(), 'src/shared/ui/js'),
  ]);

  logger.info(
    {
      apiDir,
      distBundleDir,
      chatStandaloneFile,
      chatAssetsDir,
      uiLogicFile,
      uiProviderFieldsFile,
      uiProviderModelsFile,
      uiOpenAiCodexPatchFile,
      uiClaudeCodeAuthPatchFile,
      codiconFontsDir,
      sharedUiCssDir,
      sharedUiJsDir,
    },
    'Resolved UI asset paths',
  );

  return {
    apiDir,
    distBundleDir,
    chatStandaloneFile,
    chatAssetsDir,
    uiLogicFile,
    uiProviderFieldsFile,
    uiProviderModelsFile,
    uiOpenAiCodexPatchFile,
    uiClaudeCodeAuthPatchFile,
    codiconFontsDir,
    sharedUiCssDir,
    sharedUiJsDir,
  };
}

/**
 * @description Resolves the standalone engineering/ops page directories and returns the page
 * definitions server.ts feeds to registerUiSurfaceRoutes — verbatim move of the inline list,
 * preserving the original registration order.
 *
 * @param adminConsoleGuards - Extra route guards mounted after requiresAuth on the /admin
 *   console surface (server.ts passes [requireAdminConsoleAccess()]).
 * @returns Page definitions in the original registration order.
 */
export function resolveUiSurfacePages(adminConsoleGuards: express.RequestHandler[]): UiSurfacePageDefinition[] {
  const taskExplorerDir = resolveExistingPath([path.resolve(__dirname, '../pages/task-explorer'), path.resolve(process.cwd(), 'src/pages/task-explorer')]);
  const configAdminDir = resolveExistingPath([path.resolve(__dirname, '../pages/config-admin'), path.resolve(process.cwd(), 'src/pages/config-admin')]);
  const swarmBotChatDir = resolveExistingPath([path.resolve(__dirname, '../pages/swarmbot-chat'), path.resolve(process.cwd(), 'src/pages/swarmbot-chat')]);
  const healthDashboardDir = resolveExistingPath([path.resolve(__dirname, '../pages/health-dashboard'), path.resolve(process.cwd(), 'src/pages/health-dashboard')]);
  const redisVisibilityDir = resolveExistingPath([path.resolve(__dirname, '../pages/redis-visibility'), path.resolve(process.cwd(), 'src/pages/redis-visibility')]);
  const queueDashboardDir = resolveExistingPath([path.resolve(__dirname, '../pages/queue-dashboard'), path.resolve(process.cwd(), 'src/pages/queue-dashboard')]);
  const queueManagerAdminDir = resolveExistingPath([path.resolve(__dirname, '../pages/queue-manager-admin'), path.resolve(process.cwd(), 'src/pages/queue-manager-admin')]);
  const meshDashboardDir = resolveExistingPath([path.resolve(__dirname, '../pages/mesh-dashboard'), path.resolve(process.cwd(), 'src/pages/mesh-dashboard')]);
  const opsDashboardDir = resolveExistingPath([path.resolve(__dirname, '../pages/ops-dashboard'), path.resolve(process.cwd(), 'src/pages/ops-dashboard')]);
  const userDashboardDir = resolveExistingPath([path.resolve(__dirname, '../pages/user-dashboard'), path.resolve(process.cwd(), 'src/pages/user-dashboard')]);
  const ragCenterDir = resolveExistingPath([path.resolve(__dirname, '../pages/rag-center'), path.resolve(process.cwd(), 'src/pages/rag-center')]);
  const swarmControlDir = resolveExistingPath([path.resolve(__dirname, '../pages/swarm-control'), path.resolve(process.cwd(), 'src/pages/swarm-control')]);
  const havenDir = resolveExistingPath([path.resolve(__dirname, '../pages/haven'), path.resolve(process.cwd(), 'src/pages/haven')]);
  const processLabDir = resolveExistingPath([path.resolve(__dirname, '../pages/process-lab'), path.resolve(process.cwd(), 'src/pages/process-lab')]);
  const workflowStudioDir = resolveExistingPath([path.resolve(__dirname, '../pages/workflow-studio'), path.resolve(process.cwd(), 'src/pages/workflow-studio')]);
  const applicationsDir = resolveExistingPath([path.resolve(__dirname, '../pages/applications'), path.resolve(process.cwd(), 'src/pages/applications')]);
  const intelligentProcessingDir = resolveExistingPath([path.resolve(__dirname, '../pages/intelligent-processing'), path.resolve(process.cwd(), 'src/pages/intelligent-processing')]);
  const feedsPageDir = resolveExistingPath([path.resolve(__dirname, '../pages/feeds'), path.resolve(process.cwd(), 'src/pages/feeds')]);
  const governancePageDir = resolveExistingPath([path.resolve(__dirname, '../pages/governance'), path.resolve(process.cwd(), 'src/pages/governance')]);
  const evalWallPageDir = resolveExistingPath([path.resolve(__dirname, '../pages/eval-wall'), path.resolve(process.cwd(), 'src/pages/eval-wall')]);
  const adminConsoleDir = resolveExistingPath([path.resolve(__dirname, '../pages/admin'), path.resolve(process.cwd(), 'src/pages/admin')]);
  const pumpkinDir = resolveExistingPath([path.resolve(__dirname, '../pages/pumpkin'), path.resolve(process.cwd(), 'src/pages/pumpkin')]);

  return [
    { routePath: '/task-explorer', pageDir: taskExplorerDir },
    { routePath: '/config', pageDir: configAdminDir },
    { routePath: '/swarmbot/chat', pageDir: swarmBotChatDir },
    { routePath: '/health-dashboard', pageDir: healthDashboardDir },
    { routePath: '/redis-visibility', pageDir: redisVisibilityDir },
    { routePath: '/queue-dashboard', pageDir: queueDashboardDir },
    { routePath: '/queue-manager-admin', pageDir: queueManagerAdminDir },
    { routePath: '/mesh-dashboard', pageDir: meshDashboardDir },
    { routePath: '/ops-dashboard', pageDir: opsDashboardDir },
    { routePath: '/user-dashboard', pageDir: userDashboardDir },
    { routePath: '/rag-center', pageDir: ragCenterDir },
    { routePath: '/swarm-control', pageDir: swarmControlDir },
    { routePath: '/haven', pageDir: havenDir },
    { routePath: '/process-lab', pageDir: processLabDir },
    { routePath: '/workflow-studio', pageDir: workflowStudioDir },
    // App-store preview: anonymous visitors are welcomed through /guest (demo login)
    // instead of bounced to Google OAuth — the page doubles as the public catalog.
    { routePath: '/applications', pageDir: applicationsDir, guestWelcome: true },
    { routePath: '/intelligent-processing', pageDir: intelligentProcessingDir },
    { routePath: '/feeds', pageDir: feedsPageDir },
    { routePath: '/slack', pageDir: feedsPageDir },
    { routePath: '/governance', pageDir: governancePageDir },
    { routePath: '/eval-wall', pageDir: evalWallPageDir },
    { routePath: '/admin', pageDir: adminConsoleDir, extraGuards: adminConsoleGuards },
    // Pumpkin projector — the full-screen jack-o'-lantern display for the Halloween prop (?app=pumpkin).
    { routePath: '/pumpkin', pageDir: pumpkinDir },
  ];
}
