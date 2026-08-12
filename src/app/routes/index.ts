/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial barrel export for route modules
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added voice routes export
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added Layer 1 Tools Framework route exports (tool-routes, agent-tool-routes)
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Added presentation routes export
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Added OpenAI Codex OAuth routes export
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Added schedule routes export for Redis-backed self-scheduling endpoints
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Added Claude Code auth routes export
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Added checkpoint and memory routes export for non-swarm memory layers
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | Added agent-profile routes export
 * 10 | maintainer@emeraldcoastsystemsgroup.com   | Removed direct intake route export; swarm extension now owns intake route wiring
 * 11 | maintainer@emeraldcoastsystemsgroup.com   | Added task explorer routes export for the OSHAL-native engineering screen
 * 12 | maintainer@emeraldcoastsystemsgroup.com   | Added shared static HTML page route helper export for native engineering screens
 * 13 | maintainer@emeraldcoastsystemsgroup.com   | Added ticket and workspace route exports for internal ticketing system
 * 14 | maintainer@emeraldcoastsystemsgroup.com   | Added dedicated cockpit/static and standalone surface route helper exports for engineering-screen retrofit decomposition
 * 15 | maintainer@emeraldcoastsystemsgroup.com   | Added legacy engineering compatibility route export for cockpit Engineering restoration
 * 16 | maintainer@emeraldcoastsystemsgroup.com   | Added RCA analysis routes export for rca-specialist bot
 * 17 | maintainer@emeraldcoastsystemsgroup.com   | Added section-based presentation generation routes for presentation-bot
 * 18 | maintainer@emeraldcoastsystemsgroup.com   | Added remote-client registry routes export
 * 19 | maintainer@emeraldcoastsystemsgroup.com   | Added UI profile routes export for app-packaging ribbon overlay
 * 20 | maintainer@emeraldcoastsystemsgroup.com   | Added swarm-app routes export (ADR 2026-04-20 implementation)
 * 21 | maintainer@emeraldcoastsystemsgroup.com   | Added education voice routes export for the Little Monsters voice-settings page + voice-config endpoint
 * 22 | maintainer@emeraldcoastsystemsgroup.com   | Added workflow run-history routes export (studio Runs panel / run inspector)
 * 23 | maintainer@emeraldcoastsystemsgroup.com   | Added Jarvis ambient-listening route export.
 * 24 | maintainer@emeraldcoastsystemsgroup.com   | Added owner-private ambient speaker profile and memory-only audio route export.
 * 25 | maintainer@emeraldcoastsystemsgroup.com   | Added batch Job telemetry route export for runtime/resource observability.
 * 26 | maintainer@emeraldcoastsystemsgroup.com   | Added Gemini connect-state route export (Plan E residual — status-only, host-side CLI login doctrine).
 * 27 | maintainer@emeraldcoastsystemsgroup.com   | Removed the bot-presentation routes export — AI Office carved to the oshal-applications store (ADR-085 Wave 2); the legacy Presentron proxy export stays.
 * 28 | maintainer@emeraldcoastsystemsgroup.com   | Removed the bot-video routes export — the Video Studio carved to the oshal-applications store (ADR-085 Wave 3); the series conductor engine (src/app/series-*.ts) stays core.
 * 29 | maintainer@emeraldcoastsystemsgroup.com   | Removed the world routes export — World Intelligence carved to the oshal-applications store (ADR-085 Wave 3); the world-data ENGINE + world-schedule-dispatch stay core (ADR-093).
 * 30 | maintainer@emeraldcoastsystemsgroup.com   | Added spaces routes export (ADR-111 Phase 1 — video->3D reconstruction surface + owner-scoped scan API).
 * 31 | maintainer@emeraldcoastsystemsgroup.com   | Restored camera routes export so Camera Ops can mount its real camera-node integration UI while the package-store route is absent.
 * 32 | maintainer@emeraldcoastsystemsgroup.com   | Removed the spaces routes export — the Spaces surface carved to the oshal-applications store (ADR-085, "skill with a surface"); the reconstruction ENGINE (src/features/spatial-mapping) stays core as the pinned 'spatial-mapping' kernel skill (ADR-093), and the packaged route mounts /api/spaces from deployed-apps/spaces.
 * 33 | maintainer@emeraldcoastsystemsgroup.com   | Added api-fallback export — the boot-window-aware final /api middleware (503 while swarm-app auto-load is still mounting package routes, JSON 404 after).
 * 34 | maintainer@emeraldcoastsystemsgroup.com   | Alert triage P3: added createPoolRcaSpendReader export (alertmanager-rca-spend.ts) — the cost-ledger actuals reader the /api/alerts mount wires into the FR-E2 budget gate.
 */

export { createApiFallbackHandler } from './api-fallback';
export { createTaskRoutes } from './task-routes';
export { createMessageRoutes } from './message-routes';
export { createStreamRoutes } from './stream-routes';
export { createVoiceRoutes } from './voice-routes';
export { createVisionRoutes } from './vision-routes';
export { createChatChannelRoutes } from './chat-channel-routes';
export { createToolRoutes } from './tool-routes';
export { createInternalToolBridgeRoutes } from './internal-tool-bridge-routes';
export { createAgentProfileRoutes } from './agent-profile-routes';
export { createAgentToolRoutes } from './agent-tool-routes';
// (createPresentationRoutes removed: the legacy Presentron HTTP sidecar proxy was retired —
//  dead presentron:8080 backend, render path moved to the in-repo deck engine. The packaged
//  AI Office surface owns /api/presentations/sections.)
export { createOpenAiCodexOAuthRoutes } from './openai-codex-oauth-routes';
export { createClaudeCodeAuthRoutes, handleClaudeCodeOAuthCallback } from './claude-code-auth-routes';
export { createGeminiAuthRoutes } from './gemini-auth-routes';
export { createScheduleRoutes } from './schedule-routes';
export { createCheckpointRoutes } from './checkpoint-routes';
export { createTokenChaseRoutes } from './token-chase-routes';
export { createOptimizeRoutes } from './optimize-routes';
export { createMemoryRoutes } from './memory-routes';
export { createCockpitRoutes } from './cockpit-routes';
export { createTaskExplorerRoutes } from './task-explorer-routes';
export { registerCockpitStaticRoutes } from './cockpit-static-routes';
export { registerStaticHtmlPageRoute } from './static-html-page-route';
export { registerUiSurfaceRoutes } from './ui-surface-routes';
export { createTicketRoutes } from './ticket-routes';
export { createWorkspaceRoutes } from './workspace-routes';
export { registerLegacyEngineeringCompatRoutes } from './legacy-engineering-compat-routes';
export { createRcaRoutes } from './rca-routes';
// (createBotPresentationRoutes removed: AI Office carved to the oshal-applications store,
//  ADR-085 Wave 2 — the package mounts /api/presentations/sections.)
// (createBotVideoRoutes removed: the Video Studio carved to the oshal-applications store,
//  ADR-085 Wave 3 — the package mounts /api/video. The series conductor engine stays in
//  src/app/series-*.ts per ADR-093.)
export { createAgentStatusRoutes } from './agent-status-routes';
export { createRemoteClientRoutes } from './remote-client-routes';
export { createProcessLabRoutes } from './process-lab-routes';
export { createWorkflowStudioRoutes } from './workflow-studio-routes';
export { createWorkflowStudioAssistRoutes } from './workflow-studio-assist-routes';
export { createWorkflowRunRoutes } from './workflow-run-routes';
export { createBatchJobTelemetryRoutes } from './batch-job-telemetry-routes';
export { createFacebookAuthRoutes } from './facebook-auth-routes';
export { createUiProfileRoutes } from './ui-profile-routes';
export { createSwarmAppRoutes, createPackagedThemeCssFallback } from './swarm-app-routes';
export { createSwarmPackRoutes } from './swarm-pack-routes';
export { createConnectorMarketplaceRoutes } from './connector-marketplace-routes';
export { createDemoAuthRoutes } from './demo-auth-routes';
export { createAlertmanagerRoutes } from './alertmanager-routes';
export { createPoolRcaSpendReader } from './alertmanager-rca-spend';
export { createPersonalRoutes } from './personal-routes';
// (createWorldRoutes removed: World Intelligence carved to the oshal-applications store,
//  ADR-085 Wave 3 — the package mounts /api/world; the world-data engine stays core.)
export { createAmbientListeningRoutes } from './ambient-listening-routes';
export { createAmbientSpeakerRoutes } from './ambient-speaker-routes';
export { createHelpRoutes } from './help-routes';
