/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted Session 70 config ownership contract builder from config-routes.ts to keep route files under the 800-line governance trigger
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added perAgentRuntime ownership section — OSHAL owns the runtime LLM param record, any-bot owns the mechanics (ADR-034)
 */

/**
 * @description Minimal input required to describe the shared OSHAL config surface.
 */
export interface ConfigOwnershipPaths {
  settingsPath: string;
  secretsPath: string;
}

/**
 * @description Build the canonical ownership contract for OSHAL configuration surfaces.
 *
 * @param paths - Persisted shared settings and secrets locations used by `/api/config`.
 * @returns Structured ownership description for global, per-agent, and legacy config paths.
 */
export function buildConfigOwnershipContract(paths: ConfigOwnershipPaths) {
  return {
    globalConfig: {
      owner: 'OSHAL control plane',
      routeBase: '/api/config',
      summary: 'Shared runtime, provider, and service configuration owned by the OSHAL server.',
      routes: [
        'GET /api/config',
        'POST /api/config',
        'DELETE /api/config',
        'POST /api/config/migrate',
        'GET /api/config/mcp',
        'POST /api/config/mcp',
        'GET /api/config/rag',
        'POST /api/config/rag',
        'GET /api/config/presentron',
        'POST /api/config/presentron',
      ],
      persistedTo: {
        settingsPath: paths.settingsPath,
        secretsPath: paths.secretsPath,
      },
      examples: [
        'planModeApiProvider',
        'actModeApiProvider',
        'planeUrl',
        'redisUrl',
        'gitRepoUrl',
        'codeServerWorkspaceRoot',
        'service runtime settings',
      ],
    },
    perAgentProfile: {
      owner: 'agent-profile feature',
      routeBase: '/api/agents/:agentId/profile',
      summary: 'Narrow agent identity and personalization settings scoped to one persisted agent record.',
      routes: [
        'GET /api/agents',
        'GET /api/agents/:agentId/profile',
        'PUT /api/agents/:agentId/profile',
        'POST /api/agents/:agentId/profile/avatar',
      ],
      persistedTo: {
        storage: 'agents row metadata + selector base fields',
      },
      examples: [
        'name',
        'avatarUrl',
        'projectUrl',
        'themePreference',
        'selectorSkillsText',
      ],
    },
    perAgentTools: {
      owner: 'tool-switch feature',
      routeBase: '/api/agents/:agentId/tools',
      summary: 'Per-agent tool enablement, auth mode, and runtime tool config owned by the tool framework.',
      routes: [
        'GET /api/agents/:agentId/tools',
        'PUT /api/agents/:agentId/tools/:toolId',
        'PUT /api/agents/:agentId/tools/:toolId/config',
        'PUT /api/agents/:agentId/tools/:toolId/auth-mode',
      ],
      persistedTo: {
        storage: 'agent_tools relational records',
      },
      examples: [
        'authMode',
        'tool runtime credentials',
        'per-agent tool toggles',
      ],
    },
    perAgentRuntime: {
      owner: 'OSHAL control plane (config-sync)',
      routeBase: '/api/agents/:agentId/runtime',
      summary:
        'Authoritative runtime LLM parameters for one any-bot — provider, model, mode, timeout, credentials, MCP set, behavior flags. OSHAL owns the record (single source of truth); the any-bot owns the mechanics of applying it. Per ADR-034.',
      routes: [
        'GET /api/agents/:agentId/runtime',
        'PUT /api/agents/:agentId/runtime',
      ],
      persistedTo: {
        storage: 'agent_config record (Postgres) — single source of truth, with config_version + config_sync_log audit',
      },
      syncModel: {
        pushDown:
          'dispatch carries providerId/model/configVersion; a config change calls the bot PUT /api/llm-provider via BotNodeClient.switchProvider',
        broadcastUp:
          'bot publishes a config-change envelope on mesh channel swarm.config-change; OSHAL reconciles central-wins',
        standalone:
          'bot seeds from env/cache on boot and pulls the authoritative record when OSHAL is reachable',
        conflictResolution: 'central-wins (OSHAL record is authoritative)',
      },
      examples: [
        'providerId',
        'modelId',
        'mode (act/plan)',
        'planModeApiProvider',
        'actModeApiProvider',
        'requestTimeoutMs',
        'autoApprove',
        'yoloModeToggled',
        'mcpServers',
      ],
      derivedCaches: [
        'any-bot Redis config:llm-provider:{agentId}',
        'any-bot SQLite SettingsStore',
        '~/.cline/config.json + data/globalState.json + data/secrets.json',
      ],
    },
    legacyCompatibility: {
      owner: 'compatibility only',
      summary: 'Legacy per-port /config pages are not the target OSHAL ownership model and remain compatibility surfaces only.',
      routes: [
        '/config',
        '/api/config/llm',
      ],
      guidance: [
        'Do not rebuild independent per-port /config pages as the default OSHAL admin model.',
        'Use /api/config for shared runtime settings.',
        'Use /api/agents/:agentId/profile for narrow agent identity/personalization.',
        'Use /api/agents/:agentId/tools/* for tool-specific per-agent configuration.',
      ],
    },
  };
}
