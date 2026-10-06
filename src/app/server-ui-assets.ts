/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from server.ts (1000-line cap decomposition): standalone HTML serving helpers + UI asset / engineering-page directory resolution. Verbatim moves — this module MUST stay flat in src/app/ so the __dirname-relative path candidates keep resolving to the same locations as before.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | /applications opts into guestWelcome: the app-store preview surface welcomes anonymous visitors through the /guest demo landing (?next= deep link back) instead of bouncing them to Google OAuth.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | ADR-148: register the /users swarm access-management surface. requiresAuth only, deliberately — the page is where a signed-in user learns they are NOT an admin, and where the first person on a virgin swarm claims root before any operator exists; the privileged reads and every write are fenced by requiresOperator inside /api/swarm/roles.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Registered the /data-model page (data-model explorer). requiresAuth only at the page, like /users and /app-loader: a non-operator gets the explanatory screen, and every read is fenced by requiresOperator on /api/admin/data-model.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Registered the /access-review page - the joined read-only answer to "what am I allowed to do". requiresAuth only, like /users: the whole point is that a person who cannot open something can see WHY without being an administrator, and naming somebody else's subject is fenced inside /api/access-review.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | ADR-174 Amendment B (B4, step B5-2): register the /swarm-admin surface, the home of the Swarm Admin screens, guarded by the operator role (requiresOperator, Amendment A1) after requiresAuth, so users get 403 and never see it while an operator sees it beside their ordinary screens. The guard is fixed here (no parameter a caller could weaken), so server.ts, at its line cap, does not change. The leaf directory is named like the route, so no asset alias is mounted.
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | ADR-174 Amendment B (B4, step B5-3): register /swarm-admin/ai-defaults, the AI defaults screen, under the same operator-role guard as the Swarm Admin home. Its leaf directory is named like the route, so no asset alias is mounted; as a nested route it also gives the standalone pages a /swarm-admin/shared mount of the shared helpers, behind requiresAuth like the others.
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | ADR-174 Amendment B (step B5-4): register /swarm-admin/logins, the swarm logins screen, under the same operator-role guard as the other Swarm Admin pages.
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | ADR-174 Amendment B (step B5-5): register /swarm-admin/budgets, the budgets screen, under the same operator-role guard as the other Swarm Admin pages.
 * 10 | maintainer@emeraldcoastsystemsgroup.com   | ADR-174 Amendment B (step B5-5): register /swarm-admin/connectors, the connectors screen, under the same operator-role guard as the other Swarm Admin pages.
 * 11 | maintainer@emeraldcoastsystemsgroup.com   | ADR-174 Amendment B (step B5-6): register /swarm-admin/knowledge, the shared-knowledge screen, under the same operator-role guard as the other Swarm Admin pages.
 * 12 | maintainer@emeraldcoastsystemsgroup.com   | ADR-174 Amendment B (step B5-7): register /swarm-admin/devices, the devices screen, under the same operator-role guard as the other Swarm Admin pages.
 * 13 | maintainer@emeraldcoastsystemsgroup.com   | ADR-174 Amendment B (step B5-8): register /swarm-admin/households, the households screen, under the same operator-role guard as the other Swarm Admin pages.
 */

import express from 'express';
import { requiresOperator } from '@/shared/middleware/authz';
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
  const usersDir = resolveExistingPath([path.resolve(__dirname, '../pages/users'), path.resolve(process.cwd(), 'src/pages/users')]);
  const appLoaderDir = resolveExistingPath([path.resolve(__dirname, '../pages/app-loader'), path.resolve(process.cwd(), 'src/pages/app-loader')]);
  const pumpkinDir = resolveExistingPath([path.resolve(__dirname, '../pages/pumpkin'), path.resolve(process.cwd(), 'src/pages/pumpkin')]);
  const dataModelDir = resolveExistingPath([path.resolve(__dirname, '../pages/data-model'), path.resolve(process.cwd(), 'src/pages/data-model')]);
  const accessReviewDir = resolveExistingPath([path.resolve(__dirname, '../pages/access-review'), path.resolve(process.cwd(), 'src/pages/access-review')]);
  const swarmAdminDir = resolveExistingPath([path.resolve(__dirname, '../pages/swarm-admin'), path.resolve(process.cwd(), 'src/pages/swarm-admin')]);
  const swarmAdminAiDefaultsDir = resolveExistingPath([path.resolve(__dirname, '../pages/swarm-admin/ai-defaults'), path.resolve(process.cwd(), 'src/pages/swarm-admin/ai-defaults')]);
  const swarmAdminLoginsDir = resolveExistingPath([path.resolve(__dirname, '../pages/swarm-admin/logins'), path.resolve(process.cwd(), 'src/pages/swarm-admin/logins')]);
  const swarmAdminBudgetsDir = resolveExistingPath([path.resolve(__dirname, '../pages/swarm-admin/budgets'), path.resolve(process.cwd(), 'src/pages/swarm-admin/budgets')]);
  const swarmAdminConnectorsDir = resolveExistingPath([path.resolve(__dirname, '../pages/swarm-admin/connectors'), path.resolve(process.cwd(), 'src/pages/swarm-admin/connectors')]);
  const swarmAdminKnowledgeDir = resolveExistingPath([path.resolve(__dirname, '../pages/swarm-admin/knowledge'), path.resolve(process.cwd(), 'src/pages/swarm-admin/knowledge')]);
  const swarmAdminDevicesDir = resolveExistingPath([path.resolve(__dirname, '../pages/swarm-admin/devices'), path.resolve(process.cwd(), 'src/pages/swarm-admin/devices')]);
  const swarmAdminHouseholdsDir = resolveExistingPath([path.resolve(__dirname, '../pages/swarm-admin/households'), path.resolve(process.cwd(), 'src/pages/swarm-admin/households')]);

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
    // ADR-148 swarm access management. requiresAuth only — the PAGE is readable by any signed-in
    // user because it is where somebody learns they are NOT an admin (and, on a virgin swarm,
    // where the first person claims root before any operator exists). Every privileged read and
    // every write is gated by requiresOperator inside /api/swarm/roles, which is the real fence.
    { routePath: '/users', pageDir: usersDir },
    // ADR-147 App Loader — install packages from any git registry. requiresAuth only at the page
    // level so a non-admin gets an explanatory screen rather than a bare 403; every registry read
    // and every install is fenced by requiresOperator inside /api/swarm/registries. Deliberately
    // NO guestWelcome mat: browsing a catalog is harmless, installing code is not.
    { routePath: '/app-loader', pageDir: appLoaderDir },
    // Data-model explorer. requiresAuth only at the page level so a non-admin sees why the data is
    // withheld; every read is fenced by requiresOperator on /api/admin/data-model.
    { routePath: '/data-model', pageDir: dataModelDir },
    // Access review — the one place that answers "what am I allowed to do". requiresAuth only, for
    // the same reason as /users: a person who cannot open something has to be able to see why.
    // Naming another subject is admin-only inside /api/access-review, which is the real fence.
    { routePath: '/access-review', pageDir: accessReviewDir },
    // Pumpkin projector — the full-screen jack-o'-lantern display for the Halloween prop (?app=pumpkin).
    { routePath: '/pumpkin', pageDir: pumpkinDir },
    // ADR-174 Amendment B: the Swarm Admin home. Operator role only; users get 403 and no link.
    { routePath: '/swarm-admin', pageDir: swarmAdminDir, extraGuards: [requiresOperator] },
    { routePath: '/swarm-admin/ai-defaults', pageDir: swarmAdminAiDefaultsDir, extraGuards: [requiresOperator] },
    { routePath: '/swarm-admin/logins', pageDir: swarmAdminLoginsDir, extraGuards: [requiresOperator] },
    { routePath: '/swarm-admin/budgets', pageDir: swarmAdminBudgetsDir, extraGuards: [requiresOperator] },
    { routePath: '/swarm-admin/connectors', pageDir: swarmAdminConnectorsDir, extraGuards: [requiresOperator] },
    { routePath: '/swarm-admin/knowledge', pageDir: swarmAdminKnowledgeDir, extraGuards: [requiresOperator] },
    { routePath: '/swarm-admin/devices', pageDir: swarmAdminDevicesDir, extraGuards: [requiresOperator] },
    { routePath: '/swarm-admin/households', pageDir: swarmAdminHouseholdsDir, extraGuards: [requiresOperator] },
  ];
}
