/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Phase 0: Ported 22-provider catalog from any-bot LLMProviderRegistry.js — canonical provider definitions with model groups, required keys, and Cline provider mapping
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05: clarify that runtime builders consume provider/model metadata only; required-key labels are readiness/UI metadata, never a credential-materialization contract.
 */

import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'provider-catalog' });

/**
 * @description A single model option within a provider's model group.
 */
export interface ProviderModelOption {
  id: string;
  name: string;
  default?: boolean;
}

/**
 * @description A group of related models (e.g. "Claude 4", "GPT-5", "Gemini 3").
 */
export interface ProviderModelGroup {
  group: string;
  models: ProviderModelOption[];
}

/**
 * @description Full definition of one LLM provider in the catalog.
 * Ported from any-bot LLMProviderRegistry.js PHASE_62.
 */
export interface ProviderDefinition {
  id: string;
  name: string;
  description: string;
  requiresKeys: string[];
  /** The Cline CLI provider identifier. Null means "not a Cline provider" (e.g. claude-code uses its own CLI). */
  clineProvider: string | null;
  modelGroups: ProviderModelGroup[];
  baseUrl?: string;
  note?: string;
}

/**
 * @description Canonical catalog of all 22 providers supported by the Cline CLI agent.
 * Sourced from any-bot PHASE_62 LLMProviderRegistry.js and Cline CLI source
 * (_reference/cline-source/src/shared/api.ts).
 *
 * This catalog serves three purposes:
 *   1. Cockpit UI populates provider/model dropdowns from this data
 *   2. buildClineConfig() maps provider/model ids into non-secret compatibility metadata
 *   3. buildClineGlobalState() emits non-secret plan state with autonomous approvals disabled
 */
export const PROVIDER_CATALOG: Record<string, ProviderDefinition> = {
  bedrock: {
    id: 'bedrock',
    name: 'AWS Bedrock',
    description: 'Claude via AWS Bedrock (GovCloud + Standard)',
    requiresKeys: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION'],
    clineProvider: 'bedrock',
    modelGroups: [
      {
        group: 'GovCloud (us-gov-west-1)',
        models: [
          { id: 'us-gov.anthropic.claude-3-5-sonnet-20241022-v2:0', name: 'Claude 3.5 Sonnet v2 (GovCloud)', default: true },
          { id: 'us-gov.anthropic.claude-3-5-haiku-20241022-v1:0', name: 'Claude 3.5 Haiku (GovCloud)' },
          { id: 'us-gov.anthropic.claude-3-opus-20240229-v1:0', name: 'Claude 3 Opus (GovCloud)' },
        ],
      },
      {
        group: 'Claude 4 (Standard)',
        models: [
          { id: 'claude-sonnet-4.5-20250929-v1:0', name: 'Claude Sonnet 4.5' },
          { id: 'anthropic.claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
          { id: 'anthropic.claude-haiku-4-5-20251001-v1:0', name: 'Claude Haiku 4.5' },
          { id: 'anthropic.claude-opus-4-6-v1', name: 'Claude Opus 4.6' },
        ],
      },
      {
        group: 'Claude 3.x (Standard)',
        models: [
          { id: 'anthropic.claude-3-7-sonnet-20250219-v1:0', name: 'Claude 3.7 Sonnet' },
          { id: 'anthropic.claude-3-5-sonnet-20241022-v2:0', name: 'Claude 3.5 Sonnet v2' },
          { id: 'anthropic.claude-3-5-haiku-20241022-v1:0', name: 'Claude 3.5 Haiku' },
          { id: 'anthropic.claude-3-opus-20240229-v1:0', name: 'Claude 3 Opus' },
        ],
      },
    ],
  },

  anthropic: {
    id: 'anthropic',
    name: 'Anthropic (Direct)',
    description: 'Direct Anthropic API',
    requiresKeys: ['ANTHROPIC_API_KEY'],
    clineProvider: 'anthropic',
    modelGroups: [
      {
        group: 'Claude 4',
        models: [
          { id: 'claude-3-5-sonnet-20241022', name: 'Claude Sonnet 4.5', default: true },
          { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
          { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' },
          { id: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
        ],
      },
      {
        group: 'Claude 3.x',
        models: [
          { id: 'claude-3-7-sonnet-20250219', name: 'Claude 3.7 Sonnet' },
          { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet v2' },
          { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku' },
          { id: 'claude-3-opus-20240229', name: 'Claude 3 Opus' },
          { id: 'claude-3-haiku-20240307', name: 'Claude 3 Haiku' },
        ],
      },
    ],
  },

  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter',
    description: '100+ models via one API',
    requiresKeys: ['OPENROUTER_API_KEY'],
    clineProvider: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    modelGroups: [
      {
        group: 'Anthropic (via OpenRouter)',
        models: [
          { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', default: true },
          { id: 'anthropic/claude-3.5-haiku', name: 'Claude 3.5 Haiku' },
          { id: 'anthropic/claude-3-opus', name: 'Claude 3 Opus' },
        ],
      },
      {
        group: 'OpenAI (via OpenRouter)',
        models: [
          { id: 'openai/gpt-4o', name: 'GPT-4o' },
          { id: 'openai/gpt-4o-mini', name: 'GPT-4o Mini' },
        ],
      },
      {
        group: 'Google (via OpenRouter)',
        models: [
          { id: 'google/gemini-pro-1.5', name: 'Gemini Pro 1.5' },
          { id: 'google/gemini-flash-1.5', name: 'Gemini Flash 1.5' },
        ],
      },
    ],
  },

  openai: {
    id: 'openai',
    name: 'OpenAI',
    description: 'Direct OpenAI API',
    requiresKeys: ['OPENAI_API_KEY'],
    clineProvider: 'openai',
    modelGroups: [
      {
        group: 'GPT-4o',
        models: [
          { id: 'gpt-4o', name: 'GPT-4o', default: true },
          { id: 'gpt-4o-mini', name: 'GPT-4o Mini' },
        ],
      },
      {
        group: 'o1 Reasoning',
        models: [
          { id: 'o1-preview', name: 'o1 Preview' },
          { id: 'o1-mini', name: 'o1 Mini' },
        ],
      },
    ],
  },

  'openai-native': {
    id: 'openai-native',
    name: 'OpenAI Native',
    description: 'OpenAI API (native format)',
    requiresKeys: ['OPENAI_API_KEY'],
    clineProvider: 'openai-native',
    modelGroups: [
      {
        group: 'GPT-5',
        models: [
          { id: 'gpt-5.2', name: 'GPT-5.2', default: true },
          { id: 'gpt-5.1', name: 'GPT-5.1' },
          { id: 'gpt-5-mini-2025-08-07', name: 'GPT-5 Mini' },
          { id: 'gpt-5-nano-2025-08-07', name: 'GPT-5 Nano' },
        ],
      },
      {
        group: 'o4 / o3 Reasoning',
        models: [
          { id: 'o4-mini', name: 'o4 Mini' },
          { id: 'o3-mini', name: 'o3 Mini' },
        ],
      },
      {
        group: 'GPT-4o',
        models: [
          { id: 'gpt-4o', name: 'GPT-4o' },
          { id: 'gpt-4o-mini', name: 'GPT-4o Mini' },
        ],
      },
    ],
  },

  'openai-codex': {
    id: 'openai-codex',
    name: 'OpenAI Codex (ChatGPT Pro)',
    description: 'OpenAI via ChatGPT Pro OAuth — uses Cline with openai-native provider',
    requiresKeys: [],
    clineProvider: 'openai-native',
    modelGroups: [
      {
        group: 'Codex Models',
        models: [
          { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex', default: true },
          { id: 'gpt-5.2-codex', name: 'GPT-5.2 Codex' },
          { id: 'codex-mini-latest', name: 'Codex Mini' },
        ],
      },
    ],
    note: 'Auth via OAuth flow in cockpit. Credentials synced to Cline runtime.',
  },

  gemini: {
    id: 'gemini',
    name: 'Google Gemini',
    description: 'Google Gemini API',
    requiresKeys: ['GEMINI_API_KEY'],
    clineProvider: 'gemini',
    modelGroups: [
      {
        group: 'Gemini 3',
        models: [
          { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro Preview', default: true },
          { id: 'gemini-3-pro-preview', name: 'Gemini 3 Pro Preview' },
          { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash Preview' },
        ],
      },
      {
        group: 'Gemini 2.5',
        models: [
          { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
          { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
        ],
      },
    ],
  },

  vertex: {
    id: 'vertex',
    name: 'Google Vertex AI',
    description: 'Google Cloud Vertex AI',
    requiresKeys: ['VERTEX_PROJECT_ID', 'VERTEX_REGION'],
    clineProvider: 'vertex',
    modelGroups: [
      {
        group: 'Gemini on Vertex',
        models: [
          { id: 'gemini-3-pro-preview', name: 'Gemini 3 Pro Preview', default: true },
          { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro Preview' },
          { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
        ],
      },
      {
        group: 'Claude on Vertex',
        models: [
          { id: 'claude-3-5-sonnet-v2@20241022', name: 'Claude 3.5 Sonnet v2' },
          { id: 'claude-sonnet-4@20250514', name: 'Claude Sonnet 4' },
          { id: 'claude-opus-4-5@20251101', name: 'Claude Opus 4.5' },
        ],
      },
    ],
  },

  azure: {
    id: 'azure',
    name: 'Azure OpenAI',
    description: 'Azure OpenAI Service',
    requiresKeys: ['AZURE_API_KEY', 'AZURE_ENDPOINT', 'AZURE_DEPLOYMENT_ID', 'AZURE_API_VERSION'],
    clineProvider: 'azure',
    modelGroups: [
      {
        group: 'GPT-4o',
        models: [
          { id: 'gpt-4o', name: 'GPT-4o', default: true },
          { id: 'gpt-4o-mini', name: 'GPT-4o Mini' },
        ],
      },
      {
        group: 'GPT-4',
        models: [
          { id: 'gpt-4-turbo', name: 'GPT-4 Turbo' },
          { id: 'gpt-4', name: 'GPT-4' },
        ],
      },
    ],
  },

  mistral: {
    id: 'mistral',
    name: 'Mistral AI',
    description: 'Mistral AI API',
    requiresKeys: ['MISTRAL_API_KEY'],
    clineProvider: 'mistral',
    modelGroups: [
      {
        group: 'Devstral (Code)',
        models: [
          { id: 'devstral-2512', name: 'Devstral 2512', default: true },
          { id: 'labs-devstral-small-2512', name: 'Devstral Small 2512' },
        ],
      },
      {
        group: 'Mistral Large',
        models: [
          { id: 'mistral-large-2512', name: 'Mistral Large 2512' },
          { id: 'mistral-large-2411', name: 'Mistral Large 2411' },
        ],
      },
    ],
  },

  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    description: 'DeepSeek API',
    requiresKeys: ['DEEPSEEK_API_KEY'],
    clineProvider: 'deepseek',
    modelGroups: [
      {
        group: 'DeepSeek Models',
        models: [
          { id: 'deepseek-chat', name: 'DeepSeek V3 Chat', default: true },
          { id: 'deepseek-reasoner', name: 'DeepSeek R1' },
        ],
      },
    ],
  },

  xai: {
    id: 'xai',
    name: 'xAI (Grok)',
    description: 'xAI Grok API',
    requiresKeys: ['XAI_API_KEY'],
    clineProvider: 'xai',
    modelGroups: [
      {
        group: 'Grok 4',
        models: [
          { id: 'grok-4', name: 'Grok 4', default: true },
          { id: 'grok-4-fast-reasoning', name: 'Grok 4 Fast Reasoning' },
        ],
      },
      {
        group: 'Grok 3',
        models: [
          { id: 'grok-3-beta', name: 'Grok 3 Beta' },
          { id: 'grok-3-mini-beta', name: 'Grok 3 Mini Beta' },
        ],
      },
    ],
  },

  groq: {
    id: 'groq',
    name: 'Groq',
    description: 'Groq ultra-fast inference',
    requiresKeys: ['GROQ_API_KEY'],
    clineProvider: 'groq',
    modelGroups: [
      {
        group: 'Llama on Groq',
        models: [
          { id: 'meta-llama/llama-4-maverick-17b-128e-instruct', name: 'Llama 4 Maverick 17B', default: true },
          { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B Versatile' },
          { id: 'llama-3.1-8b-instant', name: 'Llama 3.1 8B' },
        ],
      },
      {
        group: 'DeepSeek on Groq',
        models: [
          { id: 'deepseek-r1-distill-llama-70b', name: 'DeepSeek R1 Distill Llama 70B' },
        ],
      },
    ],
  },

  ollama: {
    id: 'ollama',
    name: 'Ollama (Local)',
    description: 'Local models via Ollama',
    requiresKeys: [],
    clineProvider: 'ollama',
    baseUrl: 'http://localhost:11434',
    modelGroups: [
      {
        group: 'Popular Models',
        models: [
          { id: 'llama3.1:70b', name: 'Llama 3.1 70B', default: true },
          { id: 'llama3.1:8b', name: 'Llama 3.1 8B' },
          { id: 'mistral:7b', name: 'Mistral 7B' },
          { id: 'codellama:34b', name: 'CodeLlama 34B' },
          { id: 'deepseek-coder:33b', name: 'DeepSeek Coder 33B' },
        ],
      },
    ],
    note: 'Models must be pulled first: ollama pull <model>',
  },

  lmstudio: {
    id: 'lmstudio',
    name: 'LM Studio (Local)',
    description: 'Local models via LM Studio',
    requiresKeys: [],
    clineProvider: 'lmstudio',
    baseUrl: 'http://localhost:1234',
    modelGroups: [
      {
        group: 'Local Models',
        models: [
          { id: 'local-model', name: 'Use currently loaded model', default: true },
        ],
      },
    ],
    note: 'Start LM Studio and load a model first',
  },

  together: {
    id: 'together',
    name: 'Together AI',
    description: 'Together AI',
    requiresKeys: ['TOGETHER_API_KEY'],
    clineProvider: 'together',
    modelGroups: [
      {
        group: 'Llama Models',
        models: [
          { id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', name: 'Llama 3.3 70B Turbo', default: true },
          { id: 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo', name: 'Llama 3.1 8B Turbo' },
        ],
      },
      {
        group: 'DeepSeek on Together',
        models: [
          { id: 'deepseek-ai/DeepSeek-R1', name: 'DeepSeek R1' },
        ],
      },
    ],
  },

  fireworks: {
    id: 'fireworks',
    name: 'Fireworks AI',
    description: 'Fireworks AI fast inference',
    requiresKeys: ['FIREWORKS_API_KEY'],
    clineProvider: 'fireworks',
    modelGroups: [
      {
        group: 'Latest Models',
        models: [
          { id: 'accounts/fireworks/models/kimi-k2-instruct-0905', name: 'Kimi K2 Instruct', default: true },
          { id: 'accounts/fireworks/models/qwen3-coder-480b-a35b-instruct', name: 'Qwen3 Coder 480B' },
        ],
      },
      {
        group: 'DeepSeek on Fireworks',
        models: [
          { id: 'accounts/fireworks/models/deepseek-r1-0528', name: 'DeepSeek R1 0528' },
          { id: 'accounts/fireworks/models/deepseek-v3', name: 'DeepSeek V3' },
        ],
      },
    ],
  },

  cerebras: {
    id: 'cerebras',
    name: 'Cerebras',
    description: 'Cerebras ultra-fast inference',
    requiresKeys: ['CEREBRAS_API_KEY'],
    clineProvider: 'cerebras',
    modelGroups: [
      {
        group: 'Cerebras Models',
        models: [
          { id: 'zai-glm-4.7', name: 'ZAI GLM 4.7', default: true },
          { id: 'gpt-oss-120b', name: 'GPT OSS 120B' },
        ],
      },
    ],
  },

  sambanova: {
    id: 'sambanova',
    name: 'SambaNova',
    description: 'SambaNova AI',
    requiresKeys: ['SAMBANOVA_API_KEY'],
    clineProvider: 'sambanova',
    modelGroups: [
      {
        group: 'Llama on SambaNova',
        models: [
          { id: 'Llama-4-Maverick-17B-128E-Instruct', name: 'Llama 4 Maverick 17B', default: true },
          { id: 'Meta-Llama-3.3-70B-Instruct', name: 'Llama 3.3 70B' },
          { id: 'Meta-Llama-3.1-405B-Instruct', name: 'Llama 3.1 405B' },
        ],
      },
      {
        group: 'DeepSeek on SambaNova',
        models: [
          { id: 'DeepSeek-R1', name: 'DeepSeek R1' },
        ],
      },
    ],
  },

  nebius: {
    id: 'nebius',
    name: 'Nebius AI',
    description: 'Nebius AI Studio',
    requiresKeys: ['NEBIUS_API_KEY'],
    clineProvider: 'nebius',
    modelGroups: [
      {
        group: 'DeepSeek on Nebius',
        models: [
          { id: 'deepseek-ai/DeepSeek-V3', name: 'DeepSeek V3', default: true },
          { id: 'deepseek-ai/DeepSeek-R1', name: 'DeepSeek R1' },
        ],
      },
      {
        group: 'Llama on Nebius',
        models: [
          { id: 'meta-llama/Llama-3.3-70B-Instruct-fast', name: 'Llama 3.3 70B Fast' },
        ],
      },
    ],
  },

  asksage: {
    id: 'asksage',
    name: 'AskSage',
    description: 'AskSage AI (FedRAMP)',
    requiresKeys: ['ASKSAGE_API_KEY'],
    clineProvider: 'asksage',
    modelGroups: [
      {
        group: 'Claude via AskSage',
        models: [
          { id: 'claude-4-sonnet', name: 'Claude 4 Sonnet', default: true },
          { id: 'claude-4.6-sonnet', name: 'Claude 4.6 Sonnet' },
        ],
      },
      {
        group: 'GPT via AskSage',
        models: [
          { id: 'gpt-4o', name: 'GPT-4o' },
          { id: 'gpt-4o-gov', name: 'GPT-4o Gov' },
        ],
      },
    ],
  },

  litellm: {
    id: 'litellm',
    name: 'LiteLLM Proxy',
    description: 'LiteLLM proxy server',
    requiresKeys: ['LITELLM_BASE_URL'],
    clineProvider: 'litellm',
    modelGroups: [
      {
        group: 'Proxy Models',
        models: [
          { id: 'gpt-4o', name: 'GPT-4o (via proxy)', default: true },
          { id: 'claude-3-5-sonnet', name: 'Claude 3.5 Sonnet (via proxy)' },
        ],
      },
    ],
  },

  requesty: {
    id: 'requesty',
    name: 'Requesty',
    description: 'Requesty AI router',
    requiresKeys: ['REQUESTY_API_KEY'],
    clineProvider: 'requesty',
    modelGroups: [
      {
        group: 'Routed Models',
        models: [
          { id: 'anthropic/claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet', default: true },
          { id: 'openai/gpt-4o', name: 'GPT-4o' },
        ],
      },
    ],
  },

  'cline-cli': {
    id: 'cline-cli',
    name: 'Cline CLI (Auto)',
    description: 'Cline CLI uses its own provider config (~/.cline/config.json)',
    requiresKeys: [],
    clineProvider: null,
    modelGroups: [
      {
        group: 'Current Config',
        models: [
          { id: 'auto', name: 'Use ~/.cline/config.json (current setting)', default: true },
        ],
      },
    ],
  },

  'claude-code': {
    id: 'claude-code',
    name: 'Claude Code CLI',
    description: 'Anthropic Claude via official Claude Code CLI',
    requiresKeys: [],
    clineProvider: null,
    modelGroups: [
      {
        group: 'Claude (via Claude Code CLI)',
        models: [
          { id: 'opus', name: 'Claude Opus 4.6' },
          { id: 'sonnet', name: 'Claude Sonnet 4.5', default: true },
          { id: 'haiku', name: 'Claude Haiku 4.5' },
          { id: 'claude-opus-4-6', name: 'Claude Opus 4.6 (full ID)' },
          { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (full ID)' },
        ],
      },
    ],
    note: 'Uses claude binary. Auth: ~/.claude/ (OAuth) or ANTHROPIC_API_KEY.',
  },

};

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * @description Returns all provider definitions as an array.
 */
export function getAllProviders(): ProviderDefinition[] {
  return Object.values(PROVIDER_CATALOG);
}

/**
 * @description Returns a specific provider by ID, or null if not found.
 */
export function getProvider(providerId: string): ProviderDefinition | null {
  return PROVIDER_CATALOG[providerId] ?? null;
}

/**
 * @description Returns the default model ID for a provider.
 */
export function getDefaultModel(providerId: string): string | null {
  const provider = PROVIDER_CATALOG[providerId];
  if (!provider) return null;

  for (const group of provider.modelGroups) {
    const defaultModel = group.models.find((m) => m.default);
    if (defaultModel) return defaultModel.id;
  }

  if (provider.modelGroups.length > 0 && provider.modelGroups[0].models.length > 0) {
    return provider.modelGroups[0].models[0].id;
  }

  return null;
}

/**
 * @description Returns the Cline CLI provider identifier for a given provider ID.
 * Some providers (claude-code, cline-cli) are not Cline providers — they use their own CLI.
 */
export function getClineProviderMapping(providerId: string): string | null {
  const provider = PROVIDER_CATALOG[providerId];
  return provider?.clineProvider ?? null;
}

/**
 * @description Returns provider IDs that are compatible with a given agent type.
 */
export function getProvidersForAgent(agentType: string): string[] {
  switch (agentType) {
    case 'claude-code':
      return ['anthropic'];
    case 'codex':
      return ['openai', 'openai-native', 'openai-codex'];
    case 'cline':
      return Object.keys(PROVIDER_CATALOG).filter((id) => {
        const def = PROVIDER_CATALOG[id];
        return def.clineProvider !== null || id === 'cline-cli';
      });
    default:
      return Object.keys(PROVIDER_CATALOG);
  }
}

logger.info({ providerCount: Object.keys(PROVIDER_CATALOG).length }, 'Provider catalog loaded');
