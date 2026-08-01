/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Replaced if/else provider chain with HARNESS_FACTORIES registry map (harness-as-bot framework)
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Wired agent-profile runtime selection into the Cline-backed provider so bot-scoped chats honor saved provider/model overrides
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Extracted provider/runtime selection helpers from the oversized composition root
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Wired live agent startup manifest service into the Claude Code runtime provider resolver
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Added direct AnthropicProvider resolution — reads API key from secrets.json or ANTHROPIC_API_KEY env
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Added per-bot persona loading from bot-persona.json (written by bot-entrypoint.sh from YAML persona)
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Refreshed runtime provider cache when provider or model changes and aligned Claude runtime fallback model with persisted settings
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Enforced explicit Anthropic credential failures so runtime no longer silently downgrades to the stub provider
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | Added openai-codex/openai-native/openai runtime provider branches using OAuth access token from persisted secrets
 * 10 | maintainer@emeraldcoastsystemsgroup.com   | ARCHITECTURAL FIX: Removed all direct HTTP LLM providers — ALL calls route through Cline CLI (see ADR-005)
 * 11 | maintainer@emeraldcoastsystemsgroup.com   | Refresh OpenAI Codex credentials from persisted/shared seed sources before provider resolution so Docker workers can pick up new OAuth without restart
 * 12 | maintainer@emeraldcoastsystemsgroup.com   | Registered the 'a2a' outbound harness (Plan F item 3): factory builds A2AHarnessAdapter from the registry-declared endpoint env (a2aEndpointEnv, default A2A_OUTBOUND_ENDPOINT_URL) + per-bot token env, wraps it in HarnessLLMBridge, and injects the costUnknown stamper. resolveHarnessForAgent now forwards botName/a2aEndpointEnv so per-bot config never hardcodes URLs or tokens.
 * 14 | maintainer@emeraldcoastsystemsgroup.com   | Least-privilege harnesses for CONTROLLER-INLINE bots (BACKLOG "Harden inline controller bots"). resolveHarnessForAgent now reads the registry entry's `container` and, when it is the api itself, folds resolveControllerInlineScope into the factory config: a shell-free allowedTools list (overriding the deployment-wide CLAUDE_ALLOWED_TOOLS, which grants Bash to every bot) and the platform-plane env keys the adapter must scrub from the child process. The claude-code and codex-cli factories forward both. Bot-node bots pass no container-derived scope, so their harnesses are built byte-identically. Guard: tests/unit/inline-bot-no-shell.spec.ts.
 * 13 | maintainer@emeraldcoastsystemsgroup.com   | Switched the seven deep harness-adapter imports to the new sanctioned '@/features/llm-provider/harness' entry point (barrel split, TODO-BOUNDARY-FINDING 2026-07-19) — behavior unchanged; this file stays the harness stack's sole composition root.
 */

import fs from 'fs';
import path from 'path';
import { createChildLogger } from '@/shared/logger';
import type { AgentProfileService } from '@/features/agent-profile';
import type { Pool } from 'pg';
import {
  AnthropicProvider,
  getDefaultModel,
  LLMService,
  NoopProvider,
  resolveControllerInlineScope,
} from '@/features/llm-provider';
// eslint-disable-next-line no-restricted-imports -- two-runtimes: LLM execution runtime, deliberately off the barrel graph (barrel split, TODO-BOUNDARY-FINDING)
import { GovernedProvider } from '@/features/llm-provider/services/governed-provider';
// eslint-disable-next-line no-restricted-imports -- two-runtimes: LLM execution runtime, deliberately off the barrel graph (barrel split, TODO-BOUNDARY-FINDING)
import {
  AgentStartupManifestService,
  ClineHarnessProvider,
  ClineRuntimeConfigSyncService,
} from '@/features/llm-provider/services';
// eslint-disable-next-line no-restricted-imports -- two-runtimes: LLM execution runtime, deliberately off the barrel graph (barrel split, TODO-BOUNDARY-FINDING)
import {
  isProviderRuntimeStall,
  ProviderFailoverService,
} from '@/features/llm-provider/services/provider-failover-service';
import {
  A2AHarnessAdapter,
  ClaudeCodeCliHarnessAdapter,
  CodexCliHarnessAdapter,
  GeminiCliHarnessAdapter,
  HarnessLLMBridge,
  type HarnessFactory,
  type HarnessFactoryConfig,
  type HarnessType,
} from '@/features/llm-provider/harness';
import { createA2ACostStamper } from './a2a-cost-stamper';
import {
  resolveAgentCapabilitiesFromSwarmRegistry,
  type AgentCapabilityResolver,
} from './agent-capability-resolver';

const logger = createChildLogger({ module: 'provider-runtime' });
// Generic fallback model when LLM_MODEL is unset. claude-code is the default
// working provider (codex CLI requires separate auth and is not the safe default),
// so the generic fallback is a Claude model, not a codex one. Codex-specific
// adapters keep their own gpt-* default.
const DEFAULT_MODEL = process.env.LLM_MODEL || 'claude-sonnet-4-6';
const _serviceName = process.env.SERVICE_DISPLAY_NAME || process.env.SERVICE_NAME || 'OSHAL';

// ── Harness factory registry ──────────────────────────────────────────────────
//
// Each entry maps a harness/provider key to a factory that produces a concrete
// LLMService.  Add new harnesses here — no if/else chains needed elsewhere.
//
// Key resolution: keys are matched case-insensitively against the configured
// provider name.  The first exact match wins; if no match is found the runtime
// falls through to the default Cline CLI path (ADR-005).

/**
 * @description Per-harness runtime defaults — model + binary path resolution.
 *
 * Lifted out of the previous parallel if/else chains in `resolveHarnessForAgent`
 * so adding a new harness is one entry here, not two arms in two separate
 * chains. Typed `Record<HarnessType, …>` so a missing harness is a
 * compile-time error.
 *
 * `resolveModel` receives a `fallback` thunk that returns the system's
 * default model name when the harness has no env override.
 */
export const HARNESS_RUNTIME_DEFAULTS: Record<HarnessType, {
  resolveModel: (fallback: () => string) => string;
  resolveBinary: () => string | undefined;
}> = {
  'codex-cli': {
    resolveModel: (fb) => process.env.CODEX_MODEL ?? fb(),
    resolveBinary: () => process.env.CODEX_CLI_PATH,
  },
  'claude-code': {
    resolveModel: (fb) => process.env.CLAUDE_CODE_MODEL ?? fb(),
    resolveBinary: () => process.env.CLAUDE_CLI_PATH ?? process.env.CLAUDE_CODE_CLI_PATH,
  },
  'gemini-cli': {
    resolveModel: (fb) => process.env.GEMINI_MODEL ?? fb(),
    resolveBinary: () => process.env.GEMINI_CLI_PATH,
  },
  'a2a': {
    // "Model" for an external agent is a label, not an LLM id — the remote owns
    // its own reasoning. Used in chat_tasks attribution as `a2a/<label>`.
    resolveModel: () => process.env.A2A_OUTBOUND_MODEL ?? 'remote-agent',
    resolveBinary: () => undefined,
  },
  'cline': {
    resolveModel: (fb) => fb(),
    resolveBinary: () => process.env.CLINE_CLI_PATH,
  },
  'noop': {
    resolveModel: (fb) => fb(),
    resolveBinary: () => undefined,
  },
};

/**
 * @description Registry of harness factories keyed by HarnessType.
 *
 * Typed as `Record<HarnessType, HarnessFactory>` so adding a new value to
 * the `HarnessType` union without registering a factory here is a
 * compile-time error. Previously this was `Record<string, ...>` and a
 * missing factory would only surface at runtime as "no factory found —
 * falling back to process provider".
 *
 * To register a new harness: extend `HarnessType` in harness-adapter.ts,
 * implement the adapter, add a factory entry below, AND add an entry to
 * `HARNESS_RUNTIME_DEFAULTS` above.
 */
export const HARNESS_FACTORIES: Record<HarnessType, HarnessFactory> = {
  /** No-op (noop) harness for local dev / CI without any LLM. */
  noop: (_cfg: HarnessFactoryConfig) => new NoopProvider(),

  /**
   * Cline CLI harness — the primary harness for ALL providers that are not
   * explicitly overridden.  Includes: openai-codex, claude-code, etc.
   * (see ADR-005).  Registered under 'cline' as an explicit key so bots can
   * opt-in with harnessType: 'cline' in their SwarmBotDefinition.
   *
   * When configuredProvider is any provider Cline understands, it is written to
   * the Cline session config and Cline CLI makes the actual API call using the
   * credentials from secrets.json / CONFIG_OUTPUT_DIR.
   */
  cline: (cfg: HarnessFactoryConfig) => {
    logger.info({ harnessType: 'cline' }, 'HARNESS_FACTORIES: creating Cline CLI harness (explicit)');
    return buildClineProvider(cfg);
  },

  // ── Future harnesses (stubs — implement the adapter class, then register here) ──

  /**
   * OpenAI Codex CLI harness — spawns `codex` subprocess.
   * Auth: ChatGPT/OpenAI Codex OAuth via ~/.codex/auth.json or OPENAI_API_KEY.
   * Config: CODEX_CLI_PATH, CODEX_MODEL, CODEX_WORKSPACE_ROOT, CODEX_SANDBOX_MODE.
   */
  'codex-cli': (cfg: HarnessFactoryConfig) => {
    logger.info({ harnessType: 'codex-cli' }, 'HARNESS_FACTORIES: creating Codex CLI harness');
    const adapter = new CodexCliHarnessAdapter({
      model: cfg.modelId,
      binaryPath: cfg.cliBinaryPath ?? process.env.CODEX_CLI_PATH,
      // Controller-inline bots: keep the api container's platform-plane credentials out of the
      // codex subprocess. Undefined for bot-node bots (no behaviour change there).
      scrubEnvKeys: cfg.scrubEnvKeys,
    });
    return new HarnessLLMBridge(adapter);
  },

  /**
   * Claude Code CLI standalone subprocess harness.
   *
   * When ANTHROPIC_API_KEY is a real key (not placeholder), spawns the `claude` CLI
   * directly as a subprocess via ClaudeCodeCliHarnessAdapter.
   * Falls back to Cline CLI (ADR-005) when no real Anthropic key is present.
   */
  'claude-code': (cfg: HarnessFactoryConfig) => {
    // The claude-code harness spawns the Claude Code CLI subprocess.
    // apiType must be 'claude-code' — this harness has no other mode.
    if (cfg.apiType && cfg.apiType !== 'claude-code') {
      throw new Error(
        `HARNESS_FACTORIES claude-code: apiType '${cfg.apiType}' is incompatible — ` +
        "the 'claude-code' harness only works with apiType: 'claude-code'. " +
        "Use 'cline' harnessType to route through other providers.",
      );
    }
    // Claude Code CLI authenticates EITHER via ANTHROPIC_API_KEY (CI / prod)
    // OR via an OAuth session at ~/.claude/.credentials.json (local dev —
    // the session written by `claude login` on the host, mounted into the
    // container). Accept either as valid auth.
    const anthropicKey = cfg.apiKey || process.env.ANTHROPIC_API_KEY || '';
    const hasRealKey = anthropicKey.length > 0
      && !anthropicKey.startsWith('placeholder')
      && !anthropicKey.startsWith('sk-ant-placeholder');

    let hasOauthSession = false;
    try {
      const fs = require('fs') as typeof import('fs');
      const path = require('path') as typeof import('path');
      const home = process.env.HOME || process.env.USERPROFILE || '/root';
      hasOauthSession = fs.existsSync(path.join(home, '.claude', '.credentials.json'));
    } catch {
      hasOauthSession = false;
    }

    if (!hasRealKey && !hasOauthSession) {
      throw new Error(
        'HARNESS_FACTORIES claude-code: neither ANTHROPIC_API_KEY nor an OAuth ' +
        'session at ~/.claude/.credentials.json is available. Set the env var, ' +
        'or run `claude login` on the host and mount ~/.claude into the container.',
      );
    }

    // FORCE_LLM_MODEL applies to Cline-routed providers — not Claude Code CLI.
    // Claude Code CLI uses its own model (CLAUDE_CODE_MODEL env) or a sensible default.
    const claudeModel = process.env.CLAUDE_CODE_MODEL ?? 'claude-sonnet-4-6';
    logger.info(
      { harnessType: 'claude-code', apiType: 'claude-code', model: claudeModel, via: 'claude-cli-subprocess' },
      'HARNESS_FACTORIES: claude-code using Claude Code CLI subprocess',
    );
    const adapter = new ClaudeCodeCliHarnessAdapter({
      model: claudeModel,
      binaryPath: process.env.CLAUDE_CLI_PATH ?? process.env.CLAUDE_CODE_CLI_PATH ?? 'claude',
      // Controller-inline bots run in the api container: no shell tool, and the platform-plane
      // credentials scrubbed from the child env. Both undefined for bot-node bots, which keep
      // the process-level CLAUDE_ALLOWED_TOOLS (the incident "SWAT team" posture).
      allowedTools: cfg.allowedTools,
      scrubEnvKeys: cfg.scrubEnvKeys,
    });
    const primary = new HarnessLLMBridge(adapter);
    return withProviderStallFallback(primary, cfg, 'claude-code');
  },

  /**
   * Google Gemini CLI standalone subprocess harness.
   *
   * Spawns `gemini` (from `npm install -g @google/gemini-cli`) as a one-shot
   * subprocess. Auth: GEMINI_API_KEY env var (Google AI Studio key) OR an
   * OAuth session at `~/.gemini/` from `gemini auth login` on the host
   * (mounted into containers like ~/.codex and ~/.claude).
   */
  'gemini-cli': (cfg: HarnessFactoryConfig) => {
    if (cfg.apiType && cfg.apiType !== 'google-gemini') {
      throw new Error(
        `HARNESS_FACTORIES gemini-cli: apiType '${cfg.apiType}' is incompatible — ` +
        "the 'gemini-cli' harness only works with apiType: 'google-gemini'.",
      );
    }
    const geminiModel = cfg.modelId ?? process.env.GEMINI_MODEL ?? 'gemini-2.5-pro';
    logger.info(
      { harnessType: 'gemini-cli', apiType: 'google-gemini', model: geminiModel },
      'HARNESS_FACTORIES: creating Gemini CLI harness',
    );
    const adapter = new GeminiCliHarnessAdapter({
      model: geminiModel,
      binaryPath: cfg.cliBinaryPath ?? process.env.GEMINI_CLI_PATH,
    });
    return new HarnessLLMBridge(adapter);
  },

  /**
   * Outbound A2A gateway harness (Plan F item 3) — an EXTERNAL A2A agent as a
   * dispatch target. Execution is JSON-RPC over HTTP (message/send + tasks/get
   * polling); the remote agent owns its own reasoning, so this is never an LLM
   * call by the controller (two-runtimes rule). Endpoint comes from the env var
   * the bot's registry entry declares (a2aEndpointEnv, default
   * A2A_OUTBOUND_ENDPOINT_URL); credential from A2A_OUTBOUND_TOKEN_<BOTKEY>.
   * A missing endpoint/credential throws HERE — resolveHarnessForAgent logs the
   * config gap and falls back, so a misconfigured external bot is a visible
   * skip, never a mid-task failure. In-swarm bots stay on the Redis mesh.
   */
  'a2a': (cfg: HarnessFactoryConfig) => {
    if (cfg.apiType && cfg.apiType !== 'a2a') {
      throw new Error(
        `HARNESS_FACTORIES a2a: apiType '${cfg.apiType}' is incompatible — the 'a2a' harness only works with apiType: 'a2a'.`,
      );
    }
    const endpointEnv = cfg.a2aEndpointEnv ?? 'A2A_OUTBOUND_ENDPOINT_URL';
    const endpointUrl = (process.env[endpointEnv] ?? '').trim();
    logger.info(
      { harnessType: 'a2a', endpointEnv, hasEndpoint: endpointUrl.length > 0, botName: cfg.botName ?? '(unset)' },
      'HARNESS_FACTORIES: creating outbound A2A harness',
    );
    const adapter = new A2AHarnessAdapter({
      endpointUrl,
      endpointEnvName: endpointEnv,
      botKey: cfg.botName,
      remoteAgentLabel: cfg.modelId,
      recordCost: createA2ACostStamper(),
    });
    return new HarnessLLMBridge(adapter);
  },
};
const CLINE_LEVEL0_SYSTEM_PROMPT = `You are an autonomous agent running inside ${_serviceName}.
Prioritize precise implementation, tool-driven execution, and verifiable outcomes.
Use available tools when they provide higher-confidence answers than guessing.
When uncertain, inspect code/config directly before responding.
Keep responses concise, action-oriented, and explicit about what was executed or changed.`;

/**
 * @description Resolves the Level-0 system prompt, preferring per-bot persona from
 * bot-persona.json (written by bot-entrypoint.sh) over the hardcoded Cline default.
 * @returns System prompt string.
 */
function resolveLevel0SystemPrompt(): string {
  const configDir = process.env.CONFIG_OUTPUT_DIR || './output';
  const personaPath = path.join(configDir, 'bot-persona.json');

  if (!fs.existsSync(personaPath)) {
    return CLINE_LEVEL0_SYSTEM_PROMPT;
  }

  try {
    const raw = fs.readFileSync(personaPath, 'utf-8');
    const persona = JSON.parse(raw) as Record<string, unknown>;
    const perspective = persona.perspective;

    if (typeof perspective === 'string' && perspective.trim().length > 0) {
      const botName = typeof persona.name === 'string' ? persona.name : process.env.BOT_NAME ?? 'agent';
      const botRole = typeof persona.role === 'string' ? persona.role : '';
      logger.info(
        { botName, botRole, personaPath, perspectiveLength: perspective.length },
        'Per-bot persona loaded from persona file — overriding default Cline prompt',
      );
      return perspective.trim();
    }
  } catch (error) {
    logger.error({ err: error, personaPath }, 'Failed to read bot persona file; falling back to default Cline prompt');
  }

  return CLINE_LEVEL0_SYSTEM_PROMPT;
}

interface ChatAgentProfileConfig {
  agentId: string;
  name: string;
  projectUrl?: string;
  selectorSkillsText?: string;
  avatarUrl?: string;
}

type AgentRuntimeSelectionResolver = (agentId: string) => Promise<{
  providerId?: string;
  modelId?: string;
} | null>;

/**
 * @description Shared runtime constants used by the composition helpers.
 */
export const runtimeDefaults = {
  defaultModel: DEFAULT_MODEL,
  level0SystemPrompt: resolveLevel0SystemPrompt(),
};

/**
 * @description Reads a JSON config object from disk with structured logging.
 * @param filePath - Absolute config path.
 * @returns Parsed object or undefined when missing/invalid.
 */
export function readJsonConfig(filePath: string): Record<string, unknown> | undefined {
  if (!fs.existsSync(filePath)) {
    logger.info({ operation: 'read', path: filePath, exists: false }, 'Configuration file not found');
    return undefined;
  }

  try {
    logger.info({ operation: 'read', path: filePath, exists: true }, 'Reading configuration file');
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed as Record<string, unknown>;
    }
    logger.warn({ path: filePath }, 'Configuration file does not contain an object');
    return undefined;
  } catch (error) {
    logger.error({ err: error, path: filePath }, 'Failed to read configuration file');
    return undefined;
  }
}

/**
 * @description Reads a trimmed non-empty string.
 * @param value - Raw config field.
 * @returns Trimmed value or undefined.
 */
export function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * @description Parses editable selector skill text into a unique list.
 * @param value - Raw selector skill text.
 * @returns Deduplicated skills.
 */
export function parseSelectorSkills(value?: string): string[] {
  if (!value) {
    return [];
  }

  return Array.from(new Set(
    value
      .split(/[\n,]/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  ));
}

/**
 * @description Reads the standalone chat-agent profile from persisted settings.
 * @param settings - Parsed settings object.
 * @param defaultAgentId - Default chat agent id.
 * @param defaultAgentName - Default chat agent name.
 * @returns Normalized chat-agent profile.
 */
export function readChatAgentProfileConfig(
  settings: Record<string, unknown> | undefined,
  defaultAgentId: string,
  defaultAgentName: string,
): ChatAgentProfileConfig {
  const raw = settings?.chatAgentConfig;
  const profile = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};

  return {
    agentId: defaultAgentId,
    name: readNonEmptyString(profile.name) || defaultAgentName,
    projectUrl: readNonEmptyString(profile.projectUrl),
    selectorSkillsText: readNonEmptyString(profile.selectorSkillsText),
    avatarUrl: readNonEmptyString(profile.avatarUrl),
  };
}

/**
 * @description Resolves the active runtime provider from persisted config with env fallback.
 * @returns Provider identifier selected for runtime.
 */
export function resolveRuntimeProviderName(): string {
  // Hard override: bypass global-config.json entirely when set.
  // Use FORCE_LLM_PROVIDER in compose/K8s to switch providers without modifying persistent volumes.
  const forceProvider = process.env.FORCE_LLM_PROVIDER?.trim();
  if (forceProvider) {
    return forceProvider;
  }
  const configDir = process.env.CONFIG_OUTPUT_DIR || './output';
  const settingsPath = path.join(configDir, 'global-config.json');
  const legacyPath = path.join(configDir, 'llm-config.json');
  const globalConfig = readJsonConfig(settingsPath);
  const configuredFromGlobal = resolveProviderFromSettings(globalConfig);

  if (configuredFromGlobal) {
    return configuredFromGlobal;
  }

  const legacyConfig = readJsonConfig(legacyPath);
  if (legacyConfig && typeof legacyConfig.provider === 'string' && legacyConfig.provider.trim().length > 0) {
    return legacyConfig.provider.trim();
  }

  return process.env.LLM_PROVIDER ?? 'claude-code';
}

/**
 * @description Resolves a provider name from saved settings according to active mode.
 * @param settings - Parsed config settings.
 * @returns Provider identifier when present.
 */
export function resolveProviderFromSettings(settings?: Record<string, unknown>): string | undefined {
  if (!settings) {
    return undefined;
  }

  const mode = settings.mode === 'act' || settings.mode === 'plan' ? settings.mode : undefined;
  const planProvider = readNonEmptyString(settings.planModeApiProvider);
  const actProvider = readNonEmptyString(settings.actModeApiProvider);
  const legacyProvider = readNonEmptyString(settings.provider);

  if (mode === 'act' && actProvider) {
    return actProvider;
  }
  if (mode === 'plan' && planProvider) {
    return planProvider;
  }
  if (planProvider) {
    return planProvider;
  }
  if (actProvider) {
    return actProvider;
  }
  return legacyProvider;
}

// ── Shared Cline builder (used by registry + legacy paths) ───────────────────

/**
 * @description Builds a ClineHarnessProvider from a HarnessFactoryConfig.
 * Centralises the Cline constructor call so all registry entries and legacy
 * paths stay in sync.
 */
function buildClineProvider(cfg: HarnessFactoryConfig): LLMService {
  return new ClineHarnessProvider(
    {
      apiKey: cfg.apiKey ?? process.env.CLAUDE_CODE_API_KEY ?? '',
      model: cfg.modelId ?? resolveRuntimeModelName(),
      baseUrl: cfg.cliBinaryPath ?? process.env.CLINE_CLI_PATH ?? 'cline',
      // Bot-level apiType wins; otherwise use providerId so generic Cline-backed
      // providers (bedrock, openai-codex, etc.) actually override FORCE_LLM_PROVIDER.
      configuredProvider: cfg.apiType ?? cfg.providerId,
    },
    {
      manifestService: cfg.manifestService as AgentStartupManifestService | undefined,
      resolveAgentRuntimeSelection: cfg.resolveAgentRuntimeSelection,
      resolveAgentCapabilities: cfg.resolveAgentCapabilities,
    },
  );
}

/**
 * @description Looks up the HARNESS_FACTORIES registry for a configured provider name.
 * Returns the factory when found, or null when the provider should fall through to
 * the default Cline CLI path.
 */
function lookupHarnessFactory(configuredProvider: string): HarnessFactory | null {
  const key = configuredProvider.toLowerCase().trim();
  // Narrow the arbitrary string to HarnessType via membership check.
  // Direct indexing was previously allowed because HARNESS_FACTORIES was
  // typed Record<string, ...> — that's now Record<HarnessType, ...> so a
  // missing factory is a compile-time error, but this lookup still has to
  // accept user-supplied strings safely.
  if (key in HARNESS_FACTORIES) {
    return HARNESS_FACTORIES[key as HarnessType];
  }
  return null;
}

/**
 * @description Wraps a provider with an opt-in provider-runtime-stall fallback.
 * The fallback is only active when OSHAL_PROVIDER_STALL_FALLBACK (or the more
 * explicit OSHAL_PROVIDER_STALL_FALLBACK_PROVIDER) names a second provider.
 */
function withProviderStallFallback(
  primary: LLMService,
  cfg: HarnessFactoryConfig,
  primaryProviderId: string,
): LLMService {
  const fallbackProviderId = resolveProviderStallFallbackProviderName(primaryProviderId);
  if (!fallbackProviderId) {
    return primary;
  }

  const fallback = createProviderStallFallbackProvider(fallbackProviderId, cfg);
  if (!fallback) {
    return primary;
  }

  return new ProviderFailoverService({
    primary,
    fallback,
    reason: `${primaryProviderId}_provider_runtime_stall`,
    shouldFailover: isProviderRuntimeStall,
  });
}

function resolveProviderStallFallbackProviderName(primaryProviderId: string): string | null {
  const raw = process.env.CLAUDE_CODE_STALL_FALLBACK_PROVIDER
    ?? process.env.OSHAL_PROVIDER_STALL_FALLBACK_PROVIDER
    ?? process.env.OSHAL_PROVIDER_STALL_FALLBACK
    ?? '';
  const normalized = raw.trim().toLowerCase();
  if (!normalized || normalized === 'none' || normalized === 'off' || normalized === 'false') {
    return null;
  }
  if (normalized === primaryProviderId.toLowerCase()) {
    logger.warn(
      { primaryProviderId, fallbackProviderId: normalized },
      'Ignoring provider stall fallback because it matches the primary provider',
    );
    return null;
  }
  return normalized;
}

function createProviderStallFallbackProvider(
  fallbackProviderId: string,
  cfg: HarnessFactoryConfig,
): LLMService | null {
  if (fallbackProviderId === 'claude-code') {
    logger.warn({ fallbackProviderId }, 'Ignoring recursive claude-code provider stall fallback');
    return null;
  }

  const modelId = resolveProviderStallFallbackModel(fallbackProviderId, cfg);
  const factory = lookupHarnessFactory(fallbackProviderId);
  if (factory && fallbackProviderId !== 'cline') {
    const apiType = fallbackProviderId === 'gemini-cli' ? 'google-gemini' : undefined;
    logger.info(
      { fallbackProviderId, modelId, via: 'harness-factory' },
      'Provider stall fallback configured',
    );
    return factory({
      ...cfg,
      providerId: fallbackProviderId,
      apiType,
      modelId,
    });
  }

  logger.info(
    { fallbackProviderId, modelId, via: 'cline-provider' },
    'Provider stall fallback configured',
  );
  return buildClineProvider({
    ...cfg,
    providerId: fallbackProviderId,
    apiType: fallbackProviderId,
    modelId,
  });
}

function resolveProviderStallFallbackModel(
  fallbackProviderId: string,
  cfg: HarnessFactoryConfig,
): string {
  const forcedModel = process.env.OSHAL_PROVIDER_STALL_FALLBACK_MODEL?.trim();
  if (forcedModel) {
    return forcedModel;
  }
  if (fallbackProviderId in HARNESS_RUNTIME_DEFAULTS && fallbackProviderId !== 'cline') {
    const harnessKey = fallbackProviderId as HarnessType;
    return HARNESS_RUNTIME_DEFAULTS[harnessKey].resolveModel(resolveRuntimeModelName);
  }
  return getDefaultModel(fallbackProviderId)
    ?? cfg.modelId
    ?? resolveRuntimeModelName();
}

/**
 * @description Builds the concrete runtime provider implementation.
 *              Provider resolution: HARNESS_FACTORIES registry lookup → Cline CLI fallback.
 *              ALL non-registered providers route through Cline CLI (ADR-005).
 * @param configuredProvider - Persisted provider id.
 * @returns Concrete runtime provider.
 */
export function createRuntimeProvider(
  configuredProvider: string,
  resolveAgentRuntimeSelection?: AgentRuntimeSelectionResolver,
  resolveAgentCapabilities?: AgentCapabilityResolver,
): LLMService {
  const factory = lookupHarnessFactory(configuredProvider);
  if (factory) {
    return factory({
      providerId: configuredProvider,
      modelId: resolveRuntimeModelName(),
      apiKey: process.env.CLAUDE_CODE_API_KEY,
      cliBinaryPath: process.env.CLINE_CLI_PATH,
      resolveAgentRuntimeSelection,
      resolveAgentCapabilities,
    });
  }

  // Direct Anthropic API — bypass Cline CLI when provider is 'anthropic' and a real console API key exists.
  // OAT tokens (sk-ant-oat*) from Claude Code OAuth do NOT work for raw API calls — they must go
  // through the Claude Code CLI which handles its own auth layer. Only real console keys (sk-ant-api*)
  // should use the direct provider.
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (configuredProvider === 'anthropic' && anthropicKey && !anthropicKey.startsWith('placeholder')
      && !anthropicKey.startsWith('sk-ant-oat')) {
    const model = resolveRuntimeModelName();
    logger.info({ configuredProvider, runtimeProvider: 'anthropic-direct', model }, 'Using direct Anthropic API provider');
    return new AnthropicProvider({ apiKey: anthropicKey, model });
  }

  // Default: all providers not in the registry route through Cline CLI (ADR-005).
  // The provider name is written to the Cline session config — Cline handles the API call.
  logger.info(
    { configuredProvider, runtimeProvider: 'cline-cli', model: resolveRuntimeModelName() },
    'Provider not in HARNESS_FACTORIES — routing through Cline CLI (ADR-005)',
  );
  return buildClineProvider({
    providerId: configuredProvider,
    modelId: resolveRuntimeModelName(),
    apiKey: process.env.CLAUDE_CODE_API_KEY,
    cliBinaryPath: process.env.CLINE_CLI_PATH,
    resolveAgentRuntimeSelection,
    resolveAgentCapabilities,
  });
}

/**
 * @description Resolves the model name from persisted config for a given provider.
 * @returns Model name or default.
 */
function resolveRuntimeModelName(): string {
  // Hard override: bypass global-config.json entirely when set.
  // Use FORCE_LLM_MODEL in compose/K8s to switch models without modifying persistent volumes.
  const forceModel = process.env.FORCE_LLM_MODEL?.trim();
  if (forceModel) {
    return forceModel;
  }
  const configDir = process.env.CONFIG_OUTPUT_DIR || './output';
  const settingsPath = path.join(configDir, 'global-config.json');
  const settings = readJsonConfig(settingsPath);
  if (!settings) {
    return process.env.LLM_MODEL ?? DEFAULT_MODEL;
  }

  const mode = settings.mode === 'act' || settings.mode === 'plan' ? settings.mode : 'act';
  const modelField = mode === 'plan' ? 'planModeApiModelId' : 'actModeApiModelId';
  const legacyField = 'apiModelId';

  return readNonEmptyString(settings[modelField])
    ?? readNonEmptyString(settings[legacyField])
    ?? process.env.LLM_MODEL
    ?? DEFAULT_MODEL;
}

/**
 * @description Builds the concrete runtime provider implementation with optional manifest assembly support.
 * Delegates to HARNESS_FACTORIES registry; manifests are forwarded to Cline-backed factories.
 * @param configuredProvider - Persisted provider id.
 * @param manifestService - Optional startup manifest service for Cline-backed providers.
 * @returns Concrete runtime provider.
 */
export function createRuntimeProviderWithManifest(
  configuredProvider: string,
  manifestService?: AgentStartupManifestService,
  resolveAgentRuntimeSelection?: AgentRuntimeSelectionResolver,
  resolveAgentCapabilities?: AgentCapabilityResolver,
): LLMService {
  const factory = lookupHarnessFactory(configuredProvider);
  if (factory) {
    return factory({
      providerId: configuredProvider,
      modelId: resolveRuntimeModelName(),
      apiKey: process.env.CLAUDE_CODE_API_KEY,
      cliBinaryPath: process.env.CLINE_CLI_PATH,
      manifestService,
      resolveAgentRuntimeSelection,
      resolveAgentCapabilities,
    });
  }

  // Direct Anthropic API — only with real console API keys (sk-ant-api*), not OAT tokens.
  const anthropicKey2 = process.env.ANTHROPIC_API_KEY;
  if (configuredProvider === 'anthropic' && anthropicKey2 && !anthropicKey2.startsWith('placeholder')
      && !anthropicKey2.startsWith('sk-ant-oat')) {
    const model = resolveRuntimeModelName();
    logger.info({ configuredProvider, runtimeProvider: 'anthropic-direct', model }, 'Using direct Anthropic API provider (with manifest)');
    return new AnthropicProvider({ apiKey: anthropicKey2, model });
  }

  // Default: all providers not in the registry route through Cline CLI (ADR-005).
  logger.info(
    { configuredProvider, runtimeProvider: 'cline-cli', model: resolveRuntimeModelName() },
    'Provider not in HARNESS_FACTORIES — routing through Cline CLI (ADR-005)',
  );
  return buildClineProvider({
    providerId: configuredProvider,
    modelId: resolveRuntimeModelName(),
    apiKey: process.env.CLAUDE_CODE_API_KEY,
    cliBinaryPath: process.env.CLINE_CLI_PATH,
    manifestService,
    resolveAgentRuntimeSelection,
    resolveAgentCapabilities,
  });
}

/**
 * @description Synchronizes persisted provider/model settings into `~/.cline` runtime files.
 * @param compositionLogger - Scoped logger.
 * @returns Resolved selection or null on failure.
 */
export function syncClineRuntimeSelection(
  compositionLogger: ReturnType<typeof createChildLogger>,
): { provider: string; model: string; mode: 'act' | 'plan' } | null {
  try {
    const syncService = new ClineRuntimeConfigSyncService();
    const selection = syncService.syncFromPersistedConfig(DEFAULT_MODEL);
    compositionLogger.info({ selection }, 'Synchronized Cline runtime selection from persisted config');
    return selection;
  } catch (error) {
    compositionLogger.error({ err: error }, 'Failed to sync Cline runtime selection from persisted config');
    return null;
  }
}

/**
 * @description Refreshes runtime OpenAI Codex credentials from persisted/shared sources without changing provider selection.
 * @param compositionLogger - Scoped logger.
 * @returns True when credentials were synchronized into the local Cline runtime.
 */
export function syncClineRuntimeCredentials(
  compositionLogger: ReturnType<typeof createChildLogger>,
): boolean {
  try {
    const syncService = new ClineRuntimeConfigSyncService();
    const synced = syncService.syncOpenAiCodexCredentials();
    if (synced) {
      compositionLogger.info('Synchronized OpenAI Codex runtime credentials from persisted/shared sources');
    }
    return synced;
  } catch (error) {
    compositionLogger.error({ err: error }, 'Failed to sync OpenAI Codex runtime credentials');
    return false;
  }
}

/**
 * @description Builds a dynamic provider resolver closure plus initial provider instance.
 * @param compositionLogger - Scoped logger.
 * @returns Initial provider and live resolver.
 */
export function createProviderResolver(
  compositionLogger: ReturnType<typeof createChildLogger>,
  manifestService?: AgentStartupManifestService,
  agentProfileService?: AgentProfileService,
  pool: Pool | null = null,
  agentCapabilityResolver?: AgentCapabilityResolver,
): { provider: LLMService; getProvider: () => LLMService } {
  const resolveAgentRuntimeSelection: AgentRuntimeSelectionResolver | undefined = agentProfileService
    ? async (agentId: string) => {
      const profile = await agentProfileService.getAgentProfile(agentId);
      if (!profile) {
        return null;
      }
      return {
        providerId: profile.providerId,
        modelId: profile.modelId,
      };
    }
    : undefined;
  const resolveAgentCapabilities: AgentCapabilityResolver = agentCapabilityResolver
    ?? (async (agentId: string) => resolveAgentCapabilitiesFromSwarmRegistry(agentId));
  syncClineRuntimeSelection(compositionLogger);
  let configuredProviderName = resolveRuntimeProviderName();
  let configuredModelName = resolveRuntimeModelName();
  let provider: LLMService = createRuntimeProviderWithManifest(
    configuredProviderName,
    manifestService,
    resolveAgentRuntimeSelection,
    resolveAgentCapabilities,
  );

  compositionLogger.info(
    { configuredProviderName, configuredModelName, runtimeProvider: provider.getProviderName() },
    'Runtime provider initialized',
  );

  const getProvider = (agentId?: string): LLMService => {
    // Per-bot harness override: if the calling agent has a harnessType in the registry,
    // return that harness instead of the process-level provider.
    // This enables direct-chat paths (TaskOrchestrator) and swarm paths to both
    // respect the per-bot harness configuration without separate wiring.
    if (agentId) {
      const harnessOverride = resolveHarnessForAgent(agentId, compositionLogger, resolveAgentCapabilities);
      if (harnessOverride) {
        // Wrap in the governance gate (model gateway: budgets/quotas/cost-aware
        // downshift). No-op until OSHAL_LLM_BUDGETS is enabled.
        return new GovernedProvider(harnessOverride, pool);
      }
    }

    syncClineRuntimeCredentials(compositionLogger);
    const nextProviderName = resolveRuntimeProviderName();
    const nextModelName = resolveRuntimeModelName();
    if (nextProviderName !== configuredProviderName || nextModelName !== configuredModelName) {
      syncClineRuntimeSelection(compositionLogger);
      compositionLogger.info(
        {
          previousProvider: configuredProviderName,
          nextProvider: nextProviderName,
          previousModel: configuredModelName,
          nextModel: nextModelName,
        },
        'Provider/model configuration changed, refreshing runtime provider',
      );
      configuredProviderName = nextProviderName;
      configuredModelName = nextModelName;
      provider = createRuntimeProviderWithManifest(
        configuredProviderName,
        manifestService,
        resolveAgentRuntimeSelection,
        resolveAgentCapabilities,
      );
    }
    // Wrap the raw runtime provider in the governance gate at the return
    // boundary so internal reassignment (above) is never lost. No-op until
    // OSHAL_LLM_BUDGETS is enabled.
    return new GovernedProvider(provider, pool);
  };

  return { provider: new GovernedProvider(provider, pool), getProvider };
}

// ── Per-agent harness override ─────────────────────────────────────────────────

/** The registry fields harness resolution reads. Structural, so both registries satisfy it. */
export interface HarnessRegistryEntry {
  agentId?: string;
  name?: string;
  container?: string;
  harnessType?: string;
  apiType?: string;
  capabilities?: string[];
  a2aEndpointEnv?: string;
}

/**
 * @description Default registry reader for {@link resolveHarnessForAgent}. A LAZY require
 * rather than a static import, so this composition root adds no eager edge onto the swarm
 * extension (the two-runtimes boundary the controller-runtime-boundary guard pins).
 * @returns The active registry entries.
 */
function defaultLoadHarnessRegistry(): HarnessRegistryEntry[] {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getActiveRegistry } = require('@/app/extensions/swarm/swarm-bot-registry');
  return getActiveRegistry() as HarnessRegistryEntry[];
}

/**
 * @description Resolves a per-bot harness override based on the bot's `harnessType` field
 * in the active swarm registry.  Returns null when no override is configured — the caller
 * should fall back to the process-level `getProvider()`.
 *
 * This function powers the "harness-as-bot" framework: each bot can declare its runtime
 * in its `SwarmBotDefinition` and the execution handler automatically routes LLM calls
 * through the right harness adapter.
 *
 * @example
 * ```ts
 * // In a SwarmBotDefinition:
 * { agentId: '...', name: 'codex-researcher', harnessType: 'codex-cli', ... }
 * // When that bot runs a task, its LLM calls go through CodexCliHarnessAdapter
 * // not the process-level Cline CLI provider.
 * ```
 *
 * @param agentId - The bot's agent ID.
 * @param compositionLogger - Scoped logger.
 * @param resolveAgentCapabilities - Capability resolver handed to the factory.
 * @param loadRegistry - Registry reader; defaults to {@link defaultLoadHarnessRegistry}.
 *   Injectable ONLY so a guard spec can drive this resolution: the default's
 *   `require('@/...')` alias does not resolve under the vitest transform, which silently made
 *   the whole function untestable (it returned null on every call).
 * @returns LLMService instance for the harness, or null.
 */
export function resolveHarnessForAgent(
  agentId: string,
  compositionLogger: ReturnType<typeof createChildLogger>,
  resolveAgentCapabilities: AgentCapabilityResolver = async (resolvedAgentId: string) => (
    resolveAgentCapabilitiesFromSwarmRegistry(resolvedAgentId)
  ),
  loadRegistry: () => HarnessRegistryEntry[] = defaultLoadHarnessRegistry,
): LLMService | null {
  try {
    const registry = loadRegistry();
    // Primary: match the explicit registry agentId (UUID).
    // Fallback: match by process BOT_NAME/AGENT_ID env when the caller passes a DB-seeded UUID
    //           that differs from the registry UUID (e.g. the per-container default chat agent).
    const botName = process.env.BOT_NAME?.trim() || process.env.AGENT_ID?.trim();
    const entry = registry.find((b) => b.agentId === agentId)
      ?? (botName ? registry.find((b) => b.name === botName) : undefined);
    if (!entry?.harnessType) {
      return null;
    }
    const factory = lookupHarnessFactory(entry.harnessType);
    if (!factory) {
      compositionLogger.warn(
        { agentId, harnessType: entry.harnessType },
        'Bot has harnessType but no factory found in HARNESS_FACTORIES — falling back to process provider',
      );
      return null;
    }
    compositionLogger.info(
      { agentId, harnessType: entry.harnessType, apiType: entry.apiType ?? '(unset)' },
      'resolveHarnessForAgent: using per-bot harness override',
    );
    // Per-harness model + binary resolution lives in HARNESS_RUNTIME_DEFAULTS
    // (typed Record<HarnessType, …>) — adding a harness = one entry, not
    // two if/else arms here.
    const harnessKey = entry.harnessType as HarnessType;
    const defaults = HARNESS_RUNTIME_DEFAULTS[harnessKey] ?? HARNESS_RUNTIME_DEFAULTS.cline;
    const modelId = defaults.resolveModel(resolveRuntimeModelName);
    const cliBinaryPath = defaults.resolveBinary();
    // Controller-inline least privilege (BACKLOG "Harden inline controller bots"): a bot whose
    // registry container IS the api executes inside the process that holds the platform's own
    // credentials, so it gets a shell-free tool list and an env scrub. { inline: false } for
    // every bot-node bot, leaving both fields undefined.
    const inlineScope = resolveControllerInlineScope(entry.container);
    if (inlineScope.inline) {
      compositionLogger.info(
        { agentId, container: entry.container, allowedTools: inlineScope.allowedTools },
        'resolveHarnessForAgent: controller-inline bot — shell tools removed and platform-plane env scrubbed',
      );
    }
    return factory({
      providerId: entry.harnessType,
      apiType: entry.apiType,
      modelId,
      cliBinaryPath,
      container: entry.container,
      allowedTools: inlineScope.allowedTools,
      scrubEnvKeys: inlineScope.scrubEnvKeys,
      resolveAgentCapabilities,
      // The a2a harness derives its per-bot credential env from the bot name and
      // reads its endpoint from the registry-declared env var; harmless elsewhere.
      botName: entry.name,
      a2aEndpointEnv: entry.a2aEndpointEnv,
    });
  } catch (err) {
    compositionLogger.warn({ err, agentId }, 'resolveHarnessForAgent: error resolving registry entry');
    return null;
  }
}
