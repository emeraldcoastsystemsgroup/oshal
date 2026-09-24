/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from server.ts (BACKLOG #1788): auxiliary route groups (public/legacy auth aliases, provider OAuth/auth routes, core ticketing routes, ops telemetry routes, and system onboarding/health/preset/haven routes) preserving exact registration order.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added decomposed route groups (UI documents, providers & connectors, devops & judge, budgets & queues, content & assistant, observability & voice, agent directory, governance, and workflow studio) to satisfy decomposition threshold (<800 lines).
 * -----------------------------------------------------------------------------
 */

import express from 'express';
import path from 'path';
import type { AppContext } from './composition/app-context';
import { sendHtmlResponse } from './server-ui-assets';
import {
  extractQueryString,
  isLikelyOpenAiCodexCallback,
  redirectLegacyAuthRoute,
} from './server-auth-helpers';
import {
  createOpenAiCodexOAuthRoutes,
  createClaudeCodeAuthRoutes,
  createGeminiAuthRoutes,
  createAntigravityAuthRoutes,
  createFacebookAuthRoutes,
} from './routes';
import {
  createCheckpointRoutes,
  createOptimizeRoutes,
  createTokenChaseRoutes,
  createMemoryRoutes,
  createHelpRoutes,
  createTicketRoutes,
  createWorkspaceRoutes,
  createCockpitRoutes,
  createTaskExplorerRoutes,
} from './routes';
import { createIntakeAssistantRoutes } from './routes/intake-assistant-routes';
import { createRefusalRoutes } from './routes/refusal-routes';
import { createProviderRoutes } from './routes/provider-routes';
import { createByoLlmRoutes } from './routes/byo-llm-routes';
import { createFreeTierRoutes } from './routes/free-tier-routes';
import { createLlmPreferenceRoutes } from './routes/llm-preference-routes';
import { startFallbackReadinessLoop } from './routes/fallback-rail-readiness';
import { resolveHotFallbackChain } from './routes/byo-hot-fallback';
import { connectorCallbackAuth, createConnectorsRoutes, createFacebookDataDeletionRoute } from './routes/connectors-routes';
import { createConnectorLivenessRoutes } from './routes/connector-liveness';
import { createSlackRoutes } from './routes/slack-routes';
import { createTenantRoutes } from './routes/tenant-routes';
import { createDevopsRoutes } from './routes/devops-routes';
import { createForgeRoutes } from './routes/forge-routes';
import { createJudgeRoutes } from './routes/judge-routes';
import { createBudgetRoutes } from './routes/budget-routes';
import { registerA2aGatewayRoutes } from './routes/a2a-routes';
import { createTraceRoutes } from './routes/trace-routes';
import { createQueueDlqRoutes } from './routes/queue-dlq-routes';
import { createNotifyRoutes } from './routes/notify-routes';
import { createContentRoutes } from './routes/content-routes';
import { createLinkedInAssistantRoutes } from './routes/linkedin-assistant-routes';
import { createConfigRoutes } from './routes/config-routes';
import { createLogsRoutes } from './routes/logs-routes';
import { registerSwarmExtensionRoutes } from '@/app/extensions';
import { createTaskRoutes } from './routes/task-routes';
import { createStreamRoutes } from './routes/stream-routes';
import { createVoiceRoutes } from './routes/voice-routes';
import { createVerificationRoutes } from './routes/verification-routes';
import { createAgentProfileRoutes } from './routes/agent-profile-routes';
import { createAgentToolRoutes } from './routes/agent-tool-routes';
import { createAgentStatusRoutes } from './routes/agent-status-routes';
import { registerAuditExportRoutes } from './routes/audit-export-routes';
import { registerDataLifecycleRoutes } from './routes/data-lifecycle-routes';
import { registerLlmGovernanceRoutes } from './routes/llm-governance-routes';
import { createPrivacyRoutes } from './routes/privacy-routes';
import { createRcaRoutes } from './routes/rca-routes';
import { createProcessLabRoutes } from './routes/process-lab-routes';
import { createWorkflowStudioRoutes } from './routes/workflow-studio-routes';
import { createWorkflowStudioAssistRoutes } from './routes/workflow-studio-assist-routes';
import { createWorkflowRunRoutes } from './routes/workflow-run-routes';
import { createBatchJobTelemetryRoutes } from './routes/batch-job-telemetry-routes';

/**
 * @description Mounts public marketing pages and legacy authentication redirect routes.
 */
export function mountPublicAndLegacyAuthRoutes(
  app: express.Application,
  apiDir: string,
  ctx: AppContext,
  logger: any,
): void {
  // Facebook OAuth callback alias — the FB app registers /auth/facebook/callback;
  // forward (preserving ?code&state) to the connectors handler that exchanges + stores.
  app.get('/auth/facebook/callback', (req, res) => {
    const qs = req.originalUrl.split('?')[1] || '';
    res.redirect(302, `/api/connect/facebook/callback${qs ? `?${qs}` : ''}`);
  });

  // Facebook Data Deletion Request callback (Meta requirement) — ungated, FB calls it.
  const fbDelete = createFacebookDataDeletionRoute(ctx);
  app.post('/auth/facebook/data-deletion', express.urlencoded({ extended: false }), fbDelete.post);
  app.get('/auth/facebook/data-deletion', fbDelete.page);

  // Public legal pages (required by Meta + other OAuth providers).
  app.get('/privacy', (_req, res) => res.sendFile(path.join(apiDir, 'privacy.html')));
  app.get('/terms', (_req, res) => res.sendFile(path.join(apiDir, 'terms.html')));

  // Public, surface-level technology explainer for the website (ungated marketing page).
  const serveTechnology = (_req: express.Request, res: express.Response) =>
    res.sendFile(path.join(apiDir, 'technology.html'));
  app.get('/technology', serveTechnology);
  app.get('/how-it-works', serveTechnology);

  // Legacy auth aliases for old UI pages still using /auth/login|logout|callback
  app.get('/auth/login', (req, res) => redirectLegacyAuthRoute(req, res, '/login'));
  app.get('/auth/logout', (req, res) => redirectLegacyAuthRoute(req, res, '/logout'));
  app.get('/auth/callback', (req, res) => {
    if (isLikelyOpenAiCodexCallback(req)) {
      const redirectTo = `/api/openai-codex/oauth/callback${extractQueryString(req.originalUrl)}`;
      logger.info({ legacyPath: req.originalUrl, redirectTo }, 'Routing /auth/callback to OpenAI Codex callback handler');
      res.redirect(302, redirectTo);
      return;
    }

    redirectLegacyAuthRoute(req, res, '/callback');
  });
}

/**
 * @description Mounts primary authenticated UI HTML document surfaces and their static assets.
 */
export function mountMainUiDocumentRoutes(
  app: express.Application,
  requiresAuth: express.RequestHandler,
  surfaceOnboardingGuard: express.RequestHandler,
  chatStandaloneFile: string,
  chatAssetsDir: string,
  apiDir: string,
  logger: any,
): void {
  app.get('/chat.html', requiresAuth, (req, res) => {
    logger.info('GET /chat.html (authenticated) - redirecting to /chat');
    res.redirect(302, '/chat');
  });

  app.get('/chat', requiresAuth, surfaceOnboardingGuard, (req, res) => {
    logger.info('GET /chat (authenticated) - new OSHAL chat UI');
    sendHtmlResponse(res, chatStandaloneFile, '/chat');
  });
  app.use('/chat-assets', requiresAuth, express.static(chatAssetsDir));
  app.get('/index.html', requiresAuth, (req, res) => {
    logger.info('GET /index.html (authenticated)');
    sendHtmlResponse(res, path.join(apiDir, 'index.html'), '/index.html');
  });
  app.get('/ui.html', requiresAuth, (req, res) => {
    logger.info('GET /ui.html (authenticated)');
    sendHtmlResponse(res, path.join(apiDir, 'ui.html'), '/ui.html');
  });

  app.get('/system-health', requiresAuth, (req, res) => {
    logger.info('GET /system-health (authenticated)');
    sendHtmlResponse(res, path.join(apiDir, 'system-health.html'), '/system-health');
  });
  app.get('/alert-pipeline-admin', requiresAuth, (req, res) => {
    logger.info('GET /alert-pipeline-admin (authenticated)');
    sendHtmlResponse(res, path.join(apiDir, 'alert-pipeline-admin.html'), '/alert-pipeline-admin');
  });
}

/**
 * @description Mounts LLM provider auth, OAuth callback endpoints, and free-models/utilities surfaces.
 */
export function mountProviderAuthRoutes(
  app: express.Application,
  requiresAuth: express.RequestHandler,
  apiDir: string,
): void {
  app.get('/utilities', requiresAuth, (_req, res) => {
    sendHtmlResponse(res, path.join(apiDir, 'utilities.html'), '/utilities');
  });
  // ADR-064 — "Run for free" walkthrough: connect your own free AI tokens across providers.
  app.get('/free-models', requiresAuth, (_req, res) => {
    sendHtmlResponse(res, path.join(apiDir, 'free-models.html'), '/free-models');
  });
  app.use('/api/openai-codex/oauth', createOpenAiCodexOAuthRoutes(requiresAuth));
  app.use('/api/claude-code/auth', createClaudeCodeAuthRoutes(requiresAuth));
  app.use('/api/gemini/auth', createGeminiAuthRoutes(requiresAuth));
  app.use('/api/antigravity/auth', createAntigravityAuthRoutes(requiresAuth));
  app.use('/api/facebook-auth', createFacebookAuthRoutes(requiresAuth));
}

/**
 * @description Mounts provider configuration, BYO LLM, free-tier rotation, LLM preference,
 * connectors, and tenant management routes.
 */
export function mountProvidersAndConnectorsRoutes(
  app: express.Application,
  ctx: AppContext,
  requiresAuth: express.RequestHandler,
  apiDir: string,
): void {
  app.use('/api/providers', requiresAuth, createProviderRoutes());
  app.use('/api/connect/any-llm', requiresAuth, createByoLlmRoutes(ctx));
  app.use('/api/connect/free-tier', requiresAuth, createFreeTierRoutes(ctx));
  app.use('/api/settings/llm-default', requiresAuth, createLlmPreferenceRoutes(ctx));
  startFallbackReadinessLoop(() => resolveHotFallbackChain(null).order);
  app.use('/api/connect', connectorCallbackAuth(requiresAuth), createConnectorsRoutes(ctx));
  app.use('/api/connect', requiresAuth, createConnectorLivenessRoutes(ctx));
  app.use('/api/slack', requiresAuth, createSlackRoutes(ctx));
  app.use('/api/tenants', requiresAuth, createTenantRoutes(ctx));
  mountProviderAuthRoutes(app, requiresAuth, apiDir);
}

/**
 * @description Mounts devops, Bot Forge, and LLM judge routes.
 */
export function mountDevopsAndJudgeRoutes(
  app: express.Application,
  ctx: AppContext,
  requiresAuth: express.RequestHandler,
  apiDir: string,
): void {
  app.use('/api/devops', requiresAuth, createDevopsRoutes(ctx, apiDir));
  app.use('/api/forge', requiresAuth, createForgeRoutes(apiDir));
  app.use('/api/judge', requiresAuth, createJudgeRoutes(ctx));
}

/**
 * @description Mounts spend budgets, A2A gateway, run traces, queue DLQ, and notify routes.
 */
export function mountBudgetAndQueueRoutes(
  app: express.Application | any,
  ctx: AppContext,
  requiresAuth: express.RequestHandler,
): void {
  app.use('/api/budgets', createBudgetRoutes(requiresAuth, { pool: ctx.pool }));
  registerA2aGatewayRoutes(app, requiresAuth, {
    pool: ctx.pool,
    ticketService: ctx.ticketService,
    messageStore: ctx.messageStore,
  });
  app.use('/api/trace', createTraceRoutes(requiresAuth, { pool: ctx.pool }));
  app.use('/api/queue/dlq', createQueueDlqRoutes(requiresAuth, { pool: ctx.pool, ticketService: ctx.ticketService }));
  app.use('/api/notify', createNotifyRoutes(ctx, requiresAuth));
}

/**
 * @description Mounts content and LinkedIn assistant routes.
 */
export function mountContentAndAssistantRoutes(
  app: express.Application,
  ctx: AppContext,
  requiresAuth: express.RequestHandler,
  apiDir: string,
): void {
  app.use('/api/content', requiresAuth, createContentRoutes(ctx, apiDir));
  app.use('/api/linkedin-assistant', requiresAuth, createLinkedInAssistantRoutes(ctx, apiDir));
}

/**
 * @description Mounts config, logs, swarm extensions, tasks, stream, and voice routes.
 */
export function mountCoreObservabilityAndVoiceRoutes(
  app: express.Application,
  ctx: AppContext,
  requiresAuth: express.RequestHandler,
): void {
  app.use('/api/config', requiresAuth, createConfigRoutes());
  app.use('/api/logs', requiresAuth, createLogsRoutes(ctx));
  registerSwarmExtensionRoutes(app, requiresAuth, ctx.swarm);
  app.use('/api/tasks', requiresAuth, createTaskRoutes(ctx));
  app.use('/api/stream', requiresAuth, createStreamRoutes(ctx));
  app.use('/api/voice', requiresAuth, createVoiceRoutes(ctx));
}

/**
 * @description Mounts tool verification and agent profile/tool/status directory routes.
 */
export function mountAgentDirectoryRoutes(
  app: express.Application,
  ctx: AppContext,
  requiresAuth: express.RequestHandler,
): void {
  app.use('/api/tools/verify', requiresAuth, createVerificationRoutes(ctx.verificationController));
  app.use('/api/agents', requiresAuth, createAgentProfileRoutes(ctx.agentProfileController));
  app.use('/api/agents', requiresAuth, createAgentToolRoutes(ctx.agentToolController));
  app.use('/api/agents', requiresAuth, createAgentStatusRoutes(ctx.pool));
}

/**
 * @description Mounts audit export, data lifecycle, privacy, and LLM governance routes.
 */
export function mountGovernanceRoutes(
  app: express.Application | any,
  ctx: AppContext,
  requiresAuth: express.RequestHandler,
): void {
  registerAuditExportRoutes(app, ctx, requiresAuth);
  registerDataLifecycleRoutes(app, ctx, requiresAuth);
  app.use('/api/privacy', requiresAuth, createPrivacyRoutes(ctx));
  registerLlmGovernanceRoutes(app, ctx, requiresAuth);
}

/**
 * @description Mounts RCA, process-lab, workflow studio, and batch-job telemetry routes.
 */
export function mountWorkflowStudioRoutes(
  app: express.Application,
  ctx: AppContext,
  requiresAuth: express.RequestHandler,
  apiDir: string,
): void {
  app.use('/api/rca', requiresAuth, createRcaRoutes(ctx));
  app.use('/api/process-lab', requiresAuth, createProcessLabRoutes(ctx));
  app.use('/api/workflow-studio', requiresAuth, createWorkflowStudioRoutes({ pool: ctx.pool }));
  app.use('/api/workflow-studio', requiresAuth, createWorkflowStudioAssistRoutes(ctx));
  app.use('/api/workflow-studio', requiresAuth, createWorkflowRunRoutes({ pool: ctx.pool }));
  app.use('/api/batch-jobs', requiresAuth, createBatchJobTelemetryRoutes({ pool: ctx.pool, apiDir }));
}

/**
 * @description Mounts internal ticketing, workspace, checkpoint, and cockpit routes.
 */
export function mountCoreTicketingRoutes(
  app: express.Application,
  ctx: AppContext,
  requiresAuth: express.RequestHandler,
  apiDir: string,
): void {
  app.use('/api/checkpoints', requiresAuth, createCheckpointRoutes(ctx));
  app.use('/api/optimize', requiresAuth, createOptimizeRoutes(ctx));
  app.use('/api/token-chase', requiresAuth, createTokenChaseRoutes(apiDir, ctx));
  app.use('/api/memory', requiresAuth, createMemoryRoutes(ctx));
  app.use('/api/help', requiresAuth, createHelpRoutes());

  // Internal ticketing system routes
  app.use('/api/tickets', requiresAuth, createTicketRoutes(ctx));
  app.use('/api/workspaces', requiresAuth, createWorkspaceRoutes(ctx));

  // Cockpit API routes (projects, tickets, metrics) — mounted first so ticket-store-backed
  // hierarchy takes priority over the task-explorer fallback
  const cockpitApiRouter = createCockpitRoutes(ctx);
  app.use('/api/v1', requiresAuth, cockpitApiRouter);

  const taskExplorerApiRouter = createTaskExplorerRoutes(ctx);
  app.use('/api/v1', requiresAuth, taskExplorerApiRouter);

  // Intake assistant routes (conversational ticket creation)
  if (ctx.ticketService) {
    app.use('/api/v1/intake', requiresAuth, createIntakeAssistantRoutes(ctx.ticketService));
  }
}

/**
 * @description Mounts ops telemetry, Alertmanager webhooks, refusal records, and SMS ingestion.
 */
export function mountOpsTelemetryRoutes(
  app: express.Application,
  ctx: AppContext,
  requiresAuth: express.RequestHandler,
  refusalStore: any,
): void {
  // Prometheus Alertmanager webhook -> incident ticket intake (swarm self-healing).
  if (ctx.ticketService) {
    const { createAlertmanagerRoutes } = require('./routes/alertmanager-routes');
    const { createPoolRcaSpendReader } = require('./routes/alertmanager-rca-spend');
    app.use('/api/alerts', createAlertmanagerRoutes(ctx.ticketService, {
      rcaSpend: ctx.pool ? createPoolRcaSpendReader(ctx.pool) : null,
      pool: ctx.pool ?? null,
    }));
  }

  // Operations Stream read + admin surface.
  if (ctx.pool) {
    const { createOpsPipelineRoutes } = require('./routes/ops-pipeline-routes');
    app.use('/api/ops/alert-pipeline', createOpsPipelineRoutes({ pool: ctx.pool, requiresAuth }));
    app.use('/api/ops/refusals', createRefusalRoutes(refusalStore, requiresAuth));
  }

  // Inbound SMS webhook (Twilio replies) -> POST /api/sms/inbound.
  {
    if (ctx.pool) {
      const { createWiredSmsInboundRoutes } = require('./routes/sms-inbound-wiring');
      app.use('/api/sms', createWiredSmsInboundRoutes(ctx));
    } else {
      const { createSmsInboundRoutes } = require('./routes/sms-inbound-routes');
      app.use('/api/sms', createSmsInboundRoutes());
    }
  }

  // Personal-Intelligence surface (ADR-058) — the per-user vault.
  {
    const { createPersonalRoutes } = require('./routes/personal-routes');
    app.use('/api/personal', requiresAuth, createPersonalRoutes());
  }
}

/**
 * @description Mounts system health, onboarding, what's-new, presets, and Haven Home Assistant routes.
 */
export function mountSystemAuxiliaryRoutes(
  app: express.Application,
  ctx: AppContext,
  requiresAuth: express.RequestHandler,
): void {
  const { createConfigHealthRoutes } = require('./routes/config-health-routes');
  const { createOnboardingRoutes } = require('./routes/onboarding-routes');
  const { createWhatsNewRoutes } = require('./routes/whats-new-routes');
  const { createSwarmPresetRoutes } = require('./routes/swarm-preset-routes');
  app.use('/api', requiresAuth, createConfigHealthRoutes(ctx));
  app.use('/api', requiresAuth, createOnboardingRoutes(ctx));
  const { createAppHomePreferenceRoutes } = require('./routes/app-home-preferences');
  app.use('/api/home/preferences', requiresAuth, createAppHomePreferenceRoutes(ctx));
  app.use('/api', requiresAuth, createWhatsNewRoutes());
  app.use('/api', requiresAuth, createSwarmPresetRoutes(ctx));

  const { createHavenRoutes } = require('./routes/haven-routes');
  app.use('/api', requiresAuth, createHavenRoutes(ctx));
}
